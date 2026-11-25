// tag-editor.js — the metadata tags the library and the overview edit (the editor itself is
// src/components/tag-editor.tsx): add a tag of any type to a gallery, or change the value of one it
// has, or remove it. A typed value suggests the tags already in the library, most used first; a type
// with a fixed vocabulary is picked from a list.

import * as store from './store.js';
import * as api from './api.js';
import { RATINGS } from './series.js';
import { getLang } from './i18n.js';

// Tag type → its label, in the order the editor lists the types.
export const TAG_TYPE_LABEL = {
  'tag': 'addtag.cat_tag', 'tag:female': 'addtag.cat_tagf', 'tag:male': 'addtag.cat_tagm',
  'artist': 'addtag.cat_artist', 'group': 'addtag.cat_group', 'parody': 'addtag.cat_parody',
  'character': 'addtag.cat_character', 'language': 'addtag.cat_language',
  'category': 'filter.category', 'rating': 'filter.rating',
};

// The fixed vocabularies — what the library filter offers. A gallery has at most one category and
// one rating: setting either replaces the one it had.
export const TAG_VALUES = {
  rating: RATINGS,
  category: ['manga', 'doujinshi', 'manhwa', 'manhua', 'novel', 'artist cg', 'game cg',
    'image set', 'cosplay', 'western', 'asian porn', 'anime', 'misc'],
};
const SINGLE = new Set(['category', 'rating']);

// Language code → the lowercase English name galleries are tagged with (what the flag derivation
// understands), for the language dropdown and a flag's search filter.
export const LANG_TAG_NAME = {
  en: 'english', ja: 'japanese', zh: 'chinese', 'zh-TW': 'chinese', ko: 'korean', de: 'german',
  fr: 'french', es: 'spanish', ru: 'russian', pt: 'portuguese', 'pt-BR': 'portuguese', it: 'italian',
  vi: 'vietnamese', id: 'indonesian', th: 'thai', nl: 'dutch', pl: 'polish', uk: 'ukrainian',
};
const LANG_DISPLAY = {
  en: 'English', ja: '日本語', zh: '中文（简体）', 'zh-CN': '中文（简体）', 'zh-TW': '中文（繁體）',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский', pt: 'Português',
  'pt-BR': 'Português (BR)', it: 'Italiano', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
  th: 'ไทย', nl: 'Nederlands', pl: 'Polski', uk: 'Українська',
};
// Language name shown in the app's current language (e.g. JP flag → "Japanese" in English).
let _dnInst = null, _dnLang = null;
export function langDisplayName(code) {
  const lang = getLang();
  try {
    if (_dnLang !== lang) { _dnInst = new Intl.DisplayNames([lang], { type: 'language' }); _dnLang = lang; }
    return _dnInst.of(code) || LANG_DISPLAY[code] || code;
  } catch { return LANG_DISPLAY[code] || code; }
}
// Languages a gallery can be tagged with, de-duplicated by name (zh / zh-TW both map to "chinese").
const LANG_OPTIONS = (() => {
  const seen = new Set(); const out = [];
  for (const [code, name] of Object.entries(LANG_TAG_NAME)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ code, name });
  }
  return out;
})();

// A tag's key in the tag counts (and the tagNames index).
export const tagKey = (type, name) => `${type}:${name}`.toLowerCase();

// A gallery's tag list is written where it lives: a series' combined tags, or a gallery's own.
export const tagPatchFor = (g, tags) => g?.isSeries ? { seriesTags: tags } : { tags };

// The tags one edited tag stands for: for a category or rating, every tag of that type (there is
// meant to be one); otherwise that exact tag.
const _standsFor = (tag) => (tg) => tg.type === tag.type && (SINGLE.has(tag.type) || tg.name === tag.name);

// Re-read the gallery and store edit(tags) as its tag list, unless that changes nothing. Returns
// whether it wrote.
async function updateTags(gid, edit, beforeWrite) {
  const g = await api.galleries.get(gid);
  if (!g) return false;
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const next = edit(tags);
  if (JSON.stringify(next) === JSON.stringify(tags)) return false;
  beforeWrite?.();
  await store.mutate(gid, tagPatchFor(g, next));
  return true;
}

// Remove a tag from a gallery (for a category or rating, the gallery's one of that type).
export function removeTag(gid, tag, { beforeWrite } = {}) {
  return updateTags(gid, (tags) => tags.filter((tg) => !_standsFor(tag)(tg)), beforeWrite);
}

// ── What an editor of tags asks (src/components/tag-editor.tsx draws it) ──
const SUGGEST_MAX = 8;

// The values a type is picked from, or null when its value is typed.
export function tagChoices(type) {
  if (type === 'language') return LANG_OPTIONS.map((o) => ({ value: o.name, label: langDisplayName(o.code) }));
  if (TAG_VALUES[type]) return TAG_VALUES[type].map((v) => ({ value: v, label: v }));
  return null;
}
// The value a gallery whose tags are `have` has for a category or rating.
export const singleValue = (type, have) => (SINGLE.has(type) && have.find((tg) => tg.type === type)?.name) || '';

// The library's tags of one type, most used first: [{ name, n }].
export async function tagSuggestions(type) {
  const prefix = `${type}:`;
  const all = [];
  for (const [key, n] of await api.galleries.tagCounts({ prefix })) {
    const name = key.slice(prefix.length);
    if (type === 'tag' && /^(fe)?male:/.test(name)) continue;   // female/male tags share the prefix
    all.push({ name, n });
  }
  return all.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

// The suggestions for what's typed (`term`) out of `all` (tagSuggestions' of `type`): names starting
// with it, then names containing it, leaving out the tags of that type the gallery has (`have`).
export function suggestionsFor(all, term, have, type) {
  term = term.trim().toLowerCase();
  const had = new Set(have.filter((tg) => tg.type === type).map((tg) => String(tg.name).toLowerCase()));
  const starts = [], within = [];
  for (const s of all) {
    if (had.has(s.name) || s.name === term) continue;
    if (s.name.startsWith(term)) starts.push(s);
    else if (s.name.includes(term)) within.push(s);
  }
  return [...starts, ...within].slice(0, SUGGEST_MAX);
}

// Give the gallery `gid` the tag `type`:`name` (already trimmed and lower-cased), or set the value of
// the tag `edit` it has. Resolves with whether its tags changed.
export function writeTag(gid, type, name, { edit = null, beforeWrite = null } = {}) {
  // What the new value replaces: the edited tag, or the category / rating the gallery had.
  const replaced = edit ? _standsFor(edit) : SINGLE.has(type) ? (tg) => tg.type === type : () => false;
  const same = (tg) => tg.type === type && String(tg.name).toLowerCase() === name;
  return updateTags(gid, (tags) => {
    const out = [];
    // Already there under another tag: the replaced ones just go.
    let placed = tags.some((tg) => same(tg) && !replaced(tg));
    for (const tg of tags) {
      if (!replaced(tg)) { out.push(tg); continue; }
      if (!placed) { out.push(same(tg) ? tg : { type, name, url: '' }); placed = true; }
    }
    if (!placed) out.push({ type, name, url: '' });
    return out;
  }, beforeWrite);
}
