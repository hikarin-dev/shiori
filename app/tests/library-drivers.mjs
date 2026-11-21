// library-drivers.mjs — both apps' libraries driven alike over real folders, for the storage tests
// that work through the libraries themselves (the hand-over and model tests, plan §6.2–6.3): the
// desktop's Library as the desktop app opens it, and the website's (db.js) under Node — fake-indexeddb
// for its IndexedDB, fsa-node.mjs for File System Access over the same folders. Each driver offers the
// same operations under the same names, as both libraries do behind api.js, so a test says once what
// is done and checks it on both.
//
// The website's library is one per process (db.js is a module): webLibrary() hands out the one, its
// earlier folders and galleries forgotten first (clearAll, once their folders are gone from the disk,
// so nothing is deleted there). Its restart is a page loaded again: every timer the page's modules set
// cleared (what it had scheduled never runs), then a fresh copy of every app module (app/js, each
// imported as `?gen=<n>`: generation) over the same IndexedDB and folders, which does what a page does
// as it opens (foldersPending, settleFolders). Work the old page had under way, awaiting a read or a
// write, still ends (a page closed a moment later). Each copy stays loaded (Node unloads no module:
// about 1.5 MB each), so a process offers RESTARTS_AT_MOST of them. The one module that changes the
// globals it runs in (disk-writes.js: IndexedDB's prototypes, to count writes) is loaded once — a
// copy per page would count every write once per page, each counting the others' counts for ever.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import * as fsa from './fsa-node.mjs';
import { written as desktopWritten } from '../../desktop/server/folder-store.js';

// ── Page generations (the website's restart) ──
const APP_JS = new URL('../js/', import.meta.url).href;
const ONCE = new Set([`${APP_JS}disk-writes.js`]);
const RESTARTS_AT_MOST = 400;
let generation = 0;
/** The website's page loaded now (its generation), and the page whose app module is calling now (null:
 * a caller outside app/js) — the sweeps tell a page that died from the one loaded after it. */
export const pageNow = () => generation;
export const pageCalling = () => {
  for (const line of String(new Error().stack).split('\n')) {
    const at = line.match(/(file:\/\/\/[^\s)]+?)(\?gen=(\d+))?:\d+:\d+\)?$/);
    if (at && at[1].startsWith(APP_JS)) return Number(at[3] ?? 0);
  }
  return null;
};
let hooked = false;
// The generation of the app module that called (the first frame of `stack` past this file's), or null
// for a caller outside app/js.
const callerGeneration = (stack) => {
  const frame = String(stack).split('\n').slice(2).find(l => !l.includes(import.meta.url));
  const at = frame?.match(/(file:\/\/\/[^\s)]+?)(\?gen=(\d+))?:\d+:\d+\)?$/);
  return at && at[1].startsWith(APP_JS) ? Number(at[3] ?? 0) : null;
};
const timers = new Map();   // a timer an app module set → its generation
function hookGenerations() {
  if (hooked) return;
  hooked = true;
  // An app module imported by one of generation n is of generation n.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      const gen = context.parentURL && /[?&]gen=(\d+)/.exec(context.parentURL)?.[1];
      return gen && r.url.startsWith(APP_JS) && !r.url.includes('?') && !ONCE.has(r.url) ? { ...r, url: `${r.url}?gen=${gen}` } : r;
    },
  });
  for (const [set, clear] of [['setTimeout', 'clearTimeout'], ['setInterval', 'clearInterval']]) {
    const original = globalThis[set], cleared = globalThis[clear];
    globalThis[set] = function (fn, ms, ...args) {
      const gen = callerGeneration(new Error().stack);
      if (gen == null || typeof fn !== 'function') return original(fn, ms, ...args);
      const handle = original((...a) => { if (set === 'setTimeout') timers.delete(handle); fn(...a); }, ms, ...args);
      timers.set(handle, gen);
      return handle;
    };
    globalThis[clear] = function (handle) { timers.delete(handle); return cleared(handle); };
  }
}
// Every timer generation `gen`'s modules set, cleared: the page is closed.
function closePage(gen) {
  for (const [handle, g] of timers) if (g === gen) { clearTimeout(handle); clearInterval(handle); timers.delete(handle); }
}

// ── The clock ──
// The clock moved on by `ms` for everything in this process (both apps' libraries run in it): a quiet
// moment — a claim's time to live passing (folder-owner.js CLAIM_TTL_MS), say — without waiting it out.
// It never goes back, so whatever is taken as it is for a while is as old as it would be by then.
let ahead = 0;
const realNow = Date.now;
/** @param {number} ms */
export function clockAhead(ms) {
  if (!ahead) Date.now = () => realNow() + ahead;
  ahead += ms;
}

// ── A hand-over's wait (S32) ──
// A folder that came (back) to a library is read by its check once the other app's window has passed
// (folder-owner.js readsFrom: the claim's time to live and a margin after the claim). The drivers' `scan` and
// `flush` pass that wait at once — the folder's mark aged by what is left of it, so no test sleeps it and
// nothing else of the clock moves (file ages, other claims) — then join the check (`scan`) or wait for it
// (`flush`). A test about that window drives it itself: it calls the library (`raw`) and clockAhead.
// `marks()`: [{ id, handover }] of the library's folders; `age(id, handover)`: that mark put back.
async function passWaits(marks, age, ids = null) {
  const { readsFrom } = await import('../js/storage/folder-owner.js');
  const out = [];
  for (const { id, handover } of await marks()) {
    if (!handover || (ids && !ids.includes(id))) continue;
    const left = readsFrom(handover) - Date.now();
    if (left > 0) await age(id, { ...handover, at: handover.at - left });
    out.push(id);
  }
  return out;
}

// The windows' channel, heard by nobody here (Node's own would keep the process alive, and tell other
// test files' libraries nothing they should hear).
const Quiet = class { postMessage() {} close() {} };
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
const typed = (type) => (bytes) => new Blob([bytes], { type });

/** `home`: the place the library always has (the desktop's first folder, this browser's own storage),
 * the default while a folder can't be.
 * @typedef {{
 *   app: 'website' | 'desktop', home: string,
 *   add(dir: string, options?: { force?: boolean }): Promise<string>,
 *   setDefault(id: string): Promise<void>, hide(id: string): Promise<void>, show(id: string): Promise<void>,
 *   remove(id: string, options?: { discard?: boolean }): Promise<void>,
 *   scan(id: string): Promise<{ added: number, updated: number, problems: { path: string, reason: string }[] }>,
 *   list(): Promise<any[]>, dismiss(id: string, item: { reason: string, path: string }): Promise<void>,
 *   newGallery(name: string, gid?: string): Promise<string>,
 *   putPage(gid: string, n: number, bytes: Uint8Array, type?: string): Promise<void>,
 *   putTranslation(gid: string, n: number, bytes: Uint8Array, type?: string, source?: string): Promise<void>,
 *   sources(gid: string): Promise<Record<number, string>>,
 *   setTitle(gid: string, name: string): Promise<void>,
 *   favorite(gid: string, on: boolean): Promise<void>, readTo(gid: string, page: number, pages: number): Promise<void>,
 *   marks(gid: string): Promise<any>, meta(gid: string): Promise<any>,
 *   deleteGallery(gid: string): Promise<void>,
 *   move(gid: string, to: string): Promise<void>,
 *   takeOver(id: string): Promise<void>,
 *   written(): Record<string, number>,
 *   pdfsWaiting(): Promise<{ folder: string, gid: string, path: string, name: string }[]>,
 *   pdfSource(folder: string, gid: string): Promise<{ file: Blob, token: string }>,
 *   addRendered(folder: string, gid: string, pages: Uint8Array[], token: unknown): Promise<string>,
 *   pdfFailed(folder: string, gid: string, token: unknown): Promise<void>,
 *   read(gid: string, n: number, variant?: 'translated'): Promise<Uint8Array | null>,
 *   titleOf(gid: string): Promise<string | null>,
 *   galleries(): Promise<string[]>,
 *   dirOf(gid: string): Promise<string | null>,
 *   flush(): Promise<void>,
 *   restart: (() => Promise<void>) | null,
 *   close(): Promise<void>,
 *   raw: any,
 * }} Driver
 * `move`: the gallery moved to folder `to`; `takeOver`: another app's claim written on folder `id`
 * (as "Use anyway" there does); `written`: the bytes the library's folder store adapter has written,
 * by kind (pictures, descriptions, archives, the rest); the PDFs a folder holds, drawn as a window draws
 * them (api.js folders.pdfsWaiting…: `addRendered`'s pages as PNG pictures' bytes); the person's own marks
 * (api.js personal: `favorite`, `readTo` a page read, `marks`), and a gallery's metadata (`meta`). */

// Another app's claim on the folder at `dir`, a step past whatever claim is there (folder-owner.js).
function claimElsewhere(dir) {
  const file = path.join(dir, '.shiori', 'owner.json');
  let epoch = 0;
  try { epoch = JSON.parse(fs.readFileSync(file, 'utf8')).epoch || 0; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'a1b2c3d4e5f60708', by: { app: 'web', browser: 'Chrome', site: 'example.test' }, at: Date.now(), epoch: epoch + 1 }));
}

/** The desktop library, its data and first folder in `base` (data/, own/), as the tests open it:
 * pictures put in their folders at once, descriptions written when flushed. `me`: the app's own id (as
 * folder-owner.js knows it) where it stands for the desktop app on another computer — by default this
 * one's, which every desktop library in this process shares. `own`: its first folder elsewhere (an
 * earlier version's library, as storage-fixtures.mjs desktopLibrary lays one out beside base/data).
 * @param {string} base @param {{ me?: string, own?: string }} [options] @returns {Promise<Driver>} */
export async function desktopLibrary(base, { me, own = path.join(base, 'own') } = {}) {
  globalThis.BroadcastChannel = Quiet;
  const { Library } = await import('../../desktop/server/library.js');
  const where = { dataDir: path.join(base, 'data'), libraryDir: own, placeDelay: 0, describeDelay: 600_000 };
  const made = () => { const l = new Library(where); if (me) l.folders._instance = me; return l; };
  let lib = await made().open();
  const marks = async () => lib.folders.ids().map(id => ({ id, handover: lib.folders.handover(id) }));
  const age = async (id, h) => lib.folders._setHandover(id, h);
  return {
    app: 'desktop',
    get raw() { return lib; },
    get home() { return lib.primaryId; },
    async add(dir, opts) { fs.mkdirSync(dir, { recursive: true }); return (await lib.folderAdd(path.resolve(dir), opts)).id; },
    async setDefault(id) { await lib.folderSetDefault(id); },
    async hide(id) { await lib.folderHide(id); },
    async show(id) { await lib.folderShow(id); },
    // The removal's write-back runs as a job; one that can't finish rejects (the folder stays).
    async remove(id, opts) { await lib.folderRemove(id, opts); await lib.folders.job(id); },
    async scan(id) { await passWaits(marks, age, [id]); return lib.folderScan(id); },
    list: () => lib.foldersList(),
    dismiss: (id, item) => lib.folderDismiss(id, item),
    async newGallery(name, gid = String(lib.nextGalleryId())) { await lib.metaPut({ galleryId: gid, title: title(name) }); return gid; },
    async putPage(gid, n, bytes, type = 'image/png') { await lib.pagePut(gid, n, typed(type)(bytes)); },
    async putTranslation(gid, n, bytes, type = 'image/png', source) { await lib.putTranslatedPage({ galleryId: gid, pageNum: n }, typed(type)(bytes), null, undefined, source); },
    sources: (gid) => lib.pageSources(gid),
    async setTitle(gid, name) { await lib.metaPut({ ...(await lib.metaGet(gid)), title: title(name) }); },
    async favorite(gid, on) { await lib.personalSet(gid, { favorite: on }); },
    async readTo(gid, page, pages) { await lib.personalSet(gid, { read: { page, pages } }); },
    marks: (gid) => lib.personalGet(gid),
    meta: (gid) => lib.metaGet(gid),
    async deleteGallery(gid) { await lib.deleteGallery(gid); },
    async move(gid, to) { await lib.moveGallery(gid, to); },
    async takeOver(id) { claimElsewhere(lib.folders.dir(id)); lib.folders._probes.clear(); },
    written: desktopWritten,
    pdfsWaiting: () => lib.pdfsWaiting(),
    pdfSource: (folder, gid) => lib.pdfSource(folder, gid),
    addRendered: (folder, gid, pages, token) => lib.addRendered(folder, gid, pages.map(typed('image/png')), token),
    pdfFailed: (folder, gid, token) => lib.pdfFailed(folder, gid, token),
    read: async (gid, n, variant) => bytesOf(await lib.getPageBlob(gid, n, variant).catch(() => null)),
    titleOf: async (gid) => (await lib.metaGet(gid))?.title?.english ?? null,
    galleries: () => lib.galleryIdsSorted({ sort: 'id' }),
    dirOf: async (gid) => lib.files.folderOf(gid),
    async flush() {
      for (const id of await passWaits(marks, age)) await lib.folderScan(id).catch(() => {});   // a hand-over's check, and what waited after it
      await lib.files.flush();
    },
    // A start that fails lets go of what it opened (the app's process ends then), and one after it starts afresh.
    async restart() {
      try { lib.close(); } catch {}
      const next = made();
      try { lib = await next.open(); } catch (e) { try { next.close(); } catch { try { next._db?.close(); } catch {} } throw e; }
    },
    async close() { try { lib.close(); } catch {} },
  };
}

/** The desktop app killed (review 4): `work` — an async function standing alone (it is run from its
 * source), given { lib: the desktop library over `base`, kill(when), ...args } — run in a child process
 * that exits inside the first file call `when(call)` matches (fs-faults.mjs calls) once kill(when) is
 * called. The parent then opens `base` again (desktopLibrary). Returns the child's exit code: 42 when
 * it was killed there, 0 when the work ended first.
 * @param {string} base @param {(ctx: any) => Promise<void>} work @param {Record<string, unknown>} [args] @returns {number} */
export function desktopKilled(base, work, args = {}) {
  const at = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
  const code = `import { desktopLibrary } from ${at('./library-drivers.mjs')};
    import * as faults from ${at('../../desktop/tests/fs-faults.mjs')};
    const lib = await desktopLibrary(${JSON.stringify(base)});
    const kill = (when) => faults.failNext((c) => { if (when(c)) process.exit(42); return false; }, 'EIO', { times: Infinity });
    await (${work.toString()})({ lib, kill, ...${JSON.stringify(args)} });
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
  if (child.status !== 0 && child.status !== 42) throw new Error(`the killed app ended with ${child.status}: ${child.stderr.slice(-600)}`);
  return /** @type {number} */ (child.status);
}

let web = null;          // db.js, once imported (the page's generation's)
let webWritten = null;   // its folder store adapter's write counts
// fake-indexeddb keeps every transaction a process has made, finished or not, and looks at all of them as each new one
// is scheduled (lib/Database.js processTransactions), so a process's IndexedDB work slows with the square of what it
// did before — the sweeps' long processes most. Nothing reads a finished one again: they are dropped as a library is
// handed out and as a page loads.
async function dropFinished() {
  const raw = (await web.openDB())._rawDatabase;
  if (Array.isArray(raw?.transactions)) raw.transactions = raw.transactions.filter((tx) => tx._state !== 'finished');
}
const webFolders = new Map();   // folder id → its path, for the folders the website's library was handed
// The page's app modules, of generation `generation`.
async function loadPage() {
  const q = generation ? `?gen=${generation}` : '';
  web = await import(`${APP_JS}db.js${q}`);
  webWritten = (await import(`${APP_JS}storage/folder-store-web.js${q}`)).written;
}
// Another page of the website open on the same library (S36: a second tab, or the service worker, which runs the
// browser's imports): a copy of every app module of its own, as each page loads the site's code, over the same
// IndexedDB, folders and Web Locks (Node's, shared by every module of the process as a browser's are by its pages),
// the page loaded now staying open. Its generations are apart from the restarts'.
const OTHER_PAGES = 100000;
let others = 0;
/** @returns {Promise<{ db: any, close: () => void }>} its db.js, and close(): every timer it set cleared (the page closed) */
export async function otherPage() {
  if (!web) throw new Error('the website\'s library first (webLibrary)');
  const gen = OTHER_PAGES + ++others;
  return { db: await import(`${APP_JS}db.js?gen=${gen}`), close: () => closePage(gen) };
}
/** The website's library, with no folders or galleries but those added from now on.
 * @returns {Promise<Driver>} */
export async function webLibrary() {
  if (!web) {
    await import('fake-indexeddb/auto');
    globalThis.BroadcastChannel = Quiet;
    fsa.install();
    hookGenerations();
    await loadPage();
  } else {
    fsa.reset();
    await web.clearAll({ folders: true });
    webFolders.clear();
  }
  await dropFinished();
  let db = web;
  // The folders' records as the library keeps them (db.js FOLDER_STORE 'folders'), read and put back here.
  const folderRecords = async (fn) => { const idb = await db.openDB(); return new Promise((resolve, reject) => {
    const tx = idb.transaction('folders', 'readwrite');
    let out;
    Promise.resolve(fn(tx.objectStore('folders'))).then((v) => { out = v; }, reject);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  }); };
  const marks = async () => { const all = await folderRecords((s) => new Promise((r) => { const q = s.getAll(); q.onsuccess = () => r(q.result || []); }));
    return all.filter(f => !String(f.id).startsWith('$') && f.handover).map(f => ({ id: f.id, handover: f.handover })); };
  const age = (id, h) => folderRecords((s) => { const q = s.get(id); q.onsuccess = () => { if (q.result) s.put({ ...q.result, handover: h }); }; });
  return {
    app: 'website',
    home: db.BROWSER,
    get raw() { return db; },
    async add(dir, opts) {
      const { id } = await db.folderAdd(fsa.directory(dir), opts);
      webFolders.set(id, path.resolve(dir));
      return id;
    },
    async setDefault(id) { await db.folderSetDefault(id); },
    async hide(id) { await db.folderHide(id); },
    async show(id) { await db.folderShow(id); },
    async remove(id, opts) { await db.folderRemove(id, opts); await db.folderSetAside(id); },
    async scan(id) { await passWaits(marks, age, [id]); return db.folderScan(id); },
    list: () => db.foldersList(),
    dismiss: (id, item) => db.folderDismiss(id, item),
    async newGallery(name, gid = String(db.nextGalleryId())) { await db.metaPut({ galleryId: gid, title: title(name) }); return gid; },
    // A page replaced keeps the key its record is stored under, as a page downloaded again does: a new
    // key (pagePut names one after the picture's type) would be a second record of that page.
    async putPage(gid, n, bytes, type = 'image/png') {
      const old = (await db.pageList(gid)).find(p => p.pageNum === n);
      await db.pagePut(gid, n, typed(type)(bytes), old ? { key: old.url } : {});
    },
    async putTranslation(gid, n, bytes, type = 'image/png', source) { await db.putTranslatedPage({ galleryId: gid, pageNum: n }, typed(type)(bytes), null, undefined, source); },
    sources: (gid) => db.pageSources(gid),
    async setTitle(gid, name) { await db.metaPut({ ...(await db.metaGet(gid)), title: title(name) }); },
    async favorite(gid, on) { await db.personalSet(gid, { favorite: on }); },
    async readTo(gid, page, pages) { await db.personalSet(gid, { read: { page, pages } }); },
    marks: (gid) => db.personalGet(gid),
    meta: (gid) => db.metaGet(gid),
    async deleteGallery(gid) { await db.deleteGallery(gid); },
    async move(gid, to) { await db.moveGallery(gid, to); },
    async takeOver(id) { claimElsewhere(/** @type {string} */ (webFolders.get(id))); },
    written: () => webWritten(),
    pdfsWaiting: () => db.pdfsWaiting(),
    pdfSource: (folder, gid) => db.pdfSource(folder, gid),
    addRendered: (folder, gid, pages, token) => db.addRendered(folder, gid, pages.map(typed('image/png')), token),
    pdfFailed: (folder, gid, token) => db.pdfFailed(folder, gid, token),
    read: async (gid, n, variant) => bytesOf(await db.getPageBlob(gid, n, variant).catch(() => null)),
    titleOf: async (gid) => (await db.metaGet(gid))?.title?.english ?? null,
    galleries: () => db.galleryIdsSorted({ sort: 'id' }),
    async dirOf(gid) {
      const stat = await db.galleryGet(gid);
      const root = stat?.folder && webFolders.get(stat.folder);
      return root && stat.dir && !stat.packed ? path.join(root, ...stat.dir.split('/')) : null;
    },
    async flush() {
      for (const id of await passWaits(marks, age)) await db.folderScan(id).catch(() => {});   // a hand-over's check, and what waited after it
      await db.settleFolders();
    },
    // The page loaded again (above): what it had scheduled never runs; what it had under way ends.
    restart: generation < RESTARTS_AT_MOST ? async () => {
      closePage(generation);
      generation++;
      await loadPage();
      await dropFinished();
      db = web;
      await db.foldersPending();
      await db.settleFolders();
    } : null,
    async close() {},
  };
}
