// scan.js — the library folder and the index agreeing again (at startup, and on demand). Files may
// be changed outside the app: a gallery whose archive or folder moved or was renamed is found by the
// id in its shiori.json; one whose files are gone is marked missing (never deleted); an archive or
// folder of images the index doesn't know is added — rebuilt from its shiori.json when it has one
// (the index can be rebuilt from the files), or as a new gallery when it was added by hand. Leftovers
// of an interrupted write (temporary archives, staged pages and cache files nothing refers to) go.
//
// A known path costs one existence check; only files the index doesn't know are opened.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readDirectory, readEntry } from './zip.js';

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => (s == null ? null : JSON.parse(s));
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const MAX_DEPTH = 6;

// Every gallery in the library folder: { rel, format, entries: [name], described? }. A folder holding
// images is a gallery (its subfolders aren't looked into); any other folder is walked.
async function findGalleries(root) {
  const found = [];
  const walk = async (dir, depth) => {
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const rel = (name) => path.relative(root, path.join(dir, name)).split(path.sep).join('/');
    const images = items.filter(i => i.isFile() && IMAGE.test(i.name));
    if (images.length && dir !== root) {
      found.push({ rel: path.relative(root, dir).split(path.sep).join('/'), format: 'folder',
        entries: images.map(i => i.name).sort(natural.compare), hasDescription: items.some(i => i.name === 'shiori.json') });
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.isFile() && /\.(cbz|zip)$/i.test(item.name)) found.push({ rel: rel(item.name), format: /\.cbz$/i.test(item.name) ? 'cbz' : 'zip' });
      else if (item.isDirectory() && depth < MAX_DEPTH && !item.name.endsWith('.shiori-tmp') && !item.name.endsWith('.shiori-old')) await walk(path.join(dir, item.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

// A found gallery's shiori.json, and its page files ([{ name, size }], in reading order).
async function readGallery(root, g) {
  const abs = path.join(root, ...g.rel.split('/'));
  if (g.format === 'folder') {
    const described = g.hasDescription ? parse(await fsp.readFile(path.join(abs, 'shiori.json'), 'utf8').catch(() => null)) : null;
    const pages = await Promise.all(g.entries.map(async (name) => ({ name, size: (await fsp.stat(path.join(abs, name))).size })));
    return { described, pages };
  }
  const dir = await readDirectory(abs);
  const json = dir.get('shiori.json');
  const described = json ? parse(String(await readEntry(abs, json))) : null;
  const pages = [...dir].filter(([n]) => IMAGE.test(n) && !n.startsWith('__MACOSX/')).sort(([a], [b]) => natural.compare(a, b))
    .map(([name, e]) => ({ name, size: e.size }));
  return { described, pages };
}

// Bring the index and the library folder into agreement. Resolves { moved, missing, found, added,
// removed } (gallery ids, and how many leftover files went).
export async function scanLibrary(library) {
  const root = library.libraryDir;
  const out = { moved: [], missing: [], found: [], added: [], removed: 0 };
  const known = library._s('SELECT * FROM files').all();
  const byPath = new Map(known.map(r => [r.path, r]));
  const exists = (rel) => fsp.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);

  // Leftovers of interrupted packs.
  for (const g of await findLeftovers(root)) { await fsp.rm(g, { recursive: true, force: true }).catch(() => {}); out.removed++; }

  const present = new Set();
  for (const row of known) if (await exists(row.path)) present.add(row.gid);
  const galleries = await findGalleries(root);
  const unknown = galleries.filter(g => !byPath.has(g.rel) || !present.has(byPath.get(g.rel).gid));
  const byId = new Map();
  for (const g of unknown) {
    try { g.read = await readGallery(root, g); } catch { continue; }
    const id = g.read.described?.id;
    if (id && !byId.has(String(id))) byId.set(String(id), g);
  }

  const changed = new Set();
  library._tx(() => {
    for (const row of known) {
      if (present.has(row.gid)) {
        if (row.state === 'missing') { setState(library, row.gid, 'packed'); out.found.push(row.gid); changed.add(row.gid); }
        continue;
      }
      const moved = byId.get(row.gid);
      if (moved && moved.format === row.format) {
        library._s(`UPDATE files SET path = ?, state = 'packed' WHERE gid = ?`).run(moved.rel, row.gid);
        byId.delete(row.gid);
        moved.claimed = true;
        out.moved.push(row.gid);
        changed.add(row.gid);
      } else if (row.state !== 'missing') {
        setState(library, row.gid, 'missing');
        out.missing.push(row.gid);
        changed.add(row.gid);
      }
    }
    for (const g of unknown) {
      if (g.claimed || !g.read || !g.read.pages.length) continue;
      const id = g.read.described?.id ? String(g.read.described.id) : null;
      if (id && library._s('SELECT 1 FROM files WHERE gid = ?').get(id)) continue;   // a copy of a gallery the library has
      const gid = id && /^\d{13,}$/.test(id) && !library._metaGet(id) ? id : library.nextGalleryId();
      addGallery(library, gid, g);
      out.added.push(gid);
      changed.add(gid);
    }
  });
  for (const gid of out.added) await library.rebuildGalleryEntry(gid, { silent: true });
  for (const gid of changed) library.publishFeed(gid);
  out.removed += await removeOrphans(library);
  return out;
}

function setState(library, gid, state) {
  library._s('UPDATE files SET state = ? WHERE gid = ?').run(state, gid);
  library._logIn(gid);
}

// A gallery the index didn't have, from its files: its own metadata and page keys when it describes
// itself, else a new gallery named after its file.
function addGallery(library, gid, g) {
  const { described, pages } = g.read;
  const listed = new Map((described?.pages || []).map(p => [p.file, p]));
  const stem = g.rel.split('/').pop().replace(/\.(cbz|zip)$/i, '');
  const meta = described?.meta
    ? { ...described.meta, galleryId: gid }
    : { galleryId: gid, title: { english: stem, japanese: '', pretty: stem }, tags: [], numPages: pages.length, isLocalImport: true };
  library._metaPutRaw(meta);
  const now = Date.now();
  pages.forEach(({ name, size }, i) => {
    const p = listed.get(name);
    const n = p?.n ?? i + 1;
    const ext = name.match(/\.(\w+)$/)[1].toLowerCase();
    const key = p?.key && /\/(\d+)\.\w+$/.test(p.key) ? p.key : `local://${gid}/${n}.${ext}`;
    if (library._pageRowByKey(key) || library._pageRow(gid, n)) return;
    const type = typeOf(name);
    library._pagePutRow({ gid, n, key, w: null, h: null, orig: { at: 'p', entry: name, size, type },
      record: { url: key, blob: { $orig: 1, size, type }, mediaId: String(p?.mediaId ?? gid), galleryId: gid, cachedAt: p?.cachedAt || now, size } });
  });
  library._s(`INSERT INTO files (gid, path, format, state, packed_at) VALUES (?, ?, ?, 'packed', ?)`).run(gid, g.rel, g.format, now);
  library._logIn(gid);
}

async function findLeftovers(root) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      if (/\.shiori-(tmp|old)$/.test(item.name)) out.push(abs);
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(abs, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

// Staged pages and cache files no record refers to (a write that failed half way, or the app closed
// in the middle of one). A file written in the last few minutes is spared: its write may still be
// on its way to committing.
const ORPHAN_AGE_MS = 10 * 60 * 1000;
async function removeOrphans(library) {
  const staged = new Set(), cached = new Set();
  for (const r of library._s('SELECT orig, record FROM pages').all()) {
    const orig = parse(r.orig);
    if (orig?.at === 's') staged.add(orig.file);
    collect(parse(r.record), cached);
  }
  for (const r of library._s('SELECT record FROM covers').all()) collect(parse(r.record), cached);
  let removed = 0;
  for (const [dir, keep] of [[library.stagingDir, staged], [library.cacheDir, cached]]) {
    for (const gid of await fsp.readdir(dir).catch(() => [])) {
      for (const name of await fsp.readdir(path.join(dir, gid)).catch(() => [])) {
        if (keep.has(`${gid}/${name}`)) continue;
        const file = path.join(dir, gid, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (!stat || Date.now() - stat.mtimeMs < ORPHAN_AGE_MS) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      fsp.rmdir(path.join(dir, gid)).catch(() => {});
    }
  }
  return removed;
}

function collect(value, into) {
  if (value == null || typeof value !== 'object') return;
  if (typeof value.$file === 'string') { into.add(value.$file); return; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) collect(v, into);
}
