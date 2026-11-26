// languages.js — the languages the app's words are in (app/js/locales/<code>.js), their names, and
// which one a page shows: plain data and a pure rule, read by i18n.js and by the build (the one page's
// first script, start.js, picks the same way before anything runs, to ask for that language's words
// with the rest of the page; a test holds the two rules to each other).

export const SUPPORTED = ['en', 'ja', 'de', 'fr', 'zh-CN', 'zh-TW', 'ko', 'es', 'pt-BR', 'ru', 'vi', 'id'];
export const LANG_NAMES = {
  en: 'English', ja: '日本語', de: 'Deutsch', fr: 'Français', 'zh-CN': '简体中文',
  'zh-TW': '繁體中文', ko: '한국어', es: 'Español', 'pt-BR': 'Português (BR)',
  ru: 'Русский', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
};

// The browser's languages (most preferred first) as the app has them: an exact code, any Chinese as
// Simplified, or a language's first two letters; English otherwise.
function detect(languages) {
  for (const raw of languages) {
    const l = String(raw);
    if (SUPPORTED.includes(l)) return l;
    if (/^zh\b/i.test(l)) return 'zh-CN';
    const base = l.slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(base)) return base;
  }
  return 'en';
}

// The language a page shows: the one chosen (`stored`, localStorage 'shiori-lang'), or with none chosen
// the browser's; a choice the app does not have is English.
export function pickLanguage(stored, languages) {
  const lang = stored || detect(languages);
  return SUPPORTED.includes(lang) ? lang : 'en';
}
