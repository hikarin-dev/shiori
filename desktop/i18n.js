// i18n.js — the desktop app's menus and dialogs in the app's language. The strings are the app's
// own (app/js/locales.js, every language's words, keys `desk.*`); the language is the one the app's
// window uses — or, before a window has said, the one it used last time, or the system's, picked by
// the app's own rule (app/js/languages.js).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UI_DIR } from './server/shared.js';

const load = (name) => import(pathToFileURL(path.join(UI_DIR, 'js', name)).href);
const [{ LOCALES }, languages] = await Promise.all([load('locales.js'), load('languages.js')]);

export const isLanguage = (lang) => languages.SUPPORTED.includes(lang);

// The first of `candidates` (language tags, most preferred first) the app has, as a page with no
// language chosen picks it.
export const pickLanguage = (candidates = []) => languages.pickLanguage(null, candidates);

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
