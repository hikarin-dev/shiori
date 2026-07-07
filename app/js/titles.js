// titles.js — gallery title format.
//
// The canonical shape is a single object:
//   title: { english, japanese, pretty }
// Legacy records carried flat titleEnglish / titleJapanese / titlePretty fields; this module
// migrates them (the source metadata is the authority for the raw strings) and picks the
// variant to display for the app's current language.

// App language code → the title key to prefer. Sources only ever supply english/japanese, so
// any other UI language falls back to english.
const _LANG_TITLE_KEY = { en: 'english', ja: 'japanese' };

// Build the canonical { english, japanese, pretty } object from any metadata record, whether it
// already carries the new `title` object or the legacy flat fields.
export function normalizeTitle(meta) {
  const m = meta || {};
  const t = m.title;
  if (t && typeof t === 'object') {
    return { english: t.english || '', japanese: t.japanese || '', pretty: t.pretty || '' };
  }
  const sm = m.sourceMetadata || {};
  return {
    english:  m.titleEnglish  || sm.title          || '',
    japanese: m.titleJapanese || sm.japanese_title || '',
    pretty:   m.titlePretty   || '',
  };
}

// A copy of the record in canonical form: `title` object set, legacy flat fields removed, and
// `galleryId` + `title` re-emitted as the leading keys so the record (and its JSON export) reads
// top-down. Idempotent — a record that is already canonical is returned essentially unchanged.
export function migrateTitle(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const title = normalizeTitle(meta);
  const { titleEnglish, titleJapanese, titlePretty, title: _oldTitle, galleryId, ...rest } = meta;
  return galleryId !== undefined ? { galleryId, title, ...rest } : { title, ...rest };
}

// The display title for a language code: the language-specific variant if present, else english,
// else the simplified `pretty` title. `pretty` is never auto-selected by language.
export function pickTitle(meta, langCode) {
  const tt = normalizeTitle(meta);
  const base = String(langCode || '').split('-')[0];
  const key = _LANG_TITLE_KEY[base] || _LANG_TITLE_KEY[langCode] || 'english';
  return tt[key] || tt.english || tt.pretty || '';
}

// A series title is stored as the same { english, japanese, pretty } object as a gallery title so
// it carries every source language. Coerce whatever is stored (object, legacy string, or empty)
// into that object shape; returns null when there's nothing set.
export function seriesTitleObject(st) {
  if (st && typeof st === 'object') return { english: st.english || '', japanese: st.japanese || '', pretty: st.pretty || '' };
  if (typeof st === 'string' && st) return { english: st, japanese: '', pretty: st };
  return null;
}

// The display title for a series: its own multi-language seriesTitle picked for the app language
// (fallback English → pretty), or the owner gallery's title when no series title is set.
export function pickSeriesTitle(seriesTitle, fallbackMeta, langCode) {
  const st = seriesTitleObject(seriesTitle);
  if (st) { const v = pickTitle({ title: st }, langCode); if (v) return v; }
  return pickTitle(fallbackMeta, langCode);
}

// Which title key the given app language edits: Japanese UI edits `japanese`, everything else
// edits `english` (the default fallback). Mirrors pickTitle's language→key mapping.
export function editKeyForLang(langCode) {
  return String(langCode || '').split('-')[0] === 'ja' ? 'japanese' : 'english';
}
