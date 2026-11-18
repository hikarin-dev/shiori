// capture-storage-fixtures.mjs — makes the migration fixtures (plan D13) in storage/: each one an index
// that an earlier version wrote, made by that version's own code, so a test can open it with today's
// and check what carries over. For each version it takes the code from git (`git archive`) into a
// temporary folder, runs a short scenario there in a process of its own, and saves what came out as
// JSON: the desktop library's library.db (its schema and rows) and the files of its library folders,
// or the website library's IndexedDB (its stores, indexes and records). storage-fixtures.mjs loads them
// back. Paths under the temporary folder are kept as $BASE (raw) and $BASE_JSON (inside a JSON text).
//
// Run by hand from the repository, with its history and Node 24 (node:sqlite):
//   node app/tests/fixtures/capture-storage-fixtures.mjs
// The website's library folders need File System Access, which Node hasn't: its fixtures hold a
// library kept in the browser's own storage (a website folder is added back, which D13 accepts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const OUT = path.join(here, 'storage');

// The versions: the released v1.2.6 and the working tree's shapes of the index since (plan D13).
const SHAPES = [
  { name: 'desktop-v1.2.6', kind: 'desktop', commit: 'd35c9ea', folders: false,
    about: 'released v1.2.6: one library folder, no folder tables' },
  { name: 'desktop-kv-roots', kind: 'desktop', commit: '6f2d3d7', folders: true,
    about: 'folders in kv roots / hiddenRoots / claimEpochs; tables homes, unmounted, dormant, stamps' },
  { name: 'desktop-roots', kind: 'desktop', commit: '6e563fe', folders: true,
    about: 'tables roots, places (unmounted a view), stamps' },
  { name: 'desktop-unplaced', kind: 'desktop', commit: '7d774f0', folders: true,
    about: 'as desktop-roots, plus tables unplaced and removed_notes' },
  { name: 'desktop-s30', kind: 'desktop', commit: '146199d', folders: true,
    about: 'S30, before S31: manifests naming no publication, stamps of their generation and writer alone' },
  { name: 'indexeddb-16', kind: 'indexeddb', commit: 'd35c9ea', about: 'IndexedDB 16 (released v1.2.6)' },
  { name: 'indexeddb-18', kind: 'indexeddb', commit: '6f2d3d7', about: 'IndexedDB 18: folders and dormant stores' },
  { name: 'indexeddb-19', kind: 'indexeddb', commit: '7d774f0', about: 'IndexedDB 19: the undescribed store' },
];

// Kilobyte pictures: a 1×1 WebP and a 1×1 PNG, each made distinct by a trailing byte.
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const picture = (b64, type, n) => new Blob([Buffer.from(b64, 'base64'), new Uint8Array([n])], { type });
const meta = (gid, title, tags = []) => ({ galleryId: gid, title: { english: title, japanese: '', pretty: title }, tags });
const GIDS = { a: '1790000000001', b: '1790000000002', c: '1790000000003' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The parent: one child process per version ──
function capture(shape) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-capture-'));
  try {
    const src = path.join(work, 'src');
    fs.mkdirSync(src);
    const tar = path.join(work, 'src.tar');
    run('git', ['archive', '--format=tar', `--output=${tar}`, shape.commit, 'app/js', 'desktop/server'], repo);
    run('tar', ['-xf', 'src.tar', '-C', 'src'], work);   // relative: a drive letter reads as a host to GNU tar
    const base = path.join(work, 'base');
    fs.mkdirSync(base);
    const out = path.join(work, 'dump.json');
    run(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(shape), src, base, out], repo);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    const text = JSON.stringify({ name: shape.name, commit: shape.commit, about: shape.about, ...dump }, null, 1);
    if (text.includes(path.basename(work))) throw new Error(`${shape.name}: a path under the capture folder was left in`);
    fs.writeFileSync(path.join(OUT, `${shape.name}.json`), `${text}\n`);
    console.log(`${shape.name}: ${Math.round(text.length / 1024)} KB`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed:\n${r.stdout}${r.stderr}`);
}

// Every string in `value` with `base` written as $BASE (and, escaped as JSON text holds it, $BASE_JSON).
function withoutBase(value, base) {
  const json = JSON.stringify(base).slice(1, -1);
  const swap = (s) => s.split(json).join('$BASE_JSON').split(base).join('$BASE');
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map(v => withoutBase(v, base));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutBase(v, base)]));
  return value;
}

// ── The child: the scenario, run on that version's code ──
async function child(shape, src, base, out) {
  const dump = shape.kind === 'desktop' ? await desktopScenario(shape, src, base) : await indexedDBScenario(src);
  fs.writeFileSync(out, JSON.stringify(withoutBase(dump, base)));
  process.exit(0);
}

// The desktop library: gallery A (two pages, the first translated, a cover of its own) in the
// library's own folder, archived; gallery B (as A, without the cover) kept as a folder — there, or,
// where the version has library folders, in a second folder beside a folder of loose pictures (a
// linked gallery); and there gallery C in a third folder, hidden.
async function desktopScenario(shape, src, base) {
  const { Library } = await import(pathToFileURL(path.join(src, 'desktop', 'server', 'library.js')).href);
  const dataDir = path.join(base, 'data'), libraryDir = path.join(base, 'library');
  const lib = await new Library({ dataDir, libraryDir, placeDelay: 0, describeDelay: 0 }).open();
  const gallery = async (gid, title) => {
    await lib.metaPut(meta(gid, title, [{ type: 'artist', name: 'fixture' }]));
    await lib.pagePut(gid, 1, picture(WEBP, 'image/webp', 1));
    await lib.pagePut(gid, 2, picture(WEBP, 'image/webp', 2));
    await lib.putTranslatedImage({ galleryId: gid, pageNum: 1 }, picture(PNG, 'image/png', 1));
    await lib.files.settle(gid);
  };
  await gallery(GIDS.a, 'Fixture A');
  await lib.coverPut(GIDS.a, picture(PNG, 'image/png', 9));
  await lib.files.settle(GIDS.a);
  await lib.archiveGallery(GIDS.a);
  if (!shape.folders) await gallery(GIDS.b, 'Fixture B');
  else {
    const second = path.join(base, 'second'), third = path.join(base, 'third');
    fs.mkdirSync(path.join(second, 'Loose Pictures'), { recursive: true });
    fs.mkdirSync(third);
    for (const n of [1, 2]) fs.writeFileSync(path.join(second, 'Loose Pictures', `00${n}.png`), Buffer.from(PNG, 'base64'));
    const primary = lib.primaryId;
    const { id: two } = await lib.folderAdd(second);
    await lib.folderScan(two);
    await lib.folderSetDefault(two);
    await gallery(GIDS.b, 'Fixture B');
    const { id: three } = await lib.folderAdd(third);
    await lib.folderSetDefault(three);
    await gallery(GIDS.c, 'Fixture C');
    await lib.folderSetDefault(primary);
    await lib.folderHide(three);
  }
  await lib.files.flush?.();
  await sleep(300);
  lib.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'library.db'), { readOnly: true });
  const schema = db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all()
    .map(r => ({ type: r.type, name: r.name, sql: r.sql }));
  const rows = {};
  for (const t of schema.filter(s => s.type === 'table')) rows[t.name] = db.prepare(`SELECT * FROM "${t.name}"`).all().map(r => ({ ...r }));
  db.close();
  const files = {};
  for (const rel of fs.readdirSync(base, { recursive: true })) {
    const abs = path.join(base, rel), name = rel.replace(/\\/g, '/');
    if (name === 'data' || name.startsWith('data/') || !fs.statSync(abs).isFile()) continue;
    files[name] = fs.readFileSync(abs).toString('base64');
  }
  return { schema, rows, files };
}

// The website library, in the browser's own storage: gallery A (two pages, the first translated, a
// cover of its own), and gallery B with one page.
async function indexedDBScenario(src) {
  await import('fake-indexeddb/auto');
  globalThis.BroadcastChannel ??= class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
  const api = await import(pathToFileURL(path.join(src, 'app', 'js', 'api.js')).href);
  await api.meta.put(meta(GIDS.a, 'Fixture A', [{ type: 'artist', name: 'fixture' }]));
  await api.pages.put(GIDS.a, 1, picture(WEBP, 'image/webp', 1));
  await api.pages.put(GIDS.a, 2, picture(WEBP, 'image/webp', 2));
  await (api.derived ?? api.pages).putTranslatedImage(GIDS.a, 1, picture(PNG, 'image/png', 1));   // derived.* in v1.2.6
  await api.covers.put(GIDS.a, picture(PNG, 'image/png', 9));
  await api.meta.put(meta(GIDS.b, 'Fixture B'));
  await api.pages.put(GIDS.b, 1, picture(WEBP, 'image/webp', 3));
  await sleep(600);   // the size and change-feed timers
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('shiori-cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const stores = [];
  for (const name of db.objectStoreNames) {
    const tx = db.transaction(name, 'readonly');
    const store = tx.objectStore(name);
    const indexes = [...store.indexNames].map(i => { const x = store.index(i); return { name: i, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; });
    const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()].map(req => new Promise((resolve) => { req.onsuccess = () => resolve(req.result); })));
    const records = [];
    for (const [i, value] of values.entries()) records.push({ key: store.keyPath == null ? keys[i] : undefined, value: await withBlobs(value) });
    stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records });
  }
  return { version: db.version, stores };
}
// A record with each Blob in it as { $fixtureBlob: base64, type } (storage-fixtures.mjs puts it back).
async function withBlobs(value) {
  if (value instanceof Blob) return { $fixtureBlob: Buffer.from(await value.arrayBuffer()).toString('base64'), type: value.type };
  if (Array.isArray(value)) return Promise.all(value.map(withBlobs));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await withBlobs(v)])));
  return value;
}

if (process.argv[2] === '--child') {
  await child(JSON.parse(process.argv[3]), process.argv[4], process.argv[5], process.argv[6]);
} else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const shape of SHAPES.filter(s => !process.argv[2] || s.name === process.argv[2])) capture(shape);
}
