// library-location.test.mjs — which library a page uses: the desktop app's window and the pages the
// desktop app serves at its own address say so themselves (a served page by the site's token it was
// handed in its address); a site's saved choice holds unless it continues in the browser for now.
import test from 'node:test';
import assert from 'node:assert/strict';

const _store = new Map();
globalThis.localStorage = { getItem: (k) => (_store.has(k) ? _store.get(k) : null), setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k) };
const { activeDesktop, servedLibrary, setLocation, setFallback } = await import('../js/library-location.js');

const at = (href) => { globalThis.location = new URL(href); };
// (Run as the desktop app's window — npm run test:desktop — these are a browser page's cases.)
const desktopWindow = globalThis.shioriDesktop;
test.beforeEach(() => { delete globalThis.shioriDesktop; });
test.afterEach(() => { delete globalThis.location; _store.clear(); if (desktopWindow) globalThis.shioriDesktop = desktopWindow; });

test('a page the desktop app serves uses the library whose token it was handed', () => {
  at('http://127.0.0.1:47154/app/agent.html#library=site-token-0123456789abcdef');
  assert.deepEqual(servedLibrary(), { url: 'http://127.0.0.1:47154', token: 'site-token-0123456789abcdef' });
  setLocation({ url: 'http://127.0.0.1:47153', token: 'another' });
  assert.deepEqual(activeDesktop(), { url: 'http://127.0.0.1:47154', token: 'site-token-0123456789abcdef', own: true },
    'its own address, whatever its storage says');
});

test('only a page at the desktop app\'s address, handed a token, is one', () => {
  for (const href of ['http://127.0.0.1:47153/app/agent.html', 'http://127.0.0.1:5500/app/agent.html#library=t',
    'https://127.0.0.1:47153/app/agent.html#library=t', 'http://localhost:47153/app/agent.html#library=t',
    'https://shiori.example/app/agent.html#library=t']) {
    at(href);
    assert.equal(servedLibrary(), null, href);
  }
});

test('a site uses its chosen desktop library unless it continues in the browser for now', () => {
  at('https://shiori.example/library');
  assert.equal(activeDesktop(), null);
  setLocation({ url: 'http://127.0.0.1:47153', token: 'site-token-0123456789abcdef' });
  assert.deepEqual(activeDesktop(), { kind: 'desktop', url: 'http://127.0.0.1:47153', token: 'site-token-0123456789abcdef' });
  setFallback(true);
  assert.equal(activeDesktop(), null);
});
