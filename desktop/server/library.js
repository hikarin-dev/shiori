// library.js — a library kept by the desktop app: the library interface (app/js/api.js) over SQLite
// and files instead of IndexedDB. It answers the operations db.js answers, by the same names and
// with the same results, so the app reaches either one through api.js and the same tests hold for
// both. SQLite's transactions are synchronous: each operation reads and writes everything it
// touches in one of them, which is what db.js does with IndexedDB's callbacks.
//
// What is kept where:
//   library.db (SQLite)  every record db.js keeps — metadata, gallery entry (stat record), page and
//                        cover records, source icons, the change log — as JSON, with a column for
//                        each thing it is looked up or sorted by;
//   cache/<gid>/         every image other than an original page: translations, study layers,
//                        pipeline masks, covers, cover thumbnails;
//   the library folder   original pages: staged as they arrive (.shiori/staging/<gid>/), then packed
//                        into the gallery's archive or folder (files.js).
// Where db.js keeps a Blob, a record here keeps a reference: { $file, size, type } for a cache file,
// { $orig, size, type } for the page's original, { $page: n, size, type } for a cover that is its
// gallery's page n. Records go back to the app with their Blobs in place.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { plans, model, titles, pageSize, files as galleryFilesModule, BackendError } from './shared.js';
import { FileLibrary } from './files.js';
import { scanLibrary } from './scan.js';

const { planAttach, planRemove, planReorder, planChapterTitle, planWrite, planDelete, planDeleteSeries, planRelink } = plans;
const { isSeriesMeta, effectiveTagsOf, LANG_NAME_TO_CODE, uploadDateSeconds } = model;
const { normalizeTitle, migrateTitle } = titles;
const { medianPage, describePage, headerSize } = pageSize;
const { galleryFiles, exportSize } = galleryFilesModule;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (
  gid TEXT PRIMARY KEY,
  source_id TEXT,
  is_stub INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_source ON meta (source_id, gid) WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta_tags (
  tag TEXT NOT NULL,
  gid TEXT NOT NULL,
  PRIMARY KEY (tag, gid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS meta_tags_gid ON meta_tags (gid);
CREATE TABLE IF NOT EXISTS stats (
  gid TEXT PRIMARY KEY,
  latest_at REAL,
  added_at REAL,
  size REAL,
  count REAL,
  upload_date REAL,
  parent_key TEXT,
  child INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stats_latest ON stats (latest_at, gid) WHERE latest_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS stats_added ON stats (added_at, gid) WHERE added_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS stats_size ON stats (size, gid) WHERE size IS NOT NULL;
CREATE INDEX IF NOT EXISTS stats_count ON stats (count, gid) WHERE count IS NOT NULL;
CREATE INDEX IF NOT EXISTS stats_upload ON stats (upload_date, gid) WHERE upload_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS stats_parent ON stats (parent_key) WHERE parent_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS pages (
  gid TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  key TEXT NOT NULL UNIQUE,
  w INTEGER,
  h INTEGER,
  orig TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (gid, n)
);
CREATE TABLE IF NOT EXISTS covers (gid TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS icons (source TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (rev INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// A page's number is the one its key ends in ("…/12.webp"), as in db.js.
const PAGE_URL = /\/(\d+)\.(webp|jpg|jpeg|png|gif|avif)$/i;
const keyPage = (key) => { const m = String(key ?? '').match(PAGE_URL); return m ? parseInt(m[1], 10) : null; };
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const extOf = (type) => EXT_OF_TYPE[type] || 'bin';
const CHANGES_KEPT = 20000;
const MEDIAN_PAGE_SETTLE_MS = 3000;
// Per-page fields an earlier storage format wrote; dropped whenever a page is translated again.
const RETIRED_FIELDS = ['translatedLang', 'translatedConfig', 'translatedOutputHash', 'translatedJob', 'snapshot',
  'pendingSnapshot', 'studySnapshot', 'priorSnapshot', 'sourceSha256'];
const RESTORABLE = ['pipeline', 'own', 'translatedLayers'];
// Sort orders and the column each reads (db.js's indexes); 'id' sorts by the gallery id itself.
const SORT_COLUMN = { updated: 'latest_at', size: 'size', count: 'count', uploadDate: 'upload_date' };

const isRef = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && ('$file' in v || '$orig' in v || '$page' in v);
// A value as an IndexedDB index holds it: a number (not NaN) or a string; anything else isn't indexed.
const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
const indexKey = (v) => (typeof v === 'string' || (typeof v === 'number' && !Number.isNaN(v)) ? String(v) : null);
const parse = (s) => (s == null ? null : JSON.parse(s));
const sameOrig = (a, b) => a?.at === b?.at && a?.file === b?.file && a?.entry === b?.entry;
const sizeOf = (row) => parse(row.record)?.size || 0;

// Lower-cased `type:name` strings, the tag index's keys.
function tagNamesOf(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => `${t.type}:${t.name}`.toLowerCase());
}

// Every metadata write converges on the canonical title format and keeps its tag keys (db.js).
function canonicalMeta(meta) {
  const record = migrateTitle(meta);
  if (record?.uploadDate != null) record.uploadDate = uploadDateSeconds(record.uploadDate);
  if (Array.isArray(record.tags) || Array.isArray(record.seriesTags)) return { ...record, tagNames: tagNamesOf(effectiveTagsOf(record)) };
  return record;
}

function deriveLangs(m, tags = effectiveTagsOf(m)) {
  if (!m) return [];
  if (m.translatedLang) return [m.translatedLang];
  const out = [];
  const add = (code) => { if (code && !out.includes(code)) out.push(code); };
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (tag.type !== 'language' || !tag.name) continue;
      const name = tag.name.toLowerCase();
      if (name === 'translated') continue;
      add(LANG_NAME_TO_CODE[name]);
    }
  }
  if (!out.length && m.sourceMetadata && m.sourceMetadata.language) {
    add(LANG_NAME_TO_CODE[String(m.sourceMetadata.language).toLowerCase()]);
  }
  return out;
}

// The entity every surface renders: a gallery's stat record and metadata merged (db.js _entityFrom).
function entityFrom(id, gal, meta) {
  const g = gal || {};
  const m = meta || {};
  const tags = effectiveTagsOf(m);
  return {
    id: String(id),
    count: g.count || 0,
    size: g.size || 0,
    origSize: g.origSize ?? (g.size || 0),
    latestAt: g.latestAt || 0,
    addedAt: g.addedAt ?? (Number(id) || g.latestAt || 0),
    uploadDate: g.uploadDate ?? (Number(m.uploadDate) || 0),
    coverPage: g.coverPage,
    title: normalizeTitle(m),
    numPages: m.numPages,
    tags,
    ownTags: m.tags,
    seriesTags: m.seriesTags,
    mediaId: m.mediaId,
    pageExts: m.pageExts,
    isLocalImport: m.isLocalImport || false,
    source: m.source ?? '',
    sourceId: m.sourceId || null,
    sourceUrl: m.sourceUrl || '',
    fetchedAt: m.fetchedAt,
    translated: m.translated || false,
    translatedLang: m.translatedLang || '',
    favorite: !!m.favorite,
    languages: deriveLangs(m, tags),
    chapters: Array.isArray(m.chapters) ? m.chapters : null,
    parentId: m.parentId || g.parentId || null,
    seriesTitle: m.seriesTitle || null,
    isSeries: isSeriesMeta(m),
    chapterCount: g.chapterCount ?? (Array.isArray(m.chapters) ? m.chapters.length : 0),
    aggPages: g.aggPages ?? (g.count || 0),
    aggSize: g.aggSize ?? (g.size || 0),
    aggOrig: g.aggOrig ?? g.aggSize ?? (g.origSize ?? (g.size || 0)),
    medianPage: describePage(g.medianPage),
    aggMedianPage: describePage(g.aggMedianPage ?? g.medianPage),
  };
}

// A gallery's typical page, kept with what it was measured from (db.js).
const pagesSig = (pages) => ({ n: pages.length, bytes: pages.reduce((sum, p) => sum + (p.size || 0), 0) });
function medianPageStale(stat, records) {
  const stored = stat?.medianPage;
  if (!stored) return records.length > 0;
  if (records.length && !Array.isArray(stat.pageSizes)) return true;
  const sig = pagesSig(records);
  return stored.n !== sig.n || stored.bytes !== sig.bytes;
}
function sizeTally(sizes) {
  const counts = new Map();
  for (const { w, h } of sizes) counts.set(`${w}x${h}`, (counts.get(`${w}x${h}`) || 0) + 1);
  return [...counts].map(([k, n]) => [...k.split('x').map(Number), n]).sort((a, b) => a[0] * a[1] - b[0] * b[1] || a[0] - b[0]);
}
// A page's pixel size from its header; null when it can't be read there.
function measure(bytes) {
  const size = headerSize(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  return size?.w > 0 && size?.h > 0 ? size : null;
}

function selectCover(rec, opts = {}) {
  const preferSeries = opts === 'series' || !!opts.preferSeries;
  const seriesOnly = opts === 'seriesOnly' || !!opts.seriesOnly;
  if (seriesOnly || (preferSeries && rec?.seriesCover)) return { role: 'series', source: rec?.seriesCover || null };
  return { role: 'gallery', source: rec?.cover || null };
}
function coverWidthKey(maxW) {
  const width = Math.round(Number(maxW));
  return Number.isFinite(width) && width > 0 ? String(width) : null;
}

// Every cache file a value refers to.
function fileRefs(value, out = new Set()) {
  if (value == null || typeof value !== 'object') return out;
  if (isRef(value)) { if (typeof value.$file === 'string') out.add(value.$file); return out; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) fileRefs(v, out);
  return out;
}

async function imageToBlob(src) {
  if (!src) return null;
  if (src instanceof Blob) return src;
  if (typeof src === 'string') { try { return await (await fetch(src)).blob(); } catch { return null; } }
  return null;
}

export class Library {
  // `dataDir` holds library.db and the cache; `libraryDir` is the library folder. `trash(path)` puts
  // a gallery's files out of the way when it is deleted (the recycle bin, in the app). `packDelay`:
  // how long a gallery's pages stay staged after its last change before it is packed (files.js).
  constructor({ dataDir, libraryDir, trash, packDelay } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.libraryDir = path.resolve(libraryDir);
    this.cacheDir = path.join(this.dataDir, 'cache');
    this.stagingDir = path.join(this.libraryDir, '.shiori', 'staging');
    this.trash = trash || ((p) => fsp.rm(p, { recursive: true, force: true }));
    this.context = crypto.randomUUID();
    this._subs = new Set();
    this._timers = new Set();
    this._feedTimers = new Map();
    this._sizeTimers = new Map();
    this._medianTimers = new Map();
    this._aggTimers = new Map();
    this._feedSeq = 0;
    this._lastRev = 0;
    this._lastGid = 0;
    this._inTx = null;
    this._stmts = new Map();
    this._dirs = new Set();
    this.files = new FileLibrary(this, packDelay != null ? { packDelay } : {});
  }

  async open() {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await fsp.mkdir(this.stagingDir, { recursive: true });
    this._db = new DatabaseSync(path.join(this.dataDir, 'library.db'));
    this._db.exec(SCHEMA);
    this._lastRev = Number(this._s('SELECT max(rev) AS rev FROM changes').get()?.rev || 0);
    this.files.init();
    return this;
  }

  close() {
    this.files.close();
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    for (const m of [this._feedTimers, this._sizeTimers, this._medianTimers, this._aggTimers]) m.clear();
    this._stmts.clear();
    this._db?.close();
    this._db = null;
  }

  // What the library announces: ('feed', beacon) for a changed gallery, ('control', message) for
  // cover and deletion notices — the messages db.js sends on platform.feed and platform.control.
  onPush(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
  _push(channel, msg) { for (const cb of [...this._subs]) { try { cb(channel, msg); } catch {} } }

  // ── Plumbing ──
  _s(sql) {
    let stmt = this._stmts.get(sql);
    if (!stmt) { stmt = this._db.prepare(sql); this._stmts.set(sql, stmt); }
    return stmt;
  }
  _later(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }
  _kvGet(key) { return parse(this._s('SELECT value FROM kv WHERE key = ?').get(key)?.value); }
  _kvSet(key, value) { this._s('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)); }

  // One transaction: `fn` runs synchronously inside it. Files queued with _drop are deleted once it
  // commits; on a failure the files in `fresh` (written for it beforehand) are deleted instead.
  _tx(fn, fresh = []) {
    if (this._inTx) return fn();
    this._db.exec('BEGIN IMMEDIATE');
    this._inTx = { logged: new Set(), drop: [], after: [] };
    let out, drop, after;
    try {
      out = fn();
      this._db.exec('COMMIT');
      ({ drop, after } = this._inTx);
    } catch (e) {
      try { this._db.exec('ROLLBACK'); } catch {}
      this._inTx = null;
      for (const file of fresh) fsp.rm(file, { force: true }).catch(() => {});
      throw e;
    }
    this._inTx = null;
    for (const file of drop) fsp.rm(file, { force: true }).catch(() => {});
    for (const fn of after) { try { fn(); } catch {} }
    return out;
  }
  _drop(file) { this._inTx.drop.push(file); }
  _afterCommit(fn) { this._inTx.after.push(fn); }
  async _mkdir(dir) {
    if (this._dirs.has(dir)) return;
    await fsp.mkdir(dir, { recursive: true });
    this._dirs.add(dir);
  }

  // ── Images on disk ──
  async _writeCache(gid, label, blob) {
    const dir = path.join(this.cacheDir, gid);
    await this._mkdir(dir);
    const rel = `${gid}/${label}-${crypto.randomBytes(5).toString('hex')}.${extOf(blob.type)}`;
    await fsp.writeFile(path.join(this.cacheDir, rel), new Uint8Array(await blob.arrayBuffer()));
    return { $file: rel, size: blob.size, type: blob.type || '' };
  }

  // `value` with every Blob in it written to the cache and referenced: { value, fresh } (`fresh` the
  // files written, deleted again should the write they were for fail).
  async _externalize(value, gid, label) {
    const fresh = [];
    const walk = async (v) => {
      if (v instanceof Blob) {
        const ref = await this._writeCache(gid, label, v);
        fresh.push(path.join(this.cacheDir, ref.$file));
        return ref;
      }
      if (v == null || typeof v !== 'object') return v;
      if (isRef(v)) throw new BackendError('invalid', 'a stored reference cannot be written');
      if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await walk(x)); return out; }
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    };
    try { return { value: await walk(value), fresh }; } catch (e) {
      for (const file of fresh) fsp.rm(file, { force: true }).catch(() => {});
      throw e;
    }
  }

  async _readCache(ref) {
    const file = path.resolve(this.cacheDir, String(ref.$file));
    if (!file.startsWith(this.cacheDir + path.sep)) return null;
    try { return new Blob([await fsp.readFile(file)], ref.type ? { type: ref.type } : {}); } catch { return null; }
  }

  // A page's original as a Blob, from where `orig` (its row's) says it is: staged, or packed.
  async _readOrigAt(gid, orig) {
    if (orig?.at === 's') {
      const file = path.resolve(this.stagingDir, String(orig.file));
      if (!file.startsWith(this.stagingDir + path.sep)) return null;
      try { return new Blob([await fsp.readFile(file)], orig.type ? { type: orig.type } : {}); } catch { return null; }
    }
    return this.files.readOriginal(gid, orig);
  }

  // Page `n`'s original (`orig`: where its row said it was). Packing moves an original from staging
  // into its archive, and a repack replaces the archive; a read begun before such a move reads the
  // page where its row says it is now.
  async _readOrig(gid, n, orig) {
    const blob = await this._readOrigAt(gid, orig);
    if (blob || n == null) return blob;
    const now = parse(this._pageRow(gid, n)?.orig);
    return now && !sameOrig(now, orig) ? this._readOrigAt(gid, now) : null;
  }

  // `value` with its references read back into Blobs; `gid` the gallery it belongs to, and for a page
  // record its number `n` and where its original is (`orig`).
  async _internalize(value, gid, orig = null, n = null) {
    const walk = async (v) => {
      if (v == null || typeof v !== 'object') return v;
      if (isRef(v)) {
        if (typeof v.$file === 'string') return this._readCache(v);
        if (v.$orig) return this._readOrig(gid, n, orig);
        if (v.$page != null) {
          const row = this._pageRow(gid, v.$page);
          return row ? this._readOrig(gid, row.n, parse(row.orig)) : null;
        }
        return null;
      }
      if (Array.isArray(v)) return Promise.all(v.map(walk));
      const out = {};
      await Promise.all(Object.entries(v).map(async ([k, x]) => { out[k] = await walk(x); }));
      return Object.fromEntries(Object.keys(v).map(k => [k, out[k]]));
    };
    return walk(value);
  }

  // Page `n`'s original bytes, staged until the gallery is packed.
  async _stage(gid, n, bytes, type) {
    const dir = path.join(this.stagingDir, gid);
    await this._mkdir(dir);
    const file = `${gid}/${n}-${crypto.randomBytes(5).toString('hex')}.${extOf(type)}`;
    await fsp.writeFile(path.join(this.stagingDir, file), bytes);
    return { at: 's', file, size: bytes.length, type };
  }

  // ── Records ──
  _metaGet(gid) { return parse(this._s('SELECT record FROM meta WHERE gid = ?').get(String(gid))?.record); }
  _metaPutRaw(record) {
    const gid = String(record.galleryId);
    this._s(`INSERT INTO meta (gid, source_id, is_stub, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(gid) DO UPDATE SET source_id = excluded.source_id, is_stub = excluded.is_stub, record = excluded.record`)
      .run(gid, indexKey(record.sourceId), record.isStub ? 1 : 0, JSON.stringify(record));
    this._s('DELETE FROM meta_tags WHERE gid = ?').run(gid);
    const tags = Array.isArray(record.tagNames) ? new Set(record.tagNames.filter(t => typeof t === 'string')) : [];
    for (const tag of tags) this._s('INSERT OR IGNORE INTO meta_tags (tag, gid) VALUES (?, ?)').run(tag, gid);
  }
  _metaDel(gid) {
    this._s('DELETE FROM meta WHERE gid = ?').run(String(gid));
    this._s('DELETE FROM meta_tags WHERE gid = ?').run(String(gid));
  }
  _statGet(gid) { return parse(this._s('SELECT record FROM stats WHERE gid = ?').get(String(gid))?.record); }
  _statPut(rec) {
    this._s(`INSERT INTO stats (gid, latest_at, added_at, size, count, upload_date, parent_key, child, record)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(gid) DO UPDATE SET latest_at = excluded.latest_at, added_at = excluded.added_at, size = excluded.size,
        count = excluded.count, upload_date = excluded.upload_date, parent_key = excluded.parent_key, child = excluded.child,
        record = excluded.record`)
      .run(String(rec.galleryId), num(rec.latestAt), num(rec.addedAt), num(rec.size), num(rec.count), num(rec.uploadDate),
        indexKey(rec.parentId), rec.parentId ? 1 : 0, JSON.stringify(rec));
  }
  _statDel(gid) { this._s('DELETE FROM stats WHERE gid = ?').run(String(gid)); }
  _pageRow(gid, n) { return this._s('SELECT * FROM pages WHERE gid = ? AND n = ?').get(String(gid), Number(n)); }
  _pageRowByKey(key) { return this._s('SELECT * FROM pages WHERE key = ?').get(String(key)); }
  _pageRows(gid) { return this._s('SELECT * FROM pages WHERE gid = ? ORDER BY key').all(String(gid)); }
  _pageCount(gid) { return Number(this._s('SELECT count(*) AS c FROM pages WHERE gid = ?').get(String(gid)).c); }
  _pagePutRow({ gid, n, key, w, h, orig, record }) {
    this._s(`INSERT INTO pages (gid, n, key, w, h, orig, record) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(gid, n) DO UPDATE SET key = excluded.key, w = excluded.w, h = excluded.h, orig = excluded.orig, record = excluded.record`)
      .run(String(gid), Number(n), String(key), w ?? null, h ?? null, JSON.stringify(orig), JSON.stringify(record));
  }
  // A page's record as db.js returns it before its images are read: its number, references in place.
  _rowRecord(row) { return { ...parse(row.record), pageNum: row.n }; }
  // A row's record rewritten; the cache files it no longer refers to are deleted once committed.
  _pageRewrite(row, rec) {
    const { pageNum, ...stored } = rec;
    const before = fileRefs(parse(row.record));
    const after = fileRefs(stored);
    for (const ref of before) if (!after.has(ref)) this._drop(path.join(this.cacheDir, ref));
    this._s('UPDATE pages SET record = ? WHERE gid = ? AND n = ?').run(JSON.stringify(stored), row.gid, row.n);
  }
  // A page row deleted with its staged original and its cache files.
  _pageDrop(row) {
    this._s('DELETE FROM pages WHERE gid = ? AND n = ?').run(row.gid, row.n);
    for (const ref of fileRefs(parse(row.record))) this._drop(path.join(this.cacheDir, ref));
    const orig = parse(row.orig);
    if (orig?.at === 's') this._drop(path.join(this.stagingDir, orig.file));
    else this.files.pageRemoved(row.gid);   // its archive still holds it until packed again
  }
  // The page `at` names: { galleryId, pageNum }, or its key.
  _pageAt(at) {
    if (typeof at === 'string') return this._pageRowByKey(at);
    return at ? this._pageRow(at.galleryId, at.pageNum) : null;
  }
  _coverGet(gid) { return parse(this._s('SELECT record FROM covers WHERE gid = ?').get(String(gid))?.record); }
  _coverPut(rec) {
    this._s('INSERT INTO covers (gid, record) VALUES (?, ?) ON CONFLICT(gid) DO UPDATE SET record = excluded.record')
      .run(String(rec.galleryId), JSON.stringify(rec));
  }

  // ── The change log ──
  _logIn(gid) {
    const id = String(gid);
    if (this._inTx.logged.has(id)) return;
    this._inTx.logged.add(id);
    const rev = Number(this._s('INSERT INTO changes (gid, at) VALUES (?, ?)').run(id, Date.now()).lastInsertRowid);
    this._lastRev = Math.max(this._lastRev, rev);
    if (rev % 1000 === 0 && rev > CHANGES_KEPT) {
      this._s('DELETE FROM changes WHERE rev <= ?').run(rev - CHANGES_KEPT);
      this._kvSet('compactedUpTo', rev - CHANGES_KEPT);
    }
  }

  async changeRevision() { return Number(this._s('SELECT max(rev) AS rev FROM changes').get()?.rev || 0); }

  async changesSince(rev) {
    const since = Number(rev) || 0;
    const out = { rev: since, gids: [], resync: false };
    const upTo = Number(this._kvGet('compactedUpTo')) || 0;
    if (upTo && since < upTo) out.resync = true;
    const gids = new Set();
    for (const row of this._s('SELECT rev, gid FROM changes WHERE rev > ? ORDER BY rev').all(since)) {
      out.rev = Number(row.rev);
      if (row.gid === '*') out.resync = true; else gids.add(row.gid);
    }
    if (!out.resync) out.gids = [...gids];
    return out;
  }

  // ── Announcements (db.js timings) ──
  publishFeed(galleryId) {
    const gid = String(galleryId);
    if (this._feedTimers.has(gid)) return;
    this._feedTimers.set(gid, this._later(250, async () => {
      this._feedTimers.delete(gid);
      await this.refreshGallerySize(gid).catch(() => {});
      this._push('feed', { gid, context: this.context, n: ++this._feedSeq, at: Date.now(), rev: this._lastRev });
    }));
  }

  scheduleGallerySize(galleryId) {
    const gid = String(galleryId);
    if (this._sizeTimers.has(gid)) return;
    this._sizeTimers.set(gid, this._later(1000, () => {
      this._sizeTimers.delete(gid);
      this.refreshGallerySize(gid).then(changed => { if (changed) this.publishFeed(gid); }, () => {});
    }));
  }

  scheduleMedianPage(galleryId) {
    const gid = String(galleryId);
    clearTimeout(this._medianTimers.get(gid));
    this._medianTimers.set(gid, this._later(MEDIAN_PAGE_SETTLE_MS, () => {
      this._medianTimers.delete(gid);
      this.refreshMedianPage(gid).then(changed => { if (changed) this.publishFeed(gid); }, () => {});
    }));
  }

  scheduleSeriesAggregate(ownerId) {
    const oid = String(ownerId);
    if (this._aggTimers.has(oid)) return;
    this._aggTimers.set(oid, this._later(400, () => {
      this._aggTimers.delete(oid);
      this.refreshSeriesAggregate(oid).catch(() => {});
    }));
  }

  // A gallery's size is its export archive's (gallery-files.js), recomputed from what is stored.
  async refreshGallerySize(galleryId) {
    const gid = String(galleryId);
    let changed = null, stat = null, records = [];
    this._tx(() => {
      const meta = this._metaGet(gid);
      records = this._pageRows(gid).map(r => this._rowRecord(r));
      const cover = this._coverGet(gid);
      const { total, original } = exportSize(galleryFiles({ meta, records,
        covers: { gallery: cover?.cover, series: cover?.seriesCover } }));
      const cur = stat = this._statGet(gid);
      if (!cur || (cur.size === total && cur.origSize === original)) return;
      changed = cur;
      this._statPut({ ...cur, size: total, origSize: original });
      this._logIn(gid);
    });
    if (stat && medianPageStale(stat, records)) this.scheduleMedianPage(gid);
    if (!changed) return false;
    if (changed.parentId) this.scheduleSeriesAggregate(changed.parentId);
    if (changed.chapterCount != null) this.scheduleSeriesAggregate(gid);
    return true;
  }

  // The typical page and the page-size tally, from the sizes measured as each page was stored.
  async refreshMedianPage(galleryId) {
    const gid = String(galleryId);
    let prev = null, stat = null, tallied = false, next = null;
    this._tx(() => {
      const rows = this._pageRows(gid);
      const pages = rows.map(r => ({ size: sizeOf(r) }));
      const sizes = rows.filter(r => r.w > 0 && r.h > 0).map(r => ({ w: r.w, h: r.h }));
      const median = medianPage(sizes);
      next = pages.length ? { w: median?.w || 0, h: median?.h || 0, ...pagesSig(pages) } : null;
      const tally = pages.length ? sizeTally(sizes) : null;
      const cur = this._statGet(gid);
      prev = cur?.medianPage;
      tallied = JSON.stringify(cur?.pageSizes ?? null) !== JSON.stringify(tally);
      if (!cur || (['w', 'h', 'n', 'bytes'].every(k => prev?.[k] === next?.[k]) && !tallied)) return;
      stat = cur;
      const { medianPage: _, pageSizes: __, ...rest } = cur;
      this._statPut(next ? { ...rest, medianPage: next, pageSizes: tally } : rest);
      this._logIn(gid);
    });
    const typical = !!stat && (prev?.w !== next?.w || prev?.h !== next?.h);
    if (stat && (typical || tallied)) {
      if (stat.parentId) this.scheduleSeriesAggregate(stat.parentId);
      if (stat.chapterCount != null) this.scheduleSeriesAggregate(gid);
    }
    return typical;
  }

  // The library folder and the index brought into agreement (scan.js).
  rescan() { return scanLibrary(this); }

  // ── Gallery ids ──
  nextGalleryId() {
    this._lastGid = Math.max(Date.now(), this._lastGid + 1);
    return String(this._lastGid);
  }

  // The gallery a source reference stands for; a placeholder is created on first sight. The first
  // one added answers when several share it — a real gallery before a placeholder.
  async resolveGalleryId(id) {
    const raw = String(id);
    if (/^\d{13,}$/.test(raw)) return raw;
    return this._tx(() => {
      const held = this._s('SELECT gid, is_stub FROM meta WHERE source_id = ? ORDER BY gid').all(raw);
      const found = held.find(m => !m.is_stub) || held[0];
      if (found) return String(found.gid);
      const gid = this.nextGalleryId();
      this._metaPutRaw({ galleryId: gid, sourceId: raw, isStub: true });
      return gid;
    });
  }

  // ── Galleries ──
  async galleriesPage({ sort = 'updated', dir, offset = 0, limit = 60, merge = true } = {}) {
    const order = dir === 'asc' ? 'ASC' : 'DESC';
    const col = sort === 'id' ? null : (SORT_COLUMN[sort] || 'latest_at');
    const where = [col ? `${col} IS NOT NULL` : '1', merge ? 'child = 0' : '1'].join(' AND ');
    const rows = this._s(`SELECT gid, record FROM stats WHERE ${where} ORDER BY ${col ? `${col} ${order}, ` : ''}gid ${order} LIMIT ? OFFSET ?`)
      .all(Math.max(0, Number(limit) || 0), Math.max(0, Number(offset) || 0));
    return rows.map(r => this._entity(r.gid, parse(r.record), this._metaGet(r.gid)));
  }

  async galleriesCount({ merge = true } = {}) {
    const total = Number(this._s('SELECT count(*) AS c FROM stats').get().c);
    if (!merge) return total;
    return total - Number(this._s('SELECT count(*) AS c FROM stats WHERE parent_key IS NOT NULL').get().c);
  }

  async galleryIdsSorted({ sort = 'updated', dir } = {}) {
    const order = dir === 'asc' ? 'ASC' : 'DESC';
    const col = sort === 'id' ? null : (SORT_COLUMN[sort] || 'latest_at');
    return this._s(`SELECT gid FROM stats ${col ? `WHERE ${col} IS NOT NULL ` : ''}ORDER BY ${col ? `${col} ${order}, ` : ''}gid ${order}`)
      .all().map(r => String(r.gid));
  }

  async getGallery(galleryId) {
    const gid = String(galleryId);
    const gal = this._statGet(gid), meta = this._metaGet(gid);
    if (!gal && !meta) return null;
    return this._entity(gid, gal, meta);
  }

  // A gallery as surfaces render it; `missing` when its files can't be found in the library folder.
  _entity(gid, gal, meta) {
    const entity = entityFrom(gid, gal, meta);
    if (this.files.isMissing(gid)) entity.missing = true;
    return entity;
  }

  async getGalleriesByIds(ids) { return Promise.all((ids || []).map(id => this.getGallery(id))); }

  async getStats() {
    const galleries = {};
    let totalImages = 0, totalSize = 0, totalOrig = 0;
    for (const row of this._s('SELECT record FROM stats ORDER BY gid').all()) {
      const e = parse(row.record);
      galleries[e.galleryId] = { count: e.count, size: e.size, latestAt: e.latestAt, medianPage: e.medianPage };
      totalImages += e.count;
      totalSize += e.size;
      totalOrig += e.origSize ?? e.size;
    }
    return { totalImages, totalSize, totalOrig, galleries };
  }

  // How many cards carry each tag: a gallery entry that isn't a series' chapter.
  async tagCounts({ keys, prefix } = {}) {
    const counted = 'EXISTS (SELECT 1 FROM stats s WHERE s.gid = t.gid AND s.parent_key IS NULL)';
    const counts = new Map();
    if (keys) {
      for (const key of new Set(keys)) {
        counts.set(key, Number(this._s(`SELECT count(*) AS c FROM meta_tags t WHERE tag = ? AND ${counted}`).get(String(key)).c));
      }
      return counts;
    }
    const rows = prefix
      ? this._s(`SELECT tag, count(*) AS c FROM meta_tags t WHERE substr(tag, 1, length(?)) = ? AND ${counted} GROUP BY tag ORDER BY tag`).all(prefix, prefix)
      : this._s(`SELECT tag, count(*) AS c FROM meta_tags t WHERE ${counted} GROUP BY tag ORDER BY tag`).all();
    for (const r of rows) counts.set(r.tag, Number(r.c));
    return counts;
  }

  async metaGetAllMap() {
    const map = new Map();
    for (const r of this._s('SELECT gid, record FROM meta ORDER BY gid').all()) map.set(String(r.gid), parse(r.record));
    return map;
  }

  // ── Metadata ──
  async metaGet(galleryId) { return this._metaGet(galleryId); }
  async metaGetAll() { return this._s('SELECT record FROM meta ORDER BY gid').all().map(r => parse(r.record)); }

  async metaPut(meta, opts = {}) {
    const silent = !!opts.silent;
    const onlyIfExists = !!opts.onlyIfExists;
    const record = canonicalMeta(meta);
    const gid = String(record.galleryId);
    const written = this._tx(() => {
      if (onlyIfExists && !this._metaGet(gid)) return false;
      this._metaPutRaw(record);
      this._logIn(gid);
      if (record.isStub) return true;
      const g = this._statGet(gid);
      if (!g) return true;
      g.latestAt = Math.max(g.latestAt || 0, Date.now());
      if (record.uploadDate != null) g.uploadDate = Number(record.uploadDate) || 0;
      else if (g.uploadDate == null) g.uploadDate = 0;
      this._statPut(g);
      return true;
    });
    if (!written) return false;
    if (!record.isStub) { if (silent) this.scheduleGallerySize(gid); else this.publishFeed(gid); }
    return true;
  }

  // ── The single write path (db.js mutateGallery / galleryCreate) ──
  async mutateGallery(galleryId, patch, opts = {}) {
    const gid = String(galleryId);
    const silent = !!opts.silent;
    if (!patch || !Object.keys(patch).length) { if (!silent) this.publishFeed(gid); return false; }
    if ('parentId' in patch || 'chapters' in patch) {
      return this.seriesCommand('relink', gid, patch, { touch: opts.touch !== false, onlyIfExists: !!opts.onlyIfExists, silent });
    }
    const info = this._tx(() => this._mutateIn(gid, patch, { touch: opts.touch !== false, onlyIfExists: !!opts.onlyIfExists }));
    if (!silent) this.publishFeed(gid);
    else this.scheduleGallerySize(gid);
    return info.written;
  }

  async galleryCreate(galleryId, meta = {}) {
    const gid = String(galleryId);
    const info = this._tx(() => this._mutateIn(gid, meta, { ensureStat: true }));
    this.publishFeed(gid);
    return info.written;
  }

  _mutateIn(gid, patch, { touch = true, onlyIfExists = false, ensureStat = false } = {}) {
    const metaPatch = {}, galPatch = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (model.DERIVED_FIELDS.has(k)) galPatch[k] = v; else metaPatch[k] = v;
    }
    if ('parentId' in (patch || {})) galPatch.parentId = patch.parentId;
    const hasMeta = Object.keys(metaPatch).length > 0;
    const hasGal = Object.keys(galPatch).length > 0 || ensureStat;
    if (!hasMeta && !hasGal) return { written: false };
    const curMeta = this._metaGet(gid);
    if (onlyIfExists && !curMeta) return { written: false };
    let merged = curMeta || { galleryId: gid };
    if (hasMeta) {
      merged = migrateTitle({ ...merged, ...metaPatch, galleryId: gid });
      if (merged.uploadDate != null) merged.uploadDate = uploadDateSeconds(merged.uploadDate);
      if (Array.isArray(merged.tags) || Array.isArray(merged.seriesTags)) merged = { ...merged, tagNames: tagNamesOf(effectiveTagsOf(merged)) };
      this._metaPutRaw(merged);
    }
    let cur = this._statGet(gid);
    if (hasMeta && cur && !merged.isStub) {
      cur = touch ? { ...cur, latestAt: Math.max(cur.latestAt || 0, Date.now()) } : { ...cur };
      if (merged.uploadDate != null) cur.uploadDate = Number(merged.uploadDate) || 0;
      else if (cur.uploadDate == null) cur.uploadDate = 0;
    }
    if (hasGal) {
      if (!cur) {
        const now = Date.now();
        cur = { galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now, uploadDate: Number(merged?.uploadDate) || 0 };
      }
      cur = { ...cur, ...galPatch, galleryId: gid };
    }
    if (cur) this._statPut(cur);
    this._logIn(gid);
    return { written: true };
  }

  // Recompute a gallery's stat record from its pages, in one transaction (db.js rebuildGalleryEntry).
  async rebuildGalleryEntry(galleryId, opts = {}) {
    const gid = String(galleryId);
    const silent = !!opts.silent;
    let prev = null, gone = false, coverChanged = false;
    this._tx(() => {
      const rows = this._pageRows(gid);
      const meta = this._metaGet(gid);
      prev = this._statGet(gid);
      this._logIn(gid);
      if (!rows.length) {
        this._coverDeleteIn(gid, 'gallery');
        gone = !prev || !meta || !!meta.isStub;
        if (gone) this._statDel(gid);
        else this._statPut({ ...prev, count: 0, size: 0, coverPage: 9999 });
        return;
      }
      let count = 0, size = 0, latestAt = 0, first = null;
      for (const r of rows) {
        const rec = parse(r.record);
        count++;
        size += rec.size || 0;
        latestAt = Math.max(latestAt, rec.cachedAt || 0);
        if (!first || r.n < first.n) first = r;
      }
      const uploadDate = prev?.uploadDate ?? (Number(meta?.uploadDate) || 0);
      this._statPut({ ...prev, galleryId: gid, count, size, latestAt, addedAt: prev?.addedAt ?? (Number(gid) || latestAt), coverPage: first.n, uploadDate });
      const orig = parse(first.orig);
      this._coverPatchIn(gid, { cover: { $page: first.n, size: orig.size, type: orig.type } });
      coverChanged = true;
    });
    if (gone) return;
    if (prev?.parentId) this.scheduleSeriesAggregate(prev.parentId);
    if (prev?.chapterCount != null) this.scheduleSeriesAggregate(gid);
    if (!silent) this.publishFeed(gid);
    else this.scheduleGallerySize(gid);
    void coverChanged;
  }

  // ── Series ──
  async refreshSeriesAggregate(ownerId, opts = {}) {
    const oid = String(ownerId);
    const changed = this._tx(() => this._aggregateIn(oid));
    if (changed && !opts.silent) this.publishFeed(oid);
  }

  _aggregateIn(oid) {
    const owner = this._statGet(oid);
    if (!owner) return false;
    const chapters = Array.isArray(this._metaGet(oid)?.chapters) ? this._metaGet(oid).chapters : null;
    if (!chapters || chapters.length < 2) {
      if (owner.chapterCount != null || owner.aggPages != null || owner.aggSize != null) {
        const { chapterCount, aggPages, aggSize, aggOrig, aggMedianPage, ...rest } = owner;
        this._statPut(rest);
        this._logIn(oid);
        return true;
      }
      return false;
    }
    const chapterStats = chapters.map(c => this._statGet(String(c.id)));
    let aggPages = 0, aggSize = 0, aggOrig = 0;
    for (const s of chapterStats) {
      if (s) { aggPages += s.count || 0; aggSize += s.size || 0; aggOrig += s.origSize ?? s.size ?? 0; }
    }
    const aggMedianPage = medianPage(chapterStats.filter(Boolean).flatMap(s => (Array.isArray(s.pageSizes)
      ? s.pageSizes.map(([w, h, n]) => ({ w, h, n }))
      : [{ ...s.medianPage, n: s.count }])));
    // The owner's record as it is now: it may be among its own chapters, read above.
    const current = this._statGet(oid);
    const { aggMedianPage: _, ...base } = current;
    this._statPut({ ...base, chapterCount: chapters.length, aggPages, aggSize, aggOrig, ...(aggMedianPage ? { aggMedianPage } : {}) });
    this._logIn(oid);
    return true;
  }

  async seriesResolve(galleryId) {
    const gid = String(galleryId);
    const meta = this._metaGet(gid);
    if (!meta) return null;
    const ownerId = meta.parentId ? String(meta.parentId) : gid;
    const ownerMeta = meta.parentId ? this._metaGet(ownerId) : meta;
    if (!ownerMeta || !Array.isArray(ownerMeta.chapters) || ownerMeta.chapters.length < 2) return null;
    return { ownerId, chapters: ownerMeta.chapters, seriesTitle: ownerMeta.seriesTitle || '', currentId: gid };
  }

  async seriesChapters(ownerId) {
    const meta = this._metaGet(String(ownerId));
    const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
    const entities = await this.getGalleriesByIds(chapters.map(c => c.id));
    return chapters.map((c, i) => ({ id: String(c.id), title: c.title || '', ...(c.number != null ? { number: c.number } : {}),
      ...(c.kind === 'volume' ? { kind: 'volume' } : {}), entity: entities[i] || null }));
  }

  // A series command (series-plan.js) in one transaction: its plan reads what it needs, then its
  // writes, deletions and the totals of every series it touched commit together, or nothing does.
  async seriesCommand(name, ...args) {
    const planOf = { attach: planAttach, remove: planRemove, reorder: planReorder, chapterTitle: planChapterTitle,
      write: planWrite, delete: planDelete, deleteSeries: planDeleteSeries, relink: planRelink }[name];
    if (!planOf) throw new BackendError('invalid', `no series command ${name}`);
    const metas = new Map(), stats = new Map(), children = new Map();
    const s = {
      meta: (id) => metas.get(String(id)),
      stat: (id) => stats.get(String(id)),
      children: (id) => children.get(String(id)),
      need: (ids = [], childrenOf = []) => ({ need: { ids: ids.map(String), childrenOf: childrenOf.map(String) } }),
    };
    const written = new Set(), deleted = [];
    const plan = this._tx(() => {
      let out;
      for (;;) {
        out = planOf(s, ...args);
        if (!out?.need) break;
        const { ids, childrenOf } = out.need;
        const missing = ids.filter(id => !metas.has(id) || !stats.has(id));
        const kids = childrenOf.filter(id => !children.has(id));
        if (!missing.length && !kids.length) throw new BackendError('aborted', `series plan ${name} asked again for what it has`);
        for (const id of missing) { metas.set(id, this._metaGet(id)); stats.set(id, this._statGet(id)); }
        for (const id of kids) children.set(id, this._s('SELECT gid FROM stats WHERE parent_key = ? ORDER BY gid').all(id).map(r => String(r.gid)));
      }
      const gone = new Set(out.deletes.map(String));
      for (const [gid, patch] of out.writes) {
        if (gone.has(gid)) continue;
        if (this._mutateIn(gid, patch, out.opts.get(gid) || {}).written) written.add(gid);
      }
      for (const gid of gone) deleted.push([gid, this._deleteIn(gid)]);
      for (const oid of new Set(out.totals.map(String))) {
        if (!gone.has(oid) && this._aggregateIn(oid)) written.add(oid);
      }
      return out;
    });
    const totalled = new Set(plan.totals.map(String));
    for (const [gid, meta] of deleted) {
      this._afterDelete(gid, meta);
      if (meta?.parentId && !totalled.has(String(meta.parentId))) this.scheduleSeriesAggregate(meta.parentId);
    }
    for (const gid of written) { if (plan.silent) this.scheduleGallerySize(gid); else this.publishFeed(gid); }
    return plan.result;
  }

  async deleteGallery(galleryId) { await this.seriesCommand('delete', String(galleryId)); }

  // Everything a gallery has, deleted inside the caller's transaction; returns the metadata it had.
  _deleteIn(gid) {
    const meta = this._metaGet(gid);
    this._metaDel(gid);
    this._statDel(gid);
    this._logIn(gid);
    const cover = this._coverGet(gid);
    if (cover) {
      for (const ref of fileRefs(cover)) this._drop(path.join(this.cacheDir, ref));
      this._s('DELETE FROM covers WHERE gid = ?').run(gid);
    }
    for (const row of this._pageRows(gid)) this._pageDrop(row);
    this.files.deleteIn(gid);
    return meta;
  }

  _afterDelete(gid, meta) {
    this._push('control', { type: 'GALLERY_DELETED', galleryId: gid, sourceId: meta?.sourceId || null });
    this.publishFeed(gid);
  }

  // ── Pages ──
  async pageGet(galleryId, pageNum) {
    const row = this._pageRow(galleryId, pageNum);
    return row ? this._readRecord(row) : null;
  }
  async _readRecord(row) {
    const rec = await this._internalize(parse(row.record), row.gid, parse(row.orig), row.n);
    return { ...rec, pageNum: row.n };
  }

  async pageHas(galleryId, pageNum) { return !!this._pageRow(galleryId, pageNum); }

  async pageList(galleryId) {
    return this._s('SELECT n, key FROM pages WHERE gid = ? ORDER BY n').all(String(galleryId))
      .map(r => ({ pageNum: r.n, url: r.key }));
  }

  async getGalleryImageRecords(galleryId) {
    return Promise.all(this._pageRows(galleryId).map(r => this._readRecord(r)));
  }

  // A page's image: its original, or with `variant` 'translated' its translated image when it is
  // stored as one (a translation kept as its study layers is composed by the window, which can draw).
  async getPageBlob(galleryId, pageNum, variant) {
    const row = this._pageRow(galleryId, pageNum);
    if (!row) return null;
    const rec = parse(row.record);
    if (variant === 'translated' && rec.translated != null) {
      if (typeof rec.translated === 'string') return imageToBlob(rec.translated);
      if (isRef(rec.translated)) return this._readCache(rec.translated);
    }
    if (typeof rec.dataUrl === 'string' && !rec.blob) return imageToBlob(rec.dataUrl);
    return this._readOrig(row.gid, row.n, parse(row.orig));
  }

  // Page `n` of a gallery, under `key` (which must carry that number) or `local://<gid>/<n>.<type>`.
  async pagePut(galleryId, pageNum, image, { key, mediaId, meta } = {}) {
    const gid = String(galleryId);
    const n = pageNum == null && key != null ? keyPage(key) : Number(pageNum);
    if (!Number.isSafeInteger(n) || n < 1) throw new BackendError('invalid', `not a page number: ${pageNum ?? key}`);
    const blob = await imageToBlob(image);
    if (!blob) throw new BackendError('invalid', 'no image');
    const url = key ?? `local://${gid}/${n}.${EXT_OF_TYPE[blob.type] || 'jpg'}`;
    if (keyPage(url) !== n) throw new BackendError('invalid', `key ${url} is not page ${n}`);
    await this._dbPut(url, blob, mediaId ?? gid, gid, meta ? { meta } : {});
    return n;
  }

  // Store one page and keep its gallery's stat record and cover in step, in one transaction, the
  // metadata given with it too (db.js dbPut). A key another gallery holds moves to this one.
  async _dbPut(url, blob, mediaId, galleryId, opts = {}) {
    const gid = String(galleryId || mediaId);
    const meta = opts.meta ? canonicalMeta({ ...opts.meta, galleryId: gid }) : null;
    const n = keyPage(url);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = bytes.length, type = blob.type || '', cachedAt = Date.now();
    const dims = measure(bytes);
    const orig = await this._stage(gid, n, bytes, type);
    let coverChanged = false, aggParent = null, aggSelf = null, movedFrom = null, aggMovedParent = null;
    this._tx(() => {
      if (meta) this._metaPutRaw(meta);
      const prev = this._pageRowByKey(url);
      const sameGallery = !!prev && prev.gid === gid;
      const atN = this._pageRow(gid, n);
      // The page this one replaces: the same key, or (stored under another key) the same number.
      const replaced = [prev, atN && atN.key !== url ? atN : null].filter(Boolean);
      for (const row of replaced) this._pageDrop(row);
      this._pagePutRow({ gid, n, key: url, w: dims?.w, h: dims?.h, orig,
        record: { url, blob: { $orig: 1, size, type }, mediaId: String(mediaId), galleryId: gid, cachedAt, size } });
      this._logIn(gid);
      if (prev && !sameGallery) {
        this._logIn(prev.gid);
        movedFrom = prev.gid;
        const old = this._statGet(prev.gid);
        if (old) {
          if (old.parentId) aggMovedParent = old.parentId;
          this._statPut({ ...old, count: this._pageCount(prev.gid), size: Math.max(0, (Number(old.size) || 0) - sizeOf(prev)) });
        }
      }
      const cur = this._statGet(gid);
      if (cur) {
        if (cur.parentId) aggParent = cur.parentId;
        if (cur.chapterCount != null) aggSelf = gid;
        const replacedHere = replaced.filter(r => r.gid === gid).reduce((sum, r) => sum + sizeOf(r), 0);
        const entry = { ...cur, count: this._pageCount(gid), size: (Number(cur.size) || 0) - replacedHere + size,
          latestAt: Math.max(cur.latestAt || 0, cachedAt) };
        if (entry.addedAt == null) entry.addedAt = Number(gid) || entry.latestAt;
        if (meta?.uploadDate != null) entry.uploadDate = Number(meta.uploadDate) || 0;
        if (n <= (cur.coverPage ?? 9999)) {
          entry.coverPage = n;
          this._coverPatchIn(gid, { cover: { $page: n, size, type } });
          coverChanged = true;
        }
        this._statPut(entry);
      } else {
        const m = this._metaGet(gid);
        if (n < 9999) { this._coverPatchIn(gid, { cover: { $page: n, size, type } }); coverChanged = true; }
        this._statPut({ galleryId: gid, count: this._pageCount(gid), size, latestAt: cachedAt,
          addedAt: Number(gid) || cachedAt, coverPage: n, uploadDate: Number(m?.uploadDate) || 0 });
      }
    }, [path.join(this.stagingDir, orig.file)]);
    this.files.pageStored(gid);
    if (coverChanged) this._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
    if (aggParent) this.scheduleSeriesAggregate(aggParent);
    if (aggSelf) this.scheduleSeriesAggregate(aggSelf);
    if (movedFrom) {
      if (aggMovedParent) this.scheduleSeriesAggregate(aggMovedParent);
      this.publishFeed(movedFrom);
    }
    this.publishFeed(gid);
  }

  // Delete the pages whose keys aren't in `keepUrls` (the tidy-up after an overwrite), then recount.
  async deleteStaleGalleryImages(galleryId, keepUrls) {
    const gid = String(galleryId);
    const keep = new Set(keepUrls || []);
    const removed = this._tx(() => {
      let count = 0;
      for (const row of this._pageRows(gid)) {
        if (keep.has(row.key)) continue;
        this._pageDrop(row);
        count++;
        this._logIn(gid);
      }
      return count;
    });
    if (removed) await this.rebuildGalleryEntry(gid, { silent: true });
    return removed;
  }

  // ── Page-derived data ──
  // A page record changed by `change(rec)` (true when it changed it), with `value`'s Blobs written to
  // the cache first. Resolves whether the page was there and changed.
  async _derive(at, value, change, { size = true } = {}) {
    const gid = String(typeof at === 'string' ? (this._pageRowByKey(at)?.gid ?? '') : at?.galleryId);
    const { value: stored, fresh } = await this._externalize(value, gid || '_', `p${typeof at === 'string' ? keyPage(at) : at?.pageNum}`);
    let changed = false;
    this._tx(() => {
      const row = this._pageAt(at);
      if (!row) return;
      const rec = this._rowRecord(row);
      if (change(rec, stored) === false) return;
      this._pageRewrite(row, rec);
      this._logIn(row.gid);
      changed = row.gid;
    }, fresh);
    if (!changed) { for (const file of fresh) fsp.rm(file, { force: true }).catch(() => {}); return false; }
    if (size) this.scheduleGallerySize(changed);
    return true;
  }

  async putTranslatedPage(at, image, pipeline, own) {
    await this._derive(at, { image, pipeline }, (rec, { image: img, pipeline: pipe }) => {
      delete rec.studyBg;
      delete rec.studyPage;
      delete rec.bubbles;
      for (const key of RETIRED_FIELDS) delete rec[key];
      if (img) { rec.translated = img; delete rec.translatedLayers; }
      else { delete rec.translated; rec.translatedLayers = true; }
      if (pipe) rec.pipeline = pipe;
      else delete rec.pipeline;
      if (own) rec.own = own;
      else if (own !== undefined) delete rec.own;
    });
  }

  async putPageData(at, data) {
    const restorable = {};
    for (const key of RESTORABLE) if (data?.[key] !== undefined) restorable[key] = data[key];
    await this._derive(at, restorable, (rec, values) => { Object.assign(rec, values); });
  }

  async setPagesOwn(pages, own) {
    for (const at of pages) {
      await this._derive(at, null, (rec) => { if (own) rec.own = own; else delete rec.own; });
    }
  }

  async putTranslatedImage(at, translatedSrc) {
    await this._derive(at, { image: translatedSrc }, (rec, { image }) => { rec.translated = image; });
  }

  async putPageStudy(at, study, job = null) {
    await this._derive(at, { bg: study?.bg || null, bubbles: study?.bubbles, page: study?.page || null }, (rec, s) => {
      if (!(job == null || rec.pipeline?.job === job)) return false;
      rec.studyBg = s.bg || null;
      rec.bubbles = s.bubbles;
      rec.studyPage = s.page || null;
    });
  }

  async clearGalleryTranslations(galleryId, { keepSnapshots = false } = {}) {
    const gid = String(galleryId);
    const cleared = this._tx(() => {
      let count = 0;
      for (const row of this._pageRows(gid)) {
        const v = this._rowRecord(row);
        if (!(v.translated !== undefined || v.translatedLayers || v.bubbles !== undefined || (!keepSnapshots && v.pipeline))) continue;
        const had = v.translated !== undefined || !!v.translatedLayers;
        if (!keepSnapshots) delete v.pipeline;
        delete v.translated;
        delete v.translatedLayers;
        delete v.bubbles;
        delete v.studyBg;
        delete v.studyPage;
        for (const key of RETIRED_FIELDS) delete v[key];
        this._pageRewrite(row, v);
        this._logIn(gid);
        if (had) count++;
      }
      return count;
    });
    this.scheduleGallerySize(gid);
    return cleared;
  }

  async listGalleryStudyRecords(galleryId) {
    const hits = this._pageRows(galleryId).filter(r => { const b = parse(r.record).bubbles; return Array.isArray(b) && b.length; });
    const recs = await Promise.all(hits.map(r => this._readRecord(r)));
    return recs.map(v => ({ url: v.url, bg: v.studyBg || null, bubbles: v.bubbles, page: v.studyPage || null,
      job: v.pipeline?.job || null, translated: v.translated != null }));
  }

  // ── Covers ──
  // Merge `patch` into a gallery's cover record inside the caller's transaction: a replaced image
  // drops that role's thumbnails and gets a new revision (db.js putCoverPatch).
  _coverPatchIn(galleryId, patch) {
    const gid = String(galleryId);
    const current = this._coverGet(gid) || {};
    const coverThumbs = { ...(current.coverThumbs || {}) };
    const coverRevisions = { ...(current.coverRevisions || {}) };
    for (const [role, field] of [['gallery', 'cover'], ['series', 'seriesCover']]) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      delete coverThumbs[role];
      coverRevisions[role] = crypto.randomUUID();
    }
    const next = { ...current, galleryId: gid, ...patch, coverRevisions };
    if (Object.keys(coverThumbs).length) next.coverThumbs = coverThumbs;
    else delete next.coverThumbs;
    const kept = fileRefs(next);
    for (const ref of fileRefs(current)) if (!kept.has(ref)) this._drop(path.join(this.cacheDir, ref));
    this._coverPut(next);
    this._logIn(gid);
  }

  _coverDeleteIn(galleryId, role) {
    const gid = String(galleryId);
    const rec = this._coverGet(gid);
    if (!rec) return;
    this._logIn(gid);
    const before = fileRefs(rec);
    const coverRole = role === 'series' ? 'series' : 'gallery';
    if (coverRole === 'series') delete rec.seriesCover;
    else delete rec.cover;
    if (rec.coverThumbs) {
      delete rec.coverThumbs[coverRole];
      if (!Object.keys(rec.coverThumbs).length) delete rec.coverThumbs;
    }
    if (rec.coverRevisions) {
      delete rec.coverRevisions[coverRole];
      if (!Object.keys(rec.coverRevisions).length) delete rec.coverRevisions;
    }
    const keep = rec.cover || rec.seriesCover;
    const after = keep ? fileRefs(rec) : new Set();
    for (const ref of before) if (!after.has(ref)) this._drop(path.join(this.cacheDir, ref));
    if (keep) this._coverPut(rec);
    else this._s('DELETE FROM covers WHERE gid = ?').run(gid);
  }

  async coverGet(galleryId, opts = {}) {
    const gid = String(galleryId);
    const { source } = selectCover(this._coverGet(gid), opts);
    return source ? this._internalize(source, gid) : null;
  }

  // The selected cover and any thumbnail stored for `maxW`. The cover's own bytes travel only when
  // there is no such thumbnail yet (they are what one is made from); otherwise `source` is `true`.
  async coverThumbnailGet(galleryId, maxW, opts = {}) {
    const gid = String(galleryId);
    const widthKey = coverWidthKey(maxW);
    const rec = this._coverGet(gid);
    const selected = selectCover(rec, opts);
    const thumb = widthKey ? (rec?.coverThumbs?.[selected.role]?.[widthKey] || null) : null;
    const thumbnail = thumb ? await this._internalize(thumb, gid) : null;
    const source = !selected.source ? null : (thumbnail ? true : await this._internalize(selected.source, gid));
    return { role: selected.role, source, thumbnail, revision: rec?.coverRevisions?.[selected.role], hasSeriesCover: !!rec?.seriesCover };
  }

  async coverPreviewGet(galleryId) {
    const gid = String(galleryId);
    const rec = this._coverGet(gid);
    const thumbs = rec?.coverThumbs?.gallery || {};
    const width = Object.keys(thumbs).filter(w => thumbs[w]).sort((a, b) => a - b)[0];
    return this._internalize((width && thumbs[width]) || rec?.cover || null, gid);
  }

  async coverThumbnailPut(galleryId, role, maxW, thumbnail, revision) {
    const gid = String(galleryId);
    const widthKey = coverWidthKey(maxW);
    const blob = await imageToBlob(thumbnail);
    if (!widthKey || !blob || (role !== 'gallery' && role !== 'series')) return false;
    const { value: ref, fresh } = await this._externalize(blob, gid, `thumb-${role}-${widthKey}`);
    const stored = this._tx(() => {
      const rec = this._coverGet(gid);
      const sourceField = role === 'series' ? 'seriesCover' : 'cover';
      if (!rec?.[sourceField] || rec.coverRevisions?.[role] !== revision) return false;
      const old = rec.coverThumbs?.[role]?.[widthKey];
      if (old) for (const r of fileRefs(old)) this._drop(path.join(this.cacheDir, r));
      const roleThumbs = { ...(rec.coverThumbs?.[role] || {}), [widthKey]: ref };
      this._coverPut({ ...rec, coverThumbs: { ...(rec.coverThumbs || {}), [role]: roleThumbs } });
      return true;
    }, fresh);
    if (!stored) for (const file of fresh) fsp.rm(file, { force: true }).catch(() => {});
    return stored;
  }

  async coverPut(galleryId, cover, opts = {}) {
    const gid = String(galleryId);
    const role = opts === 'series' ? 'series' : opts.role;
    const silent = opts !== 'series' && !!opts.silent;
    const { value: image, fresh } = await this._externalize(await imageToBlob(cover) ?? cover, gid, `cover-${role === 'series' ? 'series' : 'gallery'}`);
    this._tx(() => this._coverPatchIn(gid, role === 'series' ? { seriesCover: image } : { cover: image }), fresh);
    if (!silent) {
      this._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
      this.publishFeed(gid);
    }
  }

  // ── Source icons ──
  async sourceIconGet(source) { return parse(this._s('SELECT record FROM icons WHERE source = ?').get(String(source || ''))?.record); }
  async sourceIconsAll() { return this._s('SELECT record FROM icons ORDER BY source').all().map(r => parse(r.record)); }
  async sourceIconPut(source, patch) {
    const key = String(source || '');
    if (!key) return;
    this._tx(() => {
      const cur = parse(this._s('SELECT record FROM icons WHERE source = ?').get(key)?.record) || {};
      this._s('INSERT INTO icons (source, record) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET record = excluded.record')
        .run(key, JSON.stringify({ ...cur, source: key, ...patch }));
    });
  }

  // ── Transfer: a gallery's records exactly as stored ──
  async transferIds() {
    const ids = new Set();
    for (const sql of ['SELECT gid FROM meta ORDER BY gid', 'SELECT gid FROM stats ORDER BY gid', 'SELECT gid FROM covers ORDER BY gid',
      'SELECT DISTINCT gid FROM pages ORDER BY gid']) {
      for (const r of this._s(sql).all()) ids.add(String(r.gid));
    }
    return [...ids];
  }

  async transferRead(galleryId) {
    const gid = String(galleryId);
    const cover = this._coverGet(gid);
    return {
      meta: this._metaGet(gid),
      stat: this._statGet(gid),
      pages: await this.getGalleryImageRecords(gid),
      cover: cover ? await this._internalize(cover, gid) : null,
    };
  }

  // Write one gallery's records as given, in one transaction; sizes are brought up to date after.
  async transferWrite({ galleryId = null, meta = null, stat = null, pages = [], cover = null } = {}, { silent = false } = {}) {
    const gid = String(galleryId ?? meta?.galleryId ?? stat?.galleryId ?? pages[0]?.galleryId ?? '');
    if (!gid) throw new BackendError('invalid', 'a gallery to restore names no gallery');
    const fresh = [];
    const staged = [];
    try {
      for (const rec of pages || []) {
        const n = keyPage(rec?.url);
        if (n == null) continue;   // a page with no number can't be addressed; it is left out
        const { blob, dataUrl, pageNum, ...rest } = rec;
        const original = await imageToBlob(blob ?? dataUrl);
        if (!original) continue;
        const bytes = new Uint8Array(await original.arrayBuffer());
        const orig = await this._stage(gid, n, bytes, original.type || '');
        fresh.push(path.join(this.stagingDir, orig.file));
        const { value, fresh: files } = await this._externalize(rest, gid, `p${n}`);
        fresh.push(...files);
        staged.push({ n, key: String(rec.url), dims: measure(bytes), orig,
          record: { ...value, galleryId: gid, blob: { $orig: 1, size: bytes.length, type: original.type || '' } } });
      }
      const coverPatch = {};
      for (const field of ['cover', 'seriesCover']) {
        if (!cover?.[field]) continue;
        const { value, fresh: files } = await this._externalize(await imageToBlob(cover[field]) ?? cover[field], gid, `cover-${field}`);
        fresh.push(...files);
        coverPatch[field] = value;
      }
      this._tx(() => {
        this._logIn(gid);
        if (meta) this._metaPutRaw(canonicalMeta({ ...meta, galleryId: gid }));
        if (stat) this._statPut({ ...stat, galleryId: gid, uploadDate: uploadDateSeconds(stat.uploadDate ?? (Number(meta?.uploadDate) || 0)) });
        for (const p of staged) {
          const prev = this._pageRowByKey(p.key);
          if (prev) this._pageDrop(prev);
          const atN = this._pageRow(gid, p.n);
          if (atN) this._pageDrop(atN);
          this._pagePutRow({ gid, n: p.n, key: p.key, w: p.dims?.w, h: p.dims?.h, orig: p.orig, record: p.record });
        }
        if (Object.keys(coverPatch).length) this._coverPatchIn(gid, coverPatch);
      }, fresh);
    } catch (e) {
      for (const file of fresh) fsp.rm(file, { force: true }).catch(() => {});
      throw e;
    }
    if (staged.length) this.files.pageStored(gid);
    if (!silent) this.publishFeed(gid);
    else this.scheduleGallerySize(gid);
  }

  // ── Maintenance ──
  // What library-check.js checks (db.js integritySnapshot). An image's id is its cache file, or
  // `orig:<gid>/<n>` for an original page that can be read.
  async integritySnapshot() {
    const title = (m) => { const t = normalizeTitle(m); return String(t.english || t.pretty || t.japanese || '').slice(0, 80); };
    const out = { metas: [], galleries: [], pages: [], covers: [], images: [], exportSizes: {}, pagesWithoutGallery: 0 };
    const metaById = new Map(), coverById = new Map(), pagesBy = new Map();
    const origIds = [];
    this._tx(() => {
      for (const r of this._s('SELECT record FROM meta ORDER BY gid').all()) {
        const m = parse(r.record);
        metaById.set(String(m.galleryId), m);
        out.metas.push({ gid: String(m.galleryId), title: title(m), isStub: !!m.isStub,
          parentId: m.parentId ? String(m.parentId) : null, chapters: Array.isArray(m.chapters) ? m.chapters.map(c => String(c?.id)) : null,
          sourceId: m.sourceId != null && m.sourceId !== '' ? String(m.sourceId) : null, source: m.source || null });
      }
      for (const r of this._s('SELECT record FROM stats ORDER BY gid').all()) {
        const { galleryId, count, size, origSize, latestAt, addedAt, uploadDate, parentId, chapterCount, aggPages, aggSize } = parse(r.record);
        out.galleries.push({ gid: String(galleryId), count, size, origSize, latestAt, addedAt, uploadDate,
          parentId: parentId ? String(parentId) : null, chapterCount, aggPages, aggSize });
      }
      for (const r of this._s('SELECT record FROM covers ORDER BY gid').all()) {
        const c = parse(r.record);
        coverById.set(String(c.galleryId), c);
        const refs = [...fileRefs(c)];
        for (const v of [c.cover, c.seriesCover]) if (v?.$page != null) refs.push(`orig:${c.galleryId}/${v.$page}`);
        out.covers.push({ gid: String(c.galleryId), refs });
      }
      for (const row of this._s('SELECT * FROM pages ORDER BY gid, key').all()) {
        const rec = this._rowRecord(row);
        if (!pagesBy.has(row.gid)) pagesBy.set(row.gid, []);
        pagesBy.get(row.gid).push(rec);
        out.pages.push({ url: row.key, gid: row.gid, pageNum: row.n, refs: [`orig:${row.gid}/${row.n}`, ...fileRefs(rec)] });
        origIds.push([row.gid, row.n, parse(row.orig)]);
      }
    });
    const sizeOfGallery = (gid) => {
      const cover = coverById.get(gid);
      out.exportSizes[gid] = exportSize(galleryFiles({ meta: metaById.get(gid) || null, records: pagesBy.get(gid) || [],
        covers: { gallery: cover?.cover, series: cover?.seriesCover } }));
    };
    for (const gid of pagesBy.keys()) sizeOfGallery(gid);
    for (const g of out.galleries) if (!(g.gid in out.exportSizes)) sizeOfGallery(g.gid);
    for (const [gid, n, orig] of origIds) if (await this._origExists(gid, n, orig)) out.images.push(`orig:${gid}/${n}`);
    out.images.push(...await this._cacheFiles());
    return out;
  }

  // Whether page `n`'s original can be read (where its row said, or where it has moved since).
  async _origExists(gid, n, orig) {
    const at = (o) => (o?.at === 's' ? fsp.access(path.join(this.stagingDir, o.file)).then(() => true, () => false) : this.files.hasOriginal(gid, o));
    if (await at(orig)) return true;
    const now = parse(this._pageRow(gid, n)?.orig);
    return !!now && !sameOrig(now, orig) && at(now);
  }

  async _cacheFiles() {
    const out = [];
    for (const dir of await fsp.readdir(this.cacheDir).catch(() => [])) {
      for (const name of await fsp.readdir(path.join(this.cacheDir, dir)).catch(() => [])) out.push(`${dir}/${name}`);
    }
    return out;
  }

  // Everything in the library, cleared in one step (Settings → clear everything).
  async clearAll() {
    this._tx(() => {
      for (const table of ['meta', 'meta_tags', 'stats', 'pages', 'covers', 'icons']) this._s(`DELETE FROM ${table}`).run();
      this.files.clearIn();
      this._logIn('*');
    });
    this._dirs.clear();
    for (const dir of [this.cacheDir, this.stagingDir]) {
      for (const name of await fsp.readdir(dir).catch(() => [])) await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
