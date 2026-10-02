// gallery-model.js — facts about a gallery's metadata that need no library to work out, shared by
// the library backends and the surfaces that render galleries.

// A gallery is a series when its metadata owns two or more chapters.
export function isSeriesMeta(meta) {
  return Array.isArray(meta?.chapters) && meta.chapters.length > 1;
}

// A series holds two kinds of member, each listed apart: chapters, and volumes (a release of its own
// that collects a run of chapters). A member's kind is on its entry in the series' list; a gallery's
// own `kind` says which it is when it joins a series. Anything not a volume is a chapter.
export const memberKind = (entry) => (entry?.kind === 'volume' ? 'volume' : 'chapter');

// The tag list a series exposes (its rollup) vs. a plain gallery's own tags — the single
// definition every surface should consume.
export function effectiveTagsOf(meta) {
  return isSeriesMeta(meta) && Array.isArray(meta.seriesTags) ? meta.seriesTags : meta?.tags;
}

// Source language names → ISO-ish codes used for the card language flag. Covers every language
// the translator can output to, plus the common source language names.
export const LANG_NAME_TO_CODE = {
  english: 'en', japanese: 'ja', chinese: 'zh', 'chinese (simplified)': 'zh',
  'chinese (traditional)': 'zh-TW', korean: 'ko', german: 'de', french: 'fr',
  spanish: 'es', russian: 'ru', portuguese: 'pt', 'portuguese (brazil)': 'pt-BR',
  italian: 'it', vietnamese: 'vi', indonesian: 'id', thai: 'th', dutch: 'nl',
  polish: 'pl', ukrainian: 'uk',
};

// A published date is kept in Unix seconds, as sources send it. One given in milliseconds (past
// 1e12 — the year 33658 in seconds) is read as such.
export function uploadDateSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1e12 ? Math.floor(n / 1000) : value;
}

// What the library works out for itself and keeps on a gallery's stat record: page count and sizes,
// sort times, the cover page, series totals, the typical page and the page-size tally. Never written through a metadata
// change; everything else a change names is metadata, kept as given.
export const DERIVED_FIELDS = new Set([
  'count', 'size', 'origSize', 'latestAt', 'addedAt', 'coverPage',
  'chapterCount', 'aggPages', 'aggSize', 'aggOrig', 'medianPage', 'pageSizes', 'aggMedianPage',
]);
