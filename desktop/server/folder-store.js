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
// - Containment (principle 5): every `disk` call inside a library folder is refused when its path
//   goes through a link there (containIn; physicallyIn for a linked source's path, ahead of its reads).
// - A gallery's folder in format v2 (the app's js/storage/gallery-manifest.js has the rules): galleryIn
//   (whose it is: principle 2), reserveIn (the only way a folder becomes a gallery's), writeNewIn (a new
//   file never written over one), publishIn (a generation committed by one atomic manifest write),
//   deleteNamedIn (only files still as Shiori recorded writing them), deleteGalleryIn (a gallery's
//   folder deleted by name), undescribedAt / bindIn (a folder an earlier version never described, given
//   its gallery's identity), loadGallery (a folder read back by its manifest, or by v1's rules).
// - folderStore(library): the contract over `disk`. open(ref, { purpose }) is the library's own root
//   resolver (folders.js reach: the folder's path holds it — principle 1 — and its state and claim
//   allow the purpose) and hands out a Root; a Root's galleries, reservations, sources and .shiori/
//   area work by the library's own index and naming (files.js), with the gallery functions above.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { contract, content, linked as linkedSource, manifest as format, BackendError } from './shared.js';

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

// ── Containment (principle 5) ──
// Every disk call on a path inside a library folder — each library tells the adapter its folders
// (containIn) — is refused when a part of that path below the folder is a link (a symbolic link
// or a junction, as lstat reports one), wherever it leads and whoever calls: a gallery's pictures read
// or written, a linked source read, a check's tidy-up, a removal's notes. Nothing in a library folder is
// ever reached through a link (T04, F09): Shiori makes none there, and a check never walks into one,
// so no source joins through one either. The library folder itself may be reached through a link (a
// drive mounted in a folder). A call that deletes or copies a folder whole is refused for a link
// anywhere inside it too. Checked at each call, from the folder down to the first part not there yet; a
// link swapped in between the check and the call is outside the fault model (plan §2). Throws (or
// rejects with) a BackendError 'invalid', `reason: 'outside'`.
/** @type {Set<() => { path: string, id: string }[]>} */
const folderSets = new Set();
// `folders()`: a library's folders now, each its path and its id (what its library.json names: homeOf).
// Returns a function that takes them back (it closed).
export function containIn(folders) { folderSets.add(folders); return () => { folderSets.delete(folders); }; }
const caseOf = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
// The library folder `abs` is in (the innermost, should one hold another): { root, id }, or null.
function folderAround(abs) {
  const key = caseOf(abs);
  let best = null;
  for (const folders of folderSets) {
    for (const f of folders()) {
      const root = path.resolve(f.path), k = caseOf(root);
      if ((key === k || key.startsWith(k.endsWith(path.sep) ? k : k + path.sep)) && (!best || root.length > best.root.length)) best = { root, id: f.id };
    }
  }
  return best;
}
const outside = (op, file) => Object.assign(new BackendError('invalid', `${file} is reached through a link in its library folder`),
  { reason: 'outside', syscall: op, path: file });
// The first part of `abs` below folder `root` that is a link, or null. A read (`reading`) takes a folder
// on the way found no link within the last CLEAR_TTL as it was (the identity of a library folder is
// taken as read for as long: folders.js IDENTITY_TTL), so reading a page costs one lstat; every change
// looks at each part afresh.
const CLEAR_TTL = 2000;
/** @type {Map<string, number>} folder → when it was found to be no link */
const clear = new Map();
function linkOnWay(root, abs, reading = false) {
  let at = root;
  const parts = path.relative(root, abs).split(path.sep).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    at = path.join(at, part);
    const folder = i < parts.length - 1;
    if (reading && folder && Date.now() - (clear.get(at) ?? -Infinity) < CLEAR_TTL) continue;
    let st;
    try { st = fs.lstatSync(at); } catch { return null; }   // not there (yet): nothing below it is reached through a link
    if (st.isSymbolicLink()) { clear.delete(at); return at; }
    if (folder) {
      clear.set(at, Date.now());
      if (clear.size > 4096) clear.delete(clear.keys().next().value);
    }
  }
  return null;
}
// A link anywhere inside folder `dir`, or null (one that can't be listed holds none it would be told of).
function linkInside(dir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of items) {
    const at = path.join(dir, e.name);
    if (e.isSymbolicLink()) return at;
    const deeper = e.isDirectory() ? linkInside(at) : null;
    if (deeper) return deeper;
  }
  return null;
}
// Call `op` on `file` checked (`whole`: the call takes a folder with everything in it; `reading`: it
// changes nothing).
function contained(op, file, whole = false, reading = false) {
  if (!folderSets.size || !(typeof file === 'string' || file instanceof URL || Buffer.isBuffer(file))) return;
  const abs = path.resolve(String(file));
  const root = folderAround(abs)?.root;
  if (!root) return;
  const link = linkOnWay(root, abs, reading) || (whole ? linkInside(abs) : null);
  if (link) throw outside(op, abs);
}
// Path `abs` in library folder `dir` as long as no part of it below the folder is a link (linkOnWay):
// what a linked source is read through, and an overlay written in (F09), before the call itself is
// checked again (contained). Paths are first checked as written (linked-source.js safeRelPath, linked.js
// absIn: R12). Rejects with BackendError 'invalid' and `reason: 'outside'`.
export async function physicallyIn(dir, abs) {
  const rel = path.relative(dir, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || linkOnWay(path.resolve(dir), path.resolve(abs))) throw outside('open', abs);
  return abs;
}
// A folder `file` about to be deleted whole by other means than `disk` (remove.js: Windows' own file
// operation) checked as disk.rm would check it.
export const containedWhole = (file) => contained('rm', file, true);

// ── Failures, for the identity of a library folder ──
// How many disk calls have failed for another reason than a name not being there (or taken): a folder's
// identity, as read, is read again after one (folders.js _identity).
let failures = 0;
const ROUTINE = new Set(['ENOENT', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY']);
export const ioFailures = () => failures;
const failed = (e) => { if (typeof e?.code === 'string' && e.code.startsWith('E') && !ROUTINE.has(e.code)) failures++; };

// ── The calls ──
// Which of a call's arguments are paths in a library folder, whether it takes a folder whole, and
// whether it only reads.
const TARGETS = { rename: [0, 1], copyFile: [0, 1], cp: [0, 1] };
const READS = new Set(['readFile', 'stat', 'readdir', 'access', 'openAsBlob', 'exists']);
function checked(op, args) {
  const reading = READS.has(op) || (op === 'open' && !WRITES.test(String(args[1] ?? 'r')));
  for (const i of TARGETS[op] || [0]) contained(op, args[i], (op === 'rm' && !!args[1]?.recursive) || (op === 'cp' && i === 0), reading);
}
const promised = (op, after = null) => async (...args) => {
  try {
    fault(op, args);
    checked(op, args);
    const out = await fsp[op](...args);
    if (after) await after(args, out);
    return out;
  } catch (e) { failed(e); throw e; }
};
const sync = (op, after = null) => (...args) => {
  try {
    fault(op, args);
    checked(op, args);
    const out = fs[`${op}Sync`](...args);
    if (after) after(args, out);
    return out;
  } catch (e) { failed(e); throw e; }
};
const WRITES = /[wa+]/;
// A folder made inside a library folder, with `recursive`, made one part at a time below the library
// folder, which is never made itself — not even when it is the folder asked for, which must be there: a
// drive taken away (its folder gone) while a write is under way fails the call (ENOENT) instead of
// making the folder again where it was, with a gallery's folder in it (S8: the model found a write begun
// just before a drive went making its path again; S18: a gallery reserved at the library folder's top
// made the library folder itself again, found by the sweeps' drive away).
const belowFolder = (file, options) => {
  if (!options?.recursive || !(typeof file === 'string' || file instanceof URL || Buffer.isBuffer(file))) return null;
  const abs = path.resolve(String(file)), root = folderAround(abs)?.root;
  return root ? { root, parts: path.relative(root, abs).split(path.sep).filter(Boolean) } : null;
};
const madeOrThere = (e) => { if (e?.code !== 'EEXIST') throw e; };
const mkdirAsync = promised('mkdir'), mkdirNow = sync('mkdir');
// Resolves, as fs's recursive mkdir does, the first folder it made (undefined: none).
export const disk = {
  constants: fs.constants,
  readFile: promised('readFile'),
  writeFile: promised('writeFile', ([file, data]) => count(file, sizeOf(data))),
  stat: promised('stat'),
  readdir: promised('readdir'),
  async mkdir(file, options) {
    const below = belowFolder(file, options);
    if (!below) return mkdirAsync(file, options);
    if (!below.parts.length) { await disk.stat(below.root); return undefined; }   // the library folder: there, or ENOENT
    let at = below.root, first;
    for (const part of below.parts) { at = path.join(at, part); if (await mkdirAsync(at).then(() => true, madeOrThere)) first ??= at; }
    return first;
  },
  rm: promised('rm'),
  rmdir: promised('rmdir'),
  rename: promised('rename'),
  access: promised('access'),
  copyFile: promised('copyFile', async ([, to]) => count(to, (await fsp.stat(to)).size)),
  cp: promised('cp', async ([, to]) => { const st = await fsp.stat(to); if (st.isDirectory()) await countTree(to); else count(to, st.size); }),
  open: promised('open', ([file, flags = 'r'], handle) => { if (WRITES.test(String(flags))) counted(handle, file); }),
  openAsBlob: async (file, options) => {
    try { fault('openAsBlob', [file]); checked('openAsBlob', [file]); return await fs.openAsBlob(file, options); } catch (e) { failed(e); throw e; }
  },
  existsSync: (file) => { try { checked('exists', [file]); } catch { return false; } return fs.existsSync(file); },
  statSync: sync('stat'),
  readFileSync: sync('readFile'),
  writeFileSync: sync('writeFile', ([file, data]) => count(file, sizeOf(data))),
  mkdirSync(file, options) {
    const below = belowFolder(file, options);
    if (!below) return mkdirNow(file, options);
    if (!below.parts.length) { disk.statSync(below.root); return undefined; }   // the library folder: there, or ENOENT
    let at = below.root, first;
    for (const part of below.parts) { at = path.join(at, part); try { mkdirNow(at); first ??= at; } catch (e) { madeOrThere(e); } }
    return first;
  },
  renameSync: sync('rename'),
  rmSync: sync('rm'),
  rmdirSync: sync('rmdir'),
  copyFileSync: sync('copyFile', ([, to]) => count(to, fs.statSync(to).size)),
  truncateSync: sync('truncate'),
};
// Folder `dir`'s own .shiori/, made where it isn't there — inside `dir` alone, which is never made: a folder
// not one of the library's yet (being added: its library.json, its claim) whose drive is away a moment
// fails (ENOENT) instead of being made again at its path, empty (S26a).
/** @param {string} dir */
export function ownDirIn(dir) {
  try { disk.mkdirSync(path.join(dir, '.shiori')); } catch (e) { madeOrThere(e); }
}

// ── Writing a file whole ──
// `data` written to `file` and flushed to the disk.
async function writeFlushed(file, data) {
  const handle = await disk.open(file, 'w');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

// A temporary name beside `abs` for what is made whole there before it takes the place (a gallery's
// folder copied or unpacked, an archive written): `<abs>.<hex>.shiori-tmp`, a name of its own each time.
// One a kill left is never written over or deleted by its name (nothing proves it Shiori's: F08), nor
// takes a name from the next write (review 4 O2); neither app's check reads it (folder-content.js
// TEMPORARY).
export const tempBeside = (abs) => `${abs}.${crypto.randomBytes(4).toString('hex')}.shiori-tmp`;

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
// Whether `file` is there, by a look of its own (notFound's second look).
const there = (file) => disk.stat(file).then(() => true, (e) => { if (lost(e)) return false; throw e; });
// Whether the library folder `file` is in is there as itself now: its .shiori/library.json, read
// afresh, names the id the library registered it under (folder-content.js libraryIdOf, as the
// commit-time mount checks read it: files.js identityAt). A path in no library folder (the library's
// own data folder) has none to ask.
async function homeOf(file) {
  const home = folderAround(path.resolve(file));
  return !home || content.libraryIdOf(await disk.readFile(path.join(home.root, ...content.LIBRARY_FILE.split('/')), 'utf8')) === home.id;
}
// An answer of "not found" (`error`) for `file`, as the shared rule takes it (contract.js surelyMissing):
// MISSING while the library folder it is in is there as itself (homeOf: not while its drive is away) and
// a second look at `file` agrees; else unreadable. What an answer of "not found" that would delete
// something, or change what is recorded, goes through.
export const notFound = (file, error) => contract.surelyMissing({ home: () => homeOf(file), there: () => there(file) }, error);
// Whether nothing is at `file`, as the shared rule takes it (notFound), for a call that answered so.
export const gone = async (file) => (await notFound(file, 'not found')).kind === 'missing';
const within = (dir, rel) => path.join(dir, ...String(rel).split('/').filter(Boolean));
// A text read for what decides nothing (publishIn's best-effort refresh of its stable-named copies): null
// for "not found", whatever the reason.
const textOr = (file) => disk.readFile(file, 'utf8').catch((e) => { if (lost(e)) return null; throw e; });

// ── Reading what a folder holds (principle 6; review 6) ──
// Every read that tells what a library folder holds — which galleries, which pages and pictures, which
// descriptions, whether a gallery's folder is still there — answers "nothing there" only as the shared rule
// takes it (notFound): an answer of "not found" for a file or folder that a second look finds, or while the
// library folder isn't there as itself (a drive away for a moment), is a failure like any other, thrown
// with `reason: 'unreadable'`. So a gallery is never read in part: one that can't be read whole now is
// reported and left as the index has it, and read again at a later check. A file is looked for only where
// its folder's listing shows its first part (textsIn, loadGallery), so what isn't there costs no look.
// The libraries read folders with these (and the typed results of galleryIn, manifestIn, loadGallery);
// none tells "not there" by an error's code of its own (tests/architecture-fitness.test.mjs).
async function ruled(file, read, none = null) {
  try { return await read(); } catch (e) {
    if (!lost(e)) throw e;
    const r = await notFound(file, e);
    if (r.kind === 'missing') return none;
    throw cantRead(file, r);
  }
}
const cantRead = (file, r) => Object.assign(new Error(`${file} can't be read now: ${r.error}`), { reason: 'unreadable' });
// The text of `file`, or null when nothing is there.
export const textIn = (file) => ruled(file, () => disk.readFile(file, 'utf8'));
// The same, for a read that can't wait (folders.js reads a folder's claim in front of every write): the
// rule's two looks made at once (contract.js surelyMissingNow), as homeOf and there make them.
function ruledNow(file, read) {
  try { return read(); } catch (e) {
    if (!lost(e)) throw e;
    const at = folderAround(path.resolve(file));
    const home = () => !at || content.libraryIdOf(disk.readFileSync(path.join(at.root, ...content.LIBRARY_FILE.split('/')), 'utf8')) === at.id;
    const there = () => { try { disk.statSync(file); return true; } catch (e2) { if (lost(e2)) return false; throw e2; } };
    const r = contract.surelyMissingNow({ home, there }, e);
    if (r.kind === 'missing') return null;
    throw cantRead(file, r);
  }
}
export const textNow = (file) => ruledNow(file, () => disk.readFileSync(file, 'utf8'));
// `file`'s stat, or null when nothing is there, the same way (files.js moveSync: a move's target).
export const statNow = (file) => ruledNow(file, () => disk.statSync(file));
// What folder `dir` holds (its entries, with their types), or null when it isn't there.
export const entriesIn = (dir) => ruled(dir, () => disk.readdir(dir, { withFileTypes: true }));
// `file`'s stat, or null when nothing is there.
export const statIn = (file) => ruled(file, () => disk.stat(file));
// Whether a folder's listing (`items`) shows path `rel` in it: its first part, a folder when there is more.
const shownIn = (items) => (rel) => {
  const [top, ...rest] = String(rel).split('/');
  return items.some(i => i.name === top && (rest.length ? i.isDirectory() : i.isFile()));
};
// The texts of `names` (paths in folder `dir`) that its listing (`items`) shows, each read under the rule
// (textIn); null for one it doesn't show, unlooked at.
export async function textsIn(dir, items, names) {
  const shown = shownIn(items), texts = {};
  for (const name of names) texts[name] = shown(name) ? await textIn(within(dir, name)) : null;
  return texts;
}

// A new file for picture `slot` (its layout name without extension: translated/0001) of the gallery
// whose folder is `dir`: its layout name when nothing is there, else that name with a random part
// (translated/0001-3fa2c9e10b.png, which gallery-files.js layoutOf and pageNumberOf read) — created
// exclusively, so it is never written over a file (principle 3). Never flushed on its own: only the
// small manifest and descriptions are (power loss is outside the fault model; a crash or kill doesn't
// need it, and a flush per picture costs a bulk import minutes). The gallery's folder must be there: a
// folder gone meanwhile is never made again by a write into it (ENOENT). Resolves { name, size, mtime }
// as written: what the library records, and deletion checks it against.
export async function writeNewIn(dir, slot, ext, bytes) {
  const st = await disk.stat(dir);
  if (!st.isDirectory()) throw Object.assign(new Error(`${dir} is not a gallery's folder`), { code: 'ENOTDIR' });
  await disk.mkdir(path.dirname(within(dir, slot)), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const name = attempt ? `${slot}-${crypto.randomBytes(5).toString('hex')}.${ext}` : `${slot}.${ext}`;
    const file = within(dir, name);
    let handle;
    try { handle = await disk.open(file, 'wx'); } catch (e) {
      if (e?.code === 'EEXIST' && attempt < 20) continue;
      throw e;
    }
    try { await handle.writeFile(bytes); } catch (e) {
      await handle.close().catch(() => {});
      await disk.rm(file, { force: true }).catch(() => {});
      throw e;
    }
    await handle.close();
    const st = await disk.stat(file);
    return { name, size: st.size, mtime: st.mtimeMs };
  }
}

// Whose gallery folder `dir` is now (principle 2: folder-content.js galleryAt — its manifest, else its
// metadata.json, else an earlier version's shiori.json; a linked gallery's overlay, its source.json):
// { kind: 'ok' } when it names gallery `gid`; MISSING when nothing is there; { kind: 'conflict', found }
// when something is that names another gallery (`found`), or none (null); unreadable when what it holds
// can't be read (nothing is concluded from it). Nothing there, and a description not there, are told as
// the shared rule takes them (notFound, textsIn). What a change to an existing gallery folder needs
// first: nothing else makes a folder a gallery's but its reservation (reserveIn).
export async function galleryIn(dir, gid) {
  let items;
  try { items = await disk.readdir(dir, { withFileTypes: true }); } catch (e) {
    if (e?.code === 'ENOTDIR') return { kind: 'conflict', found: null };   // a file at its place
    return lost(e) ? notFound(dir, e) : unreadable(e);
  }
  try {
    const own = (await textsIn(dir, items, [content.MANIFEST_FILE]))[content.MANIFEST_FILE];
    if (content.galleryAt({ [content.MANIFEST_FILE]: own }, gid).kind === 'ok') return { kind: 'ok' };
    const texts = { [content.MANIFEST_FILE]: own, ...await textsIn(dir, items, content.OWN_FILES.slice(1)) };
    if (format.areaOf(dir.split(path.sep).join('/')) !== '') return content.galleryAt(texts, gid);
    const source = linkedSource.parseSource((await textsIn(dir, items, [linkedSource.SOURCE_FILE]))[linkedSource.SOURCE_FILE])?.galleryId ?? null;
    return content.galleryAt(texts, gid, { source });
  } catch (e) { return unreadable(e); }
}

// Gallery `gid`'s folder `dir` (an absolute path in a library folder, or in a series' folder there)
// reserved — made exclusively (EEXIST when something is there by now) — and bound to the gallery at
// once, in the same synchronous step: its first generation published there (gallery-manifest.js
// firstGeneration, by `writer`), its metadata.json (`metadata`, the gallery's description) stored by its
// content, then the manifest, renamed into place last — so nothing names the gallery before it, and a
// kill on the way leaves a folder naming none (review 4 F2). Its stable-named copies come with its first
// publication. A reservation cut short takes the folder it made with it. The only way a folder becomes
// a gallery's (contract.js reserve). `hide(abs)`: called on the .shiori/ folder made for it (D7).
// Returns the token published (gallery-manifest.js tokenOf).
export function reserveIn(dir, gid, writer, metadata, { hide = () => {} } = {}) {
  disk.mkdirSync(path.dirname(dir), { recursive: true });
  disk.mkdirSync(dir);
  try {
    const plan = format.publicationWith({ area: '.shiori/', prev: null, next: format.firstGeneration(gid, writer),
      texts: { 'metadata.json': metadata }, hashOf: (t) => crypto.createHash('sha256').update(t).digest('hex') });
    disk.mkdirSync(within(dir, format.storedDir('.shiori/')), { recursive: true });
    try { hide(within(dir, '.shiori')); } catch {}
    for (const w of plan.writes) disk.writeFileSync(within(dir, w.path), w.text);
    const file = within(dir, format.manifestPath('.shiori/'));
    disk.writeFileSync(`${file}.shiori-tmp`, plan.text);
    disk.renameSync(`${file}.shiori-tmp`, file);
    return format.tokenOf(plan.manifest);
  } catch (e) {
    try { disk.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// The manifest of the gallery whose folder is `dir`, typed (contract ParseResult): missing (format
// v1; as the shared rule takes it, textIn), ok, corrupt (gallery-manifest.js parseManifest, `gid` the
// gallery it must name), unreadable.
export async function manifestIn(dir, gid = null) {
  try {
    const text = await textIn(within(dir, format.manifestPath(format.areaOf(dir.split(path.sep).join('/')))));
    return text == null ? contract.MISSING : format.parseManifest(text, { galleryId: gid });
  } catch (e) { return contract.unreadable(e); }
}

// Generation `next` (a manifest without its descriptions, gallery-manifest.js) published in the gallery
// folder `dir`, with its descriptions `texts` (name → text): the descriptions the folder's current
// manifest doesn't store written as new files named by their content, then the manifest replaced in
// one atomic write — the commit point — then, as a best effort, the stable-named copies brought up to
// date and the stored descriptions neither generation names collected (publication). The sizes it
// records come from `next.sizes` where the library knew them. `hide(abs)`: called on the .shiori/
// folder made for it (the app marks it hidden, D7). `known`: the token the library last published or
// read there (gallery-manifest.js tokenOf; undefined: not to be weighed). Resolves { manifest: the one
// published, bytes: how many it wrote, changedBoth: whether it replaced a generation another app
// published since `known` — this app's change wins, and the case is the caller's to report (D4) }.
// Rejects when the folder no longer names the gallery (galleryIn: principle 2 — nothing is written,
// reason 'conflict' or 'missing'), when the current manifest can't be read (nothing is written then:
// tried again later), or when a write fails before the commit (the previous generation stays whole).
export async function publishIn(dir, next, texts, { hide = () => {}, known } = {}) {
  const area = format.areaOf(dir.split(path.sep).join('/'));
  const whose = await galleryIn(dir, next.galleryId);
  if (whose.kind !== 'ok') {
    throw Object.assign(new BackendError('conflict', `${dir} is not gallery ${next.galleryId}'s folder now`), { reason: whose.kind === 'missing' ? 'missing' : 'conflict' });
  }
  const now = await manifestIn(dir, next.galleryId);
  if (now.kind === 'unreadable') throw new Error(`the manifest in ${dir} can't be read: ${now.error}`);
  const prev = now.kind === 'ok' ? now.value : null;
  const changedBoth = known !== undefined && !!prev && format.tokenOf(prev) !== known && prev.writer !== next.writer;
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
  return { manifest: plan.manifest, bytes, changedBoth };
}

// The files `list` ([{ name, size, mtime }]: paths in the folder `dir`, as Shiori recorded writing
// them) deleted — each only while its size and modification time are still those (gallery-manifest.js
// unchanged); one that differs was changed outside Shiori and is left, as is one that isn't there (as
// the shared rule takes it: notFound) or can't be checked, each reported in `kept` with why. A folder
// the deletions left empty goes too, up to `dir` itself (principle 4) — unless `emptied` is false
// (`dir` holds more than the files named: an archive's folder). Resolves { deleted, kept }.
export async function deleteNamedIn(dir, list, { emptied: tidy = true } = {}) {
  const deleted = [], kept = [], emptied = new Set();
  const why = async (file, e) => (lost(e) && (await notFound(file, e)).kind === 'missing' ? 'missing' : 'unreadable');
  for (const f of list) {
    const file = within(dir, f.name);
    let st;
    try { st = await disk.stat(file); } catch (e) { kept.push({ name: f.name, why: await why(file, e) }); continue; }
    if (!st.isFile() || !format.unchanged(f, { size: st.size, mtime: st.mtimeMs })) { kept.push({ name: f.name, why: 'changed' }); continue; }
    try { await disk.rm(file); deleted.push(f.name); emptied.add(path.dirname(file)); } catch (e) { kept.push({ name: f.name, why: await why(file, e) }); }
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

// Gallery `gid`'s own folder `dir` emptied by name (gallery-manifest.js galleryDeletion, principle 4):
// the pictures the library recorded writing there (`named`: [{ name, size, mtime }]) and those its
// manifest records, each while it is as recorded; then its descriptions, each while it is the
// gallery's; then what names it, its manifest last. The folder itself, once it holds no file, is the
// library's to delete (with Windows' own delete: files.js _delete). A folder that names the gallery
// (galleryIn) is emptied so; one that names no gallery — what named it gone already (a deletion cut
// short), or put there by hand — loses only the files the library recorded writing, each while it is
// as recorded; one gone, or another gallery's, is left as it is ('missing': the gallery's folder isn't
// there — renamed or moved by hand, perhaps: F4). Nothing is concluded from an answer of "not found" the
// shared rule doesn't take (notFound: the drive away, say — review 5 F2). `named` null: a folder the
// deletion met in place of the archive it recorded, emptied by its manifest alone — left whole without one
// (galleryDeletion). Resolves whether the deletion is done — true (its folder holds no file now, or is
// gone), or 'left' when what it emptied still holds files: a person's, or one changed since Shiori wrote
// it — 'missing', or is to be tried again (false: something there couldn't be read or deleted now, or the
// folder still names the gallery).
export async function deleteGalleryIn(dir, gid, named) {
  const whose = await galleryIn(dir, String(gid));
  if (whose.kind === 'unreadable') return false;
  if (whose.kind === 'missing' || (whose.kind === 'conflict' && whose.found != null)) return 'missing';
  const now = whose.kind === 'ok' ? await manifestIn(dir, String(gid)) : contract.MISSING;
  if (now.kind === 'unreadable') return false;
  const area = format.areaOf(dir.split(path.sep).join('/'));
  const plan = format.galleryDeletion({ area, manifest: now.kind === 'ok' ? now.value : null, named });
  if (!plan) return 'left';
  const { kept } = await deleteNamedIn(dir, plan.pictures, { emptied: false });
  if (kept.some(k => k.why === 'unreadable')) return false;
  try {
    if (whose.kind === 'ok') {
      const drop = async (rel) => {
        const file = within(dir, rel), text = await textIn(file);
        if (text != null && await format.isOwnDescription(rel, text, String(gid), area)) await disk.rm(file);
      };
      for (const rel of plan.descriptions) await drop(rel);
      for (const e of (await entriesIn(within(dir, plan.stored))) ?? []) await drop(`${plan.stored}/${e.name}`);
      for (const rel of plan.identity) await drop(rel);
      // Done only once the folder no longer names the gallery: a description whose read answered "not
      // found", still there, names it yet — the deletion stays recorded, tried again (S11, review 4 F3).
      const after = await galleryIn(dir, String(gid));
      if (after.kind === 'ok' || after.kind === 'unreadable') return false;
    }
    return await holdsFile(dir) ? 'left' : true;
  } catch { return false; }
}
// Whether folder `dir` holds a file, in it or in a folder of it (none: it isn't there, as the shared rule
// takes it — notFound; one that can't be listed is thrown).
export async function holdsFile(dir) {
  for (const e of (await entriesIn(dir)) ?? []) if (!e.isDirectory() || await holdsFile(path.join(dir, e.name))) return true;
  return false;
}
// Every file under `dir`, as paths relative to it.
export async function filesIn(dir, rel = '') {
  const out = [];
  for (const e of await disk.readdir(within(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await filesIn(dir, name)); else out.push(name);
  }
  return out;
}

// The files of gallery `gid`'s own folder `dir` that its deletion takes (gallery-manifest.js
// galleryDeletion, as deleteGalleryIn takes them), each as it is now ([{ name, size, mtime }], in the
// order a deletion takes them, what names the gallery last): the pictures the library recorded writing
// there (`named`) and those its manifest records, each while it is as recorded; its descriptions, each
// while it is the gallery's. Nothing else the folder holds is listed: a file the person put there, a
// picture changed since Shiori wrote it (principle 4; review 4 F4). Rejects when the folder, or a file
// in it, can't be read now.
export async function ownedIn(dir, gid, named) {
  const now = await manifestIn(dir, String(gid));
  if (now.kind === 'unreadable') throw now.error;
  const area = format.areaOf(dir.split(path.sep).join('/'));
  const plan = format.galleryDeletion({ area, manifest: now.kind === 'ok' ? now.value : null, named });
  const pictures = new Map(plan.pictures.map(f => [f.name, f]));
  const stored = (name) => name.startsWith(`${plan.stored}/`) && !name.slice(plan.stored.length + 1).includes('/');
  const describes = (name) => plan.descriptions.includes(name) || stored(name) || plan.identity.includes(name);
  const rank = (name) => (pictures.has(name) ? 0 : plan.descriptions.includes(name) ? 1 : stored(name) ? 2 : 3 + plan.identity.indexOf(name));
  const own = [];
  for (const name of await filesIn(dir)) {
    const st = await disk.stat(within(dir, name));
    const as = { name, size: st.size, mtime: st.mtimeMs };
    const recorded = pictures.get(name);
    if (recorded ? format.unchanged(recorded, as)
      : describes(name) && await format.isOwnDescription(name, await disk.readFile(within(dir, name), 'utf8'), String(gid), area)) own.push(as);
  }
  return own.sort((a, b) => rank(a.name) - rank(b.name));
}

// What gallery folder `dir`, as the index has it for gallery `gid`, is to its first start in this
// build (plan §10, the orchestrator after S6): 'match' — it names no gallery, holds no description, and
// its pictures are exactly those the library recorded writing there (`named`: path → { size, mtime };
// gallery-manifest.js undescribedMatch), as an earlier desktop version could leave a folder it never
// described — 'described' or 'mismatch' (it stays a conflict), or what galleryIn says otherwise ('ok':
// it names the gallery; 'conflict': another; 'missing'; 'unreadable'). Read only: the owner's dry run
// asks it too.
export async function undescribedAt(dir, gid, named) {
  const whose = await galleryIn(dir, String(gid));
  if (whose.kind !== 'conflict' || whose.found != null) return whose.kind;
  try {
    const items = (await entriesIn(dir)) ?? [];
    return format.undescribedMatch({ texts: await textsIn(dir, items, content.OWN_FILES), named, found: await picturesIn(dir, items) });
  } catch { return 'unreadable'; }
}
// Gallery folder `dir` ('match' to undescribedAt) bound to its gallery: generation `next` (a manifest
// without its descriptions) published there with its descriptions `texts` — each file made exclusively,
// never over one, the manifest last — so the folder names the gallery from now on. The one way besides
// a reservation (reserveIn) that a folder becomes a gallery's, for those an earlier version made and
// never described. Cut short, what it made goes again. `hide(abs)` as for publishIn. Resolves the token.
export async function bindIn(dir, next, texts, { hide = () => {} } = {}) {
  const plan = await format.publication({ area: '.shiori/', prev: null, next, texts });
  const made = [];
  try {
    await disk.mkdir(within(dir, format.storedDir('.shiori/')), { recursive: true });
    try { hide(within(dir, '.shiori')); } catch {}
    for (const f of [...plan.writes, ...plan.stable.filter(s => s.text != null)]) {
      await disk.mkdir(path.dirname(within(dir, f.path)), { recursive: true });
      await disk.writeFile(within(dir, f.path), f.text, { flag: 'wx' });
      made.push(f.path);
    }
    await replaceFile(within(dir, format.manifestPath('.shiori/')), plan.text);
  } catch (e) {
    for (const f of made) await disk.rm(within(dir, f), { force: true }).catch(() => {});
    throw e;
  }
  return format.tokenOf(plan.manifest);
}

// The picture files gallery folder `dir` holds where the gallery format puts them (gallery-manifest.js
// PICTURE_DIRS), by their names a picture's: path → { size, mtime }. Only the folders its listings show
// are listed (`items`: the gallery's own listing, when the caller has it), and each folder and picture
// they show is read under the rule (entriesIn, statIn): one gone, as the rule takes it, holds nothing;
// one that can't be read now rejects — never a gallery with a page fewer.
export async function picturesIn(dir, items = null) {
  const out = new Map();
  const listed = new Map(items ? [['', items]] : []);   // a folder in the gallery's → its entries
  const entries = async (rel) => listed.get(rel) ?? listed.set(rel, (await entriesIn(within(dir, rel))) ?? []).get(rel);
  const holds = async (sub) => {
    let at = '';
    for (const part of sub.split('/')) { if (!(await entries(at)).some(e => e.name === part && e.isDirectory())) return false; at = at ? `${at}/${part}` : part; }
    return true;
  };
  for (const sub of format.PICTURE_DIRS) {
    if (!await holds(sub)) continue;
    for (const e of await entries(sub)) {
      if (!e.isFile() || !format.isPictureName(e.name)) continue;
      const st = await statIn(within(dir, `${sub}/${e.name}`));
      if (st) out.set(`${sub}/${e.name}`, { size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

// Gallery folder `dir` read back (gallery-manifest.js readGallery): by its manifest when it has one,
// else by format v1's rules — with the picture files it holds (`files`, picturesIn), each description
// looked for where the folder's listing shows it, under the rule. Rejects when something in it can't be
// read now.
export async function loadGallery(dir) {
  const items = (await entriesIn(dir)) ?? [];
  const files = await picturesIn(dir, items);
  const shown = shownIn(items);
  const read = await format.readGallery({ area: format.areaOf(dir.split(path.sep).join('/')), text: (rel) => (shown(rel) ? textIn(within(dir, rel)) : null), files });
  return { read, files };
}

// ── The contract ──
const { unreadable } = contract;
const join = (...parts) => parts.filter(Boolean).join('/');
// A file read whole, typed (principle 6): missing (as the shared rule takes it: notFound), or unreadable
// for any other failure.
async function readTyped(abs) {
  try {
    const [data, st] = await Promise.all([disk.readFile(abs), disk.stat(abs)]);
    return { kind: /** @type {const} */ ('ok'), data: new Uint8Array(data), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return lost(e) ? notFound(abs, e) : unreadable(e); }
}
async function listTyped(abs) {
  try {
    const entries = [];
    for (const e of await disk.readdir(abs, { withFileTypes: true })) {
      const st = await disk.stat(path.join(abs, e.name)).catch(() => null);
      entries.push({ name: e.name, kind: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file', size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
    }
    return { kind: /** @type {const} */ ('ok'), entries };
  } catch (e) { return lost(e) ? notFound(abs, e) : unreadable(e); }
}
// The adapter of `library` (library.js Library): what open() hands out reads and writes its folders as
// the library does.
export function folderStore(library) {
  const { folders, files } = library;
  // Library folder `id` at `at`, opened for `purpose`.
  function root(id, at, purpose) {
    const abs = (rel) => path.join(at, ...rel.split('/').filter(Boolean));
    // Gallery `gid`'s directory `name`, in format v2 (the functions above); the folder check's tidy-up
    // as its sweep (scan.js). Each change is made only while the directory still names the gallery
    // (galleryIn, principle 2) — one gone meanwhile, or put there since by hand, is refused.
    const galleryDir = (name, gid) => {
      const ours = async () => {
        const found = await galleryIn(abs(name), gid);
        if (found.kind !== 'ok') throw Object.assign(new BackendError('conflict', `${name} is not gallery ${gid}'s folder now`), { reason: found.kind === 'missing' ? 'missing' : 'conflict' });
      };
      return {
        name, gid,
        manifest: () => manifestIn(abs(name), gid),
        read: (rel) => readTyped(abs(join(name, rel))),
        async writeNew(slot, ext, bytes) { await ours(); return writeNewIn(abs(name), slot, ext, bytes); },
        async publish({ manifest, descriptions, known }) {
          const done = await publishIn(abs(name), manifest, descriptions, { hide: (dir) => library._hide(dir), known });
          return { generation: done.manifest.generation, ...done };
        },
        async deleteNamed(list) { await ours(); return deleteNamedIn(abs(name), list); },
        async sweep() { await library.folderScan(id); return { removed: [] }; },
      };
    };
    return {
      id, purpose,
      read: (rel) => readTyped(abs(rel)),
      list: (rel) => listTyped(abs(rel)),
      // The directory, while it names the gallery (galleryIn).
      async gallery(name, gid) {
        const found = await galleryIn(abs(name), String(gid));
        return found.kind === 'ok' ? { kind: 'ok', dir: galleryDir(name, String(gid)) } : found;
      },
      // A free directory chosen, made and bound to the gallery by its first generation (files.js _claim:
      // reserveIn).
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
    // The library's own resolver, asked afresh (folders.js reach: the folder's path holds it, and its
    // state and claim allow the purpose).
    async open(ref, { purpose }) {
      const opened = folders.reach(ref.id, purpose, { fresh: true });
      return opened.status === 'ok' ? { status: 'ok', root: root(ref.id, opened.at, purpose) } : opened;
    },
  };
}
