// platform.js — cross-context plumbing for the app (pages, the PWA service worker, and the
// agent iframe the extension embeds). Everything is same-origin web platform: BroadcastChannel
// for live signals, localStorage for small settings, IndexedDB for the durable job registry.
//
// Every app context — a library tab, the reader, the PWA service worker, the extension-hosted
// agent — publishes and subscribes through these primitives, which is what makes job progress
// and library changes live everywhere at once.

import { meterWrites, ignoreWrites } from './disk-writes.js';

// Stable id for THIS JavaScript context (page / worker / agent) — lets a broadcast receiver
// tell its own echoes apart from other contexts' messages (e.g. the library-reset reload).
export const contextId = globalThis.crypto?.randomUUID?.()
  || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── Change feed ──────────────────────────────────────────────────────────────────────────
// One beacon `{ gid, context, n, at }` per gallery mutation, delivered to every same-origin context so
// each surface re-reads just the gallery that changed (see store.js).
function makeChannelHub(name) {
  const bc = ('BroadcastChannel' in globalThis) ? new BroadcastChannel(name) : null;
  const local = new Set();   // BroadcastChannel doesn't echo to the sender; notify same-context subs too
  if (bc) bc.onmessage = (e) => { if (e.data && typeof e.data === 'object') for (const cb of [...local]) { try { cb(e.data); } catch {} } };
  return {
    publish(msg) {
      if (bc) try { bc.postMessage(msg); } catch {}
      for (const cb of [...local]) { try { cb(msg); } catch {} }
    },
    subscribe(cb) { local.add(cb); return () => local.delete(cb); },
  };
}

export const feed = makeChannelHub('shiori-feed');

// ── Small persistent key/value (settings, counters) ─────────────────────────────────────
// localStorage in pages and the agent iframe (same origin → same storage). The service worker
// has no localStorage; job payloads carry the settings they need, so its writes can drop.
const _kvMem = new Map();
const _hasLS = typeof localStorage !== 'undefined';
export const kv = {
  get(keys) {
    const out = {};
    for (const k of (Array.isArray(keys) ? keys : [keys])) {
      const v = _hasLS ? localStorage.getItem('shiori:' + k) : _kvMem.get(k);
      if (v != null) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
    }
    return Promise.resolve(out);
  },
  set(obj) {
    for (const k in obj) {
      try {
        if (_hasLS) localStorage.setItem('shiori:' + k, JSON.stringify(obj[k]));
        else _kvMem.set(k, JSON.stringify(obj[k]));
      } catch {}
    }
  },
};

// ── Cross-context control signals (e.g. cover-cache invalidation) — distinct from the data feed ──
const _controlHub = makeChannelHub('shiori-control');
export const control = {
  send(msg) { _controlHub.publish(msg); },
  on(cb) { return _controlHub.subscribe(cb); },
};

// ── Live job status (translate / upload / download), live across every open context ───────
// A job is { gid, kind, status, done, total, label, error, at }. Whoever runs the work
// publishes deltas; every surface subscribes and hydrates current() on load. Durable registry
// in IndexedDB (the PWA service worker can't use localStorage) + BroadcastChannel broadcast.
const _jobKey = (j) => `${j.gid}:${j.kind || 'job'}`;
const STALE_PURGE_MS = 24 * 60 * 60 * 1000;   // drop registry rows this old on hydrate

let _jobsDbP = null;
function _jobsDb() {
  return _jobsDbP || (_jobsDbP = new Promise((resolve, reject) => {
    const r = indexedDB.open('shiori-jobs', 4);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'key' });  // SW resume list
      if (!db.objectStoreNames.contains('resume')) db.createObjectStore('resume', { keyPath: 'gid' });     // token-reattach records
      if (!db.objectStoreNames.contains('counters')) db.createObjectStore('counters', { keyPath: 'key' }); // lifetime totals
      if (!db.objectStoreNames.contains('cursors')) db.createObjectStore('cursors', { keyPath: 'gid' });   // poll positions
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

// ── Disk writes ──────────────────────────────────────────────────────────────────────────
// Everything this app has written to the browser's storage, by kind (disk-writes.js counts it in
// every context). Kept in IndexedDB so the service worker, which has no localStorage, adds to the
// same total; the counter's own small writes aren't counted.
const WRITES_KEY = 'writes';
const _writesHub = makeChannelHub('shiori-writes');
function _writesTx(fn) {
  return _jobsDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('counters', 'readwrite');
    ignoreWrites(t);
    let out = null;
    const store = t.objectStore('counters');
    const req = store.get(WRITES_KEY);
    req.onsuccess = () => { out = fn(req.result || { key: WRITES_KEY, total: 0, by: {} }); if (out) store.put(out); };
    t.oncomplete = () => resolve(out || req.result || { key: WRITES_KEY, total: 0, by: {} });
    t.onerror = () => reject(t.error);
  }));
}
export const writes = {
  // { total, by: { pages, covers, library, jobs, settings, app, other } } in bytes.
  get: () => _writesTx(() => null),
  async add(batch) {
    // The counter before this one counted downloaded and imported pages only, in localStorage.
    const legacy = _hasLS ? localStorage.getItem('shiori:totalWrittenBytes') : null;
    const total = await _writesTx((cur) => {
      const add = { ...batch };
      if (legacy != null) add.pages = (add.pages || 0) + (Number(JSON.parse(legacy)) || 0);
      for (const [kind, bytes] of Object.entries(add)) { cur.by[kind] = (cur.by[kind] || 0) + bytes; cur.total += bytes; }
      return cur;
    });
    if (legacy != null) localStorage.removeItem('shiori:totalWrittenBytes');
    _writesHub.publish(total);
  },
  async reset() { _writesHub.publish(await _writesTx(() => ({ key: WRITES_KEY, total: 0, by: {} }))); },
  subscribe(cb) { return _writesHub.subscribe(cb); },
};
meterWrites((batch) => writes.add(batch));

const _jobsHub = makeChannelHub('shiori-jobs');
// A progress row only paints a reopened page (live progress travels on the channel), so it is saved
// at most every few seconds; every other status is saved as it happens.
const PROGRESS_SAVE_EVERY = 5000;
const _progressSavedAt = new Map();   // job key → when its progress row was last saved
export const jobs = {
  // Ephemeral cross-context events share the live jobs channel but skip the durable registry.
  signal(event) { _jobsHub.publish(event); },
  async publish(job) {
    job = { ...job, at: Date.now() };
    const key = _jobKey(job);
    const progress = job.status === 'progress';
    const save = !progress || job.at - (_progressSavedAt.get(key) || 0) >= PROGRESS_SAVE_EVERY;
    if (progress && save) _progressSavedAt.set(key, job.at);
    else if (!progress) _progressSavedAt.delete(key);
    if (save) try {
      const db = await _jobsDb();
      await new Promise((res) => {
        const t = db.transaction('jobs', 'readwrite');
        const s = t.objectStore('jobs');
        // Success rows vanish at publish; error/cancelled rows are RETAINED (seen:false) so a
        // failure produced with no live listener is still visible on the next open — the UI
        // acknowledges (clears) them after painting, and the 24h purge reaps stragglers.
        if (job.status === 'done') s.delete(key);
        else if (job.status === 'error' || job.status === 'cancelled') s.put({ key, ...job, seen: false });
        else s.put({ key, ...job });
        t.oncomplete = res; t.onerror = res;
      });
    } catch {}
    _jobsHub.publish(job);
  },
  subscribe(cb) { return _jobsHub.subscribe(cb); },
  // Drop a registry row without broadcasting — for clearing orphaned rows whose runner died.
  async clear(gid, kind) {
    try {
      const db = await _jobsDb();
      await new Promise((res) => {
        const t = db.transaction('jobs', 'readwrite');
        t.objectStore('jobs').delete(_jobKey({ gid, kind }));
        t.oncomplete = res; t.onerror = res;
      });
    } catch {}
  },
  async current() {
    try {
      const db = await _jobsDb();
      const all = await new Promise((res) => {
        const q = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => res([]);
      });
      const live = [], dead = [];
      for (const j of all) ((Date.now() - (j.at || 0)) > STALE_PURGE_MS ? dead : live).push(j);
      if (dead.length) {
        const t = db.transaction('jobs', 'readwrite');
        for (const j of dead) t.objectStore('jobs').delete(j.key);
      }
      return live;
    } catch { return []; }
  },
};

// Wipe every durable job row (registry, resume list, reattach records) — the reset path.
// Without this, "clear everything" left job state behind that could repopulate the library.
export async function clearJobsData() {
  try {
    const db = await _jobsDb();
    await new Promise((res) => {
      const t = db.transaction(['jobs', 'pending', 'resume'], 'readwrite');
      for (const s of ['jobs', 'pending', 'resume']) t.objectStore(s).clear();
      t.oncomplete = res; t.onerror = res;
    });
  } catch {}
}

// SW resume list: jobs the service worker accepted, kept until they finish so an evicted worker
// can pick them up again on its next wake.
export const jobsPending = {
  async add(entry) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction('pending', 'readwrite');
        t.objectStore('pending').put(entry);
        t.oncomplete = () => resolve(true);
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      });
    } catch { return false; }
  },
  async remove(key) { try { const db = await _jobsDb(); await new Promise(r => { const t = db.transaction('pending', 'readwrite'); t.objectStore('pending').delete(key); t.oncomplete = r; t.onerror = r; }); } catch {} },
  async all() { try { const db = await _jobsDb(); return await new Promise(r => { const q = db.transaction('pending', 'readonly').objectStore('pending').getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([]); }); } catch { return []; } },
};

// Token-reattach records for in-flight translations: { gid, token, serverUrl, settings,
// pendingUrls, total, cursor, phase }. One per active gallery translation, claimed before upload
// and removed when it finishes. The
// server owns the job (keyed by token); this lets ANY page — after a navigation, or a service
// worker Chrome killed at its ~5-min cap — re-attach to the exact same job by token and resume
// streaming the pages it hasn't collected yet, instead of starting a wasteful fresh job.
// A job's poll position lives apart from its record (the job's settings, config and page list, often
// tens of KB): a poll then writes a few bytes, and nothing when the position didn't move.
function _withCursor(rec, pos) {
  if (rec && pos && pos.token === rec.token) rec.cursor = Math.max(Number(rec.cursor) || 0, Number(pos.cursor) || 0);
  return rec;
}

export const translateResume = {
  async set(rec) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction('resume', 'readwrite');
        t.objectStore('resume').put({ ...rec, gid: String(rec.gid) });
        t.oncomplete = () => resolve(true);
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      });
    } catch { return false; }
  },
  // Atomically reserve a gallery before its upload begins. This closes the cross-context gap
  // between "no job found" and the first durable write, so two tabs cannot create two tokens.
  async claim(rec) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction(['resume', 'cursors'], 'readwrite');
        const store = t.objectStore('resume');
        const gid = String(rec.gid);
        let result = 'error';
        const q = store.get(gid);
        q.onsuccess = () => {
          if (q.result) { result = 'exists'; return; }
          store.put({ ...rec, gid });
          t.objectStore('cursors').delete(gid);
          result = 'claimed';
        };
        t.oncomplete = () => resolve(result);
        t.onerror = () => resolve('error');
        t.onabort = () => resolve('error');
      });
    } catch { return 'error'; }
  },
  async get(gid) {
    try {
      const db = await _jobsDb();
      return await new Promise((r) => {
        const t = db.transaction(['resume', 'cursors'], 'readonly');
        const q = t.objectStore('resume').get(String(gid));
        const c = t.objectStore('cursors').get(String(gid));
        t.oncomplete = () => r(_withCursor(q.result || null, c.result));
        t.onerror = () => r(null);
      });
    } catch { return null; }
  },
  // Token-scoped writes ensure a late poll from an old job cannot resurrect, advance, or delete a
  // cancelled/replaced job for the same gallery.
  async patch(gid, token, values) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction('resume', 'readwrite');
        const store = t.objectStore('resume');
        let owned = false;
        const q = store.get(String(gid));
        q.onsuccess = () => {
          const cur = q.result;
          if (!cur || cur.token !== token) return;
          store.put({ ...cur, ...values, gid: String(gid), token });
          owned = true;
        };
        t.oncomplete = () => resolve(owned);
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      });
    } catch { return false; }
  },
  async advance(gid, token, cursor) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction(['resume', 'cursors'], 'readwrite');
        const positions = t.objectStore('cursors');
        let owned = false;
        const q = t.objectStore('resume').get(String(gid));
        const c = positions.get(String(gid));
        c.onsuccess = () => {
          const cur = _withCursor(q.result, c.result);
          if (!cur || cur.token !== token) return;
          owned = true;
          if ((Number(cursor) || 0) > (Number(cur.cursor) || 0)) positions.put({ gid: String(gid), token, cursor: Number(cursor) });
        };
        t.oncomplete = () => resolve(owned);
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      });
    } catch { return false; }
  },
  async remove(gid, token = null) {
    try {
      const db = await _jobsDb();
      return await new Promise((resolve) => {
        const t = db.transaction(['resume', 'cursors'], 'readwrite');
        const store = t.objectStore('resume');
        let removed = false;
        const q = store.get(String(gid));
        q.onsuccess = () => {
          const cur = q.result;
          if (!cur || (token != null && cur.token !== token)) return;
          store.delete(String(gid));
          t.objectStore('cursors').delete(String(gid));
          removed = true;
        };
        t.oncomplete = () => resolve(removed);
        t.onerror = () => resolve(false);
        t.onabort = () => resolve(false);
      });
    } catch { return false; }
  },
  async all() {
    try {
      const db = await _jobsDb();
      return await new Promise((r) => {
        const t = db.transaction(['resume', 'cursors'], 'readonly');
        const q = t.objectStore('resume').getAll();
        const c = t.objectStore('cursors').getAll();
        t.oncomplete = () => {
          const positions = new Map((c.result || []).map(p => [p.gid, p]));
          r((q.result || []).map(rec => _withCursor(rec, positions.get(rec.gid))));
        };
        t.onerror = () => r([]);
      });
    } catch { return []; }
  },
};

// ── In-tab services: request/response + push ────────────────────────────────────────────
// The UI asks services to do work (resize a cover, delete a gallery, import a zip…) and later
// receives pushes (COVER_READY, COVER_INVALIDATED). The page registers a handler via
// registerServices(); a service that produced a result pushes it back with emitControl().

let _services = null;
export function registerServices(handler) { _services = handler; }

// Ask services to do something; resolves with the response (or null).
export function rpc(msg) { return Promise.resolve(_services ? _services.handle(msg) : null); }

// Push from a service to the UI in this tab, merged with cross-tab control signals.
const _controlSubs = new Set();
export function emitControl(msg) { for (const cb of [..._controlSubs]) { try { cb(msg); } catch {} } }

// Subscribe to service pushes (COVER_READY, COVER_INVALIDATED, …). Returns an unsubscribe.
export function onControl(cb) {
  _controlSubs.add(cb);                 // same-tab pushes (e.g. a cover we just computed)
  const off = control.on((m) => cb(m)); // cross-context control (e.g. COVER_INVALIDATED from the agent)
  return () => { _controlSubs.delete(cb); off(); };
}
