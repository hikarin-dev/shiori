// first-folder.test.mjs — the desktop app opens the library its first library folder holds, as main.js
// does at its start (files.js firstLibrary). A first folder whose .shiori/library.json the person deleted
// is still told for that library's by the folder itself, and the library carries on with its other
// folders and the person's marks (review 4 F5). Where the folder at the path can't be told for the
// library's — another drive at its letter, nothing there, or an index from before the app noted its
// folder — nothing is opened and nothing is written there (O1); a folder the person picks is theirs to
// start a library in. An index v1.0.13 or v1.0.14 left (named by its folder's path, no library.json ever
// written) is none of those: a folder it was kept in starts a library as in v1.1.0 (S17).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { firstLibrary } = await import('../server/files.js');
const { writeZip } = await import('../server/zip.js');

const png = (n) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : null);

// A computer's data folder and first library folder in a temporary folder; `start` opens the library as
// main.js does: the one the first folder holds, its index found by that library's id (the last one
// opened is closed at the end).
function computer(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-first-'));
  let open = null;
  t.after(() => { open?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const libraries = path.join(base, 'userData', 'libraries'), libraryDir = path.join(base, 'Shiori Library');
  const start = async (opts) => {
    const id = await firstLibrary(libraries, libraryDir, opts);
    return (open = await new Library({ dataDir: path.join(libraries, id), libraryDir, placeDelay: 0, describeDelay: 600_000 }).open());
  };
  return { base, libraries, libraryDir, start };
}
async function gallery(lib, name, pages) {
  const gid = String(lib.nextGalleryId());
  await lib.metaPut({ galleryId: gid, title: title(name) });
  for (let n = 1; n <= pages; n++) await lib.pagePut(gid, n, png(n));
  return gid;
}
const refused = (reason) => (e) => e?.reason === reason;
const libraryJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'library.json'), 'utf8')).id;

// The index v1.0.13 and v1.0.14 kept for library folder `folder`: named by a hash of its path, its tables
// as their library.js made them (`git show v1.0.14:desktop/server/library.js`, SCHEMA, its indexes left out)
// with one gallery's rows, closed as they closed it. Those versions never wrote a library.json.
function earlierIndex(libraries, folder) {
  const dir = path.join(libraries, crypto.createHash('sha256').update(folder.toLowerCase()).digest('hex').slice(0, 16));
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'library.db'));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (gid TEXT PRIMARY KEY, source_id TEXT, is_stub INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta_tags (tag TEXT NOT NULL, gid TEXT NOT NULL, PRIMARY KEY (tag, gid)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS stats (gid TEXT PRIMARY KEY, latest_at REAL, added_at REAL, size REAL, count REAL, upload_date REAL,
      parent_key TEXT, child INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages (gid TEXT NOT NULL, n INTEGER NOT NULL CHECK (n >= 1), key TEXT NOT NULL UNIQUE, w INTEGER, h INTEGER,
      orig TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (gid, n));
    CREATE TABLE IF NOT EXISTS covers (gid TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS icons (source TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS changes (rev INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT NOT NULL, at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (gid, record) VALUES ('1700000000001', '{"galleryId":"1700000000001"}');
    INSERT INTO changes (gid, at) VALUES ('1700000000001', 1);`);
  db.close();
  return dir;
}
const filesOf = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map(n => [n, fs.statSync(path.join(dir, n)).isFile() ? fs.readFileSync(path.join(dir, n)).toString('base64') : 'folder']));

test('review 4 F5: a first folder whose library.json the person deleted opens its own library again', async (t) => {
  const { base, libraries, libraryDir, start } = computer(t);
  let lib = await start();
  const id = lib.primaryId;
  const alpha = await gallery(lib, 'Alpha', 2);
  await lib.personalSet(alpha, { favorite: true });
  await lib.personalSet(alpha, { read: { page: 2, pages: 2 } });
  await lib.putTranslatedPage({ galleryId: alpha, pageNum: 1 }, png(9));
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  const second = (await lib.folderAdd(other)).id;
  await lib.folderSetDefault(second);
  const beta = await gallery(lib, 'Beta', 1);
  await lib.files.flush();
  lib.close();

  fs.rmSync(path.join(libraryDir, '.shiori', 'library.json'));
  lib = await start();
  assert.equal(lib.primaryId, id, 'the same library');
  assert.deepEqual(fs.readdirSync(libraries), [id], 'no new library made');
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryDir, '.shiori', 'library.json'), 'utf8')).id, id, 'its library.json put back');
  assert.deepEqual((await lib.foldersList()).map(f => [f.id, f.access]), [[id, 'granted'], [second, 'granted']], 'its other folder still in it');
  assert.deepEqual((await lib.galleryIdsSorted({ sort: 'id' })).sort(), [alpha, beta].sort());
  const marks = await lib.personalGet(alpha);
  assert.deepEqual([marks?.favorite, marks?.page, marks?.pages], [true, 2, 2], 'the person\'s marks kept');
  assert.deepEqual(await bytesOf(await lib.getPageBlob(alpha, 2)), await bytesOf(png(2)));
  assert.deepEqual(await bytesOf(await lib.getPageBlob(alpha, 1, 'translated')), await bytesOf(png(9)));
  assert.deepEqual(await bytesOf(await lib.getPageBlob(beta, 1)), await bytesOf(png(1)));
});

test('review 4 O1: another folder at the first folder\'s path, or none, opens nothing and writes nothing there', async (t) => {
  const { base, libraries, libraryDir, start } = computer(t);
  let lib = await start();
  const id = lib.primaryId;
  const alpha = await gallery(lib, 'Alpha', 1);
  await lib.files.flush();
  lib.close();

  // Another drive at its letter: a folder of the person's at the same path.
  const away = path.join(base, 'away');
  fs.renameSync(libraryDir, away);
  fs.mkdirSync(path.join(libraryDir, 'Holiday'), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'Holiday', '0001.png'), 'mine');
  const before = tree(libraryDir);
  await assert.rejects(start(), refused('unknown'));
  assert.deepEqual(tree(libraryDir), before, 'nothing written in the folder there');
  assert.deepEqual(fs.readdirSync(libraries), [id], 'no new library made');
  // No folder at the path at all: none is made.
  fs.rmSync(libraryDir, { recursive: true });
  await assert.rejects(start(), refused('missing'));
  assert.equal(fs.existsSync(libraryDir), false, 'no folder made at the path');
  // The library's own folder back (even without its library.json): the library, as it was.
  fs.renameSync(away, libraryDir);
  fs.rmSync(path.join(libraryDir, '.shiori', 'library.json'));
  lib = await start();
  assert.equal(lib.primaryId, id);
  assert.deepEqual(await bytesOf(await lib.getPageBlob(alpha, 1)), await bytesOf(png(1)));
});

test('a new library is made where no library of this computer\'s can have been, or where the person picks', async (t) => {
  const { libraries, libraryDir, start } = computer(t);
  // An index from before libraries noted their folder: the folder at the path may have been its.
  const older = path.join(libraries, '0123456789abcdef');
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, 'library.db'), '');
  fs.mkdirSync(libraryDir);
  await assert.rejects(start(), refused('unknown'));
  assert.deepEqual(tree(libraryDir), [], 'nothing written');
  // Picked by the person: a library of its own.
  const lib = await start({ chosen: true });
  assert.notEqual(lib.primaryId, '0123456789abcdef');
  assert.deepEqual(fs.readdirSync(libraries).sort(), ['0123456789abcdef', lib.primaryId].sort());
});

test('S17: a direct upgrade from v1.0.13 or v1.0.14 starts a library at its folder, the galleries in it found', async (t) => {
  const { libraries, libraryDir, start } = computer(t);
  const earlier = earlierIndex(libraries, libraryDir);
  // Its gallery as those versions kept it: an archive with its shiori.json.
  const gid = '1700000000001';
  fs.mkdirSync(path.join(libraryDir, 'Old'), { recursive: true });
  await writeZip(path.join(libraryDir, 'Old', 'Old.cbz'), [
    { name: '0001.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) },
    { name: 'shiori.json', data: Buffer.from(JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
      meta: { galleryId: gid, title: title('Old'), tags: [], numPages: 1 }, pages: [{ n: 1, file: '0001.png', key: `local://${gid}/1.png` }] })) },
  ]);
  const before = filesOf(earlier);
  const lib = await start();
  assert.notEqual(lib.primaryId, path.basename(earlier), 'a library of its own, as since v1.1.0');
  assert.equal(libraryJson(libraryDir), lib.primaryId, 'its library.json written');
  assert.deepEqual((await lib.rescan()).added, [gid], 'the gallery found by the first check');
  assert.deepEqual(await bytesOf(await lib.getPageBlob(gid, 1)), await bytesOf(png(1)));
  assert.deepEqual(filesOf(earlier), before, 'the earlier index left as it was');
});

test('S17: an index v1.0.13 or v1.0.14 left for another folder keeps no start from going on; a later one without its note still does', async (t) => {
  const { base, libraries, libraryDir, start } = computer(t);
  let lib = await start();
  const id = lib.primaryId;
  lib.close();
  const earlier = earlierIndex(libraries, path.join(base, 'Old Library'));
  const before = filesOf(earlier);
  // A folder no library of this computer's was kept in: a library of its own, as with no earlier index there.
  const fresh = path.join(base, 'Fresh');
  fs.mkdirSync(fresh);
  const made = await firstLibrary(libraries, fresh);
  assert.ok(![id, path.basename(earlier)].includes(made));
  assert.equal(libraryJson(fresh), made);
  // The library at the first folder still opens as itself without its library.json (F5).
  fs.rmSync(path.join(libraryDir, '.shiori', 'library.json'));
  lib = await start();
  assert.equal(lib.primaryId, id);
  lib.close();
  // An index from v1.1.0 on that hasn't noted its folder (made before the notes) still counts: a folder
  // without a library.json that no note names may have been its, so nothing is opened or written there.
  fs.rmSync(path.join(libraries, id, 'first-folder.json'));
  const other = path.join(base, 'Other');
  fs.mkdirSync(other);
  await assert.rejects(firstLibrary(libraries, other), refused('unknown'));
  assert.deepEqual(tree(other), [], 'nothing written');
  assert.deepEqual(filesOf(earlier), before, 'the earlier index left as it was');
});
