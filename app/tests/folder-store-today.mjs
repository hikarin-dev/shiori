// folder-store-today.mjs — today's code behind the folder store contract (storage/contract.js), thin
// and temporary: the conformance suite (folder-store.conformance.mjs) runs on both apps now, against
// the code as it is, so its cases are shown to find real faults before they judge S3's adapters, which
// replace these. Each operation does what today's code does at the call site named beside it, with the
// checks that code makes and no others; what today's code has no counterpart of (a manifest, publish)
// rejects, so its cases wait for the step that brings it.
//
// A fixture is one app's library over folders in a test's temporary folder: `store`, the adapter, and
// what a case sets up through the library itself — register(name) (a library folder at <dir>/<name>,
// added, held and made the default), hide(ref), takeOver(ref) (another app's claim written on it, the
// library's cache of it forgotten) and, on the website, deny(ref) (the person's permission withdrawn).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';
import { refused, MISSING, unreadable } from '../js/storage/contract.js';
import { galleryIdOf } from '../js/storage/folder-content.js';

/** @typedef {import('../js/storage/contract.js').FolderStore<any>} FolderStore */
/** @typedef {import('../js/storage/contract.js').FolderRef<any>} FolderRef */
/** @typedef {{ store: FolderStore, register(name: string): Promise<FolderRef>, hide(ref: FolderRef): Promise<void>,
 *   takeOver(ref: FolderRef): Promise<void>, deny?(ref: FolderRef): void, close(): Promise<void> }} Fixture */

const notToday = (what, step) => () => Promise.reject(new Error(`today's code has no ${what} (${step})`));
const join = (...parts) => parts.filter(Boolean).join('/');
const parentOf = (rel) => rel.split('/').slice(0, -1).join('/');
const baseOf = (rel) => rel.split('/').pop() || '';
// Another app's claim on the folder at `dir`, a step past whatever claim is there (folder-owner.js).
function claimElsewhere(dir) {
  const file = path.join(dir, '.shiori', 'owner.json');
  let epoch = 0;
  try { epoch = JSON.parse(fs.readFileSync(file, 'utf8')).epoch || 0; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'a1b2c3d4e5f60708', by: { app: 'web', browser: 'Chrome', site: 'example.test' }, at: Date.now(), epoch: epoch + 1 }));
}

// ── The website: folder-files.js for the I/O, db.js (through its folder list) for the gate ──

/** @param {string} dir @returns {Promise<Fixture>} */
export async function websiteToday(dir) {
  const lib = await webLibrary();
  const files = await import('../js/folder-files.js');
  const paths = new Map();   // folder id → its path
  /** @param {string} id @param {any} handle @param {string} purpose */
  function root(id, handle, purpose) {
    const read = async (/** @type {string} */ rel) => {
      const file = await files.readFile(id, handle, rel);   // db.js _readPath: null for a file missing or unreadable alike
      return file ? { kind: /** @type {const} */ ('ok'), data: new Uint8Array(await file.arrayBuffer()), size: file.size, mtime: file.lastModified } : MISSING;
    };
    const list = async (/** @type {string} */ rel) => {
      try {
        const entries = [];
        for (const e of await files.list(id, handle, rel)) {
          const file = e.kind === 'file' ? await e.handle.getFile() : null;
          entries.push({ name: e.name, kind: e.kind === 'file' ? 'file' : 'dir', size: file?.size ?? 0, mtime: file?.lastModified ?? 0 });
        }
        return { kind: /** @type {const} */ ('ok'), entries };
      } catch (e) { return unreadable(e); }
    };
    const galleryDir = (/** @type {string} */ name, /** @type {string} */ gid) => ({
      name, gid,
      manifest: notToday('manifest', 'S4'),
      read: (/** @type {string} */ rel) => read(join(name, rel)),
      // db.js _place: folderFiles.writeNew, the layout name or a suffixed one while that is taken.
      async writeNew(/** @type {string} */ slot, /** @type {string} */ ext, /** @type {Uint8Array} */ bytes) {
        const { path: at, file } = await files.writeNew(id, handle, name, `${slot}.${ext}`, new Blob([bytes]));
        return { name: at, size: file.size, mtime: file.lastModified };
      },
      publish: notToday('publish', 'S4'),
      // db.js _unlink: each file let go deleted by its name.
      async deleteNamed(/** @type {{ name: string }[]} */ list) {
        const deleted = [], kept = [];
        for (const f of list) {
          try { await files.removeFile(id, handle, join(name, f.name)); deleted.push(f.name); } catch { kept.push({ name: f.name, why: /** @type {const} */ ('unreadable') }); }
        }
        return { deleted, kept };
      },
      // The website writes no temporary files of its own (a file is written whole by createWritable).
      sweep: async () => ({ removed: [] }),
    });
    const view = {
      id, purpose, read, list,
      // db.js _mayWriteDir: the directory is the gallery's unless its metadata.json names another.
      async gallery(/** @type {string} */ name, /** @type {string} */ gid) {
        const there = (await files.list(id, handle, parentOf(name)).catch(() => [])).some(e => e.name === baseOf(name) && e.kind === 'directory');
        if (!there) return MISSING;
        const named = galleryIdOf(await files.readText(id, handle, `${name}/metadata.json`).catch(() => null));
        return named != null && named !== gid ? { kind: 'conflict', found: named } : { kind: 'ok', dir: galleryDir(name, gid) };
      },
      // db.js _reserveDir: folderFiles.reserveDir, its metadata.json naming the gallery.
      async reserve(/** @type {string} */ hint, /** @type {string} */ gid) {
        return galleryDir(await files.reserveDir(id, handle, hint, JSON.stringify({ galleryId: gid, title: { english: hint, japanese: '', pretty: '' } })), gid);
      },
      // folder-library.js reads a linked source through the folder's handle, as File System Access walks it.
      async source(/** @type {string} */ at) { return { kind: 'ok', source: { path: at, read: (rel = '') => read(join(at, rel)), list: (rel = '') => list(join(at, rel)) } }; },
      private: {
        async read(/** @type {string} */ rel) {
          try { const text = await files.readText(id, handle, `.shiori/${rel}`); return text == null ? MISSING : { kind: 'ok', data: text, size: text.length, mtime: 0 }; } catch (e) { return unreadable(e); }
        },
        list: (/** @type {string} */ rel) => list(join('.shiori', rel)),
        async write(/** @type {string} */ rel, /** @type {string} */ text) { const file = await files.writeFile(id, handle, `.shiori/${rel}`, text); return { name: rel, size: file.size, mtime: file.lastModified }; },
        remove: (/** @type {string} */ rel) => files.removeFile(id, handle, `.shiori/${rel}`),
      },
    };
    return view;
  }
  return {
    // db.js _access and _rootOf, as foldersList reports them (it asks afresh each time): a folder
    // reached and held is written to while shown; one reached is read.
    store: /** @type {FolderStore} */ ({
      async open(/** @type {FolderRef} */ ref, /** @type {{ purpose: string }} */ { purpose }) {
        const f = (await lib.list()).find(x => x.id === ref.id);
        if (!f || f.access === 'unavailable') return refused('unavailable');
        if (f.access === 'prompt') return refused('no-permission');
        if (purpose !== 'read' && f.hidden) return refused('hidden');
        if (purpose !== 'read' && f.access === 'taken') return refused('not-owned');
        return { status: 'ok', root: root(ref.id, ref.location, purpose) };
      },
    }),
    async register(name) {
      const at = path.join(dir, name);
      const id = await lib.add(at);
      await lib.setDefault(id);
      paths.set(id, at);
      return { id, location: fsa.directory(at) };
    },
    async hide(ref) { await lib.setDefault(lib.home); await lib.hide(ref.id); },
    async takeOver(ref) { claimElsewhere(/** @type {string} */ (paths.get(ref.id))); },
    deny(ref) { fsa.setPermission(/** @type {string} */ (paths.get(ref.id)), 'prompt'); },
    async close() { fsa.reset(); },
  };
}

// ── The desktop: node fs for the I/O, the library's folders.js and files.js for the gate and names ──

/** @param {string} dir @returns {Promise<Fixture>} */
export async function desktopToday(dir) {
  const driver = await desktopLibrary(path.join(dir, 'desktop'));
  const { physicallyIn } = await import('../../desktop/server/files.js');
  const lib = driver.raw, files = lib.files;
  const reason = { hidden: 'hidden', taken: 'not-owned', unavailable: 'unavailable' };
  const typed = async (/** @type {string} */ abs) => {
    try {
      const [data, st] = await Promise.all([fsp.readFile(abs), fsp.stat(abs)]);   // files.js readOwn and the like (ifMissing)
      return { kind: /** @type {const} */ ('ok'), data: new Uint8Array(data), size: st.size, mtime: st.mtimeMs };
    } catch (e) { return /** @type {any} */ (e)?.code === 'ENOENT' || /** @type {any} */ (e)?.code === 'ENOTDIR' ? MISSING : unreadable(e); }
  };
  /** @param {string} id @param {string} at @param {string} purpose */
  function root(id, at, purpose) {
    const abs = (/** @type {string} */ rel) => path.join(at, ...rel.split('/').filter(Boolean));
    const list = async (/** @type {string} */ rel) => {
      try {
        const entries = [];
        for (const e of await fsp.readdir(abs(rel), { withFileTypes: true })) {
          const st = await fsp.stat(path.join(abs(rel), e.name)).catch(() => null);
          entries.push({ name: e.name, kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
        }
        return { kind: /** @type {const} */ ('ok'), entries };
      } catch (e) { return /** @type {any} */ (e)?.code === 'ENOENT' ? MISSING : unreadable(e); }
    };
    const galleryDir = (/** @type {string} */ name, /** @type {string} */ gid) => ({
      name, gid,
      manifest: notToday('manifest', 'S4'),
      read: (/** @type {string} */ rel) => typed(abs(join(name, rel))),
      // library.js _writeOwn and files.js placeOwn: written beside its place, then renamed into it.
      async writeNew(/** @type {string} */ slot, /** @type {string} */ ext, /** @type {Uint8Array} */ bytes) {
        const file = abs(join(name, `${slot}.${ext}`));
        const temp = `${file}.${crypto.randomBytes(5).toString('hex')}.shiori-new`;
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(temp, bytes);
        fs.renameSync(temp, file);
        const st = fs.statSync(file);
        return { name: `${slot}.${ext}`, size: st.size, mtime: st.mtimeMs };
      },
      publish: notToday('publish', 'S4'),
      // files.js _remove: a gallery's file let go deleted by its name, through the gate.
      async deleteNamed(/** @type {{ name: string }[]} */ list) {
        const deleted = [];
        for (const f of list) { await files._remove(files._join(id, join(name, f.name))); if (!fs.existsSync(abs(join(name, f.name)))) deleted.push(f.name); }
        return { deleted, kept: [] };
      },
      // scan.js sweepLeftovers and removeOrphans: the folder check's tidy-up.
      async sweep() { await lib.folderScan(id); return { removed: [] }; },
    });
    return {
      id, purpose, list,
      read: (/** @type {string} */ rel) => typed(abs(rel)),
      // files.js home: the directory the index names for the gallery, written to while it is there.
      async gallery(/** @type {string} */ name, /** @type {string} */ gid) {
        const row = files._row(gid);
        if (!row || row.path !== files._join(id, name)) return MISSING;
        try { await files.home(gid); } catch { return MISSING; }
        return { kind: 'ok', dir: galleryDir(name, gid) };
      },
      // files.js _claim: a free path chosen, made and bound to the gallery by its metadata.json.
      async reserve(/** @type {string} */ hint, /** @type {string} */ gid) {
        const row = files._claim(gid, { galleryId: gid, title: { english: hint, japanese: '', pretty: '' } });
        return galleryDir(files._split(row.path).rest, gid);
      },
      // files.js _sourceIn and physicallyIn (F09): a source is read only inside the folder.
      async source(/** @type {string} */ at) {
        try { await physicallyIn(lib.rootDir(id), abs(at)); } catch { return { kind: 'outside' }; }
        return { kind: 'ok', source: { path: at, read: (rel = '') => typed(abs(join(at, rel))), list: (rel = '') => list(join(at, rel)) } };
      },
      private: {
        async read(/** @type {string} */ rel) { const r = await typed(abs(`.shiori/${rel}`)); return r.kind === 'ok' ? { ...r, data: new TextDecoder().decode(r.data) } : r; },
        list: (/** @type {string} */ rel) => list(join('.shiori', rel)),
        async write(/** @type {string} */ rel, /** @type {string} */ text) { fs.mkdirSync(path.dirname(abs(`.shiori/${rel}`)), { recursive: true }); fs.writeFileSync(abs(`.shiori/${rel}`), text); const st = fs.statSync(abs(`.shiori/${rel}`)); return { name: rel, size: st.size, mtime: st.mtimeMs }; },
        remove: (/** @type {string} */ rel) => fsp.rm(abs(`.shiori/${rel}`), { force: true }),
      },
    };
  }
  return {
    store: /** @type {FolderStore} */ ({
      async open(/** @type {FolderRef} */ ref, /** @type {{ purpose: string }} */ { purpose }) {
        if (!lib.folders.has(ref.id)) return refused('unavailable');
        lib.folders.probe(ref.id, { fresh: true });
        // Reads take the folder's path as the index has it (folders.js dir), with no further check.
        if (purpose === 'read') return fs.existsSync(ref.location) ? { status: 'ok', root: root(ref.id, ref.location, purpose) } : refused('unavailable');
        // Writes pass the gate (folders.js writable), refused as it says (_refusal).
        if (!lib.folders.writable(ref.id, purpose === 'removal' ? 'removal' : null)) {
          return refused(/** @type {any} */ (reason)[lib.folders._refusal(ref.id).reason] ?? 'unavailable');
        }
        return { status: 'ok', root: root(ref.id, ref.location, purpose) };
      },
    }),
    async register(name) {
      const at = path.join(dir, name);
      const id = await driver.add(at);
      await driver.setDefault(id);
      return { id, location: path.resolve(at) };
    },
    async hide(ref) { await driver.setDefault(driver.home); await driver.hide(ref.id); },
    async takeOver(ref) { claimElsewhere(ref.location); lib.folders._probes.clear(); },
    async close() { await driver.close(); },
  };
}
