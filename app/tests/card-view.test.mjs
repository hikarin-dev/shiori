// card-view.test.mjs — what a library card shows of its gallery (src/lib/card-view.ts), held against
// 1.3's own code: _cardView and what it calls (cardTagChips, _sizeSplit, _sizeHtml, _pagesHtml,
// _makeOpenBtnInner), and the words 1.3's _paintCard, _syncCardActions and buildCard put on the card's
// buttons, copied verbatim below from app/js/library.js (as released: plans' tree-1.3 is the same) as
// the oracle. Over a table of galleries that reaches every branch, under each preference, language and
// site state, the two say the same: every word, tip, link and attribute, in the same order (the
// oracle's HTML read back as text and attributes). Twice: in English, and with each key's own name for
// its words (so a word taken from the wrong key shows).
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document ??= { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const i18n = await import('../js/i18n.js');
const fmt = await import('../js/format.js');
const titles = await import('../js/titles.js');
const series = await import('../js/series.js');
const model = await import('../js/gallery-model.js');
const sanitize = await import('../js/sanitize.js');
const tagEditor = await import('../js/tag-editor.js');
const { cardView, cardTags, LANG_FLAG } = await import('../../src/lib/card-view.ts');

// ── What 1.3's lines read from around them: set per case by `world` ──────────────────────────────────
let _mergeSeries = true, _bypassOverview = false, _seriesView = 'chapters', _hideAppLangFlag = true;
let _lang = 'en';
let t = i18n.t;
let SITES = {}, AVAILABLE = false, ICONS = {};
const _coverCache = new Map();
const getLang = () => _lang;
const formatCount = (n) => fmt.formatCount(n, 'en');
const formatBytes = (n) => fmt.formatBytes(n, 'en');
const formatMegapixels = (mp) => fmt.formatMegapixels(mp, 'en');
const { escHtml, safeExternalUrl } = sanitize;
const { pickTitle, pickSeriesTitle } = titles;
const { chapterTally } = series;
const { memberKind } = model;
const { LANG_TAG_NAME, langDisplayName } = tagEditor;
// sites.js's rules, over the site map and the helper's availability this case gives.
const _siteName = (source) => (SITES[source]?.name) || source || '';
const _canDownload = (g) => SITES[g?.source]?.canDownload === true && AVAILABLE;
function galleryLink(g, page = 1, displayId = null) {
  if (g?.sourceUrl) return g.sourceUrl;
  const tt = g?.source != null && SITES[g.source]?.galleryUrl;
  const id = displayId ?? (g?.sourceId || g?.id);
  return (tt && id) ? String(tt).replace('{id}', id).replace('{page}', page) : '';
}
// The icon cache's read (the request it also makes is the page's, not the card's).
const _siteFavicon = (source) => ICONS[source] || '';

// ── 1.3's code, verbatim (app/js/library.js at 0ae1f66) ─────────────────────────────────────────────
function coverCacheKey(galleryId, preferSeries) {
  return `${String(galleryId)}:${preferSeries ? 'series' : 'gallery'}`;
}

const _LANG_FLAG = {
  en: 'GB', ja: 'JP', zh: 'CN', 'zh-CN': 'CN', 'zh-TW': 'TW', ko: 'KR', de: 'DE', fr: 'FR',
  es: 'ES', ru: 'RU', pt: 'PT', 'pt-BR': 'BR', it: 'IT', vi: 'VN', id: 'ID', th: 'TH',
  nl: 'NL', pl: 'PL', uk: 'UA',
};
// The app language as a base code (zh-CN → zh) — the flag for a gallery in this language is hidden.
const _langBase = (code) => String(code || '').split('-')[0];

// A card's tag chips (the inside of its .card-tags row).
function cardTagChips(tags, languages) {
  const list = Array.isArray(tags) ? tags : [];
  const category = list.filter(t => t.type === 'category');
  const artists = list.filter(t => t.type === 'artist');
  const regular = list.filter(t => t.type === 'tag');
  const female  = list.filter(t => t.type === 'tag:female');
  const male    = list.filter(t => t.type === 'tag:male');
  const chips = [];
  // Language flags — leading chips, one per gallery language; a flag matching the app's current
  // language is omitted. Clickable like a tag (adds a language filter); tooltip shows the
  // language name in the app's language.
  const appBase = _langBase(getLang());
  for (const code of (Array.isArray(languages) ? languages : [])) {
    if (!_LANG_FLAG[code] || (_hideAppLangFlag && _langBase(code) === appBase)) continue;
    chips.push(`<span class="card-tag-flag" data-lang-code="${escHtml(code)}" data-lang-name="${escHtml(LANG_TAG_NAME[code] || code)}" data-tip="${escHtml(langDisplayName(code))}"><img class="flag-img" src="flags/${_LANG_FLAG[code]}.svg" alt="${escHtml(code)}" loading="lazy"></span>`);
  }
  chips.push(
    ...category.map(t => `<span class="card-tag category" data-type="category" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...artists.map(t => `<span class="card-tag artist" data-type="artist" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...regular.map(t => `<span class="card-tag" data-type="tag" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...female.map(t => `<span class="card-tag" data-type="tag:female" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♀</span>`),
    ...male.map(t => `<span class="card-tag" data-type="tag:male" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♂</span>`),
  );
  // Trailing '+' chip — opens the add-metadata modal (shown only while the card is hovered).
  chips.push(`<span class="card-tag card-tag-add" data-tip="${t('card.tip_addtag')}">+</span>`);
  return chips.join('');
}

// What a card shows of its gallery, part by part. buildCard lays a card out from it; updateCard
// compares a new one with the card's last and changes only the parts that differ.
function _cardView(g) {
  // A series owner renders (and acts) as a merged series card only while merging is on; unmerged,
  // it is shown as its own plain chapter-1 gallery. The real g.isSeries is kept for the delete path.
  const series = !!(_mergeSeries && g.isSeries);
  const thumbSrc = _coverCache.get(coverCacheKey(g.id, series)) || null;
  // A series card shows the whole-series aggregate (stored on the owner) and a chapter badge; a
  // standalone gallery shows its own page count. The size is what the gallery's export holds;
  // hovering it splits off the original pages.
  const totalCount = g.numPages ? ` / ${formatCount(g.numPages)}` : '';
  const size = series ? _sizeHtml(g.aggSize, g.aggOrig) : _sizeHtml(g.size, g.origSize);
  const metaLine = series
    ? `${_pagesHtml(`${formatCount(g.aggPages)} ${t('card.pages')}`, g.aggMedianPage, g.aggOrig, g.aggPages)} · ${size}`
    : `${_pagesHtml(`${formatCount(g.count)}${totalCount} ${t('card.pages')}`, g.medianPage, g.origSize, g.count)} · ${size}`;
  // A library kept as files says when a gallery's files can't be found in its folder.
  const missingHtml = g.missing ? ` · <span class="card-missing">${escHtml(t('card.files_missing'))}</span>` : '';
  // A series card counts what the overview lists — its chapters or its volumes (the view chosen
  // there), or the other kind when it has none of that one.
  const tally = series && g.chapters ? chapterTally(g.chapters) : { chapters: g.chapterCount, extras: 0 };
  const volumes = series && g.chapters ? g.chapters.filter(c => memberKind(c) === 'volume').length : 0;
  const countVolumes = volumes > 0 && (_seriesView === 'volumes' || !tally.chapters);
  const canDownload = _canDownload(g);
  const visitUrl = galleryLink(g, 1);
  const siteName = _siteName(g.source);
  const idText = escHtml(g.sourceId || g.id);
  const idClass = `card-id${g.isLocalImport ? ' local' : ''}`;
  const sourceHref = safeExternalUrl(g.sourceUrl);
  return {
    series,
    // Safe Mode blurs a cover unless the gallery is rated safe or suggestive — an unrated one blurs.
    sfw: (g.tags || []).some(tg => tg.type === 'rating' && (tg.name === 'safe' || tg.name === 'suggestive')),
    // Every gallery gets an overview landing page (a standalone one can gain chapters there); the
    // "skip overview" setting sends cards straight into the reader instead.
    href: _bypassOverview ? `../reader?g=${encodeURIComponent(g.id)}` : `../overview?g=${encodeURIComponent(g.id)}`,
    thumbSrc,
    hasThumb: series ? ((g.aggPages || g.count || 0) > 0 || !!thumbSrc) : (g.count > 0 || !!thumbSrc),
    badge: !series ? '' : countVolumes ? t('card.volumes_n', { n: formatCount(volumes) }) : t('card.chapters_n', { n: formatCount(tally.chapters) }),
    favorite: !!g.favorite,
    openTip: visitUrl ? `${siteName}: ${visitUrl}` : t('card.tip_setsource'),
    openShift: visitUrl ? t('card.tip_editsource') : null,
    // Alt+click searches the library for the gallery's source — only when it has one.
    openAlt: g.source ? t('card.tip_search_source', { site: siteName }) : null,
    openInner: _makeOpenBtnInner(g.source),
    id: sourceHref
      ? `<a class="${idClass}" href="${escHtml(sourceHref)}" target="_blank" rel="noopener noreferrer" data-original="${idText}">${idText}</a>`
      : `<div class="${idClass}" data-original="${idText}">${idText}</div>`,
    canDownload,
    dlTip: !canDownload ? t('card.tip_replace') : g.numPages ? t('card.tip_dl', { n: formatCount(g.numPages) }) : t('card.tip_dl_meta'),
    dlShift: canDownload ? t('card.tip_replace') : null,
    translated: !!g.translated,
    title: (series ? pickSeriesTitle(g.seriesTitle, g, getLang()) : pickTitle(g, getLang())) || '',
    meta: metaLine + missingHtml,
    tags: cardTagChips(g.tags, g.languages),
  };
}

// "Original pages X" over "Other data Y" — a size not yet recomputed is all original.
function _sizeSplit(total, original) {
  const orig = original ?? total ?? 0;
  return t('lib.size_split', { orig: formatBytes(orig), rest: formatBytes(Math.max(0, (total || 0) - orig)) });
}
const _sizeHtml = (total, original) => `<span class="card-size" data-tip="${escHtml(_sizeSplit(total, original))}">${formatBytes(total)}</span>`;
// Hovering the page count shows the typical page — its tier, size and megapixels — over the
// average original page's bytes. The first line waits until the pages have been measured.
function _pagesHtml(text, page, original, count) {
  if (!count) return text;
  const avg = t('card.tip_page_avg', { size: formatBytes((original || 0) / count) });
  const tip = page ? `${page.w}×${page.h}, ${formatMegapixels(page.mp)}\n${avg}` : avg;
  return `<span class="card-pages" data-tip="${escHtml(tip)}"${page ? ` data-tip-badge="${page.tier}"` : ''}>${text}</span>`;
}

// Site favicon on the open-source button. Source icons render only from Shiori's durable cache;
// until one is cached the slot shows the chain icon, swapped for the fetched copy when it lands.
function _makeOpenBtnInner(source) {
  const CHAIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  if (!source) return CHAIN_SVG;
  const icon = _siteFavicon(source);
  if (!icon) return `<span class="source-icon-slot" data-fav="${escHtml(source)}" style="width:12px;height:12px;display:inline-block;pointer-events:none;">${CHAIN_SVG}</span>`;
  return `<img src="${escHtml(icon)}" data-fav="${escHtml(source)}" alt="" decoding="async" style="width:12px;height:12px;pointer-events:none;">`;
}

// A translated gallery's translate button also offers "Re-run from…" on right-click.
const _translatedTip = () => `${t('card.tip_translate_new')} · ${t('card.tip_rerun')}`;

// The words on the buttons, as _paintCard (the heart), _syncCardActions (download, translate) and
// buildCard (export, delete) set them, line for line.
function buttonWords(v) {
  return {
    fav: { tip: t(v.favorite ? 'card.tip_fav_remove' : 'card.tip_fav_add'), alt: t(v.favorite ? 'card.tip_search_fav' : 'card.tip_search_unfav') },
    download: { tip: v.dlTip, shift: v.dlShift },
    translate: { tip: v.translated ? _translatedTip() : t('card.tip_translate'), shift: v.translated ? t('card.tip_revert') : null,
      alt: t(v.translated ? 'card.tip_search_translated' : 'card.tip_search_untranslated') },
    export: { tip: t('card.tip_export'), shift: t('card.tip_export_meta') },
    remove: { tip: t('card.tip_delete'), shift: t('card.tip_quickdelete') },
  };
}

// ── Reading the oracle's HTML back ───────────────────────────────────────────────────────────────────
const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot);/g, (m) => ENTITY[m]);
const VOID = new Set(['img', 'br']);
// A tree of { tag, attrs, children } and text strings, from the markup 1.3 builds (double-quoted
// attributes, no comments).
function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) { top.children.push(decode(m[5])); continue; }
    if (m[1]) { stack.pop(); continue; }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
    const node = { tag: m[2], attrs, children: [] };
    top.children.push(node);
    if (!m[4] && !VOID.has(m[2])) stack.push(node);
  }
  return root.children;
}
const text = (node) => (typeof node === 'string' ? node : node.children.map(text).join(''));

// The meta line: [{ part, text, tip?, badge? } | separator text], as the card lays it.
function metaOf(html) {
  return parse(html).map((n) => typeof n === 'string' ? { text: n }
    : { part: n.attrs.class, text: text(n), tip: n.attrs['data-tip'] ?? null, badge: n.attrs['data-tip-badge'] ?? null });
}
function metaFrom(v) {
  const out = [];
  out.push(v.pages.tip == null ? { text: v.pages.text } : { part: 'card-pages', text: v.pages.text, tip: v.pages.tip, badge: v.pages.badge });
  out.push({ text: ' · ' }, { part: 'card-size', text: v.size.text, tip: v.size.tip, badge: null });
  if (v.missing != null) out.push({ text: ' · ' }, { part: 'card-missing', text: v.missing, tip: null, badge: null });
  // Neighbouring texts read as one, as the markup does.
  return out.reduce((acc, p) => { const last = acc[acc.length - 1]; if (!p.part && last && !last.part) last.text += p.text; else acc.push({ ...p }); return acc; }, []);
}

// The tag chips, each as what it says and does.
function tagsOf(html) {
  return parse(html).map((n) => {
    if (n.attrs.class === 'card-tag-flag') {
      const img = n.children[0];
      return { kind: 'flag', code: n.attrs['data-lang-code'], name: n.attrs['data-lang-name'], tip: n.attrs['data-tip'], img: img.attrs.src, alt: img.attrs.alt };
    }
    if (n.attrs.class === 'card-tag card-tag-add') return { kind: 'add', tip: n.attrs['data-tip'], text: text(n) };
    return { kind: 'tag', class: n.attrs.class, type: n.attrs['data-type'], name: n.attrs['data-original'], text: text(n) };
  });
}
const TAG_CLASS = { category: 'card-tag category', artist: 'card-tag artist' };
function tagsFrom(v) {
  return v.tags.map((c) => c.kind === 'flag' ? { kind: 'flag', code: c.code, name: c.name, tip: c.tip, img: `flags/${c.flag}.svg`, alt: c.code }
    : c.kind === 'add' ? { kind: 'add', tip: c.tip, text: '+' }
    : { kind: 'tag', class: TAG_CLASS[c.type] ?? 'card-tag', type: c.type, name: c.name, text: c.text });
}

// The id: an element, its classes, its link, its words.
function idOf(html) {
  const [n] = parse(html);
  return { tag: n.tag, class: n.attrs.class, href: n.attrs.href ?? null, target: n.attrs.target ?? null, rel: n.attrs.rel ?? null, original: n.attrs['data-original'], text: text(n) };
}
function idFrom(v) {
  return { tag: v.idHref ? 'a' : 'div', class: `card-id${v.local ? ' local' : ''}`, href: v.idHref, target: v.idHref ? '_blank' : null, rel: v.idHref ? 'noopener noreferrer' : null, original: v.idText, text: v.idText };
}

// The open button's face.
function faceOf(html) {
  const [n] = parse(html);
  if (n.tag === 'svg') return { kind: 'chain' };
  if (n.tag === 'img') return { kind: 'icon', src: n.attrs.src, source: n.attrs['data-fav'] };
  assert.equal(n.children[0].tag, 'svg', 'a slot holds the chain');
  return { kind: 'slot', source: n.attrs['data-fav'] };
}

// Both sides' addresses as the browser follows them: 1.3's from its page (app/library.html), the
// port's from the site's root (the one page at /library).
const resolveOld = (href) => new URL(href, 'https://h/app/library.html').href;
const resolveNew = (href) => new URL(href, 'https://h/library').href;

// ── The table ────────────────────────────────────────────────────────────────────────────────────────
const tag = (type, name) => ({ type, name, url: '' });
const PAGE = { w: 600, h: 860, mp: 0.516, tier: 'T1' };
const BIG = { w: 1800, h: 2560, mp: 4.608, tier: 'T4' };
const SITE_ONE = { name: 'Site One', galleryUrl: 'https://a.example/g/{id}/{page}', canDownload: true };
const SITE_TWO = { name: 'Site Two', galleryUrl: '', canDownload: false };
const ICON = 'data:image/png;base64,iVBORw0KGgo=';
const base = (id, over = {}) => ({ id, count: 4, numPages: 4, size: 22424, origSize: 17108, aggPages: 4, aggSize: 22424, aggOrig: 17108, medianPage: PAGE, aggMedianPage: PAGE,
  title: { english: `Gallery ${id}`, japanese: '', pretty: '' }, tags: [], languages: [], source: '', sourceId: null, sourceUrl: '', isLocalImport: false,
  translated: false, favorite: false, chapters: null, parentId: null, seriesTitle: null, isSeries: false, chapterCount: 0, ...over });
const chapters = (...kinds) => kinds.map(([n, kind], i) => ({ id: String(900 + i), title: '', number: n, ...(kind ? { kind } : {}) }));
const seriesOf = (id, members, over = {}) => base(id, { isSeries: true, chapters: members, chapterCount: members?.length ?? 0, aggPages: 26, aggSize: 218082, aggOrig: 111572,
  seriesTitle: { english: 'Harbor Lights', japanese: '港の灯', pretty: '' }, title: { english: 'Harbor Lights Ch. 1', japanese: '', pretty: '' }, ...over });

const GALLERIES = [
  ['a plain gallery', base('1001')],
  ['a gallery with a cover', base('1002'), { cover: 'data:image/webp;base64,AAAA' }],
  ['an empty gallery that can be downloaded (no pages, a known count)', base('1003', { count: 0, size: 608, origSize: 0, medianPage: null, aggPages: 0, aggMedianPage: null, numPages: 18, source: 'one.example', sourceId: '48213' })],
  ['an empty gallery that cannot be downloaded', base('1004', { count: 0, size: 608, origSize: 0, numPages: 0, medianPage: null })],
  ['an empty gallery whose cover came from its source', base('1005', { count: 0, numPages: 0, size: 0, origSize: 0, source: 'one.example' }), { cover: 'data:image/webp;base64,BBBB' }],
  ['a local import', base('1006', { isLocalImport: true, numPages: 0 })],
  ['a gallery whose files are missing', base('1007', { missing: true })],
  ['a gallery of unknown size', base('1008', { size: 12000, origSize: undefined, medianPage: null })],
  ['pages whose typical page is not measured yet', base('1009', { medianPage: undefined })],
  ['a big typical page', base('1010', { medianPage: BIG, count: 24, numPages: 30 })],
  ['a series: chapters only, with extras', seriesOf('1011', chapters([1], [2], [3], [3.5], [0], [''], [4]))],
  ['a series: volumes only', seriesOf('1012', chapters([1, 'volume'], [2, 'volume']))],
  ['a series: chapters and volumes', seriesOf('1013', chapters([1], [2], [3], [1, 'volume'], [2, 'volume']))],
  ['a series with no chapter list', seriesOf('1014', null, { chapterCount: 5 })],
  ['a series whose owner has no pages, its others have', seriesOf('1015', chapters([1], [2]), { count: 0, aggPages: 12 })],
  ['a series with no pages at all', seriesOf('1016', chapters([1], [2]), { count: 0, aggPages: 0, aggMedianPage: null })],
  ['a series with no title of its own', seriesOf('1017', chapters([1], [2]), { seriesTitle: null })],
  ['a favourite', base('1018', { favorite: true })],
  ['a translated gallery', base('1019', { translated: true, languages: ['en'] })],
  ['every kind of tag', base('1020', { tags: [tag('tag', 'tag one'), tag('category', 'doujinshi'), tag('rating', 'erotica'), tag('artist', 'studio north'), tag('artist', 'ito'),
    tag('language', 'english'), tag('tag:female', 'glasses'), tag('tag:male', 'suit'), tag('parody', 'original'), tag('character', 'the librarian'), tag('group', 'night owls'),
    tag('tag', 'a "quoted" & <marked> tag'), tag('category', 'manga')] })],
  ['rated safe', base('1021', { tags: [tag('rating', 'safe')] })],
  ['rated suggestive', base('1022', { tags: [tag('rating', 'suggestive')] })],
  ['rated pornographic', base('1023', { tags: [tag('rating', 'pornographic')] })],
  ['no tag list at all', base('1024', { tags: undefined, languages: undefined })],
  ['flags: every language, known and not', base('1025', { languages: ['en', 'ja', 'zh', 'zh-CN', 'zh-TW', 'ko', 'pt', 'pt-BR', 'uk', 'xx', 'de'] })],
  ['a source with a safe link', base('1026', { source: 'one.example', sourceId: '48213', sourceUrl: 'https://one.example/g/48213?x="1"&y=2' })],
  ['a source with an unsafe link', base('1027', { source: 'one.example', sourceId: '48214', sourceUrl: 'javascript:alert(1)' })],
  ['a source link with credentials', base('1028', { source: 'one.example', sourceUrl: 'https://user:pw@one.example/g/1' })],
  ['a source known to the helper, no link of its own', base('1029', { source: 'one.example', sourceId: '77' })],
  ['a source the helper knows but cannot download from', base('1030', { source: 'two.example', sourceId: '78' })],
  ['a source the helper does not know', base('1031', { source: 'three.example', sourceId: '79' })],
  ['a source with an icon cached', base('1032', { source: 'one.example', sourceId: '80', sourceUrl: 'http://one.example/80' })],
  ['a title in two languages', base('1033', { title: { english: 'Translated Sample', japanese: '翻訳サンプル', pretty: 'Sample' } })],
  ['no title at all', base('1034', { title: { english: '', japanese: '', pretty: '' } })],
  ['an id with a source id', base('1035', { sourceId: '00123' })],
];

// The worlds each gallery is drawn in: the preferences, the app's language, the helper and its sites.
const WORLDS = [
  { name: 'defaults, no helper', mergeSeries: true, bypass: false, seriesView: 'chapters', hideFlag: true, lang: 'en', sites: { 'one.example': SITE_ONE, 'two.example': SITE_TWO }, available: false },
  { name: 'the helper there', mergeSeries: true, bypass: false, seriesView: 'chapters', hideFlag: true, lang: 'en', sites: { 'one.example': SITE_ONE, 'two.example': SITE_TWO }, available: true, icons: { 'one.example': ICON } },
  { name: 'volumes chosen, the reader first', mergeSeries: true, bypass: true, seriesView: 'volumes', hideFlag: true, lang: 'en', sites: {}, available: true },
  { name: 'series unmerged', mergeSeries: false, bypass: false, seriesView: 'volumes', hideFlag: true, lang: 'en', sites: { 'one.example': SITE_ONE }, available: true },
  { name: 'Japanese, every flag shown', mergeSeries: true, bypass: false, seriesView: 'chapters', hideFlag: false, lang: 'ja', sites: {}, available: false },
  { name: 'Japanese, its own flag hidden', mergeSeries: true, bypass: false, seriesView: 'chapters', hideFlag: true, lang: 'ja', sites: {}, available: false },
  { name: 'Chinese (traditional)', mergeSeries: true, bypass: false, seriesView: 'chapters', hideFlag: true, lang: 'zh-TW', sites: {}, available: false },
];

const keyNames = (key, vars) => (vars ? `${key}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(',')}}` : `{${key}}`);

function world(w, words) {
  _mergeSeries = w.mergeSeries; _bypassOverview = w.bypass; _seriesView = w.seriesView; _hideAppLangFlag = w.hideFlag; _lang = w.lang;
  SITES = w.sites; AVAILABLE = w.available; ICONS = w.icons || {};
  t = words;
  return {
    t: words, lang: w.lang, count: formatCount, bytes: formatBytes, megapixels: formatMegapixels,
    prefs: { mergeSeries: w.mergeSeries, bypassOverview: w.bypass, seriesView: w.seriesView, hideAppLangFlag: w.hideFlag },
    site: { canDownload: _canDownload, name: _siteName, link: galleryLink, icon: _siteFavicon },
    langName: langDisplayName,
    rules: { pickTitle, pickSeriesTitle, chapterTally, memberKind, safeExternalUrl, LANG_TAG_NAME },
  };
}

// Every part of the card, both ways, for one gallery in one world.
function compare(label, g, { cover = null } = {}, env) {
  _coverCache.clear();
  if (cover) { _coverCache.set(coverCacheKey(g.id, true), cover); _coverCache.set(coverCacheKey(g.id, false), cover); }
  const old = _cardView(g), v = cardView(g, cover, env), words = buttonWords(old);
  const at = (what) => `${label}: ${what}`;
  assert.equal(v.id, g.id, at('id'));
  assert.equal(v.series, old.series, at('drawn as a series'));
  assert.equal(v.sfw, old.sfw, at('rated safe'));
  assert.equal(resolveNew(v.href), resolveOld(old.href), at('where it leads'));
  assert.deepEqual(v.cover, { src: old.thumbSrc, expected: old.hasThumb }, at('the cover'));
  assert.equal(v.badge, old.badge, at('the badge'));
  assert.equal(v.favorite, old.favorite, at('the favourite mark'));
  assert.deepEqual(idFrom(v), idOf(old.id), at('the id'));
  assert.deepEqual([v.open.tip, v.open.shift, v.open.alt], [old.openTip, old.openShift, old.openAlt], at('the open button\'s tips'));
  assert.deepEqual(v.open.face, faceOf(old.openInner), at('the open button\'s face'));
  assert.equal(v.canDownload, old.canDownload, at('download or replace'));
  assert.equal(v.translated, old.translated, at('translated'));
  assert.equal(v.title, old.title, at('the title'));
  assert.deepEqual(metaFrom(v), metaOf(old.meta), at('the meta line'));
  assert.deepEqual(tagsFrom(v), tagsOf(old.tags), at('the tags'));
  assert.deepEqual(tagsFrom({ tags: cardTags(g.tags, g.languages, env) }), tagsOf(cardTagChips(g.tags, g.languages)), at('the tags on their own'));
  assert.deepEqual({ fav: v.fav, download: v.download, translate: v.translate, export: v.export, remove: v.remove }, words, at('the buttons\' words'));
}

for (const [wordsName, words] of [['English', i18n.t], ['each key by name', keyNames]]) {
  test(`every gallery of the table, in every world, says what 1.3's card says (${wordsName})`, () => {
    let n = 0;
    for (const w of WORLDS) {
      const env = world(w, words);
      for (const [name, g, opts] of GALLERIES) { compare(`${w.name} / ${name}`, g, opts, env); n++; }
    }
    assert.equal(n, WORLDS.length * GALLERIES.length);
  });
}

// Each branch the table is meant to reach, reached: so a gallery taken out of the table, or a world
// changed, can't leave one unheld without saying so.
test('the table reaches every branch', () => {
  const seen = new Set();
  for (const w of WORLDS) {
    const env = world(w, keyNames);
    for (const [, g, opts] of GALLERIES) {
      _coverCache.clear();
      const v = cardView(g, opts?.cover ?? null, env);
      if (v.series) seen.add('series'); else seen.add('gallery');
      if (g.isSeries && !v.series) seen.add('series unmerged');
      if (/volumes_n/.test(v.badge)) seen.add('volumes counted');
      if (/chapters_n/.test(v.badge)) seen.add('chapters counted');
      if (v.href.startsWith('reader')) seen.add('to the reader'); else seen.add('to the overview');
      if (!v.cover.expected) seen.add('no cover to wait for');
      if (v.cover.expected && !v.cover.src) seen.add('a cover to wait for');
      if (v.cover.src) seen.add('a cover');
      if (v.local) seen.add('local');
      if (v.idHref) seen.add('a safe link'); else if (g.sourceUrl) seen.add('an unsafe link');
      seen.add(`face ${v.open.face.kind}`);
      if (v.open.shift) seen.add('a link to edit');
      if (v.open.alt) seen.add('a source to search');
      if (v.canDownload) seen.add(g.numPages ? 'download' : 'download with its metadata'); else seen.add('replace');
      if (v.translated) seen.add('translated');
      if (v.favorite) seen.add('favourite');
      if (v.missing) seen.add('missing');
      if (v.pages.tip == null) seen.add('no pages: no tip');
      else seen.add(v.pages.badge ? 'a typical page' : 'no typical page yet');
      if (!v.title) seen.add('no title');
      if (v.sfw) seen.add('rated safe');
      for (const c of v.tags) seen.add(c.kind === 'tag' ? `tag ${c.type}` : c.kind);
      if ((g.languages || []).some((code) => LANG_FLAG[code] && !v.tags.some((c) => c.kind === 'flag' && c.code === code))) seen.add('a flag left out');
    }
  }
  const want = ['series', 'gallery', 'series unmerged', 'volumes counted', 'chapters counted', 'to the reader', 'to the overview', 'no cover to wait for', 'a cover to wait for',
    'a cover', 'local', 'a safe link', 'an unsafe link', 'face chain', 'face icon', 'face slot', 'a link to edit', 'a source to search', 'download', 'download with its metadata',
    'replace', 'translated', 'favourite', 'missing', 'no pages: no tip', 'a typical page', 'no typical page yet', 'no title', 'rated safe',
    'tag category', 'tag artist', 'tag tag', 'tag tag:female', 'tag tag:male', 'flag', 'add', 'a flag left out'];
  assert.deepEqual(want.filter((b) => !seen.has(b)), []);
});
