// library-folders.browser.mjs — a browser library kept in folders (File System Access): a gallery's
// pictures live in its folder as the gallery format lays them out, read back from there; moving a
// gallery takes its files along; removing a folder writes what the library has of its galleries there
// and forgets them, leaving their files, and adding it again finds them by checking it; a folder out of reach keeps new pictures in the
// browser until it is back. The folders here are in the browser's private file system (OPFS), which
// has the same handles a picked folder has — a folder picked by hand can't be handed to a headless
// browser — and is always permitted, so asking for permission isn't covered here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser, page;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const png = async (hue, w = 300, h = 400) => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `hsl(${hue} 60% 50%)`;
      ctx.fillRect(0, 0, w, h);
      return canvas.convertToBlob({ type: 'image/png' });
    };
    const root = await navigator.storage.getDirectory();
    // A folder of the private file system, as a picked folder: `name` (made when missing).
    const folder = (name) => root.getDirectoryHandle(name, { create: true });
    // Whether `path` ("a/b/c.png") is in folder `name`.
    const has = async (name, path) => {
      try {
        let dir = await root.getDirectoryHandle(name);
        const parts = path.split('/');
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        await dir.getFileHandle(parts.at(-1));
        return true;
      } catch { return false; }
    };
    const text = async (name, path) => {
      let dir = await root.getDirectoryHandle(name);
      const parts = path.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    };
    const blobs = async () => (await window.__api.maintenance.integritySnapshot()).images;
    window.__api = await import('/app/js/api.js');
    window.__t = { png, root, folder, has, text, blobs };
  });
});

after(async () => {
  await page?.close();
  await browser?.close();
  server?.close();
});

const run = (fn, arg) => page.evaluate(fn, arg);
const title = (english) => ({ english, japanese: '', pretty: '' });

test('a new gallery goes to the default folder, its pictures laid out there as the gallery format does', { skip: !chromePath() }, async () => {
  const out = await run(async (title) => {
    const api = window.__api, t = window.__t;
    const { id } = await api.folders.add(await t.folder('Lib A'));
    await api.folders.setDefault(id);
    const gid = api.newGalleryId();
    await api.meta.put({ galleryId: gid, title, numPages: 2 });
    await api.pages.put(gid, 1, await t.png(10));
    await api.pages.put(gid, 2, await t.png(60));
    await api.derived.putTranslation(gid, 1, { image: await t.png(200), pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
    await api.derived.putStudy(gid, 1, { bg: await t.png(210), page: { w: 300, h: 400 },
      bubbles: [{ id: 0, box: { x: 1, y: 1, w: 50, h: 20 }, region: { x: 1, y: 1, w: 50, h: 20 }, tr: 'Hi', src: 'やあ', text: await t.png(220) }] }, 'j1');
    const entity = await api.galleries.get(gid);
    const dir = 'Folder Gallery';
    const places = await api.folders.list();
    const page1 = await api.pages.blob(gid, 1);
    const study = await api.derived.studyList(gid);
    return { id, gid, folder: entity.folder, count: entity.count,
      files: await Promise.all(['images/0001.png', 'images/0002.png', 'translated/0001.png', 'study/bg/0001.png', 'study/text/0001-0.png']
        .map(p => t.has('Lib A', `${dir}/${p}`))),
      inBrowser: (await t.blobs()).filter(b => !b.startsWith('cover|') && b.includes(gid)),
      page1: page1?.size || 0, studyText: study[0]?.bubbles?.[0]?.text?.size || 0,
      places: places.map(p => [p.kind, p.isDefault, p.galleries]) };
  }, title('Folder Gallery'));
  assert.equal(out.folder, out.id, 'the gallery is kept in the folder');
  assert.equal(out.count, 2);
  assert.deepEqual(out.files, [true, true, true, true, true], 'every picture is a file in the gallery\'s folder');
  assert.deepEqual(out.inBrowser, [], 'none of its pictures is kept in the browser as well');
  assert.ok(out.page1 > 0 && out.studyText > 0, 'its pictures read back from the folder');
  assert.deepEqual(out.places, [['browser', false, 0], ['folder', true, 1]]);
  // Its folder names it from the start (its metadata.json binds the folder to it); a moment later
  // the gallery describes itself in full beside its pictures.
  const records = await until(page, async () => {
    try { return JSON.parse(await window.__t.text('Lib A', 'Folder Gallery/image_records.json')); } catch { return null; }
  }, null, { what: 'image_records.json' });
  assert.equal(records.length, 2);
  const meta = JSON.parse(await run(() => window.__t.text('Lib A', 'Folder Gallery/metadata.json')));
  assert.equal(meta.galleryId, out.gid);
  assert.ok(await run(() => window.__t.has('Lib A', 'Folder Gallery/study/bubbles.json')));
  page.__gid = out.gid;
  page.__folderA = out.id;
});

test('moving a gallery takes its files along, to this browser and to another folder', { skip: !chromePath() }, async () => {
  const out = await run(async ({ gid }) => {
    const api = window.__api, t = window.__t;
    const ticks = [];
    await api.galleries.move(gid, 'browser', { onProgress: (done, total) => ticks.push([done, total]) });
    const inBrowser = {
      folder: (await api.galleries.get(gid)).folder,
      dirGone: !(await t.has('Lib A', 'Folder Gallery/images/0001.png')),
      blobs: (await t.blobs()).filter(b => b.includes('|page') && !b.startsWith('cover|')).length,
      page: (await api.pages.blob(gid, 2))?.size || 0,
      translated: (await api.pages.blob(gid, 1, 'translated'))?.size || 0,
    };
    const { id: b } = await api.folders.add(await t.folder('Lib B'));
    await api.galleries.move(gid, b);
    const inB = {
      folder: (await api.galleries.get(gid)).folder === b,
      files: await t.has('Lib B', 'Folder Gallery/images/0002.png') && await t.has('Lib B', 'Folder Gallery/translated/0001.png'),
      blobs: (await t.blobs()).filter(b => b.includes(gid) && !b.startsWith('cover|')).length,
      page: (await api.pages.blob(gid, 2))?.size || 0,
    };
    return { ticks: ticks.at(-1), inBrowser, inB, b };
  }, { gid: page.__gid });
  assert.equal(out.inBrowser.folder, 'browser');
  assert.ok(out.inBrowser.dirGone, 'the folder it left is deleted');
  assert.ok(out.inBrowser.blobs >= 2 && out.inBrowser.page > 0 && out.inBrowser.translated > 0, 'its pictures are in the browser now');
  assert.equal(out.ticks[0], out.ticks[1], 'the progress reaches its end');
  assert.ok(out.inB.folder && out.inB.files, 'then in the other folder');
  assert.equal(out.inB.blobs, 0, 'and nothing of it is left in the browser');
  assert.ok(out.inB.page > 0);
  page.__folderB = out.b;
});

test('removing a folder writes everything the library has of its galleries there, then forgets it and them; added again, it is checked from scratch', { skip: !chromePath() }, async () => {
  const out = await run(async ({ gid, a, b }) => {
    const api = window.__api, t = window.__t;
    // A gallery with no pictures yet (a chapter not downloaded): described nowhere but here.
    await api.folders.setDefault(b);
    const later = api.newGalleryId();
    await api.galleries.create(later, { title: { english: 'Not Yet', japanese: '', pretty: '' }, sourceUrl: 'https://example.test/not-yet', numPages: 9 });
    await api.folders.setDefault(a);
    const { galleries } = await api.folders.remove(b);
    const listed = (await api.folders.list()).some(f => f.id === b);
    const { removed } = await api.folders.setAside(b);
    const gone = !(await api.galleries.get(gid)) && !(await api.meta.get(gid)) && !(await api.meta.get(later));
    const inBrowser = (await t.blobs()).filter(x => x.includes(gid));
    const records = (await api.maintenance.integritySnapshot()).metas.filter(m => [gid, later].includes(m.gid)).length;
    const pending = (await api.folders.pending()).setAside.length;
    const kept = await t.has('Lib B', 'Folder Gallery/images/0001.png');
    const described = JSON.parse(await t.text('Lib B', 'Not Yet/metadata.json').catch(() => 'null'));
    const again = await api.folders.add(await t.folder('Lib B'));
    const scan = await api.folders.scan(b);
    const back = await api.galleries.get(gid);
    const study = await api.derived.studyList(gid);
    const chapter = await api.galleries.get(later);
    const out = { galleries, removed, gone, listed, inBrowser, records, pending, kept, described: described?.sourceUrl, again, added: scan.added,
      folder: back?.folder, count: back?.count, translated: (await api.pages.blob(gid, 1, 'translated'))?.size || 0,
      studyText: study[0]?.bubbles?.[0]?.text?.size || 0, title: back?.title?.english,
      chapter: chapter && [chapter.count, chapter.folder === b, (await api.meta.get(later))?.sourceUrl] };
    await api.galleries.delete(later);   // the folder as the next tests expect it
    return out;
  }, { gid: page.__gid, a: page.__folderA, b: page.__folderB });
  assert.equal(out.galleries, 2);
  assert.ok(!out.listed, 'the folder leaves the library\'s places at once');
  assert.equal(out.removed, 2);
  assert.ok(out.gone, 'the galleries left the library');
  assert.deepEqual([out.inBrowser, out.records, out.pending], [[], 0, 0], 'and the library keeps nothing of them, nor of the folder');
  assert.ok(out.kept, 'its files stayed in the folder');
  assert.equal(out.described, 'https://example.test/not-yet', 'the gallery with no pictures is described there');
  assert.deepEqual(out.again, { id: page.__folderB, restored: 0 }, 'the folder is known by its own id, nothing kept to bring back');
  assert.equal(out.added, 2, 'its galleries are found by checking it');
  assert.equal(out.folder, page.__folderB);
  assert.equal(out.count, 2);
  assert.equal(out.title, 'Folder Gallery');
  assert.ok(out.translated > 0 && out.studyText > 0, 'with its translation and study layers');
  assert.deepEqual(out.chapter, [0, true, 'https://example.test/not-yet'], 'and the one with no pictures, as it was');
});

test('hiding a place keeps it listed while its galleries leave the library; showing it brings them back', { skip: !chromePath() }, async () => {
  const out = await run(async ({ gid, a, b }) => {
    const api = window.__api, t = window.__t;
    const reason = (p) => p.then(() => 'resolved', (e) => e.reason || e.code);
    // A folder: listed still, marked hidden, counting what it hid; its files where they are.
    const hid = await api.folders.hide(b);
    const row = (await api.folders.list()).find(f => f.id === b);
    // Out of every listing, written to by nothing — yet still the library's (an import of it is a copy).
    const listings = { page: (await api.galleries.page({ limit: 1000 })).some(g => g.id === gid), ids: (await api.galleries.idsSorted()).includes(gid),
      search: (await api.galleries.searchIndex()).has(gid), stats: gid in (await api.galleries.stats()).galleries, known: (await api.transfer.ids()).includes(gid) };
    const writes = [await reason(api.pages.put(gid, 9, await t.png(5))), await reason(api.galleries.mutate(gid, { favorite: true })),
      await reason(api.meta.put({ ...(await api.meta.get(gid)), favorite: true }))];
    const hidden = { hid, listings, writes, row: [row?.hidden, row?.galleries], gone: !(await api.galleries.get(gid)),
      kept: await t.has('Lib B', 'Folder Gallery/images/0001.png'),
      refused: [await reason(api.folders.setDefault(b)), await reason(api.folders.scan(b)),
        await reason(api.galleries.move(api.newGalleryId(), b)), await reason(api.folders.hide(a))] };
    const shown = await api.folders.show(b);
    const back = await api.galleries.get(gid);
    const folderBack = { shown, folder: back?.folder, translated: (await api.pages.blob(gid, 1, 'translated'))?.size || 0,
      hidden: !!(await api.folders.list()).find(f => f.id === b).hidden };
    // This browser: its pictures stay in it while it is hidden, not copied anywhere.
    const g2 = api.newGalleryId();
    await api.meta.put({ galleryId: g2, title: { english: 'In Browser', japanese: '', pretty: '' } });
    await api.pages.put(g2, 1, await t.png(120));
    await api.galleries.move(g2, 'browser');
    const mine = async () => (await t.blobs()).filter(id => id.includes(g2) && !id.startsWith('cover|')).sort();
    const before = await mine();
    const size = (await api.pages.blob(g2, 1)).size;
    await api.folders.hide('browser');
    const during = { gone: !(await api.galleries.get(g2)), blobs: await mine(), hidden: !!(await api.folders.list())[0].hidden };
    // The default removed while this browser is hidden: the first other folder shown takes over.
    const { id: h } = await api.folders.add(await t.folder('Lib H'));
    await api.folders.setDefault(h);
    await api.folders.remove(h);
    await api.folders.setAside(h);
    const nextDefault = (await api.folders.list()).find(f => f.isDefault)?.id;
    const browserBack = { shown: await api.folders.show('browser'), page: (await api.pages.blob(g2, 1))?.size || 0, size };
    await api.folders.setDefault(a);
    return { hidden, folderBack, before, during, nextDefault, browserBack };
  }, { gid: page.__gid, a: page.__folderA, b: page.__folderB });
  assert.deepEqual(out.hidden.hid, { id: page.__folderB, galleries: 1 });
  assert.deepEqual(out.hidden.row, [true, 1], 'listed still, hidden, counting what it holds');
  assert.deepEqual(out.hidden.listings, { page: false, ids: false, search: false, stats: false, known: true }, 'out of every listing, yet still in the library');
  assert.deepEqual(out.hidden.writes, ['hidden', 'hidden', 'hidden'], 'never written to while hidden');
  assert.ok(out.hidden.gone, 'its gallery left the library');
  assert.ok(out.hidden.kept, 'its files stayed in the folder');
  assert.deepEqual(out.hidden.refused, ['hidden', 'hidden', 'hidden', 'default'],
    'a hidden place is never the default, checked or moved to; the default is never hidden');
  assert.deepEqual(out.folderBack.shown, { id: page.__folderB, restored: 1 }, 'shown again without picking it');
  assert.equal(out.folderBack.folder, page.__folderB);
  assert.ok(out.folderBack.translated > 0, 'with its translation');
  assert.equal(out.folderBack.hidden, false);
  assert.ok(out.before.length >= 1);
  assert.ok(out.during.gone && out.during.hidden);
  assert.deepEqual(out.during.blobs, out.before, 'this browser\'s pictures stay where they are');
  assert.equal(out.nextDefault, page.__folderA);
  assert.deepEqual(out.browserBack.shown, { id: 'browser', restored: 1 });
  assert.equal(out.browserBack.page, out.browserBack.size, 'its picture reads back as it was');
});

test('a folder is claimed by the library that adds it: another app asks first, a library it was taken from stops writing there, and removing it writes back what differs and lets it go', { skip: !chromePath() }, async () => {
  const out = await run(async ({ a }) => {
    const api = window.__api, t = window.__t;
    const x = await t.folder('Lib X');
    const claimOf = async () => JSON.parse(await t.text('Lib X', '.shiori/owner.json'));
    const elsewhere = async (epoch, owner = 'a1b2c3d4e5f60708') => {
      const dir = await x.getDirectoryHandle('.shiori', { create: true });
      const w = await (await dir.getFileHandle('owner.json', { create: true })).createWritable();
      await w.write(JSON.stringify({ format: 'shiori-owner', version: 1, owner, by: { app: 'desktop', host: 'OTHER-PC' }, at: 1, epoch }));
      await w.close();
    };
    const reason = (p) => p.then(() => 'resolved', (e) => e.reason || e.code);
    await elsewhere(1);
    const refused = await api.folders.add(x).then(() => null, (e) => ({ reason: e.reason, owner: e.owner }));
    const { id } = await api.folders.add(x, { force: true });
    const forced = await claimOf();
    await api.folders.setDefault(id);
    const gid = api.newGalleryId();
    await api.meta.put({ galleryId: gid, title: { english: 'Shared', japanese: '', pretty: '' } });
    await api.pages.put(gid, 1, await t.png(30));
    // Taken over by the other app: listed so; a new page waits in the browser, nothing is written there.
    await elsewhere(forced.epoch + 1);
    const row = (await api.folders.list()).find(f => f.id === id);
    await api.pages.put(gid, 2, await t.png(40));
    const taken = { access: row.access, owner: row.owner, page2: await t.has('Lib X', 'Shared/images/0002.png'),
      spilled: !!(await api.galleries.get(gid)).spilled || (await t.blobs()).some(b => b.includes(gid) && b.endsWith('|page')),
      scan: await reason(api.folders.scan(id)) };
    // Taken back: what waited moves out.
    await api.folders.claim(id);
    const deadline = Date.now() + 10000;
    while (!(await t.has('Lib X', 'Shared/images/0002.png')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const back = { owner: (await claimOf()).owner, page2: await t.has('Lib X', 'Shared/images/0002.png') };
    // Removing it: a description out of date in the folder is written again, then it is let go.
    await api.folders.setDefault(a);
    let current = null;
    while (current == null && Date.now() < deadline + 10000) {   // its description, a moment after the last change
      try { current = await t.text('Lib X', 'Shared/metadata.json'); } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    const w = await (await (await x.getDirectoryHandle('Shared')).getFileHandle('metadata.json')).createWritable();
    await w.write('{}');
    await w.close();
    await api.folders.remove(id);
    await api.folders.setAside(id);
    const removed = { meta: JSON.parse(await t.text('Lib X', 'Shared/metadata.json')).galleryId, claim: await claimOf() };
    // Added back (another app had it meanwhile, or none did): checking finds the gallery as it is there.
    await elsewhere((await claimOf()).epoch + 1, null);
    const again = await api.folders.add(x);
    const found = await api.folders.scan(id);
    const after = await api.galleries.get(gid);
    await api.folders.remove(id);
    await api.folders.setAside(id);
    return { gid, refused, forced, taken, back, removed, again, found, count: after?.count };
  }, { a: page.__folderA });
  assert.deepEqual(out.refused, { reason: 'claimed', owner: { app: 'desktop', host: 'OTHER-PC', active: true, at: 1 } }, 'refused, naming the app');
  assert.equal(out.forced.epoch, 2, 'taken over when forced');
  assert.equal(out.taken.access, 'taken');
  assert.equal(out.taken.owner.host, 'OTHER-PC');
  assert.equal(out.taken.page2, false, 'nothing written to a folder another app holds');
  assert.ok(out.taken.spilled, 'the new page waits in the browser');
  assert.equal(out.taken.scan, 'unavailable');
  assert.ok(out.back.owner && out.back.page2, 'taken back, what waited moved out');
  assert.equal(out.removed.meta, out.gid, 'the folder has the library\'s description again');
  assert.equal(out.removed.claim.owner, null, 'let go');
  assert.equal(out.again.restored, 0, 'nothing kept of it to bring back');
  assert.equal(out.found.added, 1, 'checking the folder finds the gallery as it is');
  assert.equal(out.count, 2);
});

test('a check of a folder reads again the galleries another app changed there, unless this library has changes of its own waiting', { skip: !chromePath() }, async () => {
  const out = await run(async ({ a }) => {
    const api = window.__api, t = window.__t;
    const r = await t.folder('Lib S');
    const { id } = await api.folders.add(r);
    await api.folders.setDefault(id);
    const gid = api.newGalleryId();
    await api.meta.put({ galleryId: gid, title: { english: 'Shared', japanese: '', pretty: '' }, numPages: 2 });
    await api.pages.put(gid, 1, await t.png(10));
    await api.pages.put(gid, 2, await t.png(20));
    const until = async (fn) => { const end = Date.now() + 15000; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise(res => setTimeout(res, 150)); } return null; };
    await until(async () => JSON.parse(await t.text('Lib S', 'Shared/image_records.json')).length === 2);
    await new Promise(res => setTimeout(res, 300));
    const quiet = await api.folders.scan(id);
    // Another app changes it there: a new title and a third page.
    const write = async (path, data) => {
      const parts = path.split('/');
      let d = r;
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(data);
      await w.close();
    };
    const meta = JSON.parse(await t.text('Lib S', 'Shared/metadata.json'));
    await write('Shared/metadata.json', JSON.stringify({ ...meta, title: { english: 'Shared, Renamed', japanese: '', pretty: '' }, numPages: 3 }, null, 2));
    const records = JSON.parse(await t.text('Lib S', 'Shared/image_records.json'));
    await write('Shared/image_records.json', JSON.stringify([...records, { ...records[1], url: records[1].url.replace(/\/2\.(\w+)$/, '/3.$1') }], null, 2));
    await write('Shared/images/0003.png', await t.png(30));
    const changed = await api.folders.scan(id);
    const back = await api.galleries.get(gid);
    const page3 = (await api.pages.blob(gid, 3))?.size || 0;
    const again = await api.folders.scan(id);
    // Changed there again while a change of this library's waits to be written: this library's wins.
    await api.meta.put({ ...(await api.meta.get(gid)), title: { english: 'My Title', japanese: '', pretty: '' } });
    const meta2 = JSON.parse(await t.text('Lib S', 'Shared/metadata.json'));
    await write('Shared/metadata.json', JSON.stringify({ ...meta2, title: { english: 'Their Title', japanese: '', pretty: '' } }, null, 2));
    const waiting = await api.folders.scan(id);
    const mine = (await api.galleries.get(gid)).title.english;
    const written = await until(async () => JSON.parse(await t.text('Lib S', 'Shared/metadata.json')).title.english === 'My Title');
    await api.folders.setDefault(a);
    await api.folders.remove(id);
    await api.folders.setAside(id);
    return { quiet, changed, title: back.title.english, count: back.count, page3, again, waiting, mine, written };
  }, { a: page.__folderA });
  assert.deepEqual(out.quiet, { added: 0, updated: 0, stopped: false }, 'nothing changed: nothing read again');
  assert.deepEqual(out.changed, { added: 0, updated: 1, stopped: false });
  assert.equal(out.title, 'Shared, Renamed');
  assert.equal(out.count, 3);
  assert.ok(out.page3 > 0, 'the new page reads from the folder');
  assert.equal(out.again.updated, 0, 'read once: the next check finds nothing new');
  assert.equal(out.waiting.updated, 0);
  assert.equal(out.mine, 'My Title', 'this library\'s change waiting to be written wins');
  assert.ok(out.written, 'and is written to the folder');
});

test('checking a folder finds what was put in it outside the app, as a task that can be stopped', { skip: !chromePath() }, async () => {
  const tasks = await openPage(browser, origin);
  await tasks.goto(`${origin}/tasks`, { waitUntil: 'load' });
  const out = await run(async ({ b }) => {
    const api = window.__api, t = window.__t;
    const platform = await import('/app/js/platform.js');
    const { runFolderScan } = await import('/app/js/folder-scan.js');
    // Pictures put in it by hand: a gallery of their own each, named after their folders.
    const lib = await t.folder('Lib B');
    for (const name of ['Hand Made', 'Another One']) {
      const dir = await lib.getDirectoryHandle(name, { create: true });
      for (const n of [1, 2]) {
        const w = await (await dir.getFileHandle(`00${n}.png`, { create: true })).createWritable();
        await w.write(await t.png(n * 30)); await w.close();
      }
    }
    const heard = [];
    const off = platform.jobs.subscribe((j) => { if (j?.kind === 'folder') heard.push(j.status); });
    // Stopped before it gets anywhere: nothing joins.
    const stopping = runFolderScan(b, { name: 'Lib B' });
    platform.jobs.signal({ type: 'STOP_FOLDER_SCAN', folder: b });
    const stopped = await stopping;
    const first = [...heard];
    heard.length = 0;
    const result = await runFolderScan(b, { name: 'Lib B' });
    off();
    const titles = (await api.galleries.page({ limit: 50 })).map(g => g.title.english).sort();
    return { stopped, first, result, heard, titles };
  }, { b: page.__folderB });
  assert.deepEqual(out.stopped, { found: 0, stopped: true });
  assert.equal(out.first.at(-1), 'cancelled');
  assert.deepEqual(out.result, { found: 2, stopped: false }, 'the gallery it keeps isn\'t found again; the two new ones are');
  assert.deepEqual([out.heard[0], out.heard.at(-1)], ['started', 'done']);
  assert.ok(out.titles.includes('Hand Made') && out.titles.includes('Another One'));
  const row = await until(tasks, () => {
    const r = [...document.querySelectorAll('.tk-row')].find(x => x.querySelector('.tk-kind')?.dataset.kind === 'folder');
    return r && { kind: r.querySelector('.tk-kind').textContent, title: r.querySelector('.tk-title').textContent, label: r.querySelector('.tk-label').textContent };
  }, null, { what: 'the folder task on the tasks page' });
  assert.equal(row.kind, 'Library folder');
  assert.equal(row.title, 'Lib B');
  assert.deepEqual(tasks.problems, []);
  await tasks.close();
});

test('a big folder leaves the list and the library at once, what it still owes the folder a task; a removal cut short goes on next time', { skip: !chromePath() }, async () => {
  const out = await run(async () => {
    const api = window.__api, t = window.__t;
    const platform = await import('/app/js/platform.js');
    const { runFolderJob, resumeFolderWork } = await import('/app/js/folder-scan.js');
    const { id } = await api.folders.add(await t.folder('Lib R'));
    await api.folders.setDefault(id);
    const png = await t.png(5, 20, 30);
    const made = [];
    for (let i = 0; i < 120; i++) {
      const gid = api.newGalleryId();
      await api.meta.put({ galleryId: gid, title: { english: `R ${i}`, japanese: '', pretty: '' } });
      await api.pages.put(gid, 1, png);
      made.push(gid);
    }
    await api.folders.setDefault('browser');
    const { galleries } = await api.folders.remove(id);
    const listed = (await api.folders.list()).some(f => f.id === id);
    // Cut short: stopped after its first batch, as a closed tab would leave it.
    let done = 0;
    const first = await api.folders.setAside(id, { onProgress: (n) => { done = n; }, stopped: () => done >= 50 });
    const pending = (await api.folders.pending()).setAside.map(f => f.id);
    const leftAfterStop = (await api.galleries.byIds(made)).filter(Boolean).length;
    // The next page carries it on, as a task.
    const heard = [];
    const off = platform.jobs.subscribe((j) => {
      if (j?.kind === 'folder' && j.gid === `folder-${id}`) heard.push([j.status, j.status === 'error' ? `${j.errorKey || ''} ${j.error} ${j.unsaved ?? ''}` : j.found]);
    });
    await resumeFolderWork();
    await new Promise((resolve) => { const check = () => (heard.some(h => ['done', 'error', 'cancelled'].includes(h[0])) ? resolve() : setTimeout(check, 50)); check(); });
    off();
    const left = (await api.galleries.byIds(made)).filter(Boolean).length;
    const after = (await api.folders.pending()).setAside.length;
    const again = await api.folders.add(await t.folder('Lib R'));
    const found = await api.folders.scan(id);
    const back = (await api.galleries.byIds(made)).filter(Boolean).length;
    await api.folders.remove(id);
    await runFolderJob('remove', id, { name: 'Lib R' });
    return { galleries, listed, first, pending: pending.includes(id), leftAfterStop, heard: heard.at(-1), left, after, again, found: found.added, back };
  });
  assert.equal(out.galleries, 120);
  assert.ok(!out.listed, 'off the list at once');
  assert.deepEqual(out.first, { removed: 50, stopped: true });
  assert.ok(out.pending, 'what is left is waiting to be carried on');
  assert.equal(out.leftAfterStop, 0, 'its galleries left the library at once');
  assert.deepEqual(out.heard, ['done', 120], 'the next page carried it on, as a task');
  assert.equal(out.left, 0);
  assert.equal(out.after, 0);
  assert.equal(out.again.restored, 0, 'nothing kept of it');
  assert.equal(out.found, 120, 'checking it again finds every one');
  assert.equal(out.back, 120);
});

test('a folder out of reach keeps new pictures in the browser, and they move out once it is back', { skip: !chromePath() }, async () => {
  const out = await run(async () => {
    const api = window.__api, t = window.__t;
    const { id } = await api.folders.add(await t.folder('Lib C'));
    await api.folders.setDefault(id);
    await t.root.removeEntry('Lib C', { recursive: true });   // the drive taken away
    const gid = api.newGalleryId();
    await api.meta.put({ galleryId: gid, title: { english: 'Waiting', japanese: '', pretty: '' } });
    await api.pages.put(gid, 1, await t.png(90));
    const meanwhile = { folder: (await api.galleries.get(gid)).folder === id,
      blobs: (await t.blobs()).filter(b => b.includes(gid) && b.endsWith('|page')).length,
      access: (await api.folders.list()).find(f => f.id === id).access,
      // Removing it now would lose that page: asked first.
      remove: await api.folders.remove(id).then(() => 'resolved', (e) => [e.reason, e.galleries]),
      listed: (await api.folders.list()).some(f => f.id === id) };
    await t.folder('Lib C');   // back
    await new Promise(r => setTimeout(r, 5500));
    const settled = await api.folders.settle();
    return { meanwhile, settled, file: await t.has('Lib C', 'Waiting/images/0001.png'),
      blobs: (await t.blobs()).filter(b => b.includes(gid) && b.endsWith('|page')).length,
      page: (await api.pages.blob(gid, 1))?.size || 0 };
  });
  assert.ok(out.meanwhile.folder, 'the gallery belongs to the folder');
  assert.equal(out.meanwhile.blobs, 1, 'its page waits in the browser');
  assert.equal(out.meanwhile.access, 'unavailable');
  assert.deepEqual([out.meanwhile.remove, out.meanwhile.listed], [['unsaved', 1], true], 'not removed while that would lose what waits');
  assert.equal(out.settled, 1);
  assert.ok(out.file, 'once the folder is back, the page is in it');
  assert.equal(out.blobs, 0, 'and no longer in the browser');
  assert.ok(out.page > 0);
});

test('Settings → Storage shows where the library is kept, and the overview can move a gallery', { skip: !chromePath() }, async () => {
  const settings = await openPage(browser, origin);
  await settings.goto(`${origin}/settings`, { waitUntil: 'load' });
  await settings.click('#navStorage');
  const rows = await until(settings, () => {
    const list = [...document.querySelectorAll('#foldersSection .lf-item')];
    return list.length >= 3 && list.map(r => ({ name: r.querySelector('.lf-title').textContent, meta: r.querySelector('.lf-meta')?.textContent || '',
      isDefault: !!r.querySelector('.key-status-badge:not(.unset)'), menu: !!r.querySelector('.lf-more') }));
  }, null, { what: 'the folders card' });
  assert.equal(rows[0].name, 'This browser');
  assert.match(rows[0].meta, /^IndexedDB · Galleries: /, 'this browser\'s storage is named for what it is');
  assert.deepEqual(rows.map(r => r.name).slice(1), ['Lib A', 'Lib B', 'Lib C']);
  assert.ok(rows[3].isDefault);
  assert.ok(rows.every(r => r.menu), 'each place has its menu (one with nothing to do has none)');
  // A place's menu: what can be done with it.
  const menuOf = async (name) => {
    await settings.evaluate((n) => [...document.querySelectorAll('#foldersSection .lf-item')]
      .find(r => r.querySelector('.lf-title').textContent === n).querySelector('.lf-more').click(), name);
    const items = await until(settings, () => { const m = document.querySelector('.lf-menu'); return m && [...m.querySelectorAll('.ctx-menu-item')].map(b => b.textContent); }, null, { what: 'the menu' });
    return items;
  };
  assert.deepEqual(await menuOf('This browser'), ['Set as default', 'Hide'], 'this browser is never removed');
  await settings.keyboard.press('Escape');
  assert.deepEqual(await menuOf('Lib C'), ['Rescan', 'Remove']);
  await settings.keyboard.press('Escape');
  const layout = await settings.evaluate(() => {
    const card = document.getElementById('foldersSection');
    const add = document.getElementById('lfAdd'), list = document.getElementById('lfRows');
    return { addBelow: add.getBoundingClientRect().top >= list.getBoundingClientRect().bottom,
      rescanInHeader: !!card.querySelector('.section-header #lfRescan'), location: !!card.querySelector('#lfLocation .choice-toggle') };
  });
  assert.deepEqual(layout, { addBelow: true, rescanInHeader: true, location: true }, 'add under the list, rescan in the header, the location on top');
  assert.equal(await settings.evaluate(() => document.querySelector('#foldersSection').parentElement.id), 'panelStorage');
  // On a phone the card fits the window: nothing runs past it.
  await settings.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });   // the page reloads
  await until(settings, () => document.getElementById('navStorage'), null, { what: 'the page again' });
  await settings.click('#navStorage');
  const narrow = await until(settings, () => {
    const card = document.getElementById('foldersSection').getBoundingClientRect();
    const out = [...document.querySelectorAll('#foldersSection button, #foldersSection .lf-item, #foldersSection .lf-meta')]
      .filter(el => el.getClientRects().length)
      .filter(el => { const r = el.getBoundingClientRect(); return r.left < card.left - 0.5 || r.right > card.right + 0.5; }).map(el => el.textContent);
    return card.width > 0 && document.querySelectorAll('#foldersSection .lf-item').length >= 3 && { scroll: document.documentElement.scrollWidth - innerWidth, out };
  }, null, { what: 'the card at phone width' });
  assert.deepEqual(narrow, { scroll: 0, out: [] });
  await settings.setViewport({ width: 1280, height: 900, isMobile: false, hasTouch: false });
  await until(settings, () => document.getElementById('navStorage'), null, { what: 'the page again' });
  await settings.click('#navStorage');
  await until(settings, () => document.querySelectorAll('#foldersSection .lf-item').length >= 3, null, { what: 'the folders card again' });
  // Make this browser the default again, from its menu.
  await menuOf('This browser');
  await settings.evaluate(() => document.querySelector('.lf-menu .ctx-menu-item').click());
  await until(settings, () => document.querySelector('#foldersSection .lf-item')?.querySelector('.key-status-badge:not(.unset)'), null, { what: 'the default to move' });
  // Removing asks first: "Remove folder" is the answer; moving the galleries elsewhere is a switch,
  // asked again when turned on. Turned on and then refused, it stays off.
  await menuOf('Lib B');
  await settings.evaluate(() => [...document.querySelectorAll('.lf-menu .ctx-menu-item')].find(b => b.textContent === 'Remove').click());
  const dialog = await until(settings, () => { const d = document.querySelector('.notice-dialog'); return d && {
    ok: d.querySelector('.notice-actions .btn.danger')?.textContent, toggle: d.querySelector('.notice-toggle-text')?.textContent,
    options: [...d.querySelectorAll('.notice-select option')].map(o => o.textContent) }; }, null, { what: 'the remove question' });
  assert.deepEqual(dialog, { ok: 'Remove folder', toggle: 'Move galleries to', options: ['This browser (IndexedDB)', 'Lib A', 'Lib C'] });
  await settings.evaluate(() => document.querySelector('.notice-toggle input').click());
  const asked = await until(settings, () => document.querySelectorAll('.notice-dialog').length === 2 && document.querySelectorAll('.notice-dialog')[1].querySelector('h2').textContent, null, { what: 'the move question' });
  assert.equal(asked, 'Move galleries to This browser?');
  await settings.evaluate(() => document.querySelectorAll('.notice-dialog')[1].querySelector('.notice-actions .btn:not(.danger)').click());
  assert.equal(await until(settings, () => document.querySelectorAll('.notice-dialog').length === 1 && String(document.querySelector('.notice-toggle input').checked), null, { what: 'the switch to stay off' }), 'false');
  await settings.evaluate(() => document.querySelector('.notice-dialog .notice-actions .btn:not(.danger)').click());
  assert.equal(await settings.evaluate(() => !!document.querySelector('.notice-dialog')), false);
  // Hiding a place: no question. It stays listed, marked hidden, counting what it hid, and its menu
  // offers to show it again.
  const rowOf = (name) => settings.evaluate((n) => {
    const r = [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === n);
    return r && { hidden: r.classList.contains('is-hidden'), busy: r.classList.contains('busy'), meta: r.querySelector('.lf-meta')?.textContent || '',
      badges: [...r.querySelectorAll('.key-status-badge')].map(b => b.textContent) };
  }, name);
  const shownC = await rowOf('Lib C');
  await menuOf('Lib C');
  await settings.evaluate(() => [...document.querySelectorAll('.lf-menu .ctx-menu-item')].find(b => b.textContent === 'Hide').click());
  const hiddenC = await until(settings, async () => {
    const r = [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === 'Lib C');
    return r?.classList.contains('is-hidden') && !r.classList.contains('busy') && !document.querySelector('.notice-dialog') && true;
  }, null, { what: 'Lib C hidden' }) && await rowOf('Lib C');
  assert.deepEqual(hiddenC.badges, ['Hidden']);
  assert.equal(hiddenC.meta, shownC.meta, 'it counts the galleries it hid');
  assert.deepEqual(await menuOf('Lib C'), ['Show', 'Remove']);
  await settings.keyboard.press('Escape');
  const gid = page.__gid;
  const overview = await openPage(browser, origin);
  await overview.goto(`${origin}/overview?g=${gid}`, { waitUntil: 'load' });
  await until(overview, () => { const b = document.getElementById('moveTo'); return b && !b.hidden; }, null, { what: 'the Move to button' });
  await overview.click('#moveTo');
  const choices = await until(overview, () => { const list = [...document.querySelectorAll('.notice-choice strong')].map(s => s.textContent); return list.length && list; }, null, { what: 'the places to move to' });
  assert.deepEqual(choices, ['This browser', 'Lib A', 'Cancel'], 'every other place shown, not the one it is in');
  await overview.evaluate(() => [...document.querySelectorAll('.notice-choice')].find(b => b.textContent.includes('This browser')).click());
  await until(overview, async (g) => (await window.__api?.galleries.get(g))?.folder === 'browser' || (await (await import('/app/js/api.js')).galleries.get(g))?.folder === 'browser', gid, { what: 'the gallery to move' });
  // Shown again from its menu: back as it was, no folder picked.
  await menuOf('Lib C');
  await settings.evaluate(() => [...document.querySelectorAll('.lf-menu .ctx-menu-item')].find(b => b.textContent === 'Show').click());
  await until(settings, () => {
    const r = [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === 'Lib C');
    return r && !r.classList.contains('is-hidden') && !r.classList.contains('busy');
  }, null, { what: 'Lib C shown' });
  assert.deepEqual(await rowOf('Lib C'), shownC);
  // Adding a folder another app uses: asked first, naming that app; "Use anyway" adds it.
  await settings.bringToFront();   // the overview opened over it: the card reads its folders again as it shows
  const claimY = (owner, epoch) => settings.evaluate(async ({ owner, epoch }) => {
    const y = await (await navigator.storage.getDirectory()).getDirectoryHandle('Lib Y', { create: true });
    const w = await (await (await y.getDirectoryHandle('.shiori', { create: true })).getFileHandle('owner.json', { create: true })).createWritable();
    await w.write(JSON.stringify({ format: 'shiori-owner', version: 1, owner, by: { app: 'desktop', host: 'OTHER-PC' }, at: 1, epoch }));
    await w.close();
    window.showDirectoryPicker = async () => y;
  }, { owner, epoch });
  await claimY('a1b2c3d4e5f60708', 1);
  await settings.evaluate(() => document.getElementById('lfAdd').click());   // a tab in the background: no puppeteer click
  const inUse = await until(settings, () => { const d = document.querySelector('.notice-dialog'); return d && {
    title: d.querySelector('h2').textContent, body: d.innerText.includes('Shiori Desktop on OTHER-PC'), ok: d.querySelector('.notice-actions .btn.danger')?.textContent }; },
  null, { what: 'the in-use question' });
  assert.deepEqual(inUse, { title: 'Folder in use', body: true, ok: 'Use anyway' });
  await settings.evaluate(() => document.querySelector('.notice-dialog .notice-actions .btn.danger').click());
  await until(settings, () => [...document.querySelectorAll('#foldersSection .lf-item:not(.busy) .lf-title')].some(e => e.textContent === 'Lib Y'), null, { what: 'Lib Y added' });
  // Taken over by the other app: marked so, with "Take back" (asked first).
  await claimY('a1b2c3d4e5f60708', 5);
  await settings.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // the card reads the folders again
  const takenY = await until(settings, () => {
    const r = [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === 'Lib Y');
    const b = r && [...r.querySelectorAll('.key-status-badge')].find(b => b.textContent === 'Used elsewhere');
    return b && { tip: b.dataset.tip, button: r.querySelector('[data-act="claim"]')?.textContent };
  }, null, { what: 'Lib Y taken' });
  assert.deepEqual(takenY, { tip: 'In use by Shiori Desktop on OTHER-PC', button: 'Take back' });
  await settings.evaluate(() => [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === 'Lib Y').querySelector('[data-act="claim"]').click());
  assert.equal(await until(settings, () => document.querySelector('.notice-dialog h2')?.textContent, null, { what: 'the take-back question' }), 'Take back Lib Y?');
  await settings.evaluate(() => document.querySelector('.notice-dialog .notice-actions .btn.danger').click());
  await until(settings, () => {
    const r = [...document.querySelectorAll('#foldersSection .lf-item')].find(r => r.querySelector('.lf-title').textContent === 'Lib Y');
    return r && !r.querySelector('[data-act="claim"]');
  }, null, { what: 'Lib Y taken back' });
  await settings.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const y = (await api.folders.list()).find(f => f.name === 'Lib Y');
    await api.folders.remove(y.id);
    await api.folders.setAside(y.id);
  });
  for (const p of [settings, overview]) { assert.deepEqual(p.problems, []); await p.close(); }
  assert.deepEqual(page.problems, []);
});

test('a folder of what Shiori didn\'t make is used as it is: galleries read in place, Shiori\'s additions in their overlays', { skip: !chromePath() }, async () => {
  const out = await run(async ({ a }) => {
    const api = window.__api, t = window.__t;
    const { zipCreate } = await import('/app/js/zip.js');
    const lib = await t.folder('Lib K');
    const bytes = async (hue) => new Uint8Array(await (await t.png(hue, 30, 40)).arrayBuffer());
    const dirOf = async (path, create = false) => { let d = lib; for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create }); return d; };
    const put = async (path, data) => {
      const parts = path.split('/');
      const w = await (await (await dirOf(parts.slice(0, -1).join('/'), true)).getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(data); await w.close();
    };
    const fileOf = async (path) => { const parts = path.split('/'); try { return await (await (await dirOf(parts.slice(0, -1).join('/'))).getFileHandle(parts.at(-1))).getFile(); } catch { return null; } };
    const p1 = await bytes(10), p2 = await bytes(100), p3 = await bytes(200);
    const zipPath = 'Pack/[Circle (Artist A)] Title One (Mag 2020).zip';
    await put(zipPath, zipCreate([{ name: '01.png', data: p1 }, { name: '02.png', data: p2 }]));
    await put('Pack/Series Zip.zip', zipCreate([{ name: 'Ch 1/1.png', data: p1 }, { name: 'Ch 1/2.png', data: p2 }, { name: 'Ch 2/1.png', data: p3 }]));
    await put('Loose Title/2.png', p2); await put('Loose Title/1.png', p1);
    await put('Pack/Nested/Inner Title/1.png', p3);
    await put('Pack/readme.txt', 'hello');
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
    await put('Book.pdf', pdf);
    const zipBefore = await fileOf(zipPath);
    const { id } = await api.folders.add(lib);
    const scan = await api.folders.scan(id);
    const all = async () => (await api.galleries.byIds((await api.meta.all()).map(m => m.galleryId))).filter(e => e?.folder === id);
    const byTitle = async (title) => (await all()).find(e => e.title.english === title);
    const one = await byTitle('[Circle (Artist A)] Title One (Mag 2020)');
    const read = { kind: one.linked.kind, count: one.count, pretty: one.title.pretty, tags: one.tags.map(x => `${x.type}:${x.name}`),
      page2: (await api.pages.blob(one.id, 2))?.size === p2.byteLength, loose: (await byTitle('Loose Title'))?.count };
    const series = await api.series.resolve((await byTitle('Ch 1')).id);
    // What Shiori adds goes to the overlay; the archive stays as it was.
    await api.derived.putTranslation(one.id, 1, { image: await t.png(300), pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
    const overlay = `.shiori/linked/${one.id}`;
    const translated = await t.has('Lib K', `${overlay}/translated/0001.png`);
    const end = Date.now() + 12000;
    while (!(await t.has('Lib K', `${overlay}/metadata.json`)) && Date.now() < end) await new Promise(r => setTimeout(r, 200));
    const described = await t.has('Lib K', `${overlay}/metadata.json`);
    const zipAfter = await fileOf(zipPath);
    // A PDF waits for a page to draw its pages, then joins the library with them.
    const waiting = (await api.folders.pdfsWaiting()).map(w => w.name);
    const { drawWaitingPdfs } = await import('/app/js/library-folders.js');
    await drawWaitingPdfs();
    const book = await byTitle('Book');
    // Removed from the library: its overlay goes, its files stay, a check doesn't add it again.
    await api.galleries.delete(one.id);
    await new Promise(r => setTimeout(r, 300));
    const removed = { zip: !!(await fileOf(zipPath)), overlay: await t.has('Lib K', `${overlay}/source.json`),
      noted: JSON.parse(await t.text('Lib K', '.shiori/linked/removed.json')).removed.map(r => r.path), again: (await api.folders.scan(id)).added };
    // Renamed outside the app: found again by its fingerprint, the same gallery.
    const loose = await byTitle('Loose Title');
    await put('Loose Renamed/1.png', p1); await put('Loose Renamed/2.png', p2);
    await lib.removeEntry('Loose Title', { recursive: true });
    const rescan = await api.folders.scan(id);
    const renamed = await api.galleries.get(loose.id);
    // Moved to this browser: a gallery of its own there, its files left where they were.
    const inner = await byTitle('Inner Title');
    await api.galleries.move(inner.id, 'browser');
    const moved = await api.galleries.get(inner.id);
    const result = { scan, read, chapters: series?.chapters.map(c => c.title), translated, described,
      zipSame: zipAfter.size === zipBefore.size && zipAfter.lastModified === zipBefore.lastModified,
      waiting, book: book && [book.count, book.linked.kind], pdfSame: (await fileOf('Book.pdf')).size === pdf.length, removed,
      rescan, renamed: [renamed.linked.path, renamed.count, (await api.pages.blob(loose.id, 2))?.size === p2.byteLength],
      moved: [moved.folder, moved.linked, (await api.pages.blob(inner.id, 1))?.size === p3.byteLength], innerStays: !!(await fileOf('Pack/Nested/Inner Title/1.png')),
      gid: (await byTitle('Ch 1')).id };
    await api.folders.setDefault(a);
    return result;
  }, { a: page.__folderA });
  assert.deepEqual(out.scan, { added: 5, updated: 0, stopped: false }, 'two folders of pictures, an archive, an archive\'s two chapters (the PDF waits)');
  assert.deepEqual(out.read, { kind: 'zip', count: 2, pretty: 'Title One', tags: ['group:circle', 'artist:artist a', 'tag:pack'], page2: true, loose: 2 });
  assert.deepEqual(out.chapters, ['Ch 1', 'Ch 2'], 'an archive of folders is a series');
  assert.ok(out.translated && out.described, 'its translation and descriptions in its overlay');
  assert.ok(out.zipSame, 'the archive untouched');
  assert.deepEqual(out.waiting, ['Book.pdf']);
  assert.deepEqual(out.book, [2, 'pdf'], 'its pages drawn into its overlay');
  assert.ok(out.pdfSame);
  assert.deepEqual(out.removed, { zip: true, overlay: false, noted: ['Pack/[Circle (Artist A)] Title One (Mag 2020).zip'], again: 0 });
  assert.deepEqual(out.rescan, { added: 0, updated: 1, stopped: false });
  assert.deepEqual(out.renamed, ['Loose Renamed', 2, true]);
  assert.deepEqual(out.moved, ['browser', null, true]);
  assert.ok(out.innerStays);
  page.__linked = out.gid;
  // Its card says what deleting it does: it leaves the library, its files stay.
  const library = await openPage(browser, origin);
  await library.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await until(library, (g) => !!document.querySelector(`.card[data-gallery-id="${g}"] .card-btn-del, .card .card-btn-del[data-id="${g}"]`), out.gid, { what: 'its card' });
  await library.evaluate((g) => (document.querySelector(`.card .card-btn-del[data-id="${g}"]`) || document.querySelector(`.card[data-gallery-id="${g}"] .card-btn-del`)).click(), out.gid);
  const asked = await until(library, () => { const d = document.querySelector('.notice-dialog'); return d && { title: d.querySelector('h2').textContent, ok: d.querySelector('.notice-actions .btn.danger')?.textContent }; }, null, { what: 'the question' });
  assert.deepEqual(asked, { title: 'Remove from library?', ok: 'Remove' });
  await library.evaluate(() => document.querySelector('.notice-dialog .notice-actions .btn:not(.danger)').click());
  assert.deepEqual(library.problems, []);
  await library.close();
});

test('with the service worker in charge, a folder is checked there, so it goes on whatever page is open next', { skip: !chromePath() }, async () => {
  const worker = await browser.newPage();
  const errors = [];
  worker.on('pageerror', (e) => errors.push(String(e?.message || e)));
  await worker.goto(`${origin}/settings`, { waitUntil: 'load' });
  await until(worker, () => !!navigator.serviceWorker?.controller, null, { what: 'the service worker in charge', timeout: 30000 });
  const out = await worker.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    const { startFolderScan } = await import('/app/js/folder-scan.js');
    const root = await navigator.storage.getDirectory();
    const lib = await root.getDirectoryHandle('Lib W', { create: true });
    const dir = await lib.getDirectoryHandle('By Hand', { create: true });
    const canvas = new OffscreenCanvas(40, 60);
    canvas.getContext('2d').fillRect(0, 0, 40, 60);
    const w = await (await dir.getFileHandle('01.png', { create: true })).createWritable();
    await w.write(await canvas.convertToBlob({ type: 'image/png' })); await w.close();
    const { id } = await api.folders.add(lib);
    const heard = [];
    const ended = new Promise((resolve) => platform.jobs.subscribe((j) => {
      if (j?.kind !== 'folder') return;
      heard.push([j.status, j.runner?.kind]);
      if (j.status === 'done') resolve();
    }));
    const where = await startFolderScan(id, { name: 'Lib W' });
    await ended;
    return { where, heard, found: (await api.galleries.page({ limit: 100 })).some(g => g.title.english === 'By Hand') };
  });
  assert.equal(out.where, 'worker');
  assert.deepEqual(out.heard.at(-1), ['done', 'service-worker'], 'the worker ran it, and said so');
  assert.ok(out.found);
  assert.deepEqual(errors, []);
  await worker.close();
});
