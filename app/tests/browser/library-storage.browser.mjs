// library-storage.browser.mjs — how the browser library writes to its folders, one regression test
// per audit finding (plans/library-storage-spec.md), each in a browser profile of its own. A picture
// is written under a name no file has, its record commits, and only then does the file it replaced
// go; writes to one gallery never interleave, across tabs and the service worker; a gallery's folder
// is reserved for it alone and says whose it is; a change marks its gallery as not written to its
// folder in its own transaction; a folder this library doesn't hold is never written to or deleted
// from; a restore keeps where a gallery is kept. The folders are in the browser's private file
// system (OPFS), always permitted — as in library-folders.browser.mjs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser;
const skip = !chromePath();

before(async () => {
  if (skip) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

// The library page in a new tab of `ctx` (a profile of its own: its own IndexedDB and OPFS), with
// helpers for the tests in window.__t.
async function tab(ctx) {
  const page = await openPage(ctx, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const png = async (hue, w = 30, h = 40) => {
      const canvas = new OffscreenCanvas(w, h);
      const c = canvas.getContext('2d');
      c.fillStyle = `hsl(${hue} 60% 50%)`;
      c.fillRect(0, 0, w, h);
      return canvas.convertToBlob({ type: 'image/png' });
    };
    const root = await navigator.storage.getDirectory();
    const folder = (name) => root.getDirectoryHandle(name, { create: true });
    const dirOf = async (path, create = false) => {
      let d = root;
      for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
      return d;
    };
    // What `path` holds (folders with a trailing /), [] when it isn't there.
    const ls = async (path) => {
      const out = [];
      try { for await (const [n, h] of (await dirOf(path)).entries()) out.push(h.kind === 'directory' ? `${n}/` : n); } catch {}
      return out.sort();
    };
    const file = async (path) => {
      const parts = path.split('/');
      try { return await (await (await dirOf(parts.slice(0, -1).join('/'))).getFileHandle(parts.at(-1))).getFile(); } catch { return null; }
    };
    const text = async (path) => (await file(path))?.text() ?? null;
    const write = async (path, data) => {
      const parts = path.split('/');
      const w = await (await (await dirOf(parts.slice(0, -1).join('/'), true)).getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(data);
      await w.close();
    };
    // A record as IndexedDB holds it.
    const raw = async (store, key, record) => {
      const db = await new Promise((r) => { const q = indexedDB.open('shiori-cache'); q.onsuccess = () => r(q.result); });
      try {
        if (record) return await new Promise((r) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(record); tx.oncomplete = r; });
        return await new Promise((r) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => r(q.result ?? null); });
      } finally { db.close(); }
    };
    // Files written whole of `size` bytes held back before they are complete, until open() is called.
    const holdWrites = (size) => {
      const proto = FileSystemWritableFileStream.prototype, write = proto.write, close = proto.close;
      let open, gate = new Promise((r) => { open = r; });
      proto.write = async function (data) { this.__size = data?.size; return write.call(this, data); };
      proto.close = async function () { if (this.__size === size) await gate; return close.call(this); };
      return () => { proto.write = write; proto.close = close; open(); };
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (english) => ({ english, japanese: '', pretty: '' });
    window.__api = await import('/app/js/api.js');
    window.__t = { png, folder, ls, file, text, write, raw, holdWrites, sleep, T };
  });
  return page;
}
// A test in a profile of its own: `fn(ctx)`.
async function fresh(fn) {
  const ctx = await browser.createBrowserContext();
  try { return await fn(ctx); } finally { await ctx.close(); }
}
// Folder `name` added and made the default, a gallery titled `title` with `pages` pages put there and
// its descriptions written: { id, gid }.
const setup = (page, name, title, pages = 1) => page.evaluate(async (name, title, pages) => {
  const api = window.__api, t = window.__t;
  const { id } = await api.folders.add(await t.folder(name));
  await api.folders.setDefault(id);
  const gid = api.newGalleryId();
  await api.meta.put({ galleryId: gid, title: t.T(title) });
  for (let n = 1; n <= pages; n++) await api.pages.put(gid, n, await t.png(n * 30));
  return { id, gid };
}, name, title, pages);
const described = (page, path) => until(page, (p) => window.__t.text(p), path, { what: path });

test('R02: two galleries with one title get folders of their own, and deleting one leaves the other\'s pictures', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const { id } = await api.folders.add(await t.folder('Lib'));
      await api.folders.setDefault(id);
      const a = api.newGalleryId(); await t.sleep(5); const b = api.newGalleryId();
      for (const g of [a, b]) await api.meta.put({ galleryId: g, title: t.T('Same title') });
      const first = await t.png(0, 30, 40), second = await t.png(200, 50, 60);
      await Promise.all([api.pages.put(a, 1, first), api.pages.put(b, 1, second)]);
      const dirs = [(await t.raw('galleries', a)).dir, (await t.raw('galleries', b)).dir];
      const reads = [(await api.pages.blob(a, 1))?.size, (await api.pages.blob(b, 1))?.size];
      await api.galleries.delete(a);
      await t.sleep(500);
      return { dirs, sizes: [first.size, second.size], reads, readB: (await api.pages.blob(b, 1))?.size ?? null, top: await t.ls('Lib') };
    });
    assert.deepEqual([...out.dirs].sort(), ['Same title', 'Same title (2)'], 'a folder each');
    assert.deepEqual(out.reads, out.sizes, 'each reads its own picture');
    assert.equal(out.readB, out.sizes[1], 'the other gallery\'s picture stays');
    assert.deepEqual(out.top, ['.shiori/', `${out.dirs[1]}/`]);
  });
});

test('R02: a gallery whose folder another gallery\'s description names never writes there, nor deletes it', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id, gid: a } = await setup(page, 'Lib', 'First');
    await described(page, 'Lib/First/image_records.json');
    const out = await page.evaluate(async (id, a) => {
      const api = window.__api, t = window.__t;
      // What two galleries sharing one folder (an earlier version's race) left behind.
      const b = api.newGalleryId();
      await api.meta.put({ galleryId: b, title: t.T('Second') });
      await t.raw('galleries', null, { galleryId: b, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: id, dir: 'First' });
      await api.pages.put(b, 1, await t.png(77, 44, 44));
      const spilled = (await t.raw('galleries', b)).spilled ?? null;
      await api.galleries.delete(b);
      await t.sleep(500);
      return { spilled, files: await t.ls('Lib/First/images'), named: JSON.parse(await t.text('Lib/First/metadata.json')).galleryId, a,
        readA: (await api.pages.blob(a, 1))?.size > 0 };
    }, id, a);
    assert.equal(out.spilled, 1, 'its picture waits in the browser');
    assert.deepEqual(out.files, ['0001.png'], 'nothing written into the other\'s folder, nothing deleted from it');
    assert.equal(out.named, out.a);
    assert.equal(out.readA, true);
  });
});

test('R03: a restore refused for a page key another gallery holds writes nothing over the picture a record refers to', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { gid: a } = await setup(page, 'Lib', 'A');
    const out = await page.evaluate(async (a) => {
      const api = window.__api, t = window.__t;
      const b = api.newGalleryId();
      await api.meta.put({ galleryId: b, title: t.T('B') });
      await api.pages.put(b, 1, await t.png(100, 31, 41));
      const bUrl = (await api.pages.list(b))[0].url;
      const NEW = await t.png(200, 77, 77);
      const err = await api.transfer.write({ galleryId: a, pages: [{ url: bUrl, blob: NEW, galleryId: a, mediaId: a, size: NEW.size }] })
        .then(() => 'resolved', (e) => e.code);
      return { err, readA: (await api.pages.blob(a, 1))?.size, recordA: (await api.pages.all(a))[0]?.size, readB: (await api.pages.blob(b, 1))?.size,
        bSize: (await api.pages.all(b))[0]?.size, aFiles: await t.ls('Lib/A/images') };
    }, a);
    assert.equal(out.err, 'conflict');
    assert.equal(out.readA, out.recordA, 'the record describes the bytes its file holds');
    assert.equal(out.readB, out.bSize);
    assert.deepEqual(out.aFiles, ['0001.png'], 'nothing was written');
  });
});

test('R03: a study layer for a translation replaced meanwhile never lands over the newer one', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { gid } = await setup(page, 'Lib', 'Study race');
    const out = await page.evaluate(async (g) => {
      const api = window.__api, t = window.__t;
      const pipe = (job) => ({ job, lines: [], read: [], regions: [] });
      await api.derived.putTranslation(g, 1, { image: await t.png(10), pipeline: pipe('j1') });
      const bg1 = await t.png(20, 111, 11), bg2 = await t.png(30, 222, 22);
      const bubbles = [{ box: { x: 1, y: 1, w: 9, h: 9 }, region: { x: 1, y: 1, w: 9, h: 9 }, tr: 'Hi', src: 'やあ' }];
      const open = t.holdWrites(bg1.size);
      const j1 = api.derived.putStudy(g, 1, { bg: bg1, page: { w: 30, h: 40 }, bubbles }, 'j1');
      await t.sleep(200);   // j1 is writing its layer now
      const j2 = (async () => {
        await api.derived.putTranslation(g, 1, { image: await t.png(40), pipeline: pipe('j2') });
        await api.derived.putStudy(g, 1, { bg: bg2, page: { w: 30, h: 40 }, bubbles }, 'j2');
      })();
      await t.sleep(200);
      open();
      await Promise.all([j1, j2]);
      await t.sleep(500);
      return { job: (await api.pages.all(g))[0]?.pipeline?.job, bg: (await api.derived.studyList(g))[0]?.bg?.size, bg2: bg2.size,
        layers: await t.ls('Lib/Study race/study/bg') };
    }, gid);
    assert.equal(out.job, 'j2');
    assert.equal(out.bg, out.bg2, 'the newer translation\'s layer');
    assert.equal(out.layers.length, 1, 'the layer replaced is gone');
  });
});

test('R04: a change marks its gallery in its own transaction, and a tab closed at once leaves the mark for the next one', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const { gid } = await setup(page, 'Lib', 'Original');
    await described(page, 'Lib/Original/image_records.json');
    const mark = await page.evaluate(async (g) => {
      await window.__api.galleries.mutate(g, { title: window.__t.T('EDITED') });
      return window.__t.raw('undescribed', g);
    }, gid);
    assert.ok(mark?.rev > 0, 'marked by the change itself');
    await page.close();   // before any timer could describe it
    page = await tab(ctx);
    const out = await page.evaluate(async (g) => {
      await window.__api.folders.settle();
      return { title: JSON.parse(await window.__t.text('Lib/Original/metadata.json')).title.english, mark: await window.__t.raw('undescribed', g) };
    }, gid);
    assert.equal(out.title, 'EDITED', 'the next tab wrote it to the folder');
    assert.equal(out.mark, null, 'and cleared the mark');
  });
});

test('R08: a folder whose claim can\'t be read is read, never written, until it is taken back', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const { id, gid } = await setup(page, 'Lib', 'Claimed');
    await described(page, 'Lib/Claimed/image_records.json');
    await page.evaluate(() => window.__t.write('Lib/.shiori/owner.json', '{ damaged'));
    await page.reload({ waitUntil: 'load' });
    page = await tab(ctx);
    const out = await page.evaluate(async (id, g) => {
      const api = window.__api, t = window.__t;
      const listed = (await api.folders.list()).find(f => f.id === id);
      await api.pages.put(g, 2, await t.png(90));
      const waiting = { spilled: (await t.raw('galleries', g)).spilled ?? null, files: await t.ls('Lib/Claimed/images'), claim: await t.text('Lib/.shiori/owner.json') };
      const claimed = await api.folders.claim(id);
      await api.folders.settle();
      return { access: listed.access, owner: listed.owner ?? null, waiting, claimed, files: await t.ls('Lib/Claimed/images'),
        spilled: (await t.raw('galleries', g)).spilled ?? null, page2: (await api.pages.blob(g, 2))?.size ?? null };
    }, id, gid);
    assert.equal(out.access, 'taken', 'shown as not this library\'s');
    assert.equal(out.owner, null, 'by no one it can name');
    assert.deepEqual(out.waiting, { spilled: 1, files: ['0001.png'], claim: '{ damaged' }, 'the new page waits in the browser; the claim is left as it is');
    assert.equal(out.claimed, 'granted');
    assert.deepEqual(out.files, ['0001.png', '0002.png'], 'taken back, what waited is written there');
    assert.equal(out.spilled, null);
    assert.ok(out.page2 > 0);
  });
});

test('R10: a move keeps what was written to the gallery while its pictures were copied', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const g = api.newGalleryId();
      await api.meta.put({ galleryId: g, title: t.T('Mover') });
      for (let n = 1; n <= 8; n++) await api.pages.put(g, n, await t.png(n * 20));
      await api.derived.putTranslation(g, 2, { image: await t.png(5, 30, 40), pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
      const { id } = await api.folders.add(await t.folder('Lib'));
      const NEWTR = await t.png(250, 91, 91);
      let during = null;
      const moved = await api.galleries.move(g, id, { onProgress: (done) => {
        if (done === 1 && !during) during = (async () => {
          await api.derived.setOwn([{ galleryId: g, pageNum: 1 }], 'NEW-SETTINGS');
          await api.derived.putTranslatedImage(g, 2, NEWTR);
        })();
      } });
      await during;
      const recs = await api.pages.all(g);
      return { moved: moved.moved.length, own: recs.find(r => r.pageNum === 1)?.own ?? null, tr: (await api.pages.blob(g, 2, 'translated'))?.size,
        newTr: NEWTR.size, folder: (await t.raw('galleries', g)).folder === id };
    });
    assert.equal(out.moved, 1);
    assert.equal(out.folder, true);
    assert.equal(out.own, 'NEW-SETTINGS', 'a setting changed during the copy stays');
    assert.equal(out.tr, out.newTr, 'a translation replaced during the copy stays');
  });
});

test('A01: two moves of one gallery at once leave it whole', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const g = api.newGalleryId();
      await api.meta.put({ galleryId: g, title: t.T('Twice') });
      for (let n = 1; n <= 4; n++) await api.pages.put(g, n, await t.png(n * 30));
      const { id } = await api.folders.add(await t.folder('Lib'));
      const results = await Promise.all([api.galleries.move(g, id), api.galleries.move(g, id)]);
      await t.sleep(500);
      const reads = [];
      for (let n = 1; n <= 4; n++) reads.push((await api.pages.blob(g, n))?.size ?? null);
      return { moved: results.map(r => r.moved.length).sort(), folder: (await t.raw('galleries', g)).folder === id, top: await t.ls('Lib'),
        files: await t.ls('Lib/Twice/images'), reads };
    });
    assert.deepEqual(out.moved, [0, 1], 'one moved it, the other found it there');
    assert.equal(out.folder, true);
    assert.deepEqual(out.top, ['.shiori/', 'Twice/']);
    assert.deepEqual(out.files, ['0001.png', '0002.png', '0003.png', '0004.png']);
    assert.ok(out.reads.every(n => n > 0), 'every picture reads back');
  });
});

test('A02: a write under way as its folder is removed is refused; adding the folder back finds the gallery as the folder has it', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id, gid } = await setup(page, 'Lib', 'Inflight');
    await described(page, 'Lib/Inflight/image_records.json');
    const out = await page.evaluate(async (id, g) => {
      const api = window.__api, t = window.__t;
      const p2 = await t.png(120, 77, 55);
      const open = t.holdWrites(p2.size);
      const put = api.pages.put(g, 2, p2).then(() => 'resolved', (e) => e.reason || e.code);
      await t.sleep(200);   // its picture is being written
      const removed = await api.folders.remove(id);
      const aside = api.folders.setAside(id);
      await t.sleep(200);
      open();
      const putResult = await put;
      const asideResult = await aside;
      await t.sleep(300);
      const afterRemoval = { stat: await t.raw('galleries', g), files: await t.ls('Lib/Inflight/images'), listed: (await api.folders.list()).some(f => f.id === id) };
      await api.folders.add(await t.folder('Lib'));
      const scan = await api.folders.scan(id);
      return { removed: removed.galleries, putResult, asideResult, afterRemoval, scan: scan.added, back: (await api.meta.get(g))?.title?.english,
        pages: (await api.pages.list(g)).length };
    }, id, gid);
    assert.equal(out.putResult, 'hidden', 'refused as it committed');
    assert.equal(out.asideResult.stopped, false);
    assert.deepEqual(out.afterRemoval, { stat: null, files: ['0001.png'], listed: false }, 'no ghost record, and the refused picture is gone');
    assert.equal(out.scan, 1, 'added back');
    assert.equal(out.back, 'Inflight');
    assert.equal(out.pages, 1);
  });
});

test('A03: clearing the library leaves the galleries\' folders in a folder another app took over', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const { id } = await setup(page, 'Lib', 'Kept');
    await described(page, 'Lib/Kept/image_records.json');
    await page.evaluate(async () => {
      const t = window.__t;
      const cur = JSON.parse(await t.text('Lib/.shiori/owner.json'));
      await t.write('Lib/.shiori/owner.json', JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'another-app', by: { app: 'desktop', host: 'PC' }, at: Date.now(), epoch: cur.epoch + 1 }));
    });
    page = await tab(ctx);
    const out = await page.evaluate(async (id) => {
      const api = window.__api, t = window.__t;
      const access = (await api.folders.list()).find(f => f.id === id)?.access;
      await api.browserLibraryForMove().clear();
      return { access, top: await t.ls('Lib'), files: await t.ls('Lib/Kept/images') };
    }, id);
    assert.equal(out.access, 'taken');
    assert.deepEqual(out.top, ['.shiori/', 'Kept/'], 'the other app\'s gallery stays');
    assert.deepEqual(out.files, ['0001.png']);
  });
});

test('A04: a restore keeps where a gallery is kept — pictures waiting in the browser, a linked source', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const first = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      for (const n of [1, 2]) await t.write(`Lib/Pics/${n}.png`, await t.png(n * 40));
      const { id } = await api.folders.add(await t.folder('Lib'));
      await api.folders.setDefault(id);
      await api.folders.scan(id);
      const [linked] = await api.transfer.ids();
      const cur = JSON.parse(await t.text('Lib/.shiori/owner.json'));
      await t.write('Lib/.shiori/owner.json', JSON.stringify({ ...cur, owner: 'another-app', epoch: cur.epoch + 1 }));
      return { id, linked };
    });
    page = await tab(ctx);
    const out = await page.evaluate(async ({ id, linked }) => {
      const api = window.__api, t = window.__t;
      const g = api.newGalleryId();
      await api.meta.put({ galleryId: g, title: t.T('Waiting') });
      await api.pages.put(g, 1, await t.png(300));
      const before = { spilled: (await t.raw('galleries', g)).spilled, linked: !!(await t.raw('galleries', linked)).linked };
      // What restoring a metadata backup does with each gallery.
      for (const gid of [g, linked]) {
        const meta = await api.meta.get(gid);
        const { stat } = await api.transfer.read(gid, { pages: false });
        await api.transfer.write({ galleryId: gid, meta: { ...meta, fetchedAt: Date.now() }, stat: { ...stat, latestAt: Date.now() } }, { silent: true });
      }
      const restored = { spilled: (await t.raw('galleries', g)).spilled ?? null, folder: (await t.raw('galleries', g)).folder === id,
        linked: !!(await t.raw('galleries', linked)).linked };
      await api.folders.claim(id);
      await api.folders.settle();
      return { before, restored, dir: (await t.raw('galleries', g)).dir ?? null, spilled: (await t.raw('galleries', g)).spilled ?? null };
    }, first);
    assert.deepEqual(out.before, { spilled: 1, linked: true });
    assert.deepEqual(out.restored, { spilled: 1, folder: true, linked: true }, 'its place survives the restore');
    assert.equal(out.dir, 'Waiting', 'taken back, what waited went to the folder');
    assert.equal(out.spilled, null);
  });
});

test('A11, R17: a linked gallery that leaves its folder — moved out, or deleted with others at once — is noted there, and a check doesn\'t add it again', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      for (const name of ['Move', 'One', 'Two', 'Three']) await t.write(`Lib/${name}/1.png`, await t.png(name.length * 40));
      const { id } = await api.folders.add(await t.folder('Lib'));
      const added = (await api.folders.scan(id)).added;
      const byTitle = {};
      for (const gid of await api.transfer.ids()) byTitle[(await api.meta.get(gid)).title.english] = gid;
      await api.galleries.move(byTitle.Move, 'browser');
      await Promise.all(['One', 'Two', 'Three'].map(name => api.galleries.delete(byTitle[name])));
      await t.sleep(800);
      const removed = JSON.parse(await t.text('Lib/.shiori/linked/removed.json')).removed.map(r => r.path).sort();
      const again = (await api.folders.scan(id)).added;
      return { added, removed, again, moved: (await api.pages.blob(byTitle.Move, 1))?.size > 0, source: await t.ls('Lib/Move') };
    });
    assert.equal(out.added, 4);
    assert.deepEqual(out.removed, ['Move', 'One', 'Three', 'Two'], 'every one noted');
    assert.equal(out.again, 0, 'none added again');
    assert.equal(out.moved, true, 'the moved one is the library\'s own now');
    assert.deepEqual(out.source, ['1.png'], 'its source stays where it was');
  });
});
