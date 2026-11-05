// folder-store.js — the desktop's folder store adapter (the plan's §3.2; the contract is the app's
// js/storage/contract.js): the one door between the desktop library and its library folders.
//
// - `disk`: every node fs call the library makes in a library folder (files.js, scan.js, linked.js,
//   folders.js, zip.js, remove.js, and library.js's staging and gallery files), under fs's own names,
//   so each is made here and nowhere else (tests/architecture-fitness.test.mjs). Each write is counted
//   by what it holds (written(): the bytes of pictures, descriptions, archives and the rest, which the
//   conformance suite checks against the write budget, plan D23), and any call can be failed on
//   purpose by the storage tests (failNext). The library's own data folder (its index, thumbnails,
//   write meter) is no library folder: library.js reaches it directly.
// - physicallyIn: the containment rule for links (F09), checked against the disk.
// - folderStore(library): the contract over `disk`. open(ref, { purpose }) weighs the folder by the
//   library's gate (folders.js) and the shared rule (folder-lifecycle.js refusalFor) and hands out a
//   Root; a Root's galleries, reservations, sources and .shiori/ area work by the library's own index
//   and naming (files.js), as the library does today. Format v2's manifest and publish come with S4;
//   identity-verified roots, positive gallery identity and containment in every operation with S5.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { lifecycle, contract, BackendError } from './shared.js';

// ── Faults, for the storage tests ──
// failNext(when, code, { times }): the next `times` calls `when(call)` matches throw (or reject, for a
// promised call) an error with `code` ('EBUSY', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'…). `call` is
// { op, path, to? }: `op` the fs method's name without Sync ('rename', 'rm', 'readFile'…), `path` its
// first argument as an absolute '/'-separated path, `to` the second for rename, copyFile and cp.
// Returns a function that takes the fault back (taken back by itself once used up). existsSync, which
// never throws, is never failed.
/** @type {{ when: (call: { op: string, path: string, to?: string }) => boolean, code: string, times: number }[]} */
let faults = [];
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp']);
const norm = (p) => (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p) ? path.resolve(String(p)).split(path.sep).join('/') : String(p));
function fault(op, args) {
  if (!faults.length) return;
  const call = { op, path: norm(args[0]), ...(TWO_PATHS.has(op) ? { to: norm(args[1]) } : {}) };
  const f = faults.find(x => x.when(call));
  if (!f) return;
  if (--f.times <= 0) faults = faults.filter(x => x !== f);
  throw Object.assign(new Error(`${f.code}: injected, ${op} '${call.path}'`), { code: f.code, syscall: op, path: call.path });
}
export function failNext(when, code = 'EIO', { times = 1 } = {}) {
  const f = { when, code, times };
  faults.push(f);
  return () => { faults = faults.filter(x => x !== f); };
}
export function resetFaults() { faults = []; }

// ── What is written, by kind ──
// A file's kind by its name, a temporary name (`<name>.shiori-tmp`, `<name>.<hex>.shiori-new`) read as
// the file it becomes: pages and pictures made from them (staged ones too), descriptions (JSON, and a
// CBZ's ComicInfo.xml), archives, and anything else.
const TEMP = /(\.[0-9a-f]+)?\.shiori-(tmp|new)$/i;
const KINDS = [['picture', /\.(png|jpe?g|webp|gif|avif|bmp|jxl)$/i], ['description', /\.(json|xml)$/i], ['archive', /\.(zip|cbz)$/i]];
const kindOf = (file) => { const name = String(file).replace(TEMP, ''); return KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other'; };
const totals = { picture: 0, description: 0, archive: 0, other: 0 };
const count = (file, bytes) => { if (bytes > 0) totals[kindOf(file)] += bytes; };
const sizeOf = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? 0);
// The bytes written to library folders since the app started, by kind.
export const written = () => ({ ...totals });
// Every file under `dir`, counted (a folder copied whole).
async function countTree(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const at = path.join(dir, e.name);
    if (e.isDirectory()) await countTree(at); else count(at, (await fsp.stat(at)).size);
  }
}
// A file handle opened to write, its writes counted.
function counted(handle, file) {
  const { write, writeFile } = handle;
  handle.write = async function (...args) { const r = await write.apply(this, args); count(file, r.bytesWritten); return r; };
  handle.writeFile = async function (data, ...args) { await writeFile.call(this, data, ...args); count(file, sizeOf(data)); };
  return handle;
}

// ── The calls ──
const promised = (op, after = null) => async (...args) => {
  fault(op, args);
  const out = await fsp[op](...args);
  if (after) await after(args, out);
  return out;
};
const sync = (op, after = null) => (...args) => {
  fault(op, args);
  const out = fs[`${op}Sync`](...args);
  if (after) after(args, out);
  return out;
};
const WRITES = /[wa+]/;
export const disk = {
  constants: fs.constants,
  readFile: promised('readFile'),
  writeFile: promised('writeFile', ([file, data]) => count(file, sizeOf(data))),
  stat: promised('stat'),
  readdir: promised('readdir'),
  mkdir: promised('mkdir'),
  rm: promised('rm'),
  rmdir: promised('rmdir'),
  rename: promised('rename'),
  access: promised('access'),
  realpath: promised('realpath'),
  copyFile: promised('copyFile', async ([, to]) => count(to, (await fsp.stat(to)).size)),
  cp: promised('cp', async ([, to]) => { const st = await fsp.stat(to); if (st.isDirectory()) await countTree(to); else count(to, st.size); }),
  async open(file, flags = 'r', ...rest) {
    fault('open', [file]);
    const handle = await fsp.open(file, flags, ...rest);
    return WRITES.test(String(flags)) ? counted(handle, file) : handle;
  },
  async openAsBlob(file, options) { fault('openAsBlob', [file]); return fs.openAsBlob(file, options); },
  existsSync: (file) => fs.existsSync(file),
  statSync: sync('stat'),
  readFileSync: sync('readFile'),
  writeFileSync: sync('writeFile', ([file, data]) => count(file, sizeOf(data))),
  mkdirSync: sync('mkdir'),
  renameSync: sync('rename'),
  rmSync: sync('rm'),
  rmdirSync: sync('rmdir'),
  copyFileSync: sync('copyFile', ([, to]) => count(to, fs.statSync(to).size)),
  truncateSync: sync('truncate'),
};

// ── Containment ──
// Path `abs` in library folder `dir`, as long as it is inside the folder physically. The policy (F09):
// a linked source is read, and an overlay written, only inside the library folder itself — a junction
// or link in it that leads elsewhere is never followed, whatever source.json or the index says. Paths
// are first checked as written (linked-source.js safeRelPath, linked.js absIn: R12), then here as the
// disk resolves them: the real path of `abs` (for one not made yet, of its nearest folder that is
// there) must be inside the folder's own real path. It is checked each time a source is read or an
// overlay written, so a link made after a check leads nowhere either; one swapped in between this
// check and the read or write itself is not caught. Rejects with BackendError 'invalid' and
// `reason: 'outside'`.
export async function physicallyIn(dir, abs) {
  const rest = [];
  let at = abs, real;
  for (;;) {
    try { real = await disk.realpath(at); break; } catch (e) {
      if ((e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') || path.dirname(at) === at) throw e;
      rest.unshift(path.basename(at));
      at = path.dirname(at);
    }
  }
  const inside = path.relative(await disk.realpath(dir), path.join(real, ...rest));
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw Object.assign(new BackendError('invalid', `${abs} leads out of its library folder`), { reason: 'outside' });
  }
  return abs;
}

// ── The contract ──
const { refused, MISSING, unreadable } = contract;
const join = (...parts) => parts.filter(Boolean).join('/');
const lost = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
// A file read whole, typed (principle 6): missing, or unreadable for any other failure.
async function readTyped(abs) {
  try {
    const [data, st] = await Promise.all([disk.readFile(abs), disk.stat(abs)]);
    return { kind: /** @type {const} */ ('ok'), data: new Uint8Array(data), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return lost(e) ? MISSING : unreadable(e); }
}
async function listTyped(abs) {
  try {
    const entries = [];
    for (const e of await disk.readdir(abs, { withFileTypes: true })) {
      const st = await disk.stat(path.join(abs, e.name)).catch(() => null);
      entries.push({ name: e.name, kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
    }
    return { kind: /** @type {const} */ ('ok'), entries };
  } catch (e) { return lost(e) ? MISSING : unreadable(e); }
}
const notYet = (what) => () => Promise.reject(new Error(`no ${what} before format v2 (S4)`));

// The adapter of `library` (library.js Library): what open() hands out reads and writes its folders as
// the library does.
export function folderStore(library) {
  const { folders, files } = library;
  // Library folder `id` at `at`, opened for `purpose`.
  function root(id, at, purpose) {
    const abs = (rel) => path.join(at, ...rel.split('/').filter(Boolean));
    // Gallery `gid`'s directory `name`: its files as the library writes them — a picture of its own
    // written beside its place, then renamed into it (library.js _writeOwn, files.js placeOwn); a file
    // deleted through the gate (files.js _remove); the folder check's tidy-up as its sweep (scan.js).
    const galleryDir = (name, gid) => ({
      name, gid,
      manifest: notYet('manifest'),
      read: (rel) => readTyped(abs(join(name, rel))),
      async writeNew(slot, ext, bytes) {
        const file = abs(join(name, `${slot}.${ext}`));
        const temp = `${file}.${crypto.randomBytes(5).toString('hex')}.shiori-new`;
        await disk.mkdir(path.dirname(file), { recursive: true });
        await disk.writeFile(temp, bytes);
        disk.renameSync(temp, file);
        const st = disk.statSync(file);
        return { name: `${slot}.${ext}`, size: st.size, mtime: st.mtimeMs };
      },
      publish: notYet('publish'),
      async deleteNamed(list) {
        const deleted = [];
        for (const f of list) {
          await files._remove(files._join(id, join(name, f.name)));
          if (!disk.existsSync(abs(join(name, f.name)))) deleted.push(f.name);
        }
        return { deleted, kept: [] };
      },
      async sweep() { await library.folderScan(id); return { removed: [] }; },
    });
    return {
      id, purpose,
      read: (rel) => readTyped(abs(rel)),
      list: (rel) => listTyped(abs(rel)),
      // The directory the index names for the gallery (files.js), while it is there.
      async gallery(name, gid) {
        const row = files._row(gid);
        if (!row || row.format !== 'folder' || row.path !== files._join(id, name) || !disk.existsSync(abs(name))) return MISSING;
        return { kind: 'ok', dir: galleryDir(name, gid) };
      },
      // A free directory chosen, made and bound to the gallery by its metadata.json (files.js _claim).
      async reserve(hint, gid) {
        const row = files._claim(gid, { galleryId: gid, title: { english: hint, japanese: '', pretty: '' } }, null, id);
        return galleryDir(files._split(row.path).rest, gid);
      },
      // A source is read only inside the folder (physicallyIn, F09).
      async source(at) {
        try { await physicallyIn(library.rootDir(id), abs(at)); } catch { return { kind: 'outside' }; }
        return { kind: 'ok', source: { path: at, read: (rel = '') => readTyped(abs(join(at, rel))), list: (rel = '') => listTyped(abs(join(at, rel))) } };
      },
      private: {
        async read(rel) { const r = await readTyped(abs(`.shiori/${rel}`)); return r.kind === 'ok' ? { ...r, data: new TextDecoder().decode(r.data) } : r; },
        list: (rel) => listTyped(abs(join('.shiori', rel))),
        async write(rel, text) {
          const file = abs(`.shiori/${rel}`);
          await disk.mkdir(path.dirname(file), { recursive: true });
          await disk.writeFile(file, text);
          const st = disk.statSync(file);
          return { name: rel, size: st.size, mtime: st.mtimeMs };
        },
        remove: (rel) => disk.rm(abs(`.shiori/${rel}`), { force: true }),
      },
    };
  }
  return {
    // A folder is read where the index has it while it is there (folders.js dir); written while the
    // gate lets it (folders.js probe: its path holds it, and which app holds its claim).
    async open(ref, { purpose }) {
      if (!folders.has(ref.id)) return refused('unavailable');
      const at = folders.dir(ref.id);
      if (purpose === 'read') return disk.existsSync(at) ? { status: 'ok', root: root(ref.id, at, purpose) } : refused('unavailable');
      const { reachable, access } = folders.probe(ref.id, { fresh: true });
      const why = lifecycle.refusalFor({ state: folders.state(ref.id), owned: access === 'mine', reachable }, purpose);
      return why ? refused(why) : { status: 'ok', root: root(ref.id, at, purpose) };
    },
  };
}
