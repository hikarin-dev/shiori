// first-folder.test.mjs — the desktop app opens the library its first library folder holds, as main.js
// does at its start (files.js firstLibrary). A first folder whose .shiori/library.json the person deleted
// is still told for that library's by the folder itself, and the library carries on with its other
// folders and the person's marks (review 4 F5). Where the folder at the path can't be told for the
// library's — another drive at its letter, nothing there, or an index from before the app noted its
// folder — nothing is opened and nothing is written there (O1); a folder the person picks is theirs to
// start a library in.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { firstLibrary } = await import('../server/files.js');

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
