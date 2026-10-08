// scan.js — the library folder and the index agreeing again: the full check, run only when asked
// (Settings → System) or once for an index with no galleries — the app otherwise opens files only
// when it needs them. Files may be changed outside the app: a gallery whose folder or archive moved
// or was renamed is found by the id its metadata.json carries; one whose files are gone is marked
// missing (never deleted); a folder or archive the index doesn't know is added — rebuilt from its
// descriptions when it is in the Shiori gallery format (gallery-files.js; the index can be rebuilt
// from the files, a folder's translations and study layers picked up where they lie), or as a new
// gallery of its pictures when it was put there by hand (an archive in the gallery format — one the
// app archived — rebuilt alike, from what it holds). Leftovers of an interrupted write
// (temporary files and folders, staged pages, cache files and pictures nothing refers to) go.
//
// A known path costs one existence check; only files the index doesn't know are opened.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readDirectory, readEntry } from './zip.js';

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const numberOf = (name) => { const m = String(name).match(/(?:^|\/)(\d+)(?:-[0-9a-z]+)?\.\w+$/i); return m ? parseInt(m[1], 10) : null; };
const MAX_DEPTH = 6;
// The folders of the gallery format a gallery's pictures made from its pages live in.
const DERIVED = ['translated', 'study/bg', 'study/text', 'pipeline', 'covers'];

// Every gallery in the library folder: { rel, format, layout?, entries? }. A folder in the gallery
// format (metadata.json, image_records.json or images/) is a gallery; so is a folder holding
// pictures put there by hand (its subfolders aren't looked into); any other folder — a series'
// folder among them — is walked.
async function findGalleries(root) {
  const found = [];
  const walk = async (dir, depth) => {
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const rel = (name) => path.relative(root, path.join(dir, name)).split(path.sep).join('/');
    const here = path.relative(root, dir).split(path.sep).join('/');
    if (dir !== root) {
      if (items.some(i => (i.isFile() && (i.name === 'metadata.json' || i.name === 'image_records.json')) || (i.isDirectory() && i.name === 'images'))) {
        found.push({ rel: here, format: 'folder', layout: true });
        return;
      }
      const images = items.filter(i => i.isFile() && IMAGE.test(i.name));
      if (images.length) {
        found.push({ rel: here, format: 'folder', entries: images.map(i => i.name).sort(natural.compare), hasDescription: items.some(i => i.name === 'shiori.json') });
        return;
      }
    }
    for (const item of items) {
      if (item.name.startsWith('.') || /\.shiori-(tmp|old|new)$/.test(item.name)) continue;
      if (item.isFile() && /\.(cbz|zip)$/i.test(item.name)) found.push({ rel: rel(item.name), format: /\.cbz$/i.test(item.name) ? 'cbz' : 'zip' });
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(path.join(dir, item.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

// A found gallery's description — { id, meta, pages: [{ n, file, key, mediaId, cachedAt, record }] }
// from its metadata.json and image_records.json (an earlier version's shiori.json, too), or null —
// its page files ([{ name, size }], in reading order), and, for an archive in the gallery format,
// what it holds beside its pages (`derived`, as readDerived reads a folder's).
async function readGallery(root, g) {
  const abs = path.join(root, ...g.rel.split('/'));
  if (g.format === 'folder' && g.layout) {
    const text = (name) => fsp.readFile(path.join(abs, name), 'utf8').catch(() => null);
    const names = (await fsp.readdir(path.join(abs, 'images')).catch(() => [])).filter(n => IMAGE.test(n)).sort(natural.compare);
    const pages = await Promise.all(names.map(async (name) => ({ name: `images/${name}`, size: (await fsp.stat(path.join(abs, 'images', name))).size })));
    return { described: describedBy(parse(await text('metadata.json')), parse(await text('image_records.json')), pages), pages };
  }
  if (g.format === 'folder') {
    const described = g.hasDescription ? parse(await fsp.readFile(path.join(abs, 'shiori.json'), 'utf8').catch(() => null)) : null;
    const pages = await Promise.all(g.entries.map(async (name) => ({ name, size: (await fsp.stat(path.join(abs, name))).size })));
    return { described, pages };
  }
  const dir = await readDirectory(abs);
  const json = async (name) => (dir.get(name) ? parse(String(await readEntry(abs, dir.get(name)))) : null);
  if (dir.has('metadata.json') || dir.has('image_records.json')) {
    const pages = [...dir].filter(([n]) => /^images\//.test(n) && IMAGE.test(n)).sort(([a], [b]) => natural.compare(a, b))
      .map(([name, e]) => ({ name, size: e.size }));
    const files = new Map();
    for (const [name, e] of dir) {
      if (IMAGE.test(name) && DERIVED.includes(name.slice(0, name.lastIndexOf('/')))) files.set(name, { size: e.size, type: typeOf(name) });
    }
    return { described: describedBy(await json('metadata.json'), await json('image_records.json'), pages), pages,
      derived: derivedOf(files, await json('study/bubbles.json'), await json('covers/manifest.json')) };
  }
  const pages = [...dir].filter(([n]) => IMAGE.test(n) && !n.startsWith('__MACOSX/')).sort(([a], [b]) => natural.compare(a, b))
    .map(([name, e]) => ({ name, size: e.size }));
  return { described: await json('shiori.json'), pages };
}

// A description from the gallery format's metadata.json and image_records.json: each page's record
// joined to its file by page number.
function describedBy(meta, records, pages) {
  if (!meta && !Array.isArray(records)) return null;
  const byNumber = new Map((Array.isArray(records) ? records : []).map(r => [numberOf(r?.url), r]).filter(([n]) => n != null));
  return {
    id: meta?.galleryId != null ? String(meta.galleryId) : null,
    meta,
    pages: pages.map(({ name }) => {
      const n = numberOf(name);
      const r = byNumber.get(n);
      return { n, file: name, key: r?.url, mediaId: r?.mediaId, cachedAt: r?.cachedAt, record: r };
    }),
  };
}

// Bring the index and the library folder into agreement. Resolves { moved, missing, found, added,
// removed } (gallery ids, and how many leftover files went).
export async function scanLibrary(library) {
  const root = library.libraryDir;
  const out = { moved: [], missing: [], found: [], added: [], removed: 0 };
  const known = library._s('SELECT * FROM files').all();
  const byPath = new Map(known.map(r => [r.path, r]));
  const exists = (rel) => fsp.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);

  // Leftovers of interrupted writes.
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
  // What a folder or archive in the gallery format holds beside its pages, read before the index changes.
  for (const g of unknown) {
    if (g.read) g.derived = g.read.derived ?? (g.layout ? await readDerived(path.join(root, ...g.rel.split('/'))) : undefined);
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
  for (const gid of out.added) {
    await library.rebuildGalleryEntry(gid, { silent: true });
    const g = unknown.find(x => x.addedAs === gid);
    if (g?.derived?.cover) library._tx(() => library._coverPatchIn(gid, { cover: g.derived.cover }));
  }
  for (const gid of changed) library.publishFeed(gid);
  out.removed += await removeOrphans(library);
  library.files.resume();   // galleries found again settle what waited for them
  return out;
}

function setState(library, gid, state) {
  library._s('UPDATE files SET state = ? WHERE gid = ?').run(state, gid);
  library._logIn(gid);
}

// The pictures a folder in the gallery format holds beside its pages, and its study index:
// { files: Map rel → { size, type }, bubbles, cover }.
async function readDerived(abs) {
  const files = new Map();
  for (const sub of DERIVED) {
    for (const name of await fsp.readdir(path.join(abs, ...sub.split('/'))).catch(() => [])) {
      if (!IMAGE.test(name)) continue;
      const size = (await fsp.stat(path.join(abs, ...sub.split('/'), name)).catch(() => null))?.size;
      if (size != null) files.set(`${sub}/${name}`, { size, type: typeOf(name) });
    }
  }
  const bubbles = parse(await fsp.readFile(path.join(abs, 'study', 'bubbles.json'), 'utf8').catch(() => null));
  const manifest = parse(await fsp.readFile(path.join(abs, 'covers', 'manifest.json'), 'utf8').catch(() => null));
  return derivedOf(files, bubbles, manifest);
}
function derivedOf(files, bubbles, manifest) {
  const coverFile = (manifest?.covers || []).find(c => c?.role === 'gallery')?.file;
  const cover = coverFile && files.has(coverFile) ? { $own: coverFile, ...files.get(coverFile) } : null;
  return { files, bubbles: bubbles || {}, cover };
}

// A page's record fields made from it, as a folder in the gallery format holds them: its translated
// picture, study layers and pipeline data, referenced where they lie.
function derivedRecord(derived, n, entry) {
  const out = {};
  const num = String(n).padStart(4, '0');
  const own = (rel) => (derived.files.has(rel) ? { $own: rel, ...derived.files.get(rel) } : null);
  const find = (prefix) => [...derived.files.keys()].find(rel => rel.startsWith(prefix) && /^\.\w+$/.test(rel.slice(prefix.length)));
  const translated = find(`translated/${num}`);
  if (translated) out.translated = own(translated);
  const study = derived.bubbles[num];
  const bubbles = Array.isArray(study) ? study : study?.bubbles;
  if (Array.isArray(bubbles) && bubbles.length) {
    out.bubbles = bubbles.filter(b => b?.box).map((b) => {
      const { textFile, ...rest } = b;
      return { ...rest, region: b.region || b.box, tr: b.tr || '', src: b.src || '', text: textFile ? own(`study/text/${textFile}`) : null };
    });
    const bg = find(`study/bg/${num}`);
    out.studyBg = bg ? own(bg) : null;
    out.studyPage = Array.isArray(study) ? null : (study.page || null);
  }
  if (entry?.pipeline && typeof entry.pipeline === 'object' && typeof entry.pipeline.job === 'string') {
    const masks = {};
    for (const name of ['raw', 'text']) { const rel = find(`pipeline/${num}-${name}`); if (rel) masks[name] = own(rel); }
    out.pipeline = { ...entry.pipeline, masks };
    if (typeof entry.own === 'string') out.own = entry.own;
  }
  if (entry?.translatedLayers === true && out.bubbles) out.translatedLayers = true;
  return out;
}

// A gallery the index didn't have, from its files: its own metadata and page keys when it describes
// itself (and, for a folder in the gallery format, what was made from its pages), else a new
// gallery named after its folder or file.
function addGallery(library, gid, g) {
  const { described, pages } = g.read;
  g.addedAs = gid;
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
    const made = g.derived ? derivedRecord(g.derived, n, p?.record) : {};
    library._pagePutRow({ gid, n, key, w: null, h: null, orig: { at: 'p', entry: name, size, type },
      record: { url: key, blob: { $orig: 1, size, type }, mediaId: String(p?.mediaId ?? gid), galleryId: gid, cachedAt: p?.cachedAt || now, size, ...made } });
  });
  library._s(`INSERT INTO files (gid, path, format, state, packed_at, used_at) VALUES (?, ?, ?, 'packed', ?, ?)`).run(gid, g.rel, g.format, now, now);
  library._logIn(gid);
}

async function findLeftovers(root) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      if (/\.shiori-(tmp|old|new)$/.test(item.name)) out.push(abs);
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(abs, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

// Staged pages, cache files and a gallery folder's pictures no record refers to (a write that failed
// half way, or the app closed in the middle of one). A file written in the last few minutes is
// spared: its write may still be on its way to committing.
const ORPHAN_AGE_MS = 10 * 60 * 1000;
async function removeOrphans(library) {
  const staged = new Set(), cached = new Set();
  for (const r of library._s('SELECT orig, record FROM pages').all()) {
    const orig = parse(r.orig);
    if (orig?.at === 's') staged.add(orig.file);
    collect(parse(r.record), cached);
  }
  for (const r of library._s('SELECT record FROM covers').all()) collect(parse(r.record), cached);
  for (const r of library._s('SELECT file FROM staged_own').all()) staged.add(r.file);   // pictures waiting for their archive
  let removed = 0;
  const stale = async (file) => {
    const stat = await fsp.stat(file).catch(() => null);
    return !!stat && Date.now() - stat.mtimeMs >= ORPHAN_AGE_MS;
  };
  for (const [dir, keep] of [[library.stagingDir, staged], [library.cacheDir, cached]]) {
    for (const gid of await fsp.readdir(dir).catch(() => [])) {
      for (const name of await fsp.readdir(path.join(dir, gid)).catch(() => [])) {
        if (keep.has(`${gid}/${name}`)) continue;
        const file = path.join(dir, gid, name);
        if (!await stale(file)) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      fsp.rmdir(path.join(dir, gid)).catch(() => {});
    }
  }
  // Pictures in a gallery's folder made from its pages that no record refers to.
  for (const { gid } of library._s(`SELECT gid FROM files WHERE format = 'folder'`).all()) {
    const dir = library.files.folderOf(gid);
    const keep = new Set();
    for (const r of library._s('SELECT record FROM pages WHERE gid = ?').all(gid)) collect(parse(r.record), keep, '$own');
    collect(library._coverGet(gid), keep, '$own');
    for (const sub of DERIVED) {
      for (const name of await fsp.readdir(path.join(dir, ...sub.split('/'))).catch(() => [])) {
        const rel = `${sub}/${name}`;
        if (!IMAGE.test(name) || keep.has(rel) || !await stale(path.join(dir, ...rel.split('/')))) continue;
        await fsp.rm(path.join(dir, ...rel.split('/')), { force: true }).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}

// The `key` references (cache files by default, or a gallery's own files) in a value.
function collect(value, into, key = '$file') {
  if (value == null || typeof value !== 'object') return;
  if (typeof value[key] === 'string') { into.add(value[key]); return; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) collect(v, into, key);
}
