// api-interface.test.mjs — rules the library interface keeps whatever backend stands behind it: what
// the library works out itself can't be written through a change, a new metadata field is kept with
// the gallery's metadata, an import reserves its card without disturbing a gallery that has pages,
// and a failure arrives as a BackendError the app can act on.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const api = await import('../js/api.js');
const { exportMetadata } = await import('../js/backup.js');

const webp = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
const title = (english) => ({ english, japanese: '', pretty: '' });

test('every operation of the interface is there in each backend behind it', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
  const browser = await import('../js/db.js');
  const desktop = await import('../js/desktop-backend.js');
  // Every `backend.op(` call; `backend.op?.(` names one a backend may lack.
  const called = [...new Set([...source.matchAll(/(?<![\w-])backend\.(\w+)\(/g)].map(m => m[1]))];
  assert.ok(called.length > 40);
  assert.deepEqual(called.filter(name => typeof browser[name] !== 'function'), []);
  // The desktop library has no browser storage layout to convert (capabilities.storageLayout).
  const browserOnly = new Set(['storageLayoutStatus', 'convertStorage']);
  assert.deepEqual(called.filter(name => !browserOnly.has(name) && typeof desktop[name] !== 'function'), []);
});

test('a page\'s study layers are read back through the interface', async () => {
  const gid = api.newGalleryId();
  await api.pages.put(gid, 1, webp());
  await api.pages.put(gid, 2, webp());
  await api.derived.putStudy(gid, 2, { bg: webp(), bubbles: [{ box: {}, region: {}, tr: 'Hi', src: 'やあ' }], page: { w: 1, h: 1 } });
  const layers = await api.derived.studyList(gid);
  assert.deepEqual(layers.map(l => [l.url, l.bubbles[0].tr]), [[`local://${gid}/2.webp`, 'Hi']]);
});

test('a change can\'t set what the library works out itself', async () => {
  const gid = api.newGalleryId();
  await api.galleries.create(gid, { title: title('T') });
  for (const field of ['count', 'size', 'addedAt', 'latestAt', 'chapterCount', 'medianPage']) {
    await assert.rejects(api.galleries.mutate(gid, { [field]: 7 }), { name: 'BackendError', code: 'invalid' }, field);
  }
  assert.equal((await api.galleries.get(gid)).count, 0);
});

test('a field the app doesn\'t know is kept with the metadata, and travels with it', async () => {
  const gid = api.newGalleryId();
  await api.galleries.create(gid, { title: title('T') });
  await api.galleries.mutate(gid, { futureField: { kept: true } });
  assert.deepEqual((await api.meta.get(gid)).futureField, { kept: true });
  const { blob } = await exportMetadata();
  assert.deepEqual(JSON.parse(await blob.text()).find(m => m.galleryId === gid)?.futureField, { kept: true });
});

test('reserving a card leaves a gallery that already has pages as it is', async () => {
  const gid = api.newGalleryId();
  await api.galleries.create(gid, { title: title('Reserved'), isLocalImport: true });
  const reserved = await api.galleries.get(gid);
  assert.equal(reserved.count, 0);
  assert.equal(reserved.title.english, 'Reserved');
  assert.equal(reserved.addedAt, Number(gid), 'a new card is added at its id\'s time');
  await api.pages.put(gid, 1, webp());
  await api.galleries.create(gid, { title: title('Again') });
  const after = await api.galleries.get(gid);
  assert.equal(after.count, 1);
  assert.equal(after.addedAt, Number(gid));
  assert.equal(after.title.english, 'Again');
});

test('pages are read and written by number; a page carries its number and key', async () => {
  const gid = api.newGalleryId();
  await api.pages.put(gid, 2, webp(), { key: `src://x/2.webp` });
  assert.deepEqual(await api.pages.list(gid), [{ pageNum: 2, url: 'src://x/2.webp' }]);
  const page = await api.pages.get(gid, 2);
  assert.equal(page.pageNum, 2);
  assert.equal(page.url, 'src://x/2.webp');
  assert.equal((await api.pages.blob(gid, 2)).size, 3);
  await assert.rejects(api.pages.put(gid, 3, webp(), { key: 'src://x/2.webp' }), { code: 'invalid' });
});

// A value the store can't hold throws inside the write's transaction, which aborts without an
// `error` event; the caller still hears of it. (The desktop library refuses it before sending it:
// `invalid`.)
test('a write the library can\'t complete arrives as a BackendError instead of leaving its caller waiting', { timeout: 5000 }, async () => {
  const gid = api.newGalleryId();
  await assert.rejects(api.meta.put({ galleryId: gid, title: title('T'), notData: () => {} }),
    (e) => e.name === 'BackendError' && ['aborted', 'invalid'].includes(e.code));
  assert.equal(await api.meta.get(gid), null, 'nothing was written');
});

// Published dates are kept in Unix seconds, whatever unit a source sends.
test('a published date given in milliseconds is kept in seconds, on the gallery and its stat record', async () => {
  const gid = api.newGalleryId();
  await api.meta.put({ galleryId: gid, title: title('Dated'), uploadDate: 1_779_321_794_000 });
  await api.pages.put(gid, 1, webp());
  assert.equal((await api.meta.get(gid)).uploadDate, 1_779_321_794);
  assert.equal((await api.galleries.get(gid)).uploadDate, 1_779_321_794);
  await api.galleries.mutate(gid, { uploadDate: 1_700_000_000_500 });
  assert.equal((await api.meta.get(gid)).uploadDate, 1_700_000_000);
  assert.equal((await api.galleries.get(gid)).uploadDate, 1_700_000_000, 'the sort key follows');
  await api.galleries.mutate(gid, { uploadDate: 1_600_000_000 });
  assert.equal((await api.meta.get(gid)).uploadDate, 1_600_000_000, 'seconds stay as they are');
});

test('the one-time repair converts published dates stored in milliseconds', { skip: !api.capabilities.browserLibrary && 'a repair of the browser library' }, async () => {
  const gid = api.newGalleryId();
  await new Promise((resolve, reject) => {   // a record from before dates were kept in seconds
    const open = indexedDB.open('shiori-cache');
    open.onsuccess = () => {
      const tx = open.result.transaction(['metadata', 'galleries'], 'readwrite');
      tx.objectStore('metadata').put({ galleryId: gid, title: title('Old'), uploadDate: 1_779_321_794_000 });
      tx.objectStore('galleries').put({ galleryId: gid, count: 0, size: 0, latestAt: 5, addedAt: Number(gid), uploadDate: 1_779_321_794_000 });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  const { STEPS } = await import('../js/migrations.js');
  await STEPS.find(s => s.id === 'uploadDatesInSeconds').run(() => {});
  assert.equal((await api.meta.get(gid)).uploadDate, 1_779_321_794);
  const g = await api.galleries.get(gid);
  assert.equal(g.uploadDate, 1_779_321_794);
  assert.equal(g.latestAt, 5, 'a repair is not an update');
});
