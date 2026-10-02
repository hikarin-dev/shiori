// files.js — where each gallery lives in the library folder. A gallery's pages are staged as they
// arrive (.shiori/staging/<gid>/); once they stop changing for a moment the gallery is packed into
// its archive (a CBZ or zip, store-only) or folder, with `shiori.json` (its id and metadata, so a
// moved or renamed file is recognised, and the index can be rebuilt from the files) and, unless
// turned off, `ComicInfo.xml` (what other readers read). Only original pages go in: translations,
// study layers and covers stay in the app's cache, so the files stay the gallery's own.
//
// A gallery's place is chosen when it is first packed — `<series or title>/<file>` — and kept;
// renaming or moving files is left to the person (a scan finds them again by their id).
//
// Packing is staged so a failure never leaves a half-written gallery: the new archive is written
// under a temporary name, then — in one synchronous step, so no other operation can run in between
// — the pages are checked unchanged, the archive renamed into place and the page rows pointed at it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeZip, readDirectory, readEntry } from './zip.js';
import { titles, model } from './shared.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  gid TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('cbz', 'zip', 'folder')),
  state TEXT NOT NULL CHECK (state IN ('packed', 'missing')),
  packed_at REAL
);
`;
const FORMATS = new Set(['cbz', 'zip', 'folder']);
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
// Ratings (series-plan.js RATINGS) as ComicInfo's age ratings.
const AGE_RATING = { safe: 'Everyone', suggestive: 'Teen', erotica: 'Mature 17+', pornographic: 'Adults Only 18+' };
const parse = (s) => (s == null ? null : JSON.parse(s));

// A name Windows (and every other system) accepts for a file or folder.
export function safeName(value, fallback) {
  let name = String(value || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.slice(0, 100).trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`;
  return name || fallback;
}

// A chapter or volume number as a file name sorts it: 1 → 001, 12.5 → 012.5.
function padNumber(n) {
  const [whole, part] = String(n).split('.');
  return whole.padStart(3, '0') + (part ? `.${part}` : '');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FileLibrary {
  // `library` is the Library whose pages these are. `packDelay`: how long a gallery's pages must
  // stay unchanged before it is packed.
  constructor(library, { packDelay = 8000 } = {}) {
    this.library = library;
    this.packDelay = packDelay;
    this._timers = new Map();
    this._packing = new Map();      // gid → the pack running for it
    this._again = new Set();        // packed again once the running pack ends
    this._dirty = new Set();        // galleries whose archive holds pages no longer listed
    this._reserved = new Set();     // paths chosen by packs still running
    this._dirs = new Map();         // archive path → { mtimeMs, size, entries }
    this._reading = new Map();      // archive path → reads in flight
    this._failures = new Map();     // gid → packs that failed in a row
  }

  init() {
    this.library._db.exec(SCHEMA);
    // Galleries left with staged pages (the app closed before packing them) are packed now.
    for (const r of this.library._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) this.schedule(r.gid);
  }

  close() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }

  // ── Settings ──
  writeFormat() { const f = this.library._kvGet('writeFormat'); return FORMATS.has(f) ? f : 'cbz'; }
  comicInfo() { return this.library._kvGet('comicInfo') !== false; }

  _row(gid) { return this.library._s('SELECT * FROM files WHERE gid = ?').get(String(gid)); }
  isMissing(gid) { return this._row(gid)?.state === 'missing'; }
  _abs(rel) { return path.join(this.library.libraryDir, ...String(rel).split('/')); }

  // ── Hooks the library calls ──
  pageStored(gid) { this.schedule(gid); }
  pageRemoved(gid) { this._dirty.add(String(gid)); this.schedule(gid); }

  // Inside the library's transaction deleting `gid`: its files go once that commits.
  deleteIn(gid) {
    const row = this._row(gid);
    if (!row) return;
    this.library._s('DELETE FROM files WHERE gid = ?').run(String(gid));
    this.library._afterCommit(() => { this._forget(row.path); this._remove(row.path); });
  }

  clearIn() {
    const rows = this.library._s('SELECT path FROM files').all();
    this.library._s('DELETE FROM files').run();
    this.library._afterCommit(() => { for (const r of rows) { this._forget(r.path); this._remove(r.path); } });
  }

  // A deleted gallery's archive or folder put out of the way (the recycle bin in the app), and its
  // series folder too once that is empty.
  async _remove(rel) {
    const file = this._abs(rel);
    try { await this.library.trash(file); } catch {}
    const dir = path.dirname(file);
    if (dir !== this.library.libraryDir) fsp.rmdir(dir).catch(() => {});
  }

  _forget(rel) { this._dirs.delete(this._abs(rel)); }

  // ── Reading originals ──
  async readOriginal(gid, orig) {
    const row = this._row(gid);
    if (!row || orig?.at !== 'p') return null;
    const bytes = await this._read(row, orig.entry).catch(() => null);
    return bytes ? new Blob([bytes], orig.type ? { type: orig.type } : {}) : null;
  }

  async hasOriginal(gid, orig) {
    const row = this._row(gid);
    if (!row || orig?.at !== 'p') return false;
    if (row.format === 'folder') return fsp.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);
    return !!(await this._directory(this._abs(row.path)).catch(() => null))?.has(orig.entry);
  }

  async _read(row, entry) {
    const file = this._abs(row.path);
    this._reading.set(file, (this._reading.get(file) || 0) + 1);
    try {
      if (row.format === 'folder') return await fsp.readFile(path.join(file, entry));
      const found = (await this._directory(file)).get(entry);
      return found ? await readEntry(file, found) : null;
    } finally {
      const left = this._reading.get(file) - 1;
      if (left) this._reading.set(file, left); else this._reading.delete(file);
    }
  }

  // An archive's directory, read once per version of the file.
  async _directory(file) {
    const stat = await fsp.stat(file);
    const cached = this._dirs.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entries;
    const entries = await readDirectory(file);
    this._dirs.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    if (this._dirs.size > 64) this._dirs.delete(this._dirs.keys().next().value);
    return entries;
  }

  // ── Packing ──
  schedule(gid, delay = this.packDelay) {
    const id = String(gid);
    clearTimeout(this._timers.get(id));
    const t = setTimeout(() => { this._timers.delete(id); this.pack(id).catch(() => {}); }, delay);
    t.unref?.();
    this._timers.set(id, t);
  }

  // Pack everything waiting (the app is closing).
  async flush() {
    const ids = [...this._timers.keys()];
    for (const id of ids) { clearTimeout(this._timers.get(id)); this._timers.delete(id); }
    await Promise.all([...this._packing.values()]);
    for (const id of ids) await this.pack(id).catch(() => {});
  }

  async pack(gid) {
    const id = String(gid);
    if (this._packing.has(id)) { this._again.add(id); return this._packing.get(id); }
    const run = this._pack(id).then((done) => {
      this._failures.delete(id);
      if (!done) this.schedule(id, 1000);   // changed meanwhile: once it settles again
    }, (e) => {
      const n = (this._failures.get(id) || 0) + 1;
      this._failures.set(id, n);
      console.warn(`[shiori] packing gallery ${id} failed (${n}):`, String(e?.message || e));
      if (n < 6) this.schedule(id, Math.min(60000, 2000 * 2 ** n));
    }).finally(() => {
      this._packing.delete(id);
      if (this._again.delete(id)) this.schedule(id);
    });
    this._packing.set(id, run);
    return run;
  }

  // One pack of gallery `gid`. Resolves true when done (or nothing was needed), false when its
  // pages changed while it ran.
  async _pack(gid) {
    const lib = this.library;
    const rows = lib._pageRows(gid).sort((a, b) => a.n - b.n);
    const row = this._row(gid);
    const staged = rows.filter(r => parse(r.orig).at === 's');
    if (!rows.length || (!staged.length && row && !this._dirty.has(gid))) return true;
    const signature = JSON.stringify(rows.map(r => [r.n, r.orig]));
    const format = row?.format || this.writeFormat();
    const rel = row?.path || this._choosePath(gid, format);
    const target = this._abs(rel);
    const temp = `${target}.shiori-tmp`;
    this._reserved.add(rel);
    try {
      // The pages, numbered as the archive names them, then what describes the gallery.
      const pages = [];
      for (const r of rows) {
        const orig = parse(r.orig);
        const ext = EXT_OF_TYPE[orig.type] || String(r.key).match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg';
        const data = orig.at === 's'
          ? await fsp.readFile(path.join(lib.stagingDir, orig.file))
          : await this._read(row, orig.entry);
        if (!data) throw new Error(`page ${r.n} can't be read`);
        pages.push({ n: r.n, name: `${String(r.n).padStart(4, '0')}.${ext}`, data, type: orig.type || TYPE_OF_EXT[ext] || '', key: r.key, record: parse(r.record) });
      }
      const meta = lib._metaGet(gid);
      const entries = pages.map(p => ({ name: p.name, data: p.data }));
      entries.push({ name: 'shiori.json', data: Buffer.from(JSON.stringify(this._describe(gid, meta, pages), null, 2)) });
      if (this.comicInfo()) entries.push({ name: 'ComicInfo.xml', data: Buffer.from(this._comicInfo(gid, meta, pages.length)) });

      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rm(temp, { recursive: true, force: true });
      if (format === 'folder') {
        await fsp.mkdir(temp);
        for (const e of entries) await fsp.writeFile(path.join(temp, e.name), e.data);
      } else {
        await writeZip(temp, entries);
      }

      // One synchronous step from here: nothing else can run until the archive is in place and
      // the rows say so.
      const now = lib._pageRows(gid).sort((a, b) => a.n - b.n);
      if (JSON.stringify(now.map(r => [r.n, r.orig])) !== signature || this._reading.get(target)) {
        await fsp.rm(temp, { recursive: true, force: true });
        return false;
      }
      this._replace(temp, target, format);
      this._forget(rel);
      this._dirty.delete(gid);
      lib._tx(() => {
        for (const p of pages) {
          lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?')
            .run(JSON.stringify({ at: 'p', entry: p.name, size: p.data.length, type: p.type }), gid, p.n);
        }
        lib._s(`INSERT INTO files (gid, path, format, state, packed_at) VALUES (?, ?, ?, 'packed', ?)
          ON CONFLICT(gid) DO UPDATE SET path = excluded.path, format = excluded.format, state = 'packed', packed_at = excluded.packed_at`)
          .run(gid, rel, format, Date.now());
        for (const r of staged) lib._drop(path.join(lib.stagingDir, parse(r.orig).file));
      });
      if (format === 'folder') fsp.rm(`${target}.shiori-old`, { recursive: true, force: true }).catch(() => {});
      return true;
    } catch (e) {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this._reserved.delete(rel);
    }
  }

  // Put the new archive (or folder) in place of the old one, synchronously.
  _replace(temp, target, format) {
    if (format !== 'folder') { fs.renameSync(temp, target); return; }
    const old = `${target}.shiori-old`;
    const had = fs.existsSync(target);
    if (had) { fs.rmSync(old, { recursive: true, force: true }); fs.renameSync(target, old); }
    try { fs.renameSync(temp, target); } catch (e) { if (had) fs.renameSync(old, target); throw e; }
  }

  // Where a gallery is first packed: its series' folder (where its other members are, or named
  // after the series), or a folder named after it; the file named after it.
  _choosePath(gid, format) {
    const lib = this.library;
    const meta = lib._metaGet(gid) || {};
    const owner = meta.parentId ? lib._metaGet(meta.parentId) : (Array.isArray(meta.chapters) && meta.chapters.length > 1 ? meta : null);
    const ownTitle = safeName(titles.pickTitle(meta, 'en'), `Gallery ${gid}`);
    let folder, name;
    if (owner) {
      const ownerId = String(owner.galleryId);
      const seriesTitle = safeName(titles.pickSeriesTitle(owner.seriesTitle, owner, 'en'), `Series ${ownerId}`);
      const members = (owner.chapters || []).map(c => String(c.id));
      const placed = [ownerId, ...members].map(id => this._row(id)).find(Boolean);
      folder = placed ? path.posix.dirname(placed.path) : seriesTitle;
      const at = members.indexOf(String(gid));
      const ref = owner.chapters?.[at] || {};
      const label = ref.kind === 'volume' ? 'Vol.' : 'Ch.';
      name = `${seriesTitle} ${label} ${padNumber(ref.number ?? at + 1)}`;
    } else {
      folder = ownTitle;
      name = ownTitle;
    }
    const ext = format === 'folder' ? '' : `.${format}`;
    for (let i = 1; ; i++) {
      const rel = `${folder}/${name}${i > 1 ? ` (${i})` : ''}${ext}`;
      const taken = this._reserved.has(rel) || lib._s('SELECT 1 FROM files WHERE path = ?').get(rel) || fs.existsSync(this._abs(rel));
      if (!taken) return rel;
    }
  }

  // shiori.json: the gallery's id (which never changes), its metadata and its pages, so the files
  // alone can rebuild it.
  _describe(gid, meta, pages) {
    return {
      format: 'shiori-gallery',
      version: 1,
      id: String(gid),
      meta: meta || null,
      pages: pages.map(p => ({ n: p.n, file: p.name, key: p.key, mediaId: p.record?.mediaId, cachedAt: p.record?.cachedAt })),
    };
  }

  // ComicInfo.xml, the metadata file other comic readers read.
  _comicInfo(gid, meta, pageCount) {
    const lib = this.library;
    const m = meta || {};
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const named = (type) => tags.filter(t => t.type === type).map(t => t.name);
    const owner = m.parentId ? lib._metaGet(m.parentId) : (Array.isArray(m.chapters) && m.chapters.length > 1 ? m : null);
    const ref = owner?.chapters?.find(c => String(c.id) === String(gid));
    const fields = [
      ['Title', ref?.title || titles.pickTitle(m, 'en')],
      ['Series', owner ? titles.pickSeriesTitle(owner.seriesTitle, owner, 'en') : titles.pickTitle(m, 'en')],
      [ref?.kind === 'volume' ? 'Volume' : 'Number', ref?.number],
      ['Writer', named('artist').join(', ')],
      ['Genre', named('category').join(', ')],
      ['Tags', named('tag').join(', ')],
      ['Characters', named('character').join(', ')],
      ['Web', m.sourceUrl],
      ['LanguageISO', m.translatedLang || model.LANG_NAME_TO_CODE[String(named('language').find(l => l !== 'translated') || '').toLowerCase()]],
      ['PageCount', pageCount],
      ['AgeRating', AGE_RATING[String(named('rating')[0] || '').toLowerCase()]],
    ].filter(([, v]) => v != null && v !== '');
    return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${
      fields.map(([k, v]) => `  <${k}>${xml(v)}</${k}>`).join('\n')}\n</ComicInfo>\n`;
  }
}
