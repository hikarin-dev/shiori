// library-drivers.mjs — both apps' libraries driven alike over real folders, for the storage tests
// that work through the libraries themselves (the hand-over and model tests, plan §6.2–6.3): the
// desktop's Library as the desktop app opens it, and the website's (db.js) under Node — fake-indexeddb
// for its IndexedDB, fsa-node.mjs for File System Access over the same folders. Each driver offers the
// same operations under the same names, as both libraries do behind api.js, so a test says once what
// is done and checks it on both.
//
// The website's library is one per process (db.js is a module): webLibrary() hands out the one, its
// earlier folders and galleries forgotten first (clearAll, once their folders are gone from the disk,
// so nothing is deleted there). Its restart (a page loaded again) isn't offered yet: a fresh copy of
// every module over the same IndexedDB is left for when a model run needs it.
import fs from 'node:fs';
import path from 'node:path';
import * as fsa from './fsa-node.mjs';
import { written as desktopWritten } from '../../desktop/server/folder-store.js';
import { written as websiteWritten } from '../js/storage/folder-store-web.js';

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
 *   list(): Promise<any[]>,
 *   newGallery(name: string): Promise<string>,
 *   putPage(gid: string, n: number, bytes: Uint8Array, type?: string): Promise<void>,
 *   putTranslation(gid: string, n: number, bytes: Uint8Array, type?: string): Promise<void>,
 *   setTitle(gid: string, name: string): Promise<void>,
 *   deleteGallery(gid: string): Promise<void>,
 *   move(gid: string, to: string): Promise<void>,
 *   takeOver(id: string): Promise<void>,
 *   written(): Record<string, number>,
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
 * by kind (pictures, descriptions, archives, the rest). */

// Another app's claim on the folder at `dir`, a step past whatever claim is there (folder-owner.js).
function claimElsewhere(dir) {
  const file = path.join(dir, '.shiori', 'owner.json');
  let epoch = 0;
  try { epoch = JSON.parse(fs.readFileSync(file, 'utf8')).epoch || 0; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'a1b2c3d4e5f60708', by: { app: 'web', browser: 'Chrome', site: 'example.test' }, at: Date.now(), epoch: epoch + 1 }));
}

/** The desktop library, its data and first folder in `base` (data/, own/), as the tests open it:
 * pictures put in their folders at once, descriptions written when flushed.
 * @param {string} base @returns {Promise<Driver>} */
export async function desktopLibrary(base) {
  globalThis.BroadcastChannel = Quiet;
  const { Library } = await import('../../desktop/server/library.js');
  const where = { dataDir: path.join(base, 'data'), libraryDir: path.join(base, 'own'), placeDelay: 0, describeDelay: 600_000 };
  let lib = await new Library(where).open();
  return {
    app: 'desktop',
    get raw() { return lib; },
    get home() { return lib.primaryId; },
    async add(dir, opts) { fs.mkdirSync(dir, { recursive: true }); return (await lib.folderAdd(path.resolve(dir), opts)).id; },
    async setDefault(id) { await lib.folderSetDefault(id); },
    async hide(id) { await lib.folderHide(id); },
    async show(id) { await lib.folderShow(id); },
    async remove(id, opts) { await lib.folderRemove(id, opts); await lib.folders.job(id)?.catch(() => {}); },
    scan: (id) => lib.folderScan(id),
    list: () => lib.foldersList(),
    async newGallery(name) { const gid = String(lib.nextGalleryId()); await lib.metaPut({ galleryId: gid, title: title(name) }); return gid; },
    async putPage(gid, n, bytes, type = 'image/png') { await lib.pagePut(gid, n, typed(type)(bytes)); },
    async putTranslation(gid, n, bytes, type = 'image/png') { await lib.putTranslatedPage({ galleryId: gid, pageNum: n }, typed(type)(bytes), null); },
    async setTitle(gid, name) { await lib.metaPut({ ...(await lib.metaGet(gid)), title: title(name) }); },
    async deleteGallery(gid) { await lib.deleteGallery(gid); },
    async move(gid, to) { await lib.moveGallery(gid, to); },
    async takeOver(id) { claimElsewhere(lib.folders.dir(id)); lib.folders._probes.clear(); },
    written: desktopWritten,
    read: async (gid, n, variant) => bytesOf(await lib.getPageBlob(gid, n, variant).catch(() => null)),
    titleOf: async (gid) => (await lib.metaGet(gid))?.title?.english ?? null,
    galleries: () => lib.galleryIdsSorted({ sort: 'id' }),
    dirOf: async (gid) => lib.files.folderOf(gid),
    async flush() { await lib.files.flush(); },
    async restart() { lib.close(); lib = await new Library(where).open(); },
    async close() { try { lib.close(); } catch {} },
  };
}

let web = null;          // db.js, once imported
const webFolders = new Map();   // folder id → its path, for the folders the website's library was handed
/** The website's library, with no folders or galleries but those added from now on.
 * @returns {Promise<Driver>} */
export async function webLibrary() {
  if (!web) {
    await import('fake-indexeddb/auto');
    globalThis.BroadcastChannel = Quiet;
    fsa.install();
    web = await import('../js/db.js');
  } else {
    fsa.reset();
    await web.clearAll({ folders: true });
    webFolders.clear();
  }
  const db = web;
  return {
    app: 'website',
    home: db.BROWSER,
    raw: db,
    async add(dir, opts) {
      const { id } = await db.folderAdd(fsa.directory(dir), opts);
      webFolders.set(id, path.resolve(dir));
      return id;
    },
    async setDefault(id) { await db.folderSetDefault(id); },
    async hide(id) { await db.folderHide(id); },
    async show(id) { await db.folderShow(id); },
    async remove(id, opts) { await db.folderRemove(id, opts); await db.folderSetAside(id); },
    scan: (id) => db.folderScan(id),
    list: () => db.foldersList(),
    async newGallery(name) { const gid = String(db.nextGalleryId()); await db.metaPut({ galleryId: gid, title: title(name) }); return gid; },
    // A page replaced keeps the key its record is stored under, as a page downloaded again does: a new
    // key (pagePut names one after the picture's type) would be a second record of that page.
    async putPage(gid, n, bytes, type = 'image/png') {
      const old = (await db.pageList(gid)).find(p => p.pageNum === n);
      await db.pagePut(gid, n, typed(type)(bytes), old ? { key: old.url } : {});
    },
    async putTranslation(gid, n, bytes, type = 'image/png') { await db.putTranslatedPage({ galleryId: gid, pageNum: n }, typed(type)(bytes), null); },
    async setTitle(gid, name) { await db.metaPut({ ...(await db.metaGet(gid)), title: title(name) }); },
    async deleteGallery(gid) { await db.deleteGallery(gid); },
    async move(gid, to) { await db.moveGallery(gid, to); },
    async takeOver(id) { claimElsewhere(/** @type {string} */ (webFolders.get(id))); },
    written: websiteWritten,
    read: async (gid, n, variant) => bytesOf(await db.getPageBlob(gid, n, variant).catch(() => null)),
    titleOf: async (gid) => (await db.metaGet(gid))?.title?.english ?? null,
    galleries: () => db.galleryIdsSorted({ sort: 'id' }),
    async dirOf(gid) {
      const stat = await db.galleryGet(gid);
      const root = stat?.folder && webFolders.get(stat.folder);
      return root && stat.dir && !stat.packed ? path.join(root, ...stat.dir.split('/')) : null;
    },
    async flush() { await db.settleFolders(); },
    restart: null,
    async close() {},
  };
}
