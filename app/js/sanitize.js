// sanitize.js — shared escaping/validation for record-derived values. Imported records
// (backups, archives, bridge payloads) are untrusted input: identity gets a format gate at
// every import boundary, HTML interpolation goes through escHtml, and outbound links through
// safeExternalUrl. One implementation so no surface drifts.

// HTML-escape for template-literal interpolation (text nodes and double-quoted attributes).
/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** @param {unknown} s @returns {string} */
export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => HTML_ESCAPES[c]);
}

// The app's own id convention: internal ids are Date.now() timestamps, source ids shorter
// numbers — digits only, bounded length. Imported ids must pass this gate before storage,
// because ids end up in DOM ids, data attributes and hrefs on every surface.
/** @param {unknown} id @returns {boolean} */
export function isValidGalleryId(id) {
  return /^\d{1,19}$/.test(String(id ?? ''));
}

// Allow only credential-free http(s) URLs for record-derived links (a stored javascript: URL
// would execute on click). Returns the normalized href, or null when the value must not become
// a link or window.open target.
/** @param {unknown} u @returns {string | null} */
export function safeExternalUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}
