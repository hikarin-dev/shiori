// folder-stale-view.test.mjs — the stale-view table (S31, review 8): every operation that writes into, moves,
// unpacks, archives into or deletes at a gallery's place, run on one app from a view of the gallery older than
// the folder's — the other app has published a generation of it naming a new picture (a translation of page 1)
// and a new title since this app last read it — on both apps, for each kind of gallery it applies to. One
// expectation for every row:
// - what the other app published still reads, on this app and on the other once it adds the folder the gallery
//   is now in, wherever that is — but where the person deleted the gallery here (their own deletion takes it);
// - no file a manifest there names is missing (none of the other app's deleted);
// - this app's own change is made on the folder's version (it reads, the other app's work with it), is reported
//   dropped ('changed-both'), or the operation was refused — never published over the other app's, never lost
//   unsaid.
// The forms of this app's older view (FORMS): its stamp from before the other app's publication; no stamp at all
// (an index from before stamps: the released version's, R8-1); and a stamp whose token the other app's next
// publication repeats with other content (a folder put back from an older copy, then published again at the same
// number by the same app: R8-2 — the same token text on 146199d, another since each publication carries an id).
//
// The code that does each operation on each app is in stale-view-operations.mjs (OPERATIONS, the same names as OPS
// here): the fitness tests (architecture-fitness.test.mjs, desktop/tests/architecture-fitness.test.mjs) fail when a
// function that writes or deletes at a gallery's place is neither one of them, a step of one, nor said to touch no
// version another app may have published. npm test runs one form of each row (they take turns); SHIORI_STALE_ALL=1
// runs every form (the close-out).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { OPERATIONS } from './stale-view-operations.mjs';

const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const THEIR_TITLE = 'By the other app', THEIRS = png(0, 77), MY_TITLE = 'By this app', MINE = png(0, 66);
const named = (english) => ({ english, japanese: '', pretty: '' });

// ── The galleries ──
// Each kind made in folder F, held by this app (`c.A`) and read by it, the other app (`c.B`) holding no folder:
// `c.idA` folder F's id here, `c.gid` the gallery.
const KINDS = {
  'a folder': async (c) => {
    c.idA = await c.A.add(c.F);
    await c.A.setDefault(c.idA);
    c.gid = await c.A.newGallery('Alpha');
    for (let n = 1; n <= 2; n++) await c.A.putPage(c.gid, n, png(0, n));
    await c.A.flush();
  },
  // The desktop keeps it in an archive (archive mode); the website reads such an archive in place (the desktop
  // made it, and let the folder go).
  'an archive': async (c) => {
    const maker = c.A.app === 'desktop' ? c.A : c.B;
    const id = await maker.add(c.F);
    await maker.setDefault(id);
    c.gid = await maker.newGallery('Alpha');
    for (let n = 1; n <= 2; n++) await maker.putPage(c.gid, n, png(0, n));
    await maker.flush();
    await maker.raw.archiveGallery(c.gid);
    await maker.flush();
    if (maker === c.A) { c.idA = id; return; }
    await maker.setDefault(maker.home);
    await maker.remove(id);
    c.idA = await c.A.add(c.F);
    await c.A.setDefault(c.idA);
    await c.A.scan(c.idA);
  },
  // A linked ZIP: read where it is, Shiori's additions in its overlay.
  'a linked overlay': async (c) => {
    fs.mkdirSync(c.F, { recursive: true });
    fs.writeFileSync(path.join(c.F, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(0, 1) }, { name: '002.png', data: png(0, 2) }]));
    c.idA = await c.A.add(c.F);
    await c.A.setDefault(c.idA);
    await c.A.scan(c.idA);
    [c.gid] = (await c.A.galleries()).map(String);
  },
  // A series' second gallery (the desktop keeps a series' members in its folder; the website where they are).
  'a series member': async (c) => {
    await KINDS['a folder'](c);
    c.owner = await c.A.newGallery('One');
    await c.A.putPage(c.owner, 1, png(0, 9));
    await c.A.raw.seriesCommand('write', c.owner, [{ id: c.owner, title: 'One' }, { id: c.gid, title: 'Two' }], { seriesTitle: named('Saga') });
    await c.A.flush();
  },
};
const ALL_KINDS = Object.keys(KINDS);

// ── The operations ──
// `run(c)`: the operation, made right after this app took the folder back, before any check reads the gallery
// again; `before(c)`: what it needs set up before the other app's publication (a change waiting here, a deletion
// owed, a second folder); `mine(c)`: whether this app's own change reads now (null: it makes none, or none can be
// told: the folder it was in removed); `where`: where the gallery is afterwards ('F', 'F2', 'home'); `deletes`:
// the person's own deletion; `restart`: the operation is a start (no take-back first). `kinds`, `apps`: what it
// applies to (the functions that do it, per app: stale-view-operations.mjs OPERATIONS).
const away = async (c, fn) => {   // `fn` made while folder F's drive is away: what it changes waits
  fs.renameSync(c.F, `${c.F}.away`);
  try { await fn(); await c.A.flush(); } finally { fs.renameSync(`${c.F}.away`, c.F); }
};
const secondFolder = async (c) => { c.idA2 = await c.A.add(c.F2); };
const titled = async (c) => await c.A.titleOf(c.gid) === MY_TITLE;
const OPS = {
  'a title': {
    run: (c) => c.A.setTitle(c.gid, MY_TITLE), mine: titled,
  },
  'a translation': {
    run: (c) => c.A.putTranslation(c.gid, 2, MINE), mine: async (c) => same(await c.A.read(c.gid, 2, 'translated'), MINE),
  },
  'a page added': {
    kinds: ['a folder', 'an archive', 'a series member'],
    run: (c) => c.A.putPage(c.gid, 3, MINE), mine: async (c) => same(await c.A.read(c.gid, 3), MINE),
  },
  'a change waiting from the drive\'s absence, published at the take-back': {
    before: (c) => away(c, () => c.A.setTitle(c.gid, MY_TITLE)), run: () => {}, mine: titled,
  },
  'the person\'s deletion': {
    run: (c) => c.A.deleteGallery(c.gid), mine: null, deletes: true,
  },
  'a deletion owed from before': {
    before: async (c) => {
      const inF = (p) => String(p).replaceAll('\\', '/').toLowerCase().startsWith(c.F.split(path.sep).join('/').toLowerCase());
      // The deletion's deletes refused — or, a linked gallery's, the note of its source removed — until the take-back.
      c.undo = c.A.app === 'website'
        ? fsa.failNext((x) => x.op === 'removeEntry' || (x.op === 'createWritable' && x.path.endsWith('removed.json')), 'NoModificationAllowedError', { times: 1e6 })
        : faults.failNext((x) => (['rm', 'unlink', 'rmdir'].includes(x.op) && inF(x.path)) || (x.op === 'open' && x.path.includes('removed.json')), 'EBUSY', { times: 1e6 });
      await c.A.deleteGallery(c.gid);
      await c.A.flush();
    },
    run: () => {}, mine: () => false,   // dropped: the gallery back as the other app left it, reported
  },
  'a move to another folder': {
    before: secondFolder, run: (c) => c.A.move(c.kind === 'a series member' ? c.owner : c.gid, c.idA2), mine: null, where: 'F2',
  },
  'a move into this library\'s own place': {
    run: (c) => c.A.move(c.kind === 'a series member' ? c.owner : c.gid, c.A.home), mine: null, where: 'home',
  },
  'a removal moving its galleries': {
    before: secondFolder,
    run: async (c) => { await c.A.setDefault(c.idA2); await c.A.remove(c.idA, { moveTo: c.idA2 }); }, mine: null, where: 'F2',
  },
  'a removal\'s write-back': {
    before: (c) => away(c, () => c.A.setTitle(c.gid, MY_TITLE)),
    run: async (c) => { await c.A.setDefault(c.A.home); await c.A.remove(c.idA); c.removed = true; }, mine: null,
  },
  'archiving': {
    apps: ['desktop'], kinds: ['a folder'],
    run: (c) => c.A.raw.archiveGallery(c.gid), mine: null,
  },
  'a regroup': {
    apps: ['desktop'], kinds: ['a folder'],
    before: async (c) => { c.owner = await c.A.newGallery('Zero'); await c.A.putPage(c.owner, 1, png(0, 9)); await c.A.flush(); },
    run: (c) => c.A.raw.seriesCommand('write', c.owner, [{ id: c.owner, title: 'Zero' }, { id: c.gid, title: 'Alpha' }], { seriesTitle: named('Saga') }),
    mine: async (c) => String((await c.A.meta(c.gid))?.parentId ?? '') === String(c.owner),
  },
  // The app started again with that change waiting — a start doesn't take a folder another app used back by itself:
  // "Take back" follows, as the person makes it.
  'a start with work left over': {
    before: (c) => away(c, () => c.A.setTitle(c.gid, MY_TITLE)), restart: true,
    run: () => {}, mine: titled,
  },
};
const FORMS =['a stamp from before', 'no stamp', 'the same number again after an older copy'];

// This app's stamp of gallery `gid` taken away, as an index from before stamps has none (nothing else of it changed).
async function unstamp(lib, gid) {
  if (lib.app === 'desktop') { lib.raw._s('DELETE FROM stamps WHERE gid = ?').run(String(gid)); return; }
  const db = await new Promise((res, rej) => { const r = indexedDB.open('shiori-cache'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction('galleries', 'readwrite');
      const store = tx.objectStore('galleries');
      const got = store.get(String(gid));
      got.onsuccess = () => { if (got.result) { const { stamp, ...rest } = got.result; store.put(rest); } };
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
// The other app uses folder F anyway, `change`s it there and lets it go.
async function useAnyway(c, change) {
  const id = await c.B.add(c.F, { force: true });
  await c.B.scan(id);
  await change();
  await c.B.flush();
  await c.B.setDefault(c.B.home);
  await c.B.remove(id);
  clockAhead(CLAIM_TTL_MS + 1000);
}
// `lib`'s checks of folder `id` (each with a flush after) until gallery `gid` shows `title` — the website reads
// another app's work of a gallery it is busy with at a later check (§8, S26a) — at most ten.
async function caughtUp(lib, id, gid, title) {
  for (let i = 0; i < 10; i++) {
    await lib.scan(id);
    await lib.flush();
    if (await lib.titleOf(gid) === title) return true;
    await sleep(500);
  }
  return false;
}
// The files the manifests of folder `F`'s galleries (and their linked overlays) name that aren't there.
function namedMissing(F) {
  const out = [];
  const look = (dir, manifest) => {
    if (!fs.existsSync(manifest)) return;
    const { files } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const all = [...Object.values(files.pages).flatMap(p => [p.original, p.translated, p.studyBg, ...(p.studyText || []), p.masks?.raw, p.masks?.text]), ...Object.values(files.covers)];
    for (const f of all) if (f && !fs.existsSync(path.join(dir, ...f.split('/')))) out.push(`${path.relative(F, dir)}/${f}`);
  };
  if (!fs.existsSync(F)) return out;
  for (const e of fs.readdirSync(F, { recursive: true }).map(String)) {
    if (e.endsWith(`${path.sep}.shiori${path.sep}gallery.json`) || e === `.shiori${path.sep}gallery.json`) look(path.join(F, path.dirname(path.dirname(e))), path.join(F, e));
    else if (/[\\/]\.shiori[\\/]linked[\\/][^\\/]+[\\/]gallery\.json$/.test(e)) look(path.join(F, path.dirname(e)), path.join(F, e));
  }
  return out;
}

// Whether a manifest in folder `F` (a gallery's own, or a linked overlay's) names gallery `gid`.
const namesIt = (F, gid) => fs.existsSync(F) && fs.readdirSync(F, { recursive: true }).map(String)
  .some(e => /(^|[\\/])(\.shiori[\\/]gallery\.json|\.shiori[\\/]linked[\\/][^\\/]+[\\/]gallery\.json)$/.test(e)
    && JSON.parse(fs.readFileSync(path.join(F, e), 'utf8')).galleryId === String(gid));

// One row: operation `op` on app `A`, gallery kind `kind`, this app's older view in form `form`.
async function row({ dir, A, B, op: name, kind, form }) {
  const op = OPS[name];
  const c = { A, B, F: path.join(dir, 'F'), F2: path.join(dir, 'F2'), kind, idA: '', idA2: '', gid: '', owner: '', undo: () => {}, removed: false };
  await KINDS[kind](c);
  if (form === 'the same number again after an older copy') {
    // The person's copy of the folder; the other app publishes a generation, this app reads it; the copy put back.
    fs.cpSync(c.F, `${c.F}.copy`, { recursive: true, preserveTimestamps: true });
    await useAnyway(c, async () => { await B.setTitle(c.gid, 'First by the other app'); await B.putTranslation(c.gid, 1, png(0, 76)); });
    assert.equal(await A.raw.folderClaim(c.idA), 'granted');
    assert.ok(await caughtUp(A, c.idA, c.gid, 'First by the other app'), 'this app read the other app\'s first publication');
    await op.before?.(c);
    fs.rmSync(c.F, { recursive: true, force: true });
    fs.renameSync(`${c.F}.copy`, c.F);
  } else {
    await op.before?.(c);
    if (form === 'no stamp') await unstamp(A, c.gid);
  }
  // The other app publishes a generation naming a new picture and a new title — the same number again, after the
  // older copy: it reads that copy as it uses the folder.
  await useAnyway(c, async () => { await B.setTitle(c.gid, THEIR_TITLE); await B.putTranslation(c.gid, 1, THEIRS); });
  c.undo();
  if (op.restart) await A.restart();
  assert.equal(await A.raw.folderClaim(c.idA), 'granted', 'taken back');
  const refused = await Promise.resolve().then(() => op.run(c)).then(() => null, (e) => e?.reason || e?.code || String(e));
  await A.flush();
  // This app's checks of the folders it still has (wherever the gallery is now: an operation refused leaves it
  // where it was, the other app may have unpacked it beside its archive) until it reads the other app's work.
  // A dropped deletion's gallery joins again at the check after the one that met it (S29a's rule 3); the person's
  // deletion is judged once it is done (a check tries one owed again).
  const held = async () => (await A.list()).filter(f => f.id === c.idA || f.id === c.idA2).map(f => f.id);
  const settled = async () => (op.deletes ? !namesIt(c.F, c.gid)
    : (await A.galleries()).includes(c.gid) && await A.titleOf(c.gid) === THEIR_TITLE);
  for (let i = 0; i < 10 && (await held()).length && !await settled(); i++) {
    for (const id of await held()) await A.scan(id);
    await A.flush();
    await sleep(500);
  }
  const attention = (await A.list()).flatMap(f => f.attention ?? []).filter(a => a.reason === 'changed-both');
  const kept = (await A.galleries()).includes(c.gid);
  if (op.deletes) assert.ok(!kept, 'the person\'s deletion takes it here');
  else if (kept) {
    assert.deepEqual([await A.titleOf(c.gid), same(await A.read(c.gid, 1, 'translated'), THEIRS)], [THEIR_TITLE, true], 'the other app\'s work reads here');
    if (op.mine) assert.ok(await op.mine(c) || attention.some(a => String(a.gid) === String(c.gid)) || refused != null,
      `this app's change is on the folder's version, reported dropped, or refused (refused: ${refused})`);
  } else assert.ok(c.removed || name === 'a removal moving its galleries', 'only a folder\'s removal lets it go here');
  for (const f of [c.F, c.F2]) assert.deepEqual(namedMissing(f), [], `every file a manifest names is in ${path.basename(f)}`);
  // The other app adds the folders the gallery may be in: what it published reads in the one it is in — none of
  // it deleted; nothing of it, where the person deleted it here.
  await A.setDefault(A.home);
  for (const id of await held()) await A.remove(id).catch(() => A.remove(id, { discard: true }));
  const seen = [];
  for (const at of [c.F, c.F2].filter(f => fs.existsSync(f))) {
    const id = await B.add(at, { force: true });
    await B.scan(id);
    if ((await B.galleries()).includes(c.gid)) seen.push([await B.titleOf(c.gid), same(await B.read(c.gid, 1, 'translated'), THEIRS)]);
    await B.setDefault(B.home);
    await B.remove(id);
  }
  if (op.deletes) assert.deepEqual(seen, [], 'deleted there too');
  else if (op.where !== 'home' || !kept) assert.deepEqual(seen, [[THEIR_TITLE, true]], 'the other app reads its work where the gallery is');
}

// The rows: every operation, on each app it applies to, for each kind it applies to, in each form — in npm test
// one form a row, taking turns.
const ALL = !!process.env.SHIORI_STALE_ALL;
const ROWS = [];
for (const [name, op] of Object.entries(OPS)) {
  for (const app of op.apps ?? ['desktop', 'website']) {
    for (const kind of op.kinds ?? ALL_KINDS) ROWS.push({ op: name, app, kind });
  }
}
const PDF = 'a PDF\'s first drawing';
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
test('the table runs every operation stale-view-operations.mjs names, on the apps it names them for', { skip }, () => {
  assert.deepEqual(Object.keys(OPERATIONS).sort(), [...Object.keys(OPS), PDF].sort());
  for (const [name, op] of Object.entries(OPS)) assert.deepEqual(Object.keys(OPERATIONS[name]).sort(), [...(op.apps ?? ['desktop', 'website'])].sort(), name);
});
describe('the stale-view table', () => {
  ROWS.forEach((r, i) => {
    for (const [f, form] of FORMS.entries()) {
      if (!ALL && f !== i % FORMS.length) continue;
      test(`${r.op} — on the ${r.app}, ${r.kind}, ${form}`, { skip }, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-stale-'));
        const desktop = await desktopLibrary(path.join(dir, 'desktop'));
        const website = await webLibrary();
        t.after(async () => { faults.reset(); fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
        const [A, B] = r.app === 'desktop' ? [desktop, website] : [website, desktop];
        await row({ dir, A, B, op: r.op, kind: r.kind, form });
      });
    }
  });
});

// A PDF waiting here, drawn by the other app as it used the folder anyway — it joined there, and the other app
// published a new title and a translation of page 1 — then drawn here from this app's view of it as waiting (no
// check here read the folder since): the folder's version stands — the gallery joins as the other app left it —
// none of the other app's pictures deleted or written over; the other app reads its work there.
describe(`${PDF} from a view older than the folder's`, () => {
  for (const app of ['desktop', 'website']) {
    test(`on the ${app}`, { skip }, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-stale-'));
      const desktop = await desktopLibrary(path.join(dir, 'desktop'));
      const website = await webLibrary();
      t.after(async () => { faults.reset(); fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      const [A, B] = app === 'desktop' ? [desktop, website] : [website, desktop];
      const c = { A, B, F: path.join(dir, 'F') };
      fs.mkdirSync(c.F, { recursive: true });
      fs.writeFileSync(path.join(c.F, 'Doc.pdf'), '%PDF-1.4 a document');
      const idA = await A.add(c.F);
      await A.setDefault(idA);
      await A.scan(idA);
      const [w] = await A.pdfsWaiting();
      const { token } = await A.pdfSource(w.folder, w.gid);
      await useAnyway(c, async () => {
        const [v] = await B.pdfsWaiting();
        const gid = await B.addRendered(v.folder, v.gid, [png(0, 1), png(0, 2)], (await B.pdfSource(v.folder, v.gid)).token);
        await B.flush();
        await B.setTitle(gid, THEIR_TITLE);
        await B.putTranslation(gid, 1, THEIRS);
      });
      assert.equal(await A.raw.folderClaim(idA), 'granted', 'taken back');
      await A.addRendered(w.folder, w.gid, [MINE, MINE], token).catch(() => null);
      await A.flush();
      assert.deepEqual(namedMissing(c.F), [], 'every file a manifest names is there');
      assert.ok(await caughtUp(A, idA, w.gid, THEIR_TITLE), 'the other app\'s work reads here');
      assert.deepEqual([same(await A.read(w.gid, 1), png(0, 1)), same(await A.read(w.gid, 1, 'translated'), THEIRS)], [true, true], 'its pictures as the other app drew them');
      await A.setDefault(A.home);
      await A.remove(idA);
      const id = await B.add(c.F, { force: true });
      await B.scan(id);
      assert.deepEqual([await B.titleOf(w.gid), same(await B.read(w.gid, 1), png(0, 1)), same(await B.read(w.gid, 1, 'translated'), THEIRS)], [THEIR_TITLE, true, true], 'the other app reads its work');
    });
  }
});
