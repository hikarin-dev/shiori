// sites.js — the runtime source-site map + helper availability, shared by every page.
// The app is site-agnostic: what sites exist, whether they support downloads, and how their
// gallery links look is runtime knowledge handed over by an external helper (EXT_SITES);
// nothing here is hard-coded. Without a helper the app still links to whatever exact
// sourceUrl a gallery carries and simply never offers downloads.
//
// Availability is seeded from the last confirmed probe (the localStorage warm start) so the
// very first render already shows the right download/upload affordances — without this every
// load flickered upload→download once the bridge (injected at document_idle, so always after
// first paint) finally answered. Do not regress this (ARCHITECTURE.md §5).

import { request as extRequest, available as probeAvailable } from './ext-bridge.js';

let _siteMap = {};
let _available = false;
let _sitesRefreshed = false;   // EXT_SITES re-fetched once per page life
const _loadAt = Date.now();
const _subs = new Set();

try {
  const s = JSON.parse(localStorage.getItem('shiori-ext-status') || 'null');
  if (s) { _available = !!s.available; _siteMap = s.sites || {}; }
} catch {}

export const siteMap = () => _siteMap;
export const helperAvailable = () => _available;
export const siteName = (source) => (_siteMap[source]?.name) || source || '';

// Downloading (and source-site metadata) needs the helper. When its bridge isn't answering,
// the download action is not offered at all — the button falls back to its upload/replace
// role, exactly like a gallery from a non-downloadable source.
export const canDownload = (g) => _siteMap[g?.source]?.canDownload === true && _available;

// The visit link for a gallery: the exact URL it was registered with, or the site's link
// template (runtime data) filled with its source id. `displayId` overrides the id used in the
// template (the reader shows chapters under their own source ids).
export function galleryLink(g, page = 1, displayId = null) {
  if (g?.sourceUrl) return g.sourceUrl;
  const t = g?.source != null && _siteMap[g.source]?.galleryUrl;
  const id = displayId ?? (g?.sourceId || g?.id);
  return (t && id) ? String(t).replace('{id}', id).replace('{page}', page) : '';
}

// Subscribe to availability/site-map changes (fires only on a real change). Returns unsubscribe.
export function onSitesChanged(cb) { _subs.add(cb); return () => _subs.delete(cb); }

// Probe the bridge and refresh the site map (once per page life). An early failed probe is
// inconclusive: the bridge injects at document_idle, so right after load "no answer" usually
// means "not ready yet", not "not installed" — keep the cached optimistic state until a probe
// past the grace window confirms it's really gone. Returns true when state actually changed.
export async function updateSitesStatus() {
  const ok = await probeAvailable();
  if (!ok && _available && Date.now() - _loadAt < 6000) return false;
  let sitesChanged = false;
  if (ok && !_sitesRefreshed) {
    const r = await extRequest({ type: 'EXT_SITES' });
    if (r && r.sites) {
      _sitesRefreshed = true;
      sitesChanged = JSON.stringify(r.sites) !== JSON.stringify(_siteMap);
      _siteMap = r.sites;
    }
  }
  if (ok === _available && !sitesChanged) return false;
  _available = ok;
  try { localStorage.setItem('shiori-ext-status', JSON.stringify({ available: ok, sites: _siteMap })); } catch {}
  document.body?.classList.toggle('helper-offline', !ok);
  for (const cb of [..._subs]) { try { cb({ available: ok, sites: _siteMap }); } catch {} }
  return true;
}
