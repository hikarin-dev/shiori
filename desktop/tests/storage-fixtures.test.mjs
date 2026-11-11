// storage-fixtures.test.mjs — the migration fixtures (plan D13) as the desktop library meets them:
// today's library opens each library.db an earlier version left (released v1.2.6, and each shape the
// working tree wrote since: folders in kv; tables homes, unmounted, dormant; then roots and places;
// then unplaced and removed_notes) and carries everything over — every gallery and its pages,
// translation and cover, every library folder in the state it was in, the favorite an earlier version
// kept in a gallery's metadata as the person's own mark (plan D6) — leaving none of the earlier tables
// or settings behind. The website's fixtures: app/tests/storage-fixtures.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { checkInvariants } = await import('../../app/js/library-check.js');
const { DESKTOP_FIXTURES, FIXTURE_GIDS, desktopLibrary, pictureBytes } = await import('../../app/tests/fixtures/storage-fixtures.mjs');

const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const webp = (n) => [...pictureBytes(WEBP, n)];
const png = (n) => [...pictureBytes(PNG, n)];
const tableOf = (library, name) => library._s(`SELECT type FROM sqlite_schema WHERE name = ?`).get(name)?.type ?? null;

for (const name of DESKTOP_FIXTURES) {
  test(`${name}: today's library opens it and carries everything over`, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-fixture-'));
    const { dataDir, libraryDir, fixture } = await desktopLibrary(name, base);
    // An earlier version kept the person's favorite in the metadata: gallery A's set so.
    const db = new DatabaseSync(path.join(dataDir, 'library.db'));
    const record = JSON.parse(db.prepare('SELECT record FROM meta WHERE gid = ?').get(FIXTURE_GIDS.a).record);
    db.prepare('UPDATE meta SET record = ? WHERE gid = ?').run(JSON.stringify({ ...record, favorite: true }), FIXTURE_GIDS.a);
    db.close();
    const library = await new Library({ dataDir, libraryDir, placeDelay: 0 }).open();
    t.after(() => { try { library.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
    const folders = fixture.rows.roots || fixture.rows.kv.some(r => r.key === 'roots');

    for (const gid of [FIXTURE_GIDS.a, FIXTURE_GIDS.b]) {
      assert.equal((await library.metaGet(gid))?.title?.english, gid === FIXTURE_GIDS.a ? 'Fixture A' : 'Fixture B');
      assert.deepEqual(await Promise.all([1, 2].map(n => library.getPageBlob(gid, n).then(bytesOf))), [webp(1), webp(2)], `${gid}'s pages`);
      assert.deepEqual(await bytesOf((await library.pageGet(gid, 1))?.translated), png(1), `${gid}'s translation`);
    }
    assert.deepEqual(await bytesOf(await library.coverGet(FIXTURE_GIDS.a)), png(9), 'a cover of its own');
    assert.deepEqual([(await library.getGallery(FIXTURE_GIDS.a)).favorite, (await library.metaGet(FIXTURE_GIDS.a)).favorite, await library.personalGet(FIXTURE_GIDS.b)],
      [true, undefined, null], 'the favorite a mark of its own, no longer in the metadata');
    const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
    assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);

    // Earlier shapes taken over: folders as rows, places for every gallery, no settings or tables left.
    assert.equal(library._s(`SELECT count(*) AS n FROM kv WHERE key IN ('roots', 'hiddenRoots', 'claimEpochs')`).get().n, 0);
    for (const gone of ['homes', 'dormant']) assert.equal(tableOf(library, gone), null, `${gone} is dropped`);
    assert.equal(tableOf(library, 'unmounted'), 'view');
    const listed = await library.foldersList();
    if (!folders) {
      assert.equal(listed.length, 1, 'the library folder alone');
      return;
    }
    const byPath = new Map(listed.map(f => [path.basename(f.path), f]));
    assert.deepEqual([...byPath.keys()].sort(), ['library', 'second', 'third']);
    assert.deepEqual(['library', 'second', 'third'].map(n => !!byPath.get(n).hidden), [false, false, true], 'the third one hidden still');
    const placed = Object.fromEntries(library._s('SELECT gid, root FROM places').all().map(r => [r.gid, r.root]));
    assert.equal(placed[FIXTURE_GIDS.b], byPath.get('second').id);
    assert.equal(placed[FIXTURE_GIDS.c], byPath.get('third').id);
    assert.equal(await library.getGallery(FIXTURE_GIDS.c), null, 'a hidden folder\'s gallery is out of the library');
    const linked = library._s('SELECT gid FROM files WHERE source IS NOT NULL').all();
    assert.equal(linked.length, 1, 'the folder of loose pictures, linked');
  });
}
