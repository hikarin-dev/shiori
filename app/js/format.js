// Shared formatting for user-facing counts and byte sizes.

function activeLocale() {
  return document.documentElement.lang || navigator.language || 'en';
}

export function formatCount(value, locale = activeLocale()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? 0);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(number);
}

export function formatBytes(bytes, locale = activeLocale()) {
  let value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number}${units[unit]}`;
}
