// agent-bridge.test.mjs — the privileged bridge serves only a paired session: an unpaired or
// wrong-origin caller gets no reply at all, ops travel only on the dedicated MessagePort, and
// the kv surface never exposes credentials or the pairing capability itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

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

await import('../js/agent.js');

const dispatch = (event) => { for (const fn of _listeners) fn(event); };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const SECRET = 'test-pairing-secret-0123456789abcdef';
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';
_store.set('shiori:agentPairSecret', JSON.stringify(SECRET));

const _openPorts = [];
test.after(() => { for (const p of _openPorts) { try { p.close(); } catch {} } });

function hello(origin, secret) {
  const replies = [];
  dispatch({
    data: { __shioriAgentHello: true, secret },
    origin,
    source: { postMessage: (msg, tgt, transfer) => replies.push({ msg, tgt, port: transfer?.[0] }) },
  });
  return replies;
}

function callOverPort(port, op, data) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      if (ev.data?.id !== id) return;
      port.removeEventListener('message', onMsg);
      resolve(ev.data);
    };
    port.addEventListener('message', onMsg);
    port.start?.();
    port.postMessage({ id, op, data });
    setTimeout(() => reject(new Error('no reply')), 2000);
  });
}

test('a wrong-origin caller gets no session even with the right secret', async () => {
  const replies = hello('https://evil.example.com', SECRET);
  await tick();
  assert.equal(replies.length, 0);
});

test('a wrong secret gets silence', async () => {
  const replies = hello(EXT_ORIGIN, 'not-the-secret-aaaaaaaaaaaaaaaa');
  await tick();
  assert.equal(replies.length, 0);
});

test('legacy ambient op messages are never answered', async () => {
  const replies = [];
  dispatch({
    data: { __shioriAgent: true, id: 1, op: 'kv_get', data: { keys: ['apiKey'] } },
    origin: EXT_ORIGIN,
    source: { postMessage: (msg) => replies.push(msg) },
  });
  await tick();
  assert.equal(replies.length, 0);
});

test('the paired session works over its port, and kv is allowlisted', async () => {
  _store.set('shiori:apiKey', JSON.stringify('k-123'));
  _store.set('shiori:translateSettings', JSON.stringify({ serverUrl: 'http://x', token: 'hush' }));

  const replies = hello(EXT_ORIGIN, SECRET);
  await tick();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].msg.__shioriAgentPaired);
  assert.equal(replies[0].tgt, EXT_ORIGIN);
  const port = replies[0].port;
  assert.ok(port, 'a MessagePort must be transferred');
  _openPorts.push(port);

  const kv = await callOverPort(port, 'kv_get', { keys: ['apiKey', 'translateSettings', 'agentPairSecret', 'cacheEnabled'] });
  assert.equal(kv.ok, true);
  assert.equal(kv.data.apiKey, 'k-123');
  assert.equal(kv.data.translateSettings, undefined, 'credentials must not be readable');
  assert.equal(kv.data.agentPairSecret, undefined, 'the pairing capability must not be readable');

  const has = await callOverPort(port, 'kv_has', { keys: ['translateSettings', 'agentPairSecret'] });
  assert.deepEqual(has.data, { translateSettings: true }, 'presence only, and never for the pairing secret');

  await callOverPort(port, 'kv_set', { values: { cacheEnabled: true, countsRepaired: 'evil', agentPairSecret: 'stolen' } });
  assert.equal(_store.get('shiori:cacheEnabled'), 'true');
  assert.equal(_store.has('shiori:countsRepaired'), false, 'non-allowlisted keys are dropped');
  assert.equal(JSON.parse(_store.get('shiori:agentPairSecret')), SECRET, 'the secret cannot be overwritten');

  const bad = await callOverPort(port, 'delete_gallery', { galleryId: '"><svg onload=alert(1)>' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid gallery id/);

  const largeRoster = Array.from({ length: 501 }, (_, i) => ({ id: String(i + 1) }));
  largeRoster[500].id = 'invalid-child';
  const checkedLargeRoster = await callOverPort(port, 'meta_put', {
    meta: { galleryId: '123', chapters: largeRoster },
  });
  assert.equal(checkedLargeRoster.ok, false);
  assert.match(checkedLargeRoster.error, /invalid gallery id/,
    'a roster above the per-message batch size must still validate every chapter id');

  const oversizedRoster = await callOverPort(port, 'meta_put', {
    meta: { galleryId: '123', chapters: Array.from({ length: 2001 }, (_, i) => ({ id: String(i + 1) })) },
  });
  assert.equal(oversizedRoster.ok, false);
  assert.match(oversizedRoster.error, /chapters exceeds the allowed size/);
});

test('a metadata write over the bridge keeps the record of how the gallery was translated', async () => {
  const api = await import('../js/api.js');
  const metaPut = api.meta.put, metaGet = api.meta.get;
  const translations = { j1: { at: 1, config: { render: { renderer: 'shiori_v2' } }, builds: { render: 'r1' } } };
  await metaPut({ galleryId: '4242', title: { english: 'Old', japanese: '', pretty: 'Old' }, tags: [], translations });

  const replies = hello(EXT_ORIGIN, SECRET);
  await tick();
  const port = replies[0].port;
  _openPorts.push(port);
  const res = await callOverPort(port, 'meta_put', { meta: { galleryId: '4242', title: { english: 'Fresh', japanese: '', pretty: 'Fresh' }, tags: [] } });
  assert.equal(res.ok, true);
  const meta = await metaGet('4242');
  assert.equal(meta.title.english, 'Fresh');
  assert.deepEqual(meta.translations, translations);
});

test('a metadata write over the bridge keeps the gallery a favorite', async () => {
  const api = await import('../js/api.js');
  const metaPut = api.meta.put, metaGet = api.meta.get;
  await metaPut({ galleryId: '4343', title: { english: 'Old', japanese: '', pretty: 'Old' }, tags: [], favorite: true });

  const replies = hello(EXT_ORIGIN, SECRET);
  await tick();
  const port = replies[0].port;
  _openPorts.push(port);
  const res = await callOverPort(port, 'meta_put', { meta: { galleryId: '4343', title: { english: 'Fresh', japanese: '', pretty: 'Fresh' }, tags: [] } });
  assert.equal(res.ok, true);
  assert.equal((await metaGet('4343')).favorite, true);
});

async function session() {
  const replies = hello(EXT_ORIGIN, SECRET);
  await tick();
  const port = replies[0].port;
  _openPorts.push(port);
  return port;
}
const pageBytes = () => new Uint8Array([1, 2, 3]).buffer;

test("a page can carry its own gallery's metadata — never another gallery's", async () => {
  const api = await import('../js/api.js');
  const metaPut = api.meta.put, metaGet = api.meta.get, galleryGet = api.galleries.get;
  await metaPut({ galleryId: '5151', favorite: true });   // a placeholder the user already favorited
  const port = await session();
  const title = { english: 'Arrived', japanese: '', pretty: 'Arrived' };

  const res = await callOverPort(port, 'store_page', {
    galleryId: '5151', url: 'src://5151/1.jpg', pageNum: 1, bytes: pageBytes(), mime: 'image/jpeg',
    meta: { galleryId: '5151', title, tags: [] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.metaStored, true, 'the caller learns the metadata was taken');
  const meta = await metaGet('5151');
  assert.equal(meta.title.english, 'Arrived');
  assert.equal(meta.favorite, true, 'app-only fields survive, as with meta_put');
  assert.equal((await galleryGet('5151')).count, 1);

  const crossed = await callOverPort(port, 'store_page', {
    galleryId: '5152', url: 'src://5152/1.jpg', pageNum: 1, bytes: pageBytes(), mime: 'image/jpeg',
    meta: { galleryId: '5151', title, tags: [] },
  });
  assert.equal(crossed.ok, false);
  assert.match(crossed.error, /another gallery/);
  assert.equal(await galleryGet('5152'), null, 'nothing is stored when the metadata is refused');
});

test('prune_pages keeps only the named pages, and never empties a gallery', async () => {
  const api = await import('../js/api.js');
  const getGalleryImageRecords = api.pages.all, galleryGet = api.galleries.get;
  const port = await session();
  for (const n of [1, 2, 3]) {
    await callOverPort(port, 'store_page', { galleryId: '5253', url: `src://5253/${n}.jpg`, pageNum: n, bytes: pageBytes(), mime: 'image/jpeg' });
  }
  const res = await callOverPort(port, 'prune_pages', { galleryId: '5253', keepUrls: ['src://5253/1.jpg', 'src://5253/2.jpg'] });
  assert.equal(res.ok, true);
  assert.equal(res.data.removed, 1);
  assert.deepEqual((await getGalleryImageRecords('5253')).map(r => r.url).sort(), ['src://5253/1.jpg', 'src://5253/2.jpg']);
  assert.equal((await galleryGet('5253')).count, 2);

  const empty = await callOverPort(port, 'prune_pages', { galleryId: '5253', keepUrls: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);
  assert.equal((await galleryGet('5253')).count, 2);
});

// A source's series sync that moves ownership (a new first chapter appeared) arrives as one batch:
// the old owner becomes a chapter, every chapter points at the new owner. Applied in any order, the
// library ends with one whole series.
test('a series sync that moves ownership leaves one whole series', async () => {
  const api = await import('../js/api.js');
  const { checkInvariants } = await import('../js/library-check.js');
  const port = await session();
  const ids = ['6001', '6002', '6003', '6004'];
  for (const gid of ids) {
    await callOverPort(port, 'store_page', { galleryId: gid, url: `src://${gid}/1.jpg`, pageNum: 1, bytes: pageBytes(), mime: 'image/jpeg',
      meta: { galleryId: gid, title: { english: gid, japanese: '', pretty: '' }, tags: [] } });
  }
  const ref = (gid) => ({ id: gid, title: gid });
  const roster = (owner, members) => [
    { galleryId: owner, patch: { parentId: null, chapters: members.map(ref) } },
    ...members.filter(g => g !== owner).map(g => ({ galleryId: g, patch: { parentId: owner, chapters: null } })),
  ];
  await callOverPort(port, 'gallery_batch', { mutations: roster('6002', ['6002', '6003', '6004']) });
  // 6001 is the new first chapter: the old owner's patch comes last in the batch.
  const moved = roster('6001', ids);
  const res = await callOverPort(port, 'gallery_batch', { mutations: [moved[0], ...moved.slice(2), moved[1]] });
  assert.equal(res.ok, true);
  assert.deepEqual((await api.meta.get('6001')).chapters.map(c => c.id), ids);
  for (const gid of ids.slice(1)) assert.equal((await api.meta.get(gid)).parentId, '6001', gid);
  const errors = checkInvariants(await api.maintenance.integritySnapshot()).violations.filter(v => v.severity === 'error' && ids.includes(v.gid));
  assert.deepEqual(errors, []);
});

test('the agent says where its library is, so its embedder can reach that library itself', async (t) => {
  const port = await session();
  // (Run as the desktop app's window — npm run test:desktop — this is a site's agent.)
  const desktopWindow = globalThis.shioriDesktop;
  delete globalThis.shioriDesktop;
  t.after(() => { if (desktopWindow) globalThis.shioriDesktop = desktopWindow; });
  assert.deepEqual((await callOverPort(port, 'library_location', {})).data, { kind: 'browser' });
  _store.set('shiori:libraryLocation', JSON.stringify({ kind: 'desktop', url: 'http://127.0.0.1:47153', token: 'site-token-0123456789abcdef' }));
  try {
    assert.deepEqual((await callOverPort(port, 'library_location', {})).data,
      { kind: 'desktop', url: 'http://127.0.0.1:47153', token: 'site-token-0123456789abcdef' });
    _store.set('shiori:libraryFallback', JSON.stringify({ since: Date.now() }));
    assert.deepEqual((await callOverPort(port, 'library_location', {})).data, { kind: 'browser' },
      'continuing in the browser for now, the library is this browser\'s');
  } finally {
    _store.delete('shiori:libraryLocation');
    _store.delete('shiori:libraryFallback');
  }
});
