// Shared formatting for user-facing counts and byte sizes.

function activeLocale() {
  return document.documentElement.lang || navigator.language || 'en';
}

// One formatter per locale and style: making one costs far more than formatting with it, and the
// reader's page counter formats on every frame the page moves (a library page, on every card).
const _formats = new Map();
function _format(locale, style, options) {
  const key = `${locale}|${style}`;
  let format = _formats.get(key);
  if (!format) _formats.set(key, format = new Intl.NumberFormat(locale, options));
  return format;
}

export function formatCount(value, locale = activeLocale()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? 0);
  return _format(locale, 'count', { maximumFractionDigits: 0 }).format(number);
}

// A count in its short form: 999, 1.2K, 53.2K.
export function formatCompact(value, locale = activeLocale()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? 0);
  return _format(locale, 'compact', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}

export function formatMegapixels(mp, locale = activeLocale()) {
  return `${_format(locale, 'mp', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(mp)} MP`;
}

export function formatBytes(bytes, locale = activeLocale()) {
  let value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = _format(locale, unit === 0 ? 'bytes0' : 'bytes1', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
  return `${number}${units[unit]}`;
}
