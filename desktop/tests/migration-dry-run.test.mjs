// migration-dry-run.test.mjs — the owner-run dry run of the carry-over to format v2 (plan D13,
// scripts/migration-dry-run.mjs), on a library captured from the last build before it
// (app/tests/fixtures/storage/desktop-unplaced.json) with a row in each table this build drops: it reports
// what opening the library would do, changes nothing — not the index, not a file of the library folders
// — and opening the library with today's code then does what it said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { desktopLibrary } = await import('../../app/tests/fixtures/storage-fixtures.mjs');
const { dryRun } = await import('../scripts/migration-dry-run.mjs');
const { Library } = await import('../server/library.js');

const B = '1790000000002', SECOND = 'd7a2e3b6237f6597';
// Every file under `dir`: path → [size, mtime].
function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
    const st = fs.statSync(path.join(dir, rel));
    if (st.isFile()) out[rel] = [st.size, st.mtimeMs];
  }
  return out;
}

test('the dry run reports what the carry-over to format v2 would do, changes nothing, and opening the library then does it', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-dry-run-test-'));
  let library = null;
  t.after(() => { library?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const { dataDir, libraryDir } = await desktopLibrary('desktop-unplaced', base);
  const gallery = path.join(base, 'second', 'Fixture B');
  // A picture written beside its place and not yet renamed into it, a leftover page file, and an
  // archived gallery's old folder still to delete — as the last build left them.
  fs.writeFileSync(path.join(gallery, 'translated', '0001.png.ab12cd34ef.shiori-new'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 77]));
  fs.writeFileSync(path.join(gallery, 'images', '0003.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46, 3]));
  fs.mkdirSync(path.join(base, 'second', 'Old Folder', 'images'), { recursive: true });
  fs.writeFileSync(path.join(base, 'second', 'Old Folder', 'metadata.json'), JSON.stringify({ galleryId: '1790000000009', title: { english: 'Old', japanese: '', pretty: '' } }));
  fs.writeFileSync(path.join(base, 'second', 'Old Folder', 'images', '0001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
  const db = new DatabaseSync(path.join(dataDir, 'library.db'));
  db.prepare('INSERT INTO unplaced (gid, rel, temp) VALUES (?, ?, ?)').run(B, 'translated/0001.png', 'translated/0001.png.ab12cd34ef.shiori-new');
  db.prepare('INSERT INTO leftovers (gid, entry) VALUES (?, ?)').run(B, 'images/0003.webp');
  db.prepare('INSERT INTO retired (path) VALUES (?)').run(`@${SECOND}/Old Folder`);
  db.close();

  const before = snapshot(base);
  const report = await dryRun(dataDir);
  assert.deepEqual(snapshot(base), before, 'nothing changed: not the index, not a file');
  assert.deepEqual(report.tables, { leftovers: 1, retired: 1, unplaced: 1 });
  assert.match(report.unplaced[0].becomes, /^renamed to translated\/0001-ab12cd34ef\.png/);
  assert.match(report.leftovers[0].becomes, /^retires/);
  assert.match(report.retired[0].becomes, /^retires: each of its files/);
  assert.equal(report.galleries.folders, 2);
  assert.equal(report.galleries.archives, 1);
  assert.equal(report.galleries.linked, 1);

  library = await new Library({ dataDir, libraryDir, placeDelay: 0, describeDelay: 600_000 }).open();
  for (let i = 0; i < 50 && library._s(`SELECT 1 FROM sqlite_schema WHERE name = 'unplaced'`).get(); i++) await new Promise(r => setTimeout(r, 20));
  const rec = JSON.parse(library._pageRow(B, 1).record);
  assert.equal(rec.translated.$own, 'translated/0001-ab12cd34ef.png', 'the picture keeps the name it was written under, its record pointed at it');
  assert.deepEqual([...new Uint8Array(await (await library.getPageBlob(B, 1, 'translated')).arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 77]);
  for (const table of ['unplaced', 'leftovers', 'retired']) assert.equal(library._s(`SELECT 1 FROM sqlite_schema WHERE name = ?`).get(table), undefined, `${table} dropped`);
  await library.files.flush();
  assert.equal(fs.existsSync(path.join(gallery, 'translated', '0001.png')), false, 'the picture it replaced retired once published');
  assert.equal(fs.existsSync(path.join(gallery, 'images', '0003.webp')), false, 'the leftover too');
  assert.equal(fs.existsSync(path.join(base, 'second', 'Old Folder')), false, 'and the old folder');
  assert.ok(fs.existsSync(path.join(gallery, '.shiori', 'gallery.json')), 'the gallery published in format v2');
});

// A gallery's folder as an earlier version could leave one it never described: pictures only, never
// published (no stamp), the index's flag for this step not yet set.
function undescribed(library, gid) {
  const dir = path.join(library.libraryDir, ...library.files._row(gid).path.split('/'));
  for (const f of ['.shiori', 'metadata.json', 'image_records.json', 'study', 'covers/manifest.json']) fs.rmSync(path.join(dir, ...f.split('/')), { recursive: true, force: true });
  library._s('DELETE FROM stamps WHERE gid = ?').run(gid);
  library._s(`DELETE FROM kv WHERE key = 'undescribedBound'`).run();
  return dir;
}
const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i++) await new Promise(r => setTimeout(r, 25)); };

test('a gallery\'s folder an earlier version never described gets its identity at the first start only when it holds exactly the pictures its index recorded, and the dry run says how many', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-dry-run-test-'));
  const where = { dataDir: path.join(base, 'data'), libraryDir: path.join(base, 'library'), placeDelay: 0, describeDelay: 600_000 };
  let library = await new Library(where).open();
  t.after(() => { library?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const png = (n) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])], { type: 'image/png' });
  const gallery = async (name, pages) => {
    const gid = String(library.nextGalleryId());
    await library.metaPut({ galleryId: gid, title: { english: name, japanese: '', pretty: '' } });
    for (let n = 1; n <= pages; n++) await library.pagePut(gid, n, png(n));
    await library.files.flush();
    return gid;
  };
  const [matching, extra] = [await gallery('Matching', 2), await gallery('Extra', 1)];
  const dirs = { matching: undescribed(library, matching), extra: undescribed(library, extra) };
  fs.writeFileSync(path.join(dirs.extra, 'images', '0009.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));   // a picture the index never recorded
  library.close();
  library = null;

  const report = await dryRun(where.dataDir);
  assert.deepEqual(report.galleries.undescribed, { bound: 1, conflicts: 1, unreachable: 0 });
  assert.ok(!fs.existsSync(path.join(dirs.matching, '.shiori')), 'the dry run changes nothing');

  library = await new Library(where).open();
  const manifest = path.join(dirs.matching, '.shiori', 'gallery.json');
  await until(() => fs.existsSync(manifest));
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).galleryId, matching, 'the folder names its gallery');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(manifest, 'utf8')).files.pages), ['1', '2'], 'its whole generation');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.matching, 'metadata.json'), 'utf8')).title.english, 'Matching');
  await library.metaPut({ ...(await library.metaGet(matching)), title: { english: 'Matching, edited', japanese: '', pretty: '' } });
  await library.files.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.matching, 'metadata.json'), 'utf8')).title.english, 'Matching, edited', 'and takes changes again');
  assert.ok(!fs.existsSync(path.join(dirs.extra, '.shiori', 'gallery.json')), 'one holding a picture the index never recorded stays as it is');
  assert.ok(!fs.existsSync(path.join(dirs.extra, 'metadata.json')));
  const found = await library.folderScan(library.primaryId);
  assert.ok(found.problems.some(p => p.reason === 'conflict' && p.gid === extra), 'a conflict, reported');
});
