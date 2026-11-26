// locales.js — UI strings for every supported language, one file a language (locales/<lang>.js), each
// holding every key. English is the canonical key set; t() falls back to English for any key a
// translation is missing. Technical proper nouns (translator/detector/model identifiers in the
// advanced translator modal) are intentionally left in English inside the markup and are not keyed
// here.
//
// Placeholders: {n} count, {id} gallery id, {size} formatted size, {site} site name,
// {url} link, {name} tag name, {label} category, {msg} error, {g}/{i} gallery/image counts,
// {done}/{total} progress.
//
// Every language at once, by its code.
import en from './locales/en.js';
import ja from './locales/ja.js';
import de from './locales/de.js';
import fr from './locales/fr.js';
import zhCN from './locales/zh-CN.js';
import ko from './locales/ko.js';
import zhTW from './locales/zh-TW.js';
import es from './locales/es.js';
import ptBR from './locales/pt-BR.js';
import ru from './locales/ru.js';
import vi from './locales/vi.js';
import id from './locales/id.js';

export const LOCALES = { en, ja, de, fr, 'zh-CN': zhCN, ko, 'zh-TW': zhTW, es, 'pt-BR': ptBR, ru, vi, id };
