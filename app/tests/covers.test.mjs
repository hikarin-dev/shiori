// covers.test.mjs — the library's covers (src/lib/covers.ts) and its sources' icons
// (src/lib/source-icons.ts), each in a world of its own: what is asked for, when, with what; what an
// answer or a push keeps and drops; the session's cache read and written in 1.3's form; and the
// icons' questions asked once at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverCacheKey, coverTier, createCoverStore, SESSION_KEY } from '../../src/lib/covers.ts';
import { createIconStore } from '../../src/lib/source-icons.ts';

// A world: rpc calls kept, control messages and resizes sent by hand, timers run by hand.
function world({ width = 1280, dpr = 1, session = {}, canDownload = () => false } = {}) {
  const asked = [], timers = new Map(), stored = { ...session };
  let control = null, resize = null, next = 1;
  const view = { innerWidth: width, devicePixelRatio: dpr };
  const empty = [];
  const covers = createCoverStore({
    rpc: (msg) => { asked.push(msg); },
    onControl: (cb) => { control = cb; return () => { control = null; }; },
    canDownload,
    viewport: () => view,
    onResize: (cb) => { resize = cb; return () => { resize = null; }; },
    session: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } },
    onEmptyCover: (gid) => empty.push(gid),
    timers: { setTimeout: (fn, ms) => { const h = next++; timers.set(h, { fn, ms }); return h; }, clearTimeout: (h) => { timers.delete(h); } },
  });
  const run = () => { for (const [h, { fn }] of [...timers]) { timers.delete(h); fn(); } };
  return { covers, asked, stored, empty, view, run, send: (msg) => control?.(msg), resized: () => resize?.(), get following() { return !!control && !!resize; } };
}

const g = (id, more = {}) => ({ id, source: '', count: 3, ...more });

test('the tier asked for is the smallest at least a fifth of the window in device pixels, as 1.3\'s', () => {
  for (const [w, dpr, tier] of [[1280, 1, 256], [1281, 1, 384], [1920, 1, 384], [1921, 1, 512], [1280, 1.25, 384], [1280, 2, 512], [2560, 2, 1024], [9000, 3, 1024], [390, 3, 256]]) {
    const old = [256, 384, 512, 768, 1024].find((t) => t >= Math.ceil((w / 5) * (dpr || 1))) ?? 1024;
    assert.equal(coverTier({ innerWidth: w, devicePixelRatio: dpr }), tier);
    assert.equal(tier, old);
  }
  assert.equal(coverCacheKey(17, true), '17:series');
  assert.equal(coverCacheKey('17', false), '17:gallery');
});

test('what is asked for: a gallery with pages, a merged series with pages in its chapters, an empty one the helper can fill; never one kept', () => {
  const w = world({ canDownload: (x) => x.id === 'e2' });
  w.covers.start();
  w.covers.show([g('a'), g('s', { isSeries: true, count: 0, aggPages: 4 }), g('e1', { count: 0 }), g('e2', { count: 0, source: 'x' }), g('u', { count: undefined })], true);
  assert.deepEqual(w.asked, [
    { type: 'GET_COVER', galleryId: 'a', source: '', thumbWidth: 256, page: 'library', preferSeries: false },
    { type: 'GET_COVER', galleryId: 's', source: '', thumbWidth: 256, page: 'library', preferSeries: true },
    { type: 'GET_COVER', galleryId: 'e2', source: 'x', thumbWidth: 256, page: 'library', preferSeries: false },
  ]);
  // Unmerged, the series is its own chapter-1 gallery: no pages of its own, nothing asked.
  w.asked.length = 0;
  w.covers.show([g('s', { isSeries: true, count: 0, aggPages: 4 })], false);
  assert.deepEqual(w.asked, []);
  // An answer kept: not asked again.
  w.covers.show([g('a')], true);
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 'a', preferSeries: false, coverDataUrl: 'data:image/webp;base64,AA' });
  w.asked.length = 0;
  w.covers.show([g('a')], true);
  assert.deepEqual(w.asked, []);
  assert.equal(w.covers.get('a:gallery'), 'data:image/webp;base64,AA');
});

test('answers: another page\'s, a gallery not shown and the other role\'s are left; a role\'s answer drops the other; an empty gallery\'s says so', () => {
  const w = world();
  w.covers.start();
  let told = 0;
  w.covers.subscribe(() => told++);
  w.covers.show([g('s', { isSeries: true }), g('e', { count: 0 })], true);
  w.send({ type: 'COVER_READY', page: 'tasks', galleryId: 's', preferSeries: true, coverDataUrl: 'data:x' });
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 'nope', preferSeries: false, coverDataUrl: 'data:x' });
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 's', preferSeries: false, coverDataUrl: 'data:chapter' });
  assert.equal(w.covers.get('s:gallery'), null, 'a chapter\'s cover asked before it became a series is not taken');
  const before = told;
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 's', preferSeries: true, coverDataUrl: 'data:series' });
  assert.equal(w.covers.get('s:series'), 'data:series');
  assert.equal(told, before + 1, 'its readers told');
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 'e', preferSeries: false, coverDataUrl: 'data:e' });
  assert.deepEqual(w.empty, ['e']);
  // Invalidated: both roles dropped, asked again while shown.
  w.asked.length = 0;
  w.send({ type: 'COVER_INVALIDATED', galleryId: 's' });
  assert.equal(w.covers.get('s:series'), null);
  assert.deepEqual(w.asked.map((m) => [m.galleryId, m.preferSeries]), [['s', true]]);
  w.send({ type: 'COVER_INVALIDATED', galleryId: 'gone' });
  assert.equal(w.asked.length, 1, 'one not shown is not asked for');
});

test('the session\'s cache: read as the page starts (an entry from before roles as a gallery\'s own), written 800 ms after a change with the page\'s galleries only', () => {
  const w = world({ session: { [SESSION_KEY]: JSON.stringify({ a: 'data:old', 'b:series': 'data:b', 'z:gallery': 'data:z' }) } });
  w.covers.start();
  assert.equal(w.covers.get('a:gallery'), 'data:old');
  assert.equal(w.covers.get('a:series'), null);
  assert.equal(w.covers.get('b:series'), 'data:b');
  w.covers.show([g('a'), g('b', { isSeries: true })], true);
  assert.deepEqual(w.asked, [], 'what the session kept is not asked for');
  w.send({ type: 'COVER_READY', page: 'library', galleryId: 'a', preferSeries: false, coverDataUrl: 'data:new' });
  w.run();
  assert.deepEqual(JSON.parse(w.stored[SESSION_KEY]), { 'a:gallery': 'data:new', 'b:series': 'data:b' });
});

test('the window grown into another tier: every cover dropped and the page asked for again; shrunk, nothing', () => {
  const w = world({ width: 1280 });
  w.covers.start();
  w.covers.show([g('a'), g('b')], true);
  for (const id of ['a', 'b']) w.send({ type: 'COVER_READY', page: 'library', galleryId: id, preferSeries: false, coverDataUrl: `data:${id}` });
  w.run();
  w.asked.length = 0;
  w.view.innerWidth = 1000; w.resized(); w.run();
  assert.deepEqual(w.asked, [], 'smaller: the sharper covers kept');
  w.view.innerWidth = 1300; w.resized(); w.run();
  assert.deepEqual(w.asked.map((m) => [m.galleryId, m.thumbWidth]), [['a', 384], ['b', 384]]);
  assert.equal(w.covers.get('a:gallery'), null);
  assert.equal(w.stored[SESSION_KEY], undefined, 'the session\'s cache dropped with them');
  w.covers.stop();
  assert.equal(w.following, false, 'stopped: nothing followed');
});

test('icons: read from the library first, asked for once at a time, kept when given; warmed for every source of the site map', async () => {
  const asked = [], puts = [], gets = [];
  let answer = null;
  const icons = createIconStore({
    all: async () => [{ source: 'a', dataUrl: 'data:image/png;base64,A', url: 'https://a.example/i' }, { source: 'bad', dataUrl: 'nope' }],
    get: async (s) => { gets.push(s); return null; },
    put: async (s, rec) => { puts.push([s, rec.dataUrl]); },
    request: (msg) => { asked.push(msg); return new Promise((r) => { answer = r; }); },
    sources: () => ['a', 'b'],
    now: () => 1,
  });
  await icons.hydrate();
  assert.equal(icons.get('a'), 'data:image/png;base64,A');
  assert.equal(icons.get('bad'), '');
  icons.want('a');
  assert.deepEqual(asked, [], 'one kept is not asked for');
  icons.want('b'); icons.want('b');
  assert.deepEqual(gets, ['b']);
  assert.deepEqual(asked, [{ type: 'EXT_FETCH_ICON', source: 'b', have: null }], 'asked once while the question is open');
  answer({ ok: true, url: 'u', dataUrl: 'data:image/png;base64,B' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(icons.get('b'), 'data:image/png;base64,B');
  assert.deepEqual(puts, [['b', 'data:image/png;base64,B']]);
  asked.length = 0;
  icons.warm();
  assert.deepEqual(asked.map((m) => [m.source, m.have]), [['a', 'https://a.example/i'], ['b', 'u']]);
});
