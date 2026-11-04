// storage-fixtures.mjs — the migration fixtures (plan D13), made in a test's own temporary folder:
// - desktopLibrary(name, base): a desktop library as an earlier version left it — base/data/library.db
//   and its library folders' files (base/library, and base/second and base/third where it had them),
//   loaded from storage/<name>.json (capture-storage-fixtures.mjs recorded them, running that version).
// - indexedDBLibrary(name, factory): the website library's IndexedDB ('shiori-cache') as that version
//   left it, in `factory` (fake-indexeddb's under Node).
// - v1Gallery(dir, { files }): a gallery folder in description format v1 whose page 1 was replaced and
//   saved under a suffixed name beside the old file: with image_records.json's `files` list naming it
//   (as written since the list exists) or without (as written before).
// - legacyGallery(dir): a gallery folder in the desktop's oldest format: shiori.json beside its pictures.
// The captured libraries hold Windows paths (where they were made, and the desktop's platform: D14).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { galleryFiles } from '../../js/storage/gallery-files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP_FIXTURES = ['desktop-v1.2.6', 'desktop-kv-roots', 'desktop-roots', 'desktop-unplaced'];
export const INDEXEDDB_FIXTURES = ['indexeddb-16', 'indexeddb-18', 'indexeddb-19'];
// The galleries every captured library holds (capture-storage-fixtures.mjs): A archived with a cover
// of its own, B a folder, C a folder in a hidden library folder (where the version had folders).
export const FIXTURE_GIDS = { a: '1790000000001', b: '1790000000002', c: '1790000000003' };

export const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'storage', `${name}.json`), 'utf8'));
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

// A captured string with the temporary folder it was made in put back as `base`.
function placed(value, base) {
  if (typeof value !== 'string') return value;
  return value.split('$BASE_JSON').join(JSON.stringify(base).slice(1, -1)).split('$BASE').join(base);
}

export async function desktopLibrary(name, base) {
  const fx = loadFixture(name);
  for (const [rel, b64] of Object.entries(fx.files)) write(path.join(base, ...rel.split('/')), Buffer.from(b64, 'base64'));
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'library.db'));
  try {
    db.exec('BEGIN');
    for (const s of fx.schema) db.exec(s.sql);
    for (const [table, rows] of Object.entries(fx.rows)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map(c => placed(row[c], base)));
      }
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  return { dataDir, libraryDir: path.join(base, 'library'), fixture: fx };
}

export async function indexedDBLibrary(name, factory = globalThis.indexedDB) {
  const fx = loadFixture(name);
  const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const open = factory.open('shiori-cache', fx.version);
  open.onupgradeneeded = () => {
    for (const s of fx.stores) {
      const store = open.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
      for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
    }
  };
  const db = await done(open);
  const tx = db.transaction(fx.stores.map(s => s.name), 'readwrite');
  for (const s of fx.stores) {
    for (const r of s.records) {
      if (s.keyPath == null) tx.objectStore(s.name).put(withBlobs(r.value), r.key);
      else tx.objectStore(s.name).put(withBlobs(r.value));
    }
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
  return { fixture: fx };
}
// A captured record with its Blobs put back ({ $fixtureBlob: base64, type }).
function withBlobs(value) {
  if (Array.isArray(value)) return value.map(withBlobs);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$fixtureBlob === 'string') return new Blob([Buffer.from(value.$fixtureBlob, 'base64')], { type: value.type });
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withBlobs(v)]));
}

// Kilobyte pictures, told apart by a trailing byte.
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const pictureBytes = (b64, n) => Buffer.concat([Buffer.from(b64, 'base64'), Buffer.from([n])]);
const picture = (b64, type, n) => new Blob([pictureBytes(b64, n)], { type });
const title = (english) => ({ english, japanese: '', pretty: english });

export async function v1Gallery(dir, { files = true } = {}) {
  const gid = '1790000000011';
  const replaced = picture(WEBP, 'image/webp', 11);
  const renamed = 'images/0001-3fa2c9e1.webp';
  const records = [
    { pageNum: 1, url: `local://${gid}/1.webp`, galleryId: gid, mediaId: gid, cachedAt: 1, size: replaced.size, blob: replaced,
      translated: picture(PNG, 'image/png', 1) },
    { pageNum: 2, url: `local://${gid}/2.webp`, galleryId: gid, mediaId: gid, cachedAt: 1, size: 46, blob: picture(WEBP, 'image/webp', 2) },
  ];
  const laid = galleryFiles({ meta: { galleryId: gid, title: title('Version one'), tags: [] }, records }, '',
    files ? { fileOf: (src) => (src === replaced ? renamed : null) } : {});
  for (const f of laid) {
    const bytes = f.source instanceof Blob ? Buffer.from(await f.source.arrayBuffer()) : Buffer.from(f.source);
    write(path.join(dir, ...(f.source === replaced ? renamed : f.name).split('/')), bytes);
  }
  write(path.join(dir, 'images', '0001.webp'), pictureBytes(WEBP, 1));   // the picture page 1 showed before, left behind
  return { gid, current: { 1: renamed, 2: 'images/0002.webp' }, stale: ['images/0001.webp'] };
}

export function legacyGallery(dir) {
  const gid = '1790000000012';
  const pages = [1, 2].map(n => ({ n, file: `000${n}.webp`, key: `local://${gid}/${n}.webp`, mediaId: gid, cachedAt: 1 }));
  for (const p of pages) write(path.join(dir, p.file), pictureBytes(WEBP, 20 + p.n));
  write(path.join(dir, 'shiori.json'), JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
    meta: { galleryId: gid, title: title('The oldest format'), tags: [], numPages: pages.length }, pages }, null, 2));
  return { gid, pages: pages.map(p => p.file) };
}
