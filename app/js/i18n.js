// i18n.js — lightweight UI internationalization for the app.
//
// The active language lives in localStorage ('shiori-lang') so it is readable synchronously at
// boot (no flash, no async round-trip) and shared across same-origin tabs. Pages mark static
// text with data-i18n* attributes; dynamic strings call t(key, vars). applyTranslations() walks
// a root and fills everything in. A 'storage' listener keeps other open tabs in sync.
//
// Each language's words are a module of their own (locales/<code>.js). A page holds English (the
// fallback) and the language it shows: this module waits for that language's words before it is done,
// so whatever imports it runs with them there, and t() is never asked before they have come. Another
// language's words are fetched when it is chosen (setLang), here or in another tab, and the page
// changes to it once they have come.

import en from './locales/en.js';
import { SUPPORTED, LANG_NAMES, pickLanguage } from './languages.js';

export { SUPPORTED, LANG_NAMES };

// The words of each language this page has loaded.
const _words = { en };
const _load = (lang) => (_words[lang] ? Promise.resolve(_words[lang])
  : import(/* @vite-ignore */ `./locales/${lang}.js`).then((m) => (_words[lang] = m.default)));

let _lang = pickLanguage(localStorage.getItem('shiori-lang'), navigator.languages || [navigator.language || 'en']);
// (Words that can't be had, which the page's own files are, leave it in English.)
if (_lang !== 'en') { try { await _load(_lang); } catch { _lang = 'en'; } }
// The page says its language (figures are written in it: format.js; a browser picks letter shapes and
// breaks words by it), from its start. (1.3's pages each filled their own markup as they started,
// which set it; the one page fills none, and said "en" in every language until one was changed.)
if (typeof document !== 'undefined') document.documentElement.lang = _lang;   // (a test may load this with no page)

export function getLang() { return _lang; }

// Translate a key. Falls back to English, then to the raw key. {placeholders} are filled from vars.
export function t(key, vars) {
  const dict = _words[_lang] || en;
  let s = (dict && dict[key] != null) ? dict[key] : (en[key] != null ? en[key] : key);
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// Fill every translatable node under `root`.
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  // A field without a placeholder of its own (an editable box) shows data-placeholder through CSS.
  root.querySelectorAll('[data-i18n-ph]').forEach(el => {
    if ('placeholder' in el) el.placeholder = t(el.dataset.i18nPh);
    else el.dataset.placeholder = t(el.dataset.i18nPh);
  });
  root.querySelectorAll('[data-i18n-tip]').forEach(el => { el.dataset.tip = t(el.dataset.i18nTip); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.documentElement.lang = _lang;
}

// The page changes to `lang` once its words are here (at once when they are already), the last asked
// for winning. Resolves when it has; rejects, the language left as it was, when they can't be had.
let _asked = 0;
async function _change(lang, keep) {
  const asked = ++_asked;
  await _load(lang);
  if (asked !== _asked) return;
  _lang = lang;
  if (keep) localStorage.setItem('shiori-lang', lang);
  applyTranslations(document);
  window.dispatchEvent(new CustomEvent('shiori-lang-change', { detail: lang }));
}

export function setLang(lang) {
  return _change(SUPPORTED.includes(lang) ? lang : 'en', true);
}

// Keep other open tabs in sync when the language is changed elsewhere.
window.addEventListener('storage', (e) => {
  if (e.key === 'shiori-lang' && e.newValue && e.newValue !== _lang) {
    _change(SUPPORTED.includes(e.newValue) ? e.newValue : 'en', false).catch(() => {});
  }
});
