// gallery-export.js — a gallery (or series) exported as an archive: its files in the Shiori gallery
// format (storage/gallery-files.js, which lays them out), read for the archive, with ComicInfo.xml
// for a CBZ (comicInfoXml) and, if asked, without the translations (withoutTranslations), and the
// archive's exact size (exportSize: also what the library counts as a gallery's size).

import { pickTitle, pickSeriesTitle } from './titles.js';
import { LANG_NAME_TO_CODE } from './gallery-model.js';
import { galleryFiles, galleryName, seriesName, seriesManifest, sourceBytes } from './storage/gallery-files.js';

// Page records as the library returns them carry their page number.
const _pageNum = (rec) => rec.pageNum ?? 9999;

// A file's bytes, read for the archive.
export async function fileBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
  const bin = atob(String(src).split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Page records without what was made from the pages — translations, study layers, pipeline data
// and masks — for an export that holds the original pages only.
const TRANSLATION_FIELDS = ['translated', 'translatedLayers', 'bubbles', 'studyBg', 'studyPage', 'pipeline', 'own'];
function withoutTranslations(records) {
  return (records || []).map((rec) => {
    const out = { ...rec };
    for (const key of TRANSLATION_FIELDS) delete out[key];
    return out;
  });
}

// Ratings (series-plan.js RATINGS) as ComicInfo's age ratings.
const AGE_RATING = { safe: 'Everyone', suggestive: 'Teen', erotica: 'Mature 17+', pornographic: 'Adults Only 18+' };
const _xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ComicInfo.xml for a CBZ export: the details other comic readers show. `meta` is the exported
// gallery's; `owner` the series it belongs to (its member entry gives the number and title);
// `series` when the export is a whole series (meta is then the series owner's); `pageCount` the
// original pages the archive holds.
export function comicInfoXml(meta, { owner = null, series = false, pageCount } = {}) {
  const m = meta || {};
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const named = (type) => tags.filter(t => t.type === type).map(t => t.name);
  const ref = !series && owner ? owner.chapters?.find(c => String(c.id) === String(m.galleryId)) : null;
  const seriesTitle = series ? pickSeriesTitle(m.seriesTitle, m, 'en') : owner ? pickSeriesTitle(owner.seriesTitle, owner, 'en') : null;
  const fields = [
    ['Title', series ? seriesTitle : (ref?.title || pickTitle(m, 'en'))],
    ['Series', seriesTitle || pickTitle(m, 'en')],
    [ref?.kind === 'volume' ? 'Volume' : 'Number', ref?.number],
    ['Count', series && Array.isArray(m.chapters) ? m.chapters.length : null],
    ['Writer', named('artist').join(', ')],
    ['Genre', named('category').join(', ')],
    ['Tags', named('tag').join(', ')],
    ['Characters', named('character').join(', ')],
    ['Web', m.sourceUrl],
    ['LanguageISO', m.translatedLang || LANG_NAME_TO_CODE[String(named('language').find(l => l !== 'translated') || '').toLowerCase()]],
    ['PageCount', pageCount],
    ['AgeRating', AGE_RATING[String(named('rating')[0] || '').toLowerCase()]],
  ].filter(([, v]) => v != null && v !== '');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${
    fields.map(([k, v]) => `  <${k}>${_xml(v)}</${k}>`).join('\n')}\n</ComicInfo>\n`;
}

// Two pictures with the same bytes.
async function _same(a, b) {
  if (!(a instanceof Blob) || !(b instanceof Blob) || a.size !== b.size) return false;
  const [x, y] = (await Promise.all([a.arrayBuffer(), b.arrayBuffer()])).map(buf => new Uint8Array(buf));
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// One gallery's files, read for an archive, from its transfer record (api.transfer.read), every
// name under `prefix`. A cover that is the gallery's first page is left out: it is implied. Its
// metadata.json keeps the person's favorite, as an export always has (importing it takes it back);
// a library folder's description never does (storage/personal.js).
async function _galleryExport({ meta, pages, cover, personal }, prefix, { translations, stripSeriesFields }) {
  const records = translations ? pages : withoutTranslations(pages);
  const first = [...(pages || [])].sort((a, b) => _pageNum(a) - _pageNum(b))[0]?.blob ?? null;
  const own = async (src) => (src && !(await _same(src, first)) ? src : null);
  const marked = meta && typeof personal?.favorite === 'boolean' ? { ...meta, favorite: personal.favorite } : meta;
  const listed = galleryFiles({ meta: marked, records, covers: { gallery: await own(cover?.cover), series: await own(cover?.seriesCover) } },
    prefix, { stripSeriesFields });
  const out = [];
  for (const f of listed) out.push({ name: f.name, data: await fileBytes(f.source), original: !!f.original });
  return out;
}

// What exporting gallery `gid` writes — a series owner exports its whole series: { name, files }
// in the Shiori gallery format, `name` the archive's (without its extension), each file { name,
// data, original }. `read(gid)` and `metaGet(gid)` read the library (api.transfer.read,
// api.meta.get). `translations: false` leaves out what was made from the pages; `comicInfo` adds
// ComicInfo.xml (a CBZ).
export async function exportFiles(gid, { read, metaGet, translations = true, comicInfo = false }) {
  const enc = new TextEncoder();
  const meta = await metaGet(String(gid));
  const pageCount = (files) => files.filter(f => f.original).length;
  const chapters = Array.isArray(meta?.chapters) && meta.chapters.length > 1 ? meta.chapters : null;
  if (!chapters) {
    const files = await _galleryExport(await read(String(gid)), '', { translations });
    if (comicInfo) {
      const owner = meta?.parentId ? await metaGet(String(meta.parentId)) : null;
      files.push({ name: 'ComicInfo.xml', data: enc.encode(comicInfoXml(meta, { owner, pageCount: pageCount(files) })) });
    }
    return { name: galleryName(meta || { galleryId: gid }), files };
  }
  const manifest = seriesManifest(meta);
  const files = [];
  for (const { id, folder } of manifest.chapters) {
    files.push(...await _galleryExport(await read(id), `${folder}/`, { translations, stripSeriesFields: true }));
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  if (comicInfo) files.push({ name: 'ComicInfo.xml', data: enc.encode(comicInfoXml(meta, { series: true, pageCount: pageCount(files) })) });
  return { name: seriesName(meta), files };
}

// The archive's exact size (zip.js stores files uncompressed: each adds a 30-byte local header
// and a 46-byte directory entry, each carrying its name, and a 22-byte record ends the archive),
// and how much of it is the original pages.
export function exportSize(files) {
  const enc = new TextEncoder();
  let total = 22, original = 0;
  for (const f of files) {
    const bytes = sourceBytes(f.source);
    total += 76 + 2 * enc.encode(f.name).length + bytes;
    if (f.original) original += bytes;
  }
  return { total, original };
}
