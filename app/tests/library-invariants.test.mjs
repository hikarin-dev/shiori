// library-invariants.test.mjs — random sequences of the things that happen to a library, with the
// library's invariants (library-check.js) checked after every step.
//
// Writes that arrive over the bridge (download, capture, overwrite re-download, a recount racing a
// capture) go through the real paired agent, sent the way a client sends them: a gallery with no
// pages gets its metadata with its first stored page, an overwrite stores every page over its old
// copy and prunes leftovers only when complete. UI actions call what the library and overview
// pages call, through the library interface (api.js), so the same sequences can check any backend
// behind it. A download can die after any page. fast-check shrinks a failing sequence to a minimal
// one and prints it.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import fc from 'fast-check';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
const _listeners = [];
globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') _listeners.push(fn); } };
globalThis.window.parent = globalThis.window;
globalThis.location = new URL('http://localhost:5500/app/agent.html');

const api = await import('../js/api.js');
const { checkInvariants } = await import('../js/library-check.js');
const { exportFull, importBackup } = await import('../js/backup.js');
const { migrateTitle } = await import('../js/titles.js');
await import('../js/agent.js');

// ── A paired bridge session, as a client opens one ──
const SECRET = 'invariants-pairing-secret-0123456789';
_store.set('shiori:agentPairSecret', JSON.stringify(SECRET));
const port = await new Promise((resolve) => {
  const event = {
    data: { __shioriAgentHello: true, secret: SECRET },
    origin: 'chrome-extension://invariantstest',
    source: { postMessage: (msg, tgt, transfer) => { if (msg.__shioriAgentPaired) resolve(transfer[0]); } },
  };
  for (const fn of _listeners) fn(event);
});
const pending = new Map();
let nextId = 1;
port.addEventListener('message', (ev) => {
  const p = pending.get(ev.data?.id);
  if (!p) return;
  pending.delete(ev.data.id);
  if (ev.data.ok) p.resolve(ev.data.data); else p.reject(new Error(ev.data.error));
});
port.start?.();
test.after(() => { try { port.close(); } catch {} });
function op(name, data) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ id, op: name, data });
  });
}

// ── What a bridge client does ──
const bytes = (n) => new Uint8Array([n % 251, 7, 7]).buffer;
const metaFor = (gid, ref, pages) => ({
  galleryId: gid, sourceId: ref, source: 'test', title: { english: `G${ref}`, japanese: '', pretty: `G${ref}` },
  tags: [{ type: 'tag', name: `t${ref}`, url: '' }], numPages: pages, uploadDate: 1700000000,
});

// A download (or an overwrite re-download) of source `ref` with `pages` pages, failing after
// `diesAfter` stored pages: the run dies there, or (`continueOnError`, a flaky source) the
// remaining pages fail and the run still finishes with its recount.
async function download(ref, pages, { diesAfter = Infinity, ext = 'webp', overwrite = false, continueOnError = false } = {}) {
  const { gid } = await op('resolve_gid', { sourceRef: ref });
  const info = await op('gallery_info', { galleryId: gid });
  const meta = metaFor(gid, ref, pages);
  let held = null;
  if (info.count > 0) await op('meta_put', { meta }); else held = meta;
  const have = new Set(overwrite ? [] : (await op('existing_pages', { galleryId: gid })).pages);
  const stored = [];
  for (let n = 1; n <= pages; n++) {
    if (have.has(n)) continue;
    if (stored.length >= diesAfter) { if (continueOnError) break; return; }
    const url = `src://${ref}/${n}.${ext}`;
    const res = await op('store_page', { galleryId: gid, url, pageNum: n, bytes: bytes(n), mime: `image/${ext}`, ...(held ? { meta: held } : {}) });
    if (held && !res.metaStored) throw new Error('metadata not taken');
    held = null;
    stored.push(url);
  }
  const complete = stored.length + have.size >= pages;
  if (overwrite && complete && stored.length) await op('prune_pages', { galleryId: gid, keepUrls: stored });
  await op('rebuild', { galleryId: gid });
}

// One page captured while browsing source `ref`, then its metadata filled in.
async function capture(ref, n) {
  const { gid } = await op('resolve_gid', { sourceRef: ref });
  const url = `src://${ref}/${n}.webp`;
  if (!(await op('page_exists', { galleryId: gid, url, pageNum: n })).exists) {
    await op('store_page', { galleryId: gid, url, pageNum: n, bytes: bytes(n), mime: 'image/webp' });
  }
  const info = await op('gallery_info', { galleryId: gid });
  if (!info.meta || info.meta.isStub) await op('meta_put', { meta: metaFor(gid, ref, Math.max(n, 3)) });
}

// ── Picking targets from the live library ──
const pick = (list, k) => (list.length ? list[k % list.length] : null);
// Every gallery in the library (each one with a stat record), in id order.
async function entity(k, filter = () => true) {
  const all = (await api.galleries.page({ sort: 'id', dir: 'asc', limit: Infinity, merge: false })).filter(filter);
  return pick(all, k);
}

// ── Commands ──
class Step {
  constructor(name, args, act) { this.name = name; this.args = args; this.act = act; }
  check() { return true; }
  async run() {
    await this.act(...this.args);
    const report = checkInvariants(await api.maintenance.integritySnapshot());
    const errors = report.violations.filter(v => v.severity === 'error');
    if (errors.length) throw new Error(`after ${this}:\n${errors.map(v => `  ${v.id} ${v.gid ?? ''} ${v.detail}`).join('\n')}`);
  }
  toString() { return `${this.name}(${this.args.map(a => JSON.stringify(a)).join(', ')})`; }
}
const step = (name, arb, act) => arb.map(args => new Step(name, args, act));
const ref = fc.integer({ min: 1, max: 6 }).map(String);
const k = fc.nat(50);

const commands = [
  step('download', fc.tuple(ref, fc.integer({ min: 1, max: 4 }), fc.option(fc.nat(3), { nil: Infinity }), fc.boolean()),
    (r, pages, diesAfter, continueOnError) => download(r, pages, { diesAfter, continueOnError })),
  step('overwrite', fc.tuple(ref, fc.integer({ min: 1, max: 4 }), fc.option(fc.nat(3), { nil: Infinity }), fc.constantFrom('webp', 'jpg'), fc.boolean()),
    (r, pages, diesAfter, ext, continueOnError) => download(r, pages, { diesAfter, ext, overwrite: true, continueOnError })),
  // A real gallery with no pages yet — a series member listed before its download, or one restored
  // from a metadata-only backup.
  step('pagelessGallery', fc.tuple(ref, fc.boolean()), async (r, announced) => {
    const { gid } = await op('resolve_gid', { sourceRef: r });
    const info = await op('gallery_info', { galleryId: gid });
    if (info.meta && !info.meta.isStub) return;
    // What a series roster sync sends: grouping fields only, which create a zero entry if none exists.
    // A roster sync announces only the series owner, so a chapter's entry may never be announced.
    await op('gallery_batch', { metas: [metaFor(gid, r, 3)], mutations: [{ galleryId: gid, patch: { parentId: null } }], notifyGalleryIds: announced ? [gid] : [] });
  }),
  // A background pass (a series' chapter info) still writing after the gallery it writes for was
  // deleted: its late batch must not bring the gallery's metadata back.
  step('lateBatchWriteAfterDelete', fc.tuple(ref, fc.boolean()), async (r, asMutation) => {
    const { gid } = await op('resolve_gid', { sourceRef: r });
    await api.galleries.delete(gid);
    await op('gallery_batch', asMutation
      ? { mutations: [{ galleryId: gid, patch: { parentId: null } }], notifyGalleryIds: [gid] }
      : { metas: [metaFor(gid, r, 3)], notifyGalleryIds: [gid] });
  }),
  step('seriesTotalsWhileCapturing', fc.tuple(k, fc.integer({ min: 1, max: 6 })), async (i, n) => {
    const s = await entity(i, e => e.isSeries);
    if (!s) return;
    const url = `own://${s.id}/${n}.webp`;
    await Promise.all([
      api.series.refreshTotals(s.id),
      op('store_page', { galleryId: s.id, url, pageNum: n, bytes: bytes(n), mime: 'image/webp' }),
    ]);
  }),
  step('capture', fc.tuple(ref, fc.integer({ min: 1, max: 5 })), capture),
  step('recountWhileCapturing', fc.tuple(ref, fc.integer({ min: 1, max: 6 })), async (r, n) => {
    const { gid } = await op('resolve_gid', { sourceRef: r });
    await Promise.all([
      op('rebuild', { galleryId: gid }),
      op('store_page', { galleryId: gid, url: `src://${r}/${n}.webp`, pageNum: n, bytes: bytes(n), mime: 'image/webp' }),
    ]);
  }),
  // The library's delete button: a series card deletes every chapter; in the unmerged view a
  // series member goes through removeChapter; anything else is a plain delete.
  step('deleteCard', fc.tuple(k, fc.boolean()), async (i, merged) => {
    const g = await entity(i, e => !merged || !e.parentId);
    if (!g) return;
    if (merged && g.isSeries) { await api.series.delete(g.id); return; }
    if (g.isSeries || g.parentId) await api.series.remove(String(g.parentId || g.id), g.id, { deleteImages: true });
    else await api.galleries.delete(g.id);
  }),
  step('merge', fc.tuple(k, k), async (a, b) => {
    const owner = await entity(a, e => !e.parentId);
    const child = await entity(b, e => !e.parentId);
    if (!owner || !child || owner.id === child.id) return;
    await api.series.attach(owner.id, child.id).catch(() => {});   // refused merges show a toast
  }),
  step('detachChapter', fc.tuple(k), async (i) => {
    const c = await entity(i, e => !!e.parentId);
    if (c) await api.series.remove(c.parentId, c.id, { deleteImages: false });
  }),
  step('reorder', fc.tuple(k, fc.nat(5)), async (i, rot) => {
    const s = await entity(i, e => e.isSeries);
    if (!s) return;
    const ids = s.chapters.map(c => c.id);
    await api.series.reorder(s.id, [...ids.slice(rot % ids.length), ...ids.slice(0, rot % ids.length)]);
  }),
  step('favorite', fc.tuple(k), async (i) => {
    const g = await entity(i);
    if (g) await api.galleries.mutate(g.id, { favorite: !g.favorite });
  }),
  step('translatePage', fc.tuple(k, k), async (i, p) => {
    const g = await entity(i, e => e.count > 0);
    if (!g) return;
    const rec = pick(await api.pages.list(g.id), p);
    if (rec) await api.derived.putTranslatedImage(g.id, rec.pageNum, new Blob([new Uint8Array([9, 9])], { type: 'image/webp' }));
  }),
];

test('every step of any sequence keeps the library consistent', { timeout: 600000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 25 }), async (cmds) => {
    await api.maintenance.clearAll();
    await fc.asyncModelRun(() => ({ model: {}, real: {} }), cmds);
  }), { numRuns: Number(process.env.INVARIANT_RUNS) || 60 });
  assert.ok(true);
});

// Derived numbers (sizes, series totals) are refreshed by the app's own debounced timers. Once those
// have run, they must agree with what is stored, and nothing may be left behind (unreferenced
// images). Tolerated: duplicate page numbers after an interrupted overwrite (I13), pages captured
// before any metadata arrived (I14).
const TOLERATED = new Set(['I13', 'I14']);
async function settledWarnings() {
  let warnings = [];
  for (let waited = 0; waited <= 4000; waited += 250) {
    const report = checkInvariants(await api.maintenance.integritySnapshot());
    warnings = report.violations.filter(v => v.severity === 'warning' && !TOLERATED.has(v.id));
    if (!warnings.length) return [];
    await new Promise(r => setTimeout(r, 250));
  }
  return warnings;
}

test('once the app settles, derived numbers agree and nothing is left behind', { timeout: 600000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 20 }), async (cmds) => {
    await api.maintenance.clearAll();
    await fc.asyncModelRun(() => ({ model: {}, real: {} }), cmds);
    const warnings = await settledWarnings();
    if (warnings.length) throw new Error(warnings.map(v => `  ${v.id} ${v.gid ?? ''} ${v.detail}`).join('\n'));
  }), { numRuns: Number(process.env.SETTLED_RUNS) || 8 });
});

// A full backup restored after the library was lost gives back exactly what was there: every
// gallery the library holds anything for, placeholders included, as stored.
async function libraryState() {
  const out = {};
  for (const gid of (await api.transfer.ids()).sort()) {
    const { meta: stored, stat, pages: records } = await api.transfer.read(gid);
    const { fetchedAt, ...meta } = stored ? migrateTitle(stored) : {};   // canonical form
    const pages = [];
    for (const r of records.sort((a, b) => a.url.localeCompare(b.url))) {
      pages.push([r.url, [...new Uint8Array(await r.blob.arrayBuffer())], r.translated ? [...new Uint8Array(await r.translated.arrayBuffer())] : null]);
    }
    out[gid] = { meta, count: stat?.count ?? null, parentId: stat?.parentId || null, chapterCount: stat?.chapterCount ?? null, pages };
  }
  return out;
}

test('a full backup round-trips any library exactly', { timeout: 600000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: 15 }), async (cmds) => {
    await api.maintenance.clearAll();
    await fc.asyncModelRun(() => ({ model: {}, real: {} }), cmds);
    await settledWarnings();
    const before = await libraryState();
    const { archive } = await exportFull();
    await api.maintenance.clearAll();
    await importBackup(new File([archive], 'library.shioridb'));
    assert.deepEqual(await libraryState(), before);
    const errors = checkInvariants(await api.maintenance.integritySnapshot()).violations.filter(v => v.severity === 'error');
    assert.deepEqual(errors, []);
  }), { numRuns: Number(process.env.ROUNDTRIP_RUNS) || 8 });
});
