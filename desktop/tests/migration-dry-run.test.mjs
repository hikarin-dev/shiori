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
