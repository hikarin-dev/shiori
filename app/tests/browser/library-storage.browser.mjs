// library-storage.browser.mjs — how the browser library writes to its folders, one regression test
// per audit finding (plans/library-storage-spec.md), each in a browser profile of its own. A picture
// is written under a name no file has, its record commits, and only then does the file it replaced
// go; writes to one gallery never interleave, across tabs and the service worker; a gallery's folder
// is reserved for it alone and says whose it is; a change marks its gallery as not written to its
// folder in its own transaction; a folder this library doesn't hold is never written to or deleted
// from; a restore keeps where a gallery is kept. And how it reads them back and manages them: what is
// Shiori's own is told by its descriptions, never by names; an archive in the gallery format is a
// gallery of its own; a linked source keeps its identity, its overlay's pages and its series through
// renames, removals and re-adds; a re-read never overwrites changes not written yet; a PDF joins once
// all its pages are drawn, and one that can't be is not tried again; one job runs on a folder at a
// time; a removal reports what it couldn't move; visibility changes are logged. The folders are in
// the browser's private file system (OPFS), always permitted — as in library-folders.browser.mjs (a
// test needing a folder that asks for leave stubs the handles' permission).
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
    // `path` (a file or a folder, with all it holds) deleted; moved to `to`.
    const remove = async (path) => { const parts = path.split('/'); await (await dirOf(parts.slice(0, -1).join('/'))).removeEntry(parts.at(-1), { recursive: true }); };
    const move = async (from, to) => {
      const copy = async (a, b) => {
        for await (const [n, h] of (await dirOf(a)).entries()) {
          if (h.kind === 'directory') await copy(`${a}/${n}`, `${b}/${n}`); else await write(`${b}/${n}`, await h.getFile());
        }
      };
      await copy(from, to);
      await remove(from);
    };
    // Another app's claim on folder `name`, a step past this library's.
    const takeOver = async (name) => {
      const cur = JSON.parse(await text(`${name}/.shiori/owner.json`));
      await write(`${name}/.shiori/owner.json`, JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'another-app', by: { app: 'desktop', host: 'PC' }, at: Date.now(), epoch: cur.epoch + 1 }));
    };
    const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
    const until = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(150); }
      return null;
    };
    const db = await import('/app/js/db.js');
    const inFolder = async (id) => (await db.galleryGetAll()).filter(g => g.folder === id);
    const { zipCreate } = await import('/app/js/zip.js');
    window.__api = await import('/app/js/api.js');
    // Folder `id`'s hand-over (S32) through: the other app's moment passed — its mark aged, rather than
    // waited out — and its check joined (what the check found).
    const handedOver = async (id) => {
      const f = await raw('folders', id);
      if (f?.handover) await raw('folders', null, { ...f, handover: { ...f.handover, at: f.handover.at - 60000 } });
      return window.__api.folders.scan(id);
    };
    window.__t = { png, folder, ls, file, text, write, raw, holdWrites, sleep, T, remove, move, takeOver, bytes, until, db, inFolder, zipCreate, handedOver };
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
      // Its folder goes once the deletion has committed.
      await t.until(async () => !(await t.ls('Lib')).includes(`${dirs[0]}/`));
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
      await api.folders.settle();   // a file let go is deleted once the change is published
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
      // A change to its gallery is accepted meanwhile and waits in this browser: a claim that can't be
      // checked is no knowledge that another app holds the folder (S29b, C1) — but nothing is written there.
      const refused = await api.pages.put(g, 2, await t.png(90)).then(() => 'resolved', (e) => e.reason);
      const meanwhile = { refused, spilled: (await t.raw('galleries', g)).spilled ?? null, files: await t.ls('Lib/Claimed/images'), claim: await t.text('Lib/.shiori/owner.json') };
      const claimed = await api.folders.claim(id);
      await t.handedOver(id);
      await api.folders.settle();
      return { access: listed.access, owner: listed.owner ?? null, waiting: meanwhile, claimed, files: await t.ls('Lib/Claimed/images'),
        spilled: (await t.raw('galleries', g)).spilled ?? null, page2: (await api.pages.blob(g, 2))?.size ?? null };
    }, id, gid);
    assert.equal(out.access, 'taken', 'shown as not this library\'s');
    assert.equal(out.owner, null, 'by no one it can name');
    assert.deepEqual(out.waiting, { refused: 'resolved', spilled: 1, files: ['0001.png'], claim: '{ damaged' }, 'a new page waits in this browser, nothing written there; the claim is left as it is');
    assert.equal(out.claimed, 'granted');
    assert.deepEqual(out.files, ['0001.png', '0002.png'], 'taken back, the page that waited is written there');
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
      // What restoring a metadata backup does with a gallery.
      const restore = async (gid) => {
        const meta = await api.meta.get(gid);
        const { stat } = await api.transfer.read(gid, { pages: false });
        await api.transfer.write({ galleryId: gid, meta: { ...meta, fetchedAt: Date.now() }, stat: { ...stat, latestAt: Date.now() } }, { silent: true });
      };
      await restore(g);
      // The linked gallery is the folder's, which another app holds: read-only here until the take-back.
      const refused = await restore(linked).then(() => 'resolved', (e) => e.reason);
      const waiting = { spilled: (await t.raw('galleries', g)).spilled ?? null, folder: (await t.raw('galleries', g)).folder === id };
      await api.folders.claim(id);
      await t.handedOver(id);
      await restore(linked);
      const restored = { ...waiting, linked: !!(await t.raw('galleries', linked)).linked };
      await api.folders.settle();
      return { before, refused, restored, dir: (await t.raw('galleries', g)).dir ?? null, spilled: (await t.raw('galleries', g)).spilled ?? null };
    }, first);
    assert.deepEqual(out.before, { spilled: 1, linked: true });
    assert.equal(out.refused, 'not-owned', 'a linked gallery of a folder another app holds isn\'t restored over');
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

// ── Reading a folder back (stage 2) ──

// A one-page PDF.
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
// Until gallery `gid` has nothing waiting to be written to its folder (its descriptions written).
const settled = (page, gid) => until(page, async (g) => !(await window.__t.raw('undescribed', g)) && !(await window.__t.raw('galleries', g))?.spilled, gid, { what: `gallery ${gid} written to its folder` });

test('R01: pictures in an images/ folder, or beside another tool\'s metadata.json, are linked: read in place, and deleting them leaves every file', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('R01/Ordinary/images/1.png', await t.png(10));
      await t.write('R01/Ordinary/notes.txt', 'my notes');
      await t.write('R01/Photos/metadata.json', JSON.stringify({ title: 'some other tool', camera: 'X100' }));
      await t.write('R01/Photos/a.png', await t.png(20));
      const { id } = await api.folders.add(await t.folder('R01'));
      const scan = await api.folders.scan(id);
      const kept = await t.inFolder(id);
      for (const g of kept) await api.galleries.delete(String(g.galleryId));
      await t.sleep(800);
      return { scan: scan.added, linked: kept.map(g => !!g.linked), ordinary: await t.ls('R01/Ordinary'), images: await t.ls('R01/Ordinary/images'),
        photos: await t.ls('R01/Photos'), camera: JSON.parse(await t.text('R01/Photos/metadata.json')).camera };
    });
    assert.equal(out.scan, 2);
    assert.deepEqual(out.linked, [true, true], 'neither is Shiori\'s');
    assert.deepEqual([out.ordinary, out.images, out.photos], [['images/', 'notes.txt'], ['1.png'], ['a.png', 'metadata.json']], 'every file stays');
    assert.equal(out.camera, 'X100', 'the other tool\'s description is never rewritten');
  });
});

test('R11: a PDF joins once all its pages are drawn, never with the pages drawn so far', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async (pdf) => {
      const api = window.__api, t = window.__t;
      await t.write('R11/Book.pdf', pdf);
      const { id } = await api.folders.add(await t.folder('R11'));
      const first = (await api.folders.scan(id)).added;
      const [w] = await api.folders.pdfsWaiting();
      // A window drawing it has written its first page so far.
      await t.write(`R11/.shiori/linked/${w.gid}/images/0001.webp`, await t.png(5));
      const partial = (await api.folders.scan(id)).added;
      const still = (await api.folders.pdfsWaiting()).length;
      const made = await api.folders.addRendered(id, w.gid, [await t.png(10), await t.png(20)], (await api.folders.pdfSource(id, w.gid)).token);
      const source = JSON.parse(await t.text(`R11/.shiori/linked/${w.gid}/source.json`)).source;
      return { first, partial, still, made: made === w.gid, count: (await api.galleries.get(w.gid))?.count, rendered: source.rendered?.pages, again: (await api.folders.scan(id)).added };
    }, PDF);
    assert.deepEqual(out, { first: 0, partial: 0, still: 1, made: true, count: 2, rendered: 2, again: 0 });
  });
});

test('R13: a page replaced in a linked gallery stays replaced when its source is renamed and back (D5: missing meanwhile), and when its folder is removed and added again', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id, gid, repl } = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('R13/Loose/1.png', await t.png(10));
      await t.write('R13/Loose/2.png', await t.png(100));
      const { id } = await api.folders.add(await t.folder('R13'));
      await api.folders.scan(id);
      const [g] = await t.inFolder(id);
      const repl = await t.png(250, 50, 70);
      await api.pages.put(String(g.galleryId), 1, repl);
      return { id, gid: String(g.galleryId), repl: repl.size };
    });
    await settled(page, gid);
    const out = await page.evaluate(async ({ id, gid }) => {
      const api = window.__api, t = window.__t;
      await t.move('R13/Loose', 'R13/Loose Renamed');
      const renamed = await api.folders.scan(id);
      const afterRename = [(await api.pages.blob(gid, 1))?.size, (await t.raw('galleries', gid)).linked.path, (await api.galleries.get(gid)).missing];
      await t.move('R13/Loose Renamed', 'R13/Loose');
      await api.folders.scan(id);
      const back = (await api.galleries.get(gid)).missing ?? false;
      await api.folders.setDefault('browser');
      await api.folders.remove(id);
      await api.folders.setAside(id);
      await api.folders.add(await t.folder('R13'));
      const readded = await api.folders.scan(id);
      return { renamed: [renamed.added, renamed.updated], afterRename, back, readded: readded.added, afterReadd: (await api.pages.blob(gid, 1))?.size,
        count: (await api.galleries.get(gid))?.count };
    }, { id, gid });
    assert.deepEqual(out.renamed, [1, 0], 'renamed: another source, joining as new');
    assert.deepEqual(out.afterRename, [repl, 'Loose', true], 'this gallery missing meanwhile, its own page 1 kept in its overlay');
    assert.equal(out.back, false, 'renamed back: this gallery again');
    assert.equal(out.readded, 1);
    assert.equal(out.afterReadd, repl, 'added again: the same');
    assert.equal(out.count, 2);
  });
});

// An archive in the gallery format: Native.zip with pages 1 and 3 (sparse), their records, a
// translation of page 1 and both covers.
async function nativeZip(page) {
  return page.evaluate(async () => {
    const api = window.__api, t = window.__t;
    const gid = api.newGalleryId();
    const [p1, p3, tr, cv, cs] = await Promise.all([t.png(10), t.png(30, 40, 60), t.png(200), t.png(120, 20, 20), t.png(140, 22, 22)]);
    const json = (v) => new TextEncoder().encode(JSON.stringify(v));
    await t.write('R14/Native.zip', t.zipCreate([
      { name: 'metadata.json', data: json({ galleryId: gid, title: t.T('Native'), tags: [], numPages: 2 }) },
      { name: 'image_records.json', data: json([{ url: `local://${gid}/1.png`, mediaId: 'm1' }, { url: `local://${gid}/3.png`, mediaId: 'm3' }]) },
      { name: 'images/0001.png', data: await t.bytes(p1) }, { name: 'images/0003.png', data: await t.bytes(p3) },
      { name: 'translated/0001.png', data: await t.bytes(tr) },
      { name: 'covers/gallery.png', data: await t.bytes(cv) }, { name: 'covers/series.png', data: await t.bytes(cs) },
      { name: 'covers/manifest.json', data: json({ covers: [{ role: 'gallery', file: 'covers/gallery.png' }, { role: 'series', file: 'covers/series.png' }] }) },
    ]));
    return { gid, sizes: { p1: p1.size, p3: p3.size, cv: cv.size, cs: cs.size } };
  });
}

test('R14, A15: an archive in the gallery format is a gallery of its own, read in place — sparse page numbers, its records, both covers — and unpacked beside it on its first change', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { gid, sizes } = await nativeZip(page);
    const read = await page.evaluate(async (gid) => {
      const api = window.__api, t = window.__t;
      const { id } = await api.folders.add(await t.folder('R14'));
      const scan = await api.folders.scan(id);
      const stat = await t.raw('galleries', gid);
      const cover = await t.raw('covers', gid);
      return { id, scan: scan.added, dir: stat.dir, packed: stat.packed, linked: stat.linked ?? null, pages: (await api.pages.list(gid)).map(p => p.pageNum),
        p1: (await api.pages.blob(gid, 1))?.size, p3: (await api.pages.blob(gid, 3))?.size, mediaId: (await api.pages.get(gid, 3))?.mediaId,
        covers: [cover?.cover?.$path, cover?.seriesCover?.$path], overlays: (await t.ls('R14/.shiori')).includes('linked/') };
    }, gid);
    assert.deepEqual({ ...read, id: undefined }, { id: undefined, scan: 1, dir: 'Native.zip', packed: { inner: '' }, linked: null, pages: [1, 3], p1: sizes.p1, p3: sizes.p3,
      mediaId: 'm3', covers: ['covers/gallery.png', 'covers/series.png'], overlays: false }, 'its own gallery, no overlay made');
    const out = await page.evaluate(async (gid) => {
      const api = window.__api, t = window.__t;
      await api.meta.put({ ...(await api.meta.get(gid)), title: t.T('Native, edited') });
      // Published there: its manifest (format v2) is written only once the unpack has committed.
      const written = await t.until(async () => JSON.parse(await t.text('R14/Native/metadata.json')).title.english === 'Native, edited'
        && !!JSON.parse(await t.text('R14/Native/.shiori/gallery.json')).generation);
      // The archive goes once the unpack has committed.
      await t.until(async () => !(await t.ls('R14')).includes('Native.zip'));
      const stat = await t.raw('galleries', gid);
      return { written, dir: stat.dir, packed: stat.packed ?? null, top: await t.ls('R14'), images: await t.ls('R14/Native/images'), translated: await t.ls('R14/Native/translated'),
        p3: (await api.pages.blob(gid, 3))?.size };
    }, gid);
    assert.ok(out.written, 'its change is written to the folder it was unpacked into');
    assert.deepEqual([out.dir, out.packed], ['Native', null]);
    assert.deepEqual(out.top, ['.shiori/', 'Native/'], 'the archive went once unpacked');
    assert.deepEqual([out.images, out.translated], [['0001.png', '0003.png'], ['0001.png']]);
    assert.equal(out.p3, sizes.p3);
  });
});

test('R14: a series export archive is a series of galleries of their own, each read in place', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const a = api.newGalleryId(); await t.sleep(5); const b = api.newGalleryId();
      const json = (v) => new TextEncoder().encode(JSON.stringify(v));
      const chapters = [{ id: a, title: 'One', folder: 'One' }, { id: b, title: 'Two', folder: 'Two' }];
      await t.write('S/Series.zip', t.zipCreate([
        { name: 'series.json', data: json({ format: 'shiori-series', version: 1, seriesTitle: 'Series', chapters }) },
        { name: 'One/metadata.json', data: json({ galleryId: a, title: t.T('One'), chapters: chapters.map(({ id, title }) => ({ id, title })), seriesTitle: 'Series' }) },
        { name: 'One/images/0001.png', data: await t.bytes(await t.png(10)) },
        { name: 'Two/metadata.json', data: json({ galleryId: b, title: t.T('Two'), parentId: a }) },
        { name: 'Two/images/0001.png', data: await t.bytes(await t.png(90)) },
      ]));
      const { id } = await api.folders.add(await t.folder('S'));
      const scan = await api.folders.scan(id);
      return { scan: scan.added, chapters: (await api.series.resolve(b))?.chapters.map(c => String(c.id)), a, b,
        packed: [(await t.raw('galleries', a)).packed, (await t.raw('galleries', b)).packed], read: (await api.pages.blob(b, 1))?.size > 0 };
    });
    assert.equal(out.scan, 2);
    assert.deepEqual(out.chapters, [out.a, out.b]);
    assert.deepEqual(out.packed, [{ inner: 'One/' }, { inner: 'Two/' }]);
    assert.ok(out.read);
  });
});

test('R15: a series kept across two folders comes back whole, whichever folder is added first', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const json = (v) => JSON.stringify(v);
      const result = [];
      for (const order of [['Child', 'Owner'], ['Owner', 'Child']]) {
        const owner = api.newGalleryId(); await t.sleep(5); const child = api.newGalleryId();
        const tag = order[0];
        await t.write(`${tag}-Owner/Owner/metadata.json`, json({ galleryId: owner, title: t.T('Owner'), chapters: [{ id: owner, title: 'Owner' }, { id: child, title: 'Child' }], seriesTitle: 'Split' }));
        await t.write(`${tag}-Owner/Owner/images/0001.png`, await t.png(10));
        await t.write(`${tag}-Child/Child/metadata.json`, json({ galleryId: child, title: t.T('Child'), parentId: owner }));
        await t.write(`${tag}-Child/Child/images/0001.png`, await t.png(50));
        for (const which of order) {
          const { id } = await api.folders.add(await t.folder(`${tag}-${which}`));
          await api.folders.scan(id);
        }
        result.push({ chapters: (await api.series.resolve(child))?.chapters.map(c => String(c.id)), parent: String((await api.meta.get(child)).parentId), owner, child });
      }
      return result;
    });
    for (const r of out) {
      assert.deepEqual(r.chapters, [r.owner, r.child], 'the owner lists its chapter');
      assert.equal(r.parent, r.owner, 'the chapter names its series');
    }
  });
});

test('R18, D5: an archive of chapters renamed outside the app joins as new galleries, its old ones missing; renamed back, they are its galleries again, their series and their ids', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const first = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const zip = t.zipCreate([{ name: 'Ch 1/1.png', data: await t.bytes(await t.png(20)) }, { name: 'Ch 2/1.png', data: await t.bytes(await t.png(40)) }]);
      await t.write('R18/Before.zip', zip);
      const { id } = await api.folders.add(await t.folder('R18'));
      const scan = await api.folders.scan(id);
      return { id, scan: scan.added, ids: (await t.inFolder(id)).sort((x, y) => x.linked.inner.localeCompare(y.linked.inner)).map(g => String(g.galleryId)) };
    });
    for (const gid of first.ids) await settled(page, gid);
    const out = await page.evaluate(async ({ id, ids }) => {
      const api = window.__api, t = window.__t;
      await t.write('R18/After.zip', await t.file('R18/Before.zip'));
      await t.remove('R18/Before.zip');
      const scan = await api.folders.scan(id);
      const all = await t.inFolder(id);
      const missing = await Promise.all(ids.map(async (gid) => (await api.galleries.get(gid)).missing ?? false));
      const fresh = all.filter(g => !ids.includes(String(g.galleryId))).map(g => `${g.linked.path} ${g.linked.inner}`).sort();
      await t.write('R18/Before.zip', await t.file('R18/After.zip'));
      await t.remove('R18/After.zip');
      await api.folders.scan(id);
      const kept = (await t.inFolder(id)).filter(g => ids.includes(String(g.galleryId))).sort((x, y) => x.linked.inner.localeCompare(y.linked.inner));
      return { scan: [scan.added, scan.updated], missing, fresh, ids: kept.map(g => String(g.galleryId)), paths: kept.map(g => g.linked.path),
        back: await Promise.all(ids.map(async (gid) => (await api.galleries.get(gid)).missing ?? false)),
        series: (await api.series.resolve(String(kept[1].galleryId)))?.chapters.length };
    }, first);
    assert.equal(first.scan, 2);
    assert.deepEqual(out.scan, [2, 0], 'renamed: its chapters join as galleries of their own');
    assert.deepEqual(out.missing, [true, true], 'the galleries that were there are missing');
    assert.deepEqual(out.fresh, ['After.zip Ch 1/', 'After.zip Ch 2/']);
    assert.deepEqual(out.ids, first.ids, 'renamed back: the same galleries');
    assert.deepEqual([out.paths, out.back], [['Before.zip', 'Before.zip'], [false, false]]);
    assert.equal(out.series, 2, 'still a series');
  });
});

test('R19: a linked folder whose pictures changed is read again; one removed and replaced by other pictures at its path joins again', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('R19/Loose/1.png', await t.png(30));
      const { id } = await api.folders.add(await t.folder('R19'));
      await api.folders.scan(id);
      const [g] = await t.inFolder(id);
      const gid = String(g.galleryId);
      await t.write('R19/Loose/2.png', await t.png(31));
      const grown = await api.folders.scan(id);
      const count = (await api.galleries.get(gid)).count;
      await api.galleries.delete(gid);
      await t.sleep(600);
      await t.remove('R19/Loose');
      for (const [n, hue] of [['a', 200], ['b', 210], ['c', 220]]) await t.write(`R19/Loose/${n}.png`, await t.png(hue, 50 + hue % 7, 60));
      const replaced = await api.folders.scan(id);
      return { grown: grown.updated, count, replaced: replaced.added };
    });
    assert.deepEqual(out, { grown: 1, count: 2, replaced: 1 });
  });
});

test('R20: a removal asked during a check stops the check, then runs; a check asked during a removal is refused', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const jobs = await import('/app/js/folder-scan.js');
      for (let i = 0; i < 40; i++) await t.write(`R20/T${i}/1.png`, await t.png(i * 9));
      const { id } = await api.folders.add(await t.folder('R20'));
      const held = async (kind) => (await navigator.locks.query()).held.some(l => l.name === `shiori:folder-job:${id}:${kind}`);
      const checking = jobs.runFolderScan(id, { name: 'R20' });
      await t.until(() => held('scan'));
      await api.folders.remove(id);
      const removing = jobs.runFolderJob('remove', id, { name: 'R20' });
      await t.until(() => held('removal'));
      const refused = await jobs.runFolderScan(id, { name: 'R20' });
      const [check, removal] = await Promise.all([checking, removing]);
      return { check: check.stopped, removal: removal && !removal.stopped, refused, left: (await api.folders.pending()).setAside.length, listed: (await api.folders.list()).some(f => f.id === id) };
    });
    assert.deepEqual(out, { check: true, removal: true, refused: null, left: 0, listed: false });
  });
});

test('R21: a folder added back once another app took it over while its removal was stopped is refused, unless taken over — then read fresh', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id } = await setup(page, 'Lib', 'Kept');
    await described(page, 'Lib/Kept/image_records.json');
    const out = await page.evaluate(async (id) => {
      const api = window.__api, t = window.__t;
      await api.folders.setDefault('browser');
      await api.folders.remove(id);
      const stopped = (await api.folders.setAside(id, { stopped: () => true })).stopped;
      await t.takeOver('Lib');
      const refused = await api.folders.add(await t.folder('Lib')).then(() => null, (e) => e.reason);
      const forced = await api.folders.add(await t.folder('Lib'), { force: true });
      const scan = await t.handedOver(id);
      return { stopped, refused, restored: forced.restored, added: scan.added, pending: (await api.folders.pending()).setAside.length };
    }, id);
    assert.deepEqual(out, { stopped: true, refused: 'claimed', restored: 0, added: 1, pending: 0 });
  });
});

test('A10: a removal moving its galleries to a place that can\'t take them now is refused; galleries a move couldn\'t take are reported, written back, and the folder still goes', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const { id: a, gid } = await setup(page, 'Lib A', 'Kept');
    await described(page, 'Lib A/Kept/image_records.json');
    const b = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const { id } = await api.folders.add(await t.folder('Lib B'));
      await api.folders.setDefault('browser');
      await t.takeOver('Lib B');
      return id;
    });
    page = await tab(ctx);
    const refused = await page.evaluate((a, b) => window.__api.folders.remove(a, { moveTo: b }).then(() => null, (e) => e.reason), a, b);
    await page.evaluate(async (a, b) => {
      const api = window.__api, t = window.__t;
      await api.folders.claim(b);
      await t.handedOver(b);
      await api.folders.remove(a, { moveTo: b });
      await t.takeOver('Lib B');   // taken again before the move runs
    }, a, b);
    page = await tab(ctx);
    const out = await page.evaluate(async (a, gid) => {
      const api = window.__api, t = window.__t;
      const r = await api.folders.setAside(a);
      return { r, gone: !(await api.galleries.get(gid)), files: await t.ls('Lib A/Kept/images'), moved: await t.ls('Lib B') };
    }, a, gid);
    assert.equal(refused, 'move-to');
    assert.deepEqual(out.r, { removed: 1, moved: 0, left: 1, stopped: false });
    assert.ok(out.gone, 'forgotten with its folder');
    assert.deepEqual(out.files, ['0001.png'], 'its files stay where they were');
    assert.deepEqual(out.moved, ['.shiori/']);
  });
});

test('A14: a linked folder renamed, and back, while the library has changes not written to it yet keeps those changes', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('A14/Loose/1.png', await t.png(30));
      const { id } = await api.folders.add(await t.folder('A14'));
      await api.folders.scan(id);
      const [g] = await t.inFolder(id);
      const gid = String(g.galleryId);
      await api.meta.put({ ...(await api.meta.get(gid)), title: t.T('Edited in library') });
      // Renamed (D5: another source, joining as new; this gallery missing meanwhile), then back.
      await t.move('A14/Loose', 'A14/Loose Renamed');
      const scan = await api.folders.scan(id);
      const missing = (await api.galleries.get(gid)).missing ?? false;
      await t.move('A14/Loose Renamed', 'A14/Loose');
      await api.folders.scan(id);
      return { scan: [scan.added, scan.updated], missing, title: (await api.galleries.get(gid)).title.english, path: (await t.raw('galleries', gid)).linked.path };
    });
    assert.deepEqual(out, { scan: [1, 0], missing: true, title: 'Edited in library', path: 'Loose' }, 'the edit kept');
  });
});

test('A16: two tabs checking one folder at once add each title once', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const id = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      for (const name of ['One', 'Two', 'Three']) await t.write(`A16/${name}/1.png`, await t.png(name.length * 30));
      return (await api.folders.add(await t.folder('A16'))).id;
    });
    const other = await tab(ctx);
    const scans = await Promise.all([page, other].map(p => p.evaluate((id) => window.__api.folders.scan(id), id)));
    const kept = await page.evaluate(async (id) => (await window.__t.inFolder(id)).length, id);
    assert.equal(scans[0].added + scans[1].added, 3);
    assert.equal(kept, 3, 'no title twice');
  });
});

test('A22: Stop on a folder job nothing answers for ends its row', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const platform = await import('/app/js/platform.js');
      const { services } = await import('/app/js/services.js');
      // A check whose runner is gone: its last word, and nothing since.
      await platform.jobs.publish({ gid: 'folder-gone', kind: 'folder', status: 'progress', title: 'Gone', labelKey: 'lf.task_checking', done: 1, total: 9 });
      await services.handle({ type: 'STOP_JOB', galleryId: 'folder-gone', kind: 'folder' });
      return window.__t.until(async () => (await platform.jobs.current()).find(j => j.gid === 'folder-gone' && j.status === 'cancelled') && 'cancelled', 20000);
    });
    assert.equal(out, 'cancelled');
  });
});

test('F13: a dead folder job is ended though its last word shares Stop\'s millisecond, answers late, or is stopped twice', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const platform = await import('/app/js/platform.js');
      const { services } = await import('/app/js/services.js');
      const job = (gid) => ({ gid, kind: 'folder', status: 'progress', title: gid, labelKey: 'lf.task_checking', done: 1, total: 9 });
      const stop = (gid) => services.handle({ type: 'STOP_JOB', galleryId: gid, kind: 'folder' });
      const status = async (gid) => (await platform.jobs.current()).find(j => j.gid === gid)?.status;
      // Its last word and the Stop in one millisecond.
      const now = Date.now, at = now();
      Date.now = () => at;
      try { await platform.jobs.publish(job('folder-same')); await stop('folder-same'); } finally { Date.now = now; }
      // Stopped twice.
      await platform.jobs.publish(job('folder-twice'));
      await stop('folder-twice'); await stop('folder-twice');
      // A last word after the Stop (saved: progress is saved at most every 5 s), then nothing.
      await platform.jobs.publish(job('folder-late'));
      await stop('folder-late');
      await new Promise(r => setTimeout(r, 6000));
      await platform.jobs.publish(job('folder-late'));
      await new Promise(r => setTimeout(r, 7000));
      const lateAt13 = await status('folder-late');
      await window.__t.until(async () => await status('folder-late') === 'cancelled', 12000);
      return { same: await status('folder-same'), twice: await status('folder-twice'), lateAt13, late: await status('folder-late') };
    });
    assert.deepEqual(out, { same: 'cancelled', twice: 'cancelled', lateAt13: 'progress', late: 'cancelled' });
  });
});

test('F02: a removal\'s move into a folder removed or hidden while it is copied is refused — the gallery stays where it was, left, readable', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = {};
    for (const how of ['remove', 'hide']) {
      const { id: a, gid } = await setup(page, `F02 A ${how}`, 'Moving');
      await described(page, `F02 A ${how}/Moving/image_records.json`);
      out[how] = await page.evaluate(async (a, gid, how) => {
        const api = window.__api, t = window.__t;
        const { id: b } = await api.folders.add(await t.folder(`F02 B ${how}`));
        await api.folders.setDefault('browser');
        const open = t.holdWrites((await t.png(30)).size);   // its page, as it is copied
        await api.folders.remove(a, { moveTo: b });
        const aside = api.folders.setAside(a);
        await t.sleep(300);
        if (how === 'remove') { await api.folders.remove(b); await api.folders.setAside(b); } else await api.folders.hide(b);
        open();
        const r = await aside;
        return { r, kept: await t.ls(`F02 A ${how}/Moving/images`), copy: (await t.ls(`F02 B ${how}`)).filter(n => n !== '.shiori/'), gone: !(await api.galleries.get(gid)) };
      }, a, gid, how);
    }
    const left = { r: { removed: 1, moved: 0, left: 1, stopped: false }, kept: ['0001.png'], copy: [], gone: true };
    assert.deepEqual(out, { remove: left, hide: left });
  });
});

test('F11: a folder added back just as its removal lets it go is added afresh once the removal has ended — never restored, then forgotten', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id, gid } = await setup(page, 'F11', 'Saved');
    await described(page, 'F11/Saved/image_records.json');
    const out = await page.evaluate(async (id, gid) => {
      const api = window.__api, t = window.__t;
      await api.folders.setDefault('browser');
      // The removal's last writes held: its claim let go.
      const proto = FileSystemWritableFileStream.prototype, write = proto.write, close = proto.close;
      let open, reached;
      const gate = new Promise((r) => { open = r; }), releasing = new Promise((r) => { reached = r; });
      proto.write = async function (data) { this.__release = typeof data === 'string' && data.includes('"shiori-owner"') && data.includes('"owner": null'); return write.call(this, data); };
      proto.close = async function () { if (this.__release) { reached(); await gate; } return close.call(this); };
      try {
        await api.folders.remove(id);
        const aside = api.folders.setAside(id);
        await releasing;
        const added = api.folders.add(await t.folder('F11'));
        await t.sleep(300);
        open();
        const removal = await aside;
        const readd = await added;
        const listed = (await api.folders.list()).some(f => f.id === id);
        const scan = await api.folders.scan(id);
        return { stopped: removal.stopped, readd, listed, added: scan.added, back: (await api.meta.get(gid))?.title?.english };
      } finally { proto.write = write; proto.close = close; }
    }, id, gid);
    assert.deepEqual(out, { stopped: false, readd: { id, restored: 0 }, listed: true, added: 1, back: 'Saved' });
  });
});

test('F12: a linked gallery deleted while its note can\'t be written stays removed: no check adds its source again, and the note is written later', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('F12/Linked/1.png', await t.png(40));
      const { id } = await api.folders.add(await t.folder('F12'));
      const added = (await api.folders.scan(id)).added;
      const [gid] = await api.transfer.ids();
      const proto = FileSystemWritableFileStream.prototype, write = proto.write;
      proto.write = async function (data) {
        if (typeof data === 'string' && data.includes('"shiori-linked-removed"')) throw new DOMException('injected', 'QuotaExceededError');
        return write.call(this, data);
      };
      let meanwhile;
      try {
        await api.galleries.delete(gid);
        await t.sleep(300);
        meanwhile = { noted: !!(await t.text('F12/.shiori/linked/removed.json'))?.includes('Linked'), overlay: (await t.ls(`F12/.shiori/linked/${gid}`)).length > 0, again: (await api.folders.scan(id)).added };
      } finally { proto.write = write; }
      const again = (await api.folders.scan(id)).added;
      return { added, meanwhile, again, noted: JSON.parse(await t.text('F12/.shiori/linked/removed.json')).removed.map(r => r.path),
        overlay: (await t.ls(`F12/.shiori/linked/${gid}`)).length > 0, source: await t.ls('F12/Linked') };
    });
    assert.deepEqual(out, { added: 1, meanwhile: { noted: false, overlay: true, again: 0 }, again: 0, noted: ['Linked'], overlay: false, source: ['1.png'] });
  });
});

test('A23: a PDF that can\'t be drawn is noted, and not tried again until its file changes', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      await t.write('A23/Bad.pdf', 'not a PDF at all');
      const { id } = await api.folders.add(await t.folder('A23'));
      await api.folders.scan(id);
      const before = (await api.folders.pdfsWaiting()).map(w => w.name);
      const { drawWaitingPdfs } = await import('/app/js/library-folders.js');
      await drawWaitingPdfs();
      const after = (await api.folders.pdfsWaiting()).length;
      await t.write('A23/Bad.pdf', 'still not a PDF, but another file');
      return { before, after, changed: (await api.folders.pdfsWaiting()).length };
    });
    assert.deepEqual(out, { before: ['Bad.pdf'], after: 0, changed: 1 });
  });
});

test('A24: a hidden folder never asks for leave, and what waits for the other folders is moved out all the same', { skip }, async () => {
  await fresh(async (ctx) => {
    let page = await tab(ctx);
    const { x, gy } = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const x = (await api.folders.add(await t.folder('X'))).id;
      await api.folders.setDefault(x);
      const gx = api.newGalleryId();
      await api.meta.put({ galleryId: gx, title: t.T('In X') });
      await api.pages.put(gx, 1, await t.png(10));
      const y = (await api.folders.add(await t.folder('Y'))).id;
      await api.folders.setDefault(y);
      const gy = api.newGalleryId();
      await api.meta.put({ galleryId: gy, title: t.T('In Y') });
      await api.pages.put(gy, 1, await t.png(40));
      return { x, gy };
    });
    // This visit, both folders wait for leave: a new page of Y's gallery waits in the browser.
    const asking = (names) => { const proto = FileSystemDirectoryHandle.prototype, q = proto.__q ||= proto.queryPermission;
      proto.queryPermission = async function (o) { return names.includes(this.name) ? 'prompt' : q.call(this, o); }; };
    page = await tab(ctx);
    await page.evaluate(asking, ['X', 'Y']);
    const spilled = await page.evaluate(async (gy) => { await window.__api.pages.put(gy, 2, await window.__t.png(80)); return (await window.__t.raw('galleries', gy)).spilled; }, gy);
    // Next visit Y may be used, X still asks.
    page = await tab(ctx);
    await page.evaluate(asking, ['X']);
    const out = await page.evaluate(async ({ x, gy }) => {
      const api = window.__api, t = window.__t;
      const waiting = (await api.folders.waiting()).map(f => f.id);
      const { promptFolderAccess } = await import('/app/js/library-folders.js');
      await promptFolderAccess();
      const settled = await t.until(async () => !(await t.raw('galleries', gy)).spilled);
      await api.folders.hide(x);
      return { folders: api.capabilities.folders, waiting: waiting.includes(x), settled: !!settled, hidden: (await api.folders.waiting()).length };
    }, { x, gy });
    assert.equal(spilled, 1);
    assert.deepEqual(out, { folders: 'pick', waiting: true, settled: true, hidden: 0 });
  });
});

test('A26: hiding, showing and removing a folder leave a trace in the change log, so a window that missed the notice reads everything again', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id } = await setup(page, 'Lib', 'Kept');
    const out = await page.evaluate(async (id) => {
      const api = window.__api;
      await api.folders.setDefault('browser');
      const resync = async (step) => { const rev = await api.events.revision(); await step(); return (await api.events.since(rev)).resync; };
      return [await resync(() => api.folders.hide(id)), await resync(() => api.folders.show(id)), await resync(() => api.folders.remove(id))];
    }, id);
    assert.deepEqual(out, [true, true, true]);
  });
});

test('A27: a removal moving its galleries, carried on by the next page, still says it moves them', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id: a } = await setup(page, 'Lib A', 'Kept');
    await described(page, 'Lib A/Kept/image_records.json');
    const out = await page.evaluate(async (a) => {
      const api = window.__api, t = window.__t;
      const platform = await import('/app/js/platform.js');
      const { resumeFolderWork } = await import('/app/js/folder-scan.js');
      const { id: b } = await api.folders.add(await t.folder('Lib B'));
      await api.folders.setDefault('browser');
      await api.folders.remove(a, { moveTo: b });
      const heard = [];
      const ended = new Promise((resolve) => platform.jobs.subscribe((j) => {
        if (j?.gid !== `folder-${a}`) return;
        heard.push([j.status, j.labelKey, j.doneKey, j.found]);
        if (['done', 'error', 'cancelled'].includes(j.status)) resolve();
      }));
      await resumeFolderWork();
      await ended;
      return { first: heard[0].slice(0, 3), last: heard.at(-1), there: await t.ls('Lib B/Kept/images') };
    }, a);
    assert.deepEqual(out.first, ['started', 'lf.task_moving', 'lf.task_moved']);
    assert.deepEqual(out.last, ['done', 'lf.task_moving', 'lf.task_moved', 1]);
    assert.deepEqual(out.there, ['0001.png']);
  });
});

test('a gallery\'s folder moved by hand inside its library folder is read again where it is now, not added as a copy', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { id, gid } = await setup(page, 'Lib', 'Moved');
    await described(page, 'Lib/Moved/image_records.json');
    await settled(page, gid);
    const out = await page.evaluate(async ({ id, gid }) => {
      const api = window.__api, t = window.__t;
      await t.move('Lib/Moved', 'Lib/Sub/Moved');
      const scan = await api.folders.scan(id);
      return { scan: [scan.added, scan.updated], dir: (await t.raw('galleries', gid)).dir, read: (await api.pages.blob(gid, 1))?.size > 0, count: (await t.inFolder(id)).length };
    }, { id, gid });
    assert.deepEqual(out, { scan: [0, 1], dir: 'Sub/Moved', read: true, count: 1 });
  });
});

test('F04: a gallery\'s descriptions name the file each picture is in where a replacement took another name, so another app reads it whole', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const { gid } = await setup(page, 'Lib', 'Twice');
    const out = await page.evaluate(async (g) => {
      const api = window.__api, t = window.__t;
      const { folderPictures, derivedRecord } = await import('/app/js/storage/gallery-files.js');
      const bubbles = [{ box: { x: 1, y: 1, w: 9, h: 9 }, region: { x: 1, y: 1, w: 9, h: 9 }, tr: 'Hi', src: 'やあ' }];
      // Every picture made from the page, and both covers, written twice: the second of each under
      // another name, its layout name in use by the first while it is replaced (a translation drops
      // the page's study layers, so they are written twice after it).
      const made = {};
      for (const round of [1, 2]) {
        const [tr, raw, text, cover, series] = await Promise.all([1, 2, 3, 4, 5].map(k => t.png(k * 40 + round, 20 + k, 30 + round)));
        Object.assign(made, { tr, raw, text, cover, series });
        await api.derived.putTranslation(g, 1, { image: tr, pipeline: { job: `j${round}`, lines: [], read: [], regions: [], masks: { raw, text } } });
        await api.covers.put(g, cover, { role: 'gallery' });
        await api.covers.put(g, series, 'series');
      }
      for (const round of [1, 2]) {
        const [bg, layer] = await Promise.all([6, 7].map(k => t.png(k * 40 + round, 20 + k, 30 + round)));
        Object.assign(made, { bg, layer });
        await api.derived.putStudy(g, 1, { bg, page: { w: 30, h: 40 }, bubbles: bubbles.map(b => ({ ...b, text: layer })) }, 'j2');
      }
      // Its folder as another app finds it: its descriptions, once written, and its pictures there.
      const records = await t.until(async () => { const r = JSON.parse(await t.text('Lib/Twice/image_records.json')); return r[0]?.files?.length === 5 && r; });
      const paths = [];
      for (const dir of ['images', 'translated', 'study/bg', 'study/text', 'pipeline', 'covers']) {
        for (const name of await t.ls(`Lib/Twice/${dir}`)) if (/\.png$/.test(name)) paths.push(`${dir}/${name}`);
      }
      const pictures = folderPictures(paths, { records, manifest: JSON.parse(await t.text('Lib/Twice/covers/manifest.json')) });
      const read = derivedRecord(pictures, JSON.parse(await t.text('Lib/Twice/study/bubbles.json')), 1, records[0], (p) => p);
      const sizeOf = async (p) => (p ? (await t.file(`Lib/Twice/${p}`))?.size : null);
      const at = { tr: read.translated, raw: read.pipeline?.masks?.raw, text: read.pipeline?.masks?.text, bg: read.studyBg, layer: read.bubbles?.[0]?.text,
        cover: pictures.covers.gallery, series: pictures.covers.series };
      const sizes = {}, want = {};
      for (const k of Object.keys(at)) { sizes[k] = await sizeOf(at[k]); want[k] = made[k].size; }
      return { named: records?.[0]?.files?.length ?? 0, renamed: Object.values(at).every(p => /-[0-9a-f]{8}\.png$/.test(p || '')), sizes, want };
    }, gid);
    assert.equal(out.named, 5, 'the page\'s five pictures named in its record');
    assert.ok(out.renamed, 'each second picture took another name');
    assert.deepEqual(out.sizes, out.want, 'each read from the file holding its latest picture');
  });
});

test('F10: a drawn PDF whose file changed is drawn again: its old pages read until the new ones are all in, what was made from them dropped', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async (pdf) => {
      const api = window.__api, t = window.__t;
      await t.write('F10/Book.pdf', pdf);
      const { id } = await api.folders.add(await t.folder('F10'));
      await api.folders.scan(id);
      const [w] = await api.folders.pdfsWaiting();
      const first = await t.png(10), second = await t.png(200, 50, 60), third = await t.png(300, 20, 20);
      await api.folders.addRendered(id, w.gid, [first], (await api.folders.pdfSource(id, w.gid)).token);
      await api.derived.putTranslatedImage(w.gid, 1, await t.png(90));
      const translatedOf = async () => !!(await t.raw('images', `local://${w.gid}/1.png`))?.translated;
      const had = await translatedOf();
      const drawn = (await api.folders.pdfsWaiting()).length;
      await t.write('F10/Book.pdf', `${pdf}% and a line more\n`);
      await api.folders.scan(id);
      const changed = (await api.folders.pdfsWaiting()).map(p => p.gid);
      const meanwhile = (await api.pages.blob(w.gid, 1))?.size;
      await api.folders.addRendered(id, w.gid, [second, third], (await api.folders.pdfSource(id, w.gid)).token);
      const source = JSON.parse(await t.text(`F10/.shiori/linked/${w.gid}/source.json`)).source;
      const after = { count: (await api.galleries.get(w.gid))?.count, sizes: [(await api.pages.blob(w.gid, 1))?.size, (await api.pages.blob(w.gid, 2))?.size],
        translated: await translatedOf(), waiting: (await api.folders.pdfsWaiting()).length,
        marker: source.rendered.pages === 2 && source.rendered.fingerprint === source.fingerprint };
      await t.sleep(300);
      await api.folders.settle();   // the old page's file is deleted once its replacement is published
      return { had, drawn, changed, meanwhile, sizes: [first.size, second.size, third.size], after, again: await api.folders.scan(id),
        reread: (await api.pages.blob(w.gid, 1))?.size, images: (await t.ls(`F10/.shiori/linked/${w.gid}/images`)).length };
    }, PDF);
    assert.deepEqual([out.had, out.drawn], [true, 0], 'translated, and drawn from the file as it is');
    assert.equal(out.changed.length, 1, 'drawn again once its file changed');
    assert.equal(out.meanwhile, out.sizes[0], 'its old page read meanwhile');
    assert.deepEqual(out.after, { count: 2, sizes: [out.sizes[1], out.sizes[2]], translated: false, waiting: 0, marker: true });
    assert.deepEqual([out.again.problems, out.reread, out.images], [[], out.sizes[1], 2], 'read back as drawn again, the old page\'s file gone');
  });
});

test('F06: a description or picture that can\'t be read fails its gallery\'s read, reported: never joined in part, nor taken for a linked folder', { skip }, async () => {
  await fresh(async (ctx) => {
    const page = await tab(ctx);
    const out = await page.evaluate(async () => {
      const api = window.__api, t = window.__t;
      const { galleryFiles, DESCRIPTION_FILES } = await import('/app/js/storage/gallery-files.js');
      const gid = '1700000000066', dir = 'Studied';
      const ref = (p) => ({ $path: p, folder: 'web', dir, size: 5, type: 'image/png' });
      const records = [{ pageNum: 1, url: `local://${gid}/1.png`, mediaId: gid, galleryId: gid, cachedAt: 1, size: 5, blob: ref('images/0001.png'),
        studyBg: ref('study/bg/0001.png'), studyPage: { w: 10, h: 10 }, bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Hello', src: 'x', text: ref('study/text/0001-0.png') }] }];
      for (const f of galleryFiles({ meta: { galleryId: gid, title: t.T('Studied') }, records }, '', { fileOf: (src) => src.$path })) {
        if (DESCRIPTION_FILES.includes(f.name)) await t.write(`F06/${dir}/${f.name}`, f.source);
      }
      for (const p of ['images/0001.png', 'study/bg/0001.png', 'study/text/0001-0.png']) await t.write(`F06/${dir}/${p}`, await t.png(40));
      await t.write('F06/Unsure/series.json', JSON.stringify({ format: 'shiori-series', version: 1 }));
      await t.write('F06/Unsure/01.png', await t.png(50));
      // Its study index, and the other folder's description, unreadable for a while (not gone).
      const getFile = FileSystemFileHandle.prototype.getFile;
      let denied = true;
      FileSystemFileHandle.prototype.getFile = function () {
        return denied && ['bubbles.json', 'series.json'].includes(this.name) ? Promise.reject(new DOMException('denied', 'NotReadableError')) : getFile.call(this);
      };
      try {
        const { id } = await api.folders.add(await t.folder('F06'));
        const first = await api.folders.scan(id);
        const after = { has: !!(await api.galleries.get(gid)), linked: (await t.inFolder(id)).length };
        denied = false;
        const again = await api.folders.scan(id);
        const rec = await t.raw('images', `local://${gid}/1.png`);
        return { first, after, added: again.added, linked: (await t.inFolder(id)).filter(g => g.linked).length, bubbles: rec?.bubbles?.length ?? 0 };
      } finally { FileSystemFileHandle.prototype.getFile = getFile; }
    });
    assert.deepEqual(out.first.added, 0);
    assert.deepEqual(out.first.problems.map(p => p.reason), ['unreadable', 'unreadable'], JSON.stringify(out.first.problems));
    assert.deepEqual(out.after, { has: false, linked: 0 }, 'neither joined without its study layers, nor the other read as linked');
    assert.deepEqual([out.added, out.linked, out.bubbles], [2, 1, 1], 'both read whole once they can be');
  });
});
