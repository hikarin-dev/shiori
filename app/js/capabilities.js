// capabilities.js — what the configured translation server can run (GET /capabilities).
//
// The server is the only source of models, options, presets and languages. The last answer per
// server is kept (in memory, and in settings storage where the context has it) so Settings can
// still show choices while the server is unreachable, marked as a cached copy. Refreshes send
// If-None-Match, so an unchanged server answers with an empty 304.

import { kv } from './platform.js';

const STORE_KEY = 'translateCapabilities';
const _memory = new Map();   // serverUrl → { etag, doc, at }

function _headers(settings) {
  const token = ((settings || {}).serverToken || '').trim();
  return token ? { 'X-Access-Token': token } : {};
}

async function _stored() {
  try { return (await kv.get([STORE_KEY]))[STORE_KEY] || {}; } catch { return {}; }
}

export async function cachedCapabilities(serverUrl) {
  if (_memory.has(serverUrl)) return _memory.get(serverUrl);
  const entry = (await _stored())[serverUrl];
  if (entry?.doc) _memory.set(serverUrl, entry);
  return entry?.doc ? entry : null;
}

async function _remember(serverUrl, entry) {
  _memory.set(serverUrl, entry);
  try {
    const all = await _stored();
    all[serverUrl] = entry;
    await kv.set({ [STORE_KEY]: all });
  } catch {}
}

// { doc, offline } — `doc` null when nothing is known about this server. A fresh answer (or a
// 304 confirming the cached one) has offline false.
export async function getCapabilities(serverUrl, settings = {}, { timeoutMs = 4000 } = {}) {
  const cached = await cachedCapabilities(serverUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = _headers(settings);
    if (cached?.etag) headers['If-None-Match'] = `"${cached.etag}"`;
    const resp = await fetch(`${serverUrl}/capabilities`, { headers, cache: 'no-store', signal: ctrl.signal });
    if (resp.status === 304 && cached) return { doc: cached.doc, offline: false };
    // Reachable but without this endpoint: an older server that offers no capabilities at all.
    if (resp.status === 404) return { doc: null, offline: false, status: 404 };
    if (!resp.ok) return { doc: cached?.doc || null, offline: true, status: resp.status };
    const doc = await resp.json();
    if (!doc || !Array.isArray(doc.stages)) return { doc: cached?.doc || null, offline: true };
    await _remember(serverUrl, { etag: doc.etag, doc, at: Date.now() });
    return { doc, offline: false };
  } catch {
    return { doc: cached?.doc || null, offline: true };
  } finally {
    clearTimeout(timer);
  }
}
