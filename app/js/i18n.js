// i18n.js — lightweight UI internationalization for the app.
//
// The active language lives in localStorage ('shiori-lang') so it is readable synchronously at
// boot (no flash, no async round-trip) and shared across same-origin tabs. Pages mark static
// text with data-i18n* attributes; dynamic strings call t(key, vars). applyTranslations() walks
// a root and fills everything in. A 'storage' listener keeps other open tabs in sync.

import { LOCALES } from './locales.js';

export const SUPPORTED = ['en', 'ja', 'de', 'fr', 'zh-CN', 'zh-TW', 'ko', 'es', 'pt-BR', 'ru', 'vi', 'id'];
export const LANG_NAMES = {
  en: 'English', ja: '日本語', de: 'Deutsch', fr: 'Français', 'zh-CN': '简体中文',
  'zh-TW': '繁體中文', ko: '한국어', es: 'Español', 'pt-BR': 'Português (BR)',
  ru: 'Русский', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
};

function _detect() {
  const navs = navigator.languages || [navigator.language || 'en'];
  for (const raw of navs) {
    const l = String(raw);
    if (SUPPORTED.includes(l)) return l;
    if (/^zh\b/i.test(l)) return 'zh-CN';
    const base = l.slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(base)) return base;
  }
  return 'en';
}

let _lang = localStorage.getItem('shiori-lang') || _detect();
if (!SUPPORTED.includes(_lang)) _lang = 'en';

export function getLang() { return _lang; }

// Translate a key. Falls back to English, then to the raw key. {placeholders} are filled from vars.
export function t(key, vars) {
  const dict = LOCALES[_lang] || LOCALES.en;
  let s = (dict && dict[key] != null) ? dict[key] : (LOCALES.en[key] != null ? LOCALES.en[key] : key);
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// Fill every translatable node under `root`.
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-tip]').forEach(el => { el.dataset.tip = t(el.dataset.i18nTip); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.documentElement.lang = _lang;
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = 'en';
  _lang = lang;
  localStorage.setItem('shiori-lang', lang);
  applyTranslations(document);
  window.dispatchEvent(new CustomEvent('shiori-lang-change', { detail: lang }));
}

// Keep other open tabs in sync when the language is changed elsewhere.
window.addEventListener('storage', (e) => {
  if (e.key === 'shiori-lang' && e.newValue && e.newValue !== _lang) {
    _lang = SUPPORTED.includes(e.newValue) ? e.newValue : 'en';
    applyTranslations(document);
    window.dispatchEvent(new CustomEvent('shiori-lang-change', { detail: _lang }));
  }
});
