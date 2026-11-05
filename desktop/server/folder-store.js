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
// - A gallery's folder in format v2 (the app's js/storage/gallery-manifest.js has the rules): writeNewIn
//   (a new file never written over one), publishIn (a generation committed by one atomic manifest
//   write), deleteNamedIn (only files still as Shiori recorded writing them), loadGallery (a folder read
//   back by its manifest, or by v1's rules).
// - folderStore(library): the contract over `disk`. open(ref, { purpose }) weighs the folder by the
//   library's gate (folders.js) and the shared rule (folder-lifecycle.js refusalFor) and hands out a
//   Root; a Root's galleries, reservations, sources and .shiori/ area work by the library's own index
//   and naming (files.js), with the gallery functions above. Identity-verified roots, positive gallery
//   identity and containment in every operation come with S5.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { lifecycle, contract, manifest as format, BackendError } from './shared.js';

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

// ── Writing a file whole ──
// `data` written to `file` and flushed to the disk.
export async function writeFlushed(file, data) {
  const handle = await disk.open(file, 'w');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

// A small file replaced whole: written beside it, then renamed over it — tried again a few times
// while Windows refuses because something holds the file for a moment (a reader of it, an antivirus
// scan of the one just written), rather than losing the change (R17).
export async function replaceFile(file, data) {
  const temp = `${file}.shiori-tmp`;
  await writeFlushed(temp, data);
  for (let attempt = 0; ; attempt++) {
    try { return await disk.rename(temp, file); } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { await disk.rm(temp, { force: true }).catch(() => {}); throw e; }
      await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}

// ── A gallery's folder (format v2: js/storage/gallery-manifest.js) ──
const lost = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const within = (dir, rel) => path.join(dir, ...String(rel).split('/').filter(Boolean));
const textOr = (file) => disk.readFile(file, 'utf8').catch((e) => { if (lost(e)) return null; throw e; });

// A new file for picture `slot` (its layout name without extension: translated/0001) of the gallery
// whose folder is `dir`: its layout name when nothing is there, else that name with a random part
// (translated/0001-3fa2c9e10b.png, which gallery-files.js layoutOf and pageNumberOf read) — created
// exclusively, so it is never written over a file (principle 3), and flushed to the disk. Resolves
// { name, size, mtime } as written: what the library records, and deletion checks it against.
export async function writeNewIn(dir, slot, ext, bytes) {
  await disk.mkdir(path.dirname(within(dir, slot)), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const name = attempt ? `${slot}-${crypto.randomBytes(5).toString('hex')}.${ext}` : `${slot}.${ext}`;
    const file = within(dir, name);
    let handle;
    try { handle = await disk.open(file, 'wx'); } catch (e) {
      if (e?.code === 'EEXIST' && attempt < 20) continue;
      throw e;
    }
    try { await handle.writeFile(bytes); await handle.sync(); } catch (e) {
      await handle.close().catch(() => {});
      await disk.rm(file, { force: true }).catch(() => {});
      throw e;
    }
    await handle.close();
    const st = await disk.stat(file);
    return { name, size: st.size, mtime: st.mtimeMs };
  }
}

// The manifest of the gallery whose folder is `dir`, typed (contract ParseResult): missing (format
// v1), ok, corrupt (gallery-manifest.js parseManifest, `gid` the gallery it must name), unreadable.
export async function manifestIn(dir, gid = null) {
  try {
    const text = await textOr(within(dir, format.manifestPath(format.areaOf(dir.split(path.sep).join('/')))));
    return text == null ? contract.MISSING : format.parseManifest(text, { galleryId: gid });
  } catch (e) { return contract.unreadable(e); }
}

// Generation `next` (a manifest without its descriptions, gallery-manifest.js) published in the gallery
// folder `dir`, with its descriptions `texts` (name → text): the descriptions the folder's current
// manifest doesn't store written as new files named by their content, then the manifest replaced in
// one atomic write — the commit point — then, as a best effort, the stable-named copies brought up to
// date and the stored descriptions neither generation names collected (publication). The sizes it
// records come from `next.sizes` where the library knew them. `hide(abs)`: called on the .shiori/
// folder made for it (the app marks it hidden, D7). Resolves { manifest: the one published, bytes: how
// many it wrote }. Rejects when the
// current manifest can't be read (nothing is written then: tried again later) or a write fails before
// the commit (the previous generation stays whole).
export async function publishIn(dir, next, texts, { hide = () => {} } = {}) {
  const area = format.areaOf(dir.split(path.sep).join('/'));
  const now = await manifestIn(dir, next.galleryId);
  if (now.kind === 'unreadable') throw new Error(`the manifest in ${dir} can't be read: ${now.error}`);
  const prev = now.kind === 'ok' ? now.value : null;
  const sizes = await format.sizesOf(next.files, new Map(Object.entries(next.sizes || {})), prev, async (f) => {
    const st = await disk.stat(within(dir, f)).catch(() => null);
    return st?.isFile() ? [st.size, st.mtimeMs] : null;
  });
  const plan = await format.publication({ area, prev, next: { ...next, sizes }, texts });
  if (area) {
    const made = await disk.mkdir(within(dir, area), { recursive: true });
    if (made) try { hide(within(dir, area)); } catch {}
  }
  if (plan.writes.length) await disk.mkdir(within(dir, format.storedDir(area)), { recursive: true });
  let bytes = 0;
  for (const w of plan.writes) { await replaceFile(within(dir, w.path), w.text); bytes += Buffer.byteLength(w.text); }
  await replaceFile(within(dir, format.manifestPath(area)), plan.text);
  bytes += Buffer.byteLength(plan.text);
  for (const s of plan.stable) {
    try {
      const file = within(dir, s.path);
      const had = await textOr(file);
      if (s.text != null && had !== s.text) { await disk.mkdir(path.dirname(file), { recursive: true }); await replaceFile(file, s.text); bytes += Buffer.byteLength(s.text); }
      else if (s.text == null && had != null && s.was && await format.matches(s.was, had)) await disk.rm(file, { force: true });
    } catch {}
  }
  try {
    for (const name of await disk.readdir(within(dir, format.storedDir(area))).catch(() => [])) {
      const at = `${format.storedDir(area)}/${name}`;
      if (plan.keep.has(at) || !format.storedHash(at)) continue;
      const had = await textOr(within(dir, at)).catch(() => null);
      if (had != null && await format.matches(at, had)) await disk.rm(within(dir, at), { force: true });
    }
  } catch {}
  return { manifest: plan.manifest, bytes };
}

// The files `list` ([{ name, size, mtime }]: paths in the folder `dir`, as Shiori recorded writing
// them) deleted — each only while its size and modification time are still those (gallery-manifest.js
// unchanged); one that differs was changed outside Shiori and is left, as is one that isn't there or
// can't be checked, each reported in `kept` with why. A folder the deletions left empty goes too, up to
// `dir` itself (principle 4) — unless `emptied` is false (`dir` holds more than the files named: an
// archive's folder). Resolves { deleted, kept }.
export async function deleteNamedIn(dir, list, { emptied: tidy = true } = {}) {
  const deleted = [], kept = [], emptied = new Set();
  for (const f of list) {
    const file = within(dir, f.name);
    let st;
    try { st = await disk.stat(file); } catch (e) { kept.push({ name: f.name, why: lost(e) ? 'missing' : 'unreadable' }); continue; }
    if (!st.isFile() || !format.unchanged(f, { size: st.size, mtime: st.mtimeMs })) { kept.push({ name: f.name, why: 'changed' }); continue; }
    try { await disk.rm(file); deleted.push(f.name); emptied.add(path.dirname(file)); } catch (e) { kept.push({ name: f.name, why: lost(e) ? 'missing' : 'unreadable' }); }
  }
  const top = path.resolve(dir);
  if (tidy) for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
    for (let at = path.resolve(d); at === top || at.startsWith(top + path.sep); at = path.dirname(at)) {
      if ((await disk.readdir(at).catch(() => [null])).length) break;
      try { await disk.rmdir(at); } catch { break; }
      if (at === top) break;
    }
  }
  return { deleted, kept };
}

// The picture files gallery folder `dir` holds where the gallery format puts them (gallery-manifest.js
// PICTURE_DIRS), by their names a picture's: path → { size, mtime }. Rejects when a folder of them can't be listed (one that isn't
// there holds nothing).
export async function picturesIn(dir) {
  const out = new Map();
  for (const sub of format.PICTURE_DIRS) {
    let names;
    try { names = await disk.readdir(within(dir, sub), { withFileTypes: true }); } catch (e) { if (lost(e)) continue; throw e; }
    for (const e of names) {
      if (!e.isFile() || !format.isPictureName(e.name)) continue;
      const st = await disk.stat(within(dir, `${sub}/${e.name}`)).catch((err) => { if (lost(err)) return null; throw err; });
      if (st) out.set(`${sub}/${e.name}`, { size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

// Gallery folder `dir` read back (gallery-manifest.js readGallery): by its manifest when it has one,
// else by format v1's rules — with the picture files it holds (`files`, picturesIn). Rejects when
// something in it can't be read.
export async function loadGallery(dir) {
  const files = await picturesIn(dir);
  const read = await format.readGallery({ area: format.areaOf(dir.split(path.sep).join('/')), text: (rel) => textOr(within(dir, rel)), files });
  return { read, files };
}

// ── The contract ──
const { refused, MISSING, unreadable } = contract;
const join = (...parts) => parts.filter(Boolean).join('/');
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
// The adapter of `library` (library.js Library): what open() hands out reads and writes its folders as
// the library does.
export function folderStore(library) {
  const { folders, files } = library;
  // Library folder `id` at `at`, opened for `purpose`.
  function root(id, at, purpose) {
    const abs = (rel) => path.join(at, ...rel.split('/').filter(Boolean));
    // Gallery `gid`'s directory `name`, in format v2 (the functions above); the folder check's tidy-up
    // as its sweep (scan.js).
    const galleryDir = (name, gid) => ({
      name, gid,
      manifest: () => manifestIn(abs(name), gid),
      read: (rel) => readTyped(abs(join(name, rel))),
      writeNew: (slot, ext, bytes) => writeNewIn(abs(name), slot, ext, bytes),
      async publish({ manifest, descriptions }) {
        const done = await publishIn(abs(name), manifest, descriptions, { hide: (dir) => library._hide(dir) });
        return { generation: done.manifest.generation, ...done };
      },
      deleteNamed: (list) => deleteNamedIn(abs(name), list),
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
