// library-location.js — where this site keeps its library: in this browser (IndexedDB), or in the
// Shiori Desktop app on this computer, reached over its local server with the token it gave this
// site when the person allowed it. Kept in localStorage, so it is known synchronously when a page
// loads (api.js picks its backend then) and shared by every page of the site, the pages a helper
// embeds included. While the desktop app can't be reached the person may continue in this browser
// alone for a while ("fallback"); what is saved then stays in this browser until it is moved. A page
// the desktop app serves at its own address (desktopHosted) has no choice: its library is the app's.
//
// Also: finding the desktop app (it answers /api/ping on one of its ports), whether the browser lets
// this site reach it, and asking it to let this site use its library (/api/pair, which the desktop
// app confirms with the person).

const LOCATION_KEY = 'shiori:libraryLocation';
const FALLBACK_KEY = 'shiori:libraryFallback';
export const DESKTOP_PORTS = Array.from({ length: 10 }, (_, i) => 47153 + i);

function _read(key) {
  try { return JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null'); } catch { return null; }
}
function _write(key, value) {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {}
}

// { kind: 'desktop', url, token } when this site uses the desktop library, else null (this browser).
export function savedLocation() {
  const loc = _read(LOCATION_KEY);
  return loc?.kind === 'desktop' && typeof loc.url === 'string' && typeof loc.token === 'string' ? loc : null;
}
export function setLocation(loc) { _write(LOCATION_KEY, loc ? { kind: 'desktop', url: loc.url, token: loc.token } : null); }

// { since } while this site continues in this browser alone, else null.
export function fallback() { const f = _read(FALLBACK_KEY); return f && Number.isFinite(f.since) ? f : null; }
export function setFallback(on) { _write(FALLBACK_KEY, on ? { since: Date.now() } : null); }

// Whether this page is served by the desktop app at its own address — in the app's window, or
// opened in a browser. Such a page's library is the desktop app's, always: it never keeps one in
// the browser.
export function desktopHosted() {
  const loc = globalThis.location;
  return loc?.protocol === 'http:' && (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost')
    && DESKTOP_PORTS.includes(Number(loc.port));
}

// A page the desktop app serves at its own address, handed a site's library token in its address
// (`#library=…`) by whoever embeds it there: that site's library, reached at the page's own
// address. (A helper of the site that can't reach the desktop app from the site's own pages
// reaches it this way.)
export function servedLibrary() {
  if (!desktopHosted()) return null;
  const loc = globalThis.location;
  const token = new URLSearchParams(String(loc.hash || '').slice(1)).get('library');
  return token ? { url: loc.origin, token } : null;
}

// The desktop library this page uses now: the desktop app's own window says so itself, as does a
// page it serves (servedLibrary, or any other page at its address, which the app lets in without a
// token); a site that chose the desktop library uses it unless it is continuing in this browser for
// now.
export function activeDesktop() {
  if (globalThis.shioriDesktop?.url && globalThis.shioriDesktop?.token) return { ...globalThis.shioriDesktop, own: true };
  const served = servedLibrary();
  if (served) return { ...served, own: true };
  if (desktopHosted()) return { url: globalThis.location.origin, token: '', own: true };
  const loc = savedLocation();
  return loc && !fallback() ? loc : null;
}

// Whether the browser lets this site reach apps on this device, which some browsers ask the person
// first: 'granted', 'prompt' (it will ask), 'denied', or null where the browser has no such
// permission (and lets the site reach them).
export async function localAccess() {
  for (const name of ['loopback-network', 'local-network-access']) {
    try { return (await navigator.permissions.query({ name })).state; } catch {}
  }
  return null;
}

// Whether the desktop app answers at `url`.
export async function pingDesktop(url, { timeoutMs = 1500 } = {}) {
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/ping`, { signal: ctrl.signal, cache: 'no-store' });
    const body = res.ok ? await res.json() : null;
    return body?.app === 'shiori-desktop';
  } catch { return false; } finally { clearTimeout(timer); }
}

// The desktop app on this computer: its address, or null when none answers. `preferred` (an
// address that worked before) is tried first. While the browser is asking the person whether this
// site may reach apps on this device, the requests wait for the answer.
export async function findDesktop({ preferred = null, timeoutMs = 1500 } = {}) {
  if (await localAccess() === 'prompt') timeoutMs = Math.max(timeoutMs, 120000);
  const urls = [...new Set([preferred, ...DESKTOP_PORTS.map(p => `http://127.0.0.1:${p}`)].filter(Boolean))];
  const probe = async (url) => ((await pingDesktop(url, { timeoutMs })) ? url : null);
  if (preferred && await probe(preferred)) return preferred;
  const found = await Promise.all(urls.filter(u => u !== preferred).map(probe));
  return found.find(Boolean) || null;
}

// Ask the desktop app at `url` to let this site use its library. Resolves its token, or null when
// the person didn't allow it (or the app didn't answer in time).
export async function requestPairing(url, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/pair`, { method: 'POST', signal: ctrl.signal, cache: 'no-store' });
    const body = res.ok ? await res.json() : null;
    return typeof body?.token === 'string' ? body.token : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
