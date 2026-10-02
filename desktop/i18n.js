// i18n.js — the desktop app's menus and dialogs in the app's language. The strings are the app's
// own (app/js/locales.js, keys `desk.*`); the language is the one the app's window uses — or, before
// a window has said, the one it used last time, or the system's, picked as the app picks it.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UI_DIR } from './server/shared.js';

const { LOCALES } = await import(pathToFileURL(path.join(UI_DIR, 'js', 'locales.js')).href);

export const isLanguage = (lang) => Object.hasOwn(LOCALES, lang);

// The first of `candidates` (language tags, most preferred first) the app has (app/js/i18n.js).
export function pickLanguage(candidates = []) {
  for (const raw of candidates) {
    const tag = String(raw);
    if (isLanguage(tag)) return tag;
    if (/^zh\b/i.test(tag)) return 'zh-CN';
    const base = tag.slice(0, 2).toLowerCase();
    if (isLanguage(base)) return base;
  }
  return 'en';
}

// t(key, vars) for `lang`: the desktop string `desk.<key>`, English when a language lacks it,
// {placeholders} filled from vars.
export function translator(lang) {
  const table = LOCALES[lang] || LOCALES.en;
  return (key, vars) => {
    let s = table[`desk.${key}`] ?? LOCALES.en[`desk.${key}`] ?? key;
    if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
    return s;
  };
}
