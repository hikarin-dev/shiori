// settings-optional.browser.mjs — Settings' optional panel as the one page draws it (src/routes/
// settings/optional.tsx), held to what 1.3's page gave: each table below has its record
// (records/settings-optional.browser.mjs.<table>.json, records.mjs), 1.3's behaviour as measured on
// 2026-11-24, which a deliberate change edits in the same commit. The panel is filled from outside the
// app; here by a stand-in filler written in the test: a few lines that put an element in the panel and
// name its nav entry by the contract (the shiori-app meta saying "settings", #settingsMount, its
// data-label). (The records were taken with the same filler written for 1.3's page: its panel and nav
// item.)
//
//   - Nothing filling it: the app's own download offer, under the app's name for the entry, as 1.3's;
//     in Firefox its own package, opened in the page's tab.
//   - Filled: the filler's name on the entry, the offer gone, the panel showing the filler's element
//     alone; emptied, the offer and the app's name back; emptied while the panel shows, Library shows
//     (as 1.3). A change of language. Nothing else moves when the panel is filled after the first paint.
//   - The mount: the same node before and after a panel switch, a language change and a preference
//     change; a new, empty one when the page is left and shown again, which leaves no observer or
//     listener behind.
//   - A filler written for 1.3's page (it looks for the meta saying "options", then for an element of
//     the class `content`) finds nothing to hook, and returns before touching anything.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/settings';
const FILE = 'settings-optional.browser.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const skip = (t) => { if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return true; } return false; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (page, fn, arg) => page.evaluate(fn, arg);

// The stand-in filler and what the test reads, installed in the page as window.__o: the mount.
function helpers() {
  const nav = () => document.getElementById('navOptional');
  const panel = () => document.getElementById('panelOptional');
  const shown = (el) => !!el && el.getClientRects().length > 0;
  window.__o = {
    fill: (label) => {
      const el = document.createElement('div');
      el.id = 'standIn';
      el.textContent = 'Stand-in card';
      const mount = document.getElementById('settingsMount');
      mount.append(el);
      mount.dataset.label = label;
    },
    empty: () => document.getElementById('standIn')?.remove(),
    // What shows: the entry (and its name), the panel shown, the offer, the panel's words.
    read: () => {
      // (The offer: in the panel and not hidden itself, whether or not the panel shows.)
      const link = panel().querySelector('a[href*="/releases/"]');
      const card = link?.closest('.section, [data-slot="card"]');
      const offer = card && !card.hidden ? card : null;
      const active = document.querySelector('.settings-panels > .panel.active');
      return {
        entry: shown(nav()) ? nav().textContent : null,
        shows: active === panel() ? 'optional' : active?.id ?? null,
        offer: offer && { title: offer.querySelector('h2').textContent,
          words: [...offer.querySelectorAll('[data-slot="setting-row"] [id$="-name"], [data-slot="setting-row"] [id$="-desc"]')].map((x) => x.textContent),
          button: link.textContent.trim(), href: link.getAttribute('href'), target: link.getAttribute('target'), rel: link.getAttribute('rel') },
        standIn: shown(document.getElementById('standIn')),
        // The panel's own words while it shows.
        text: active === panel() ? panel().innerText.trim() : null,
      };
    },
    show: () => nav().click(),
  };
}

async function open(t, path, { viewport, agent } = {}) {
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  if (agent) await page.setUserAgent(agent);
  if (viewport) await page.setViewport(viewport);
  await page.evaluateOnNewDocument(helpers);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('navStorage') && !!window.__o.read().entry && !!window.__o.read().offer, null, { what: 'Settings with its offer' });
  return page;
}

// The page: what `drive(page)` resolves, normalised (records.mjs), to compare with 1.3's record.
async function one(t, drive, opts) {
  const page = await open(t, NEW, opts);
  const seen = await drive(page);
  assert.deepEqual(page.problems, []);
  assert.deepEqual(page.refused, [], 'nothing asked of another address');
  return normalised(seen);
}

const read = (page) => run(page, () => window.__o.read());
const showOptional = (page) => until(page, () => { window.__o.show(); return window.__o.read().shows === 'optional'; }, null, { what: 'the optional panel shown' });

test('the offer, filled, emptied, emptied while it shows: the same entry, panel and offer as 1.3\'s page', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    const steps = {};
    steps.offer = await read(page);
    await showOptional(page);
    steps.offerShown = await read(page);
    await run(page, () => window.__o.fill('Stand-in'));
    await until(page, () => window.__o.read().standIn && window.__o.read().entry === 'Stand-in', null, { what: 'filled' });
    steps.filled = await read(page);
    await run(page, () => document.getElementById('navLibrary').click());
    await until(page, () => window.__o.read().shows === 'panelLibrary', null, { what: 'Library' });
    await run(page, () => window.__o.empty());
    await until(page, () => !!window.__o.read().entry && window.__o.read().entry !== 'Stand-in', null, { what: 'the app\'s name back' });
    steps.emptied = await read(page);
    await showOptional(page);
    steps.offerAgain = await read(page);
    // Filled again, then emptied while it shows.
    await run(page, () => window.__o.fill('Stand-in'));
    await until(page, () => window.__o.read().standIn, null, { what: 'filled again' });
    await showOptional(page);
    await run(page, () => window.__o.empty());
    await until(page, () => window.__o.read().shows !== 'optional', null, { what: 'another panel' });
    await pause(200);
    steps.emptiedShown = await read(page);
    return steps;
  });
  const was = record(FILE, 'steps');
  assert.deepEqual(now, was);
  const offer = { title: 'Extension', words: ['Download the extension', 'Unpack the zip, then load the folder as an unpacked extension in your browser.'], button: 'Download',
    href: 'https://github.com/hikarin-dev/shiori/releases/latest/download/extension.zip', target: '_blank', rel: 'noopener' };
  assert.deepEqual(was.offer, { entry: 'Extension', shows: 'panelLibrary', offer, standIn: false, text: null });
  assert.equal(was.offerShown.shows, 'optional');
  assert.deepEqual(was.filled, { entry: 'Stand-in', shows: 'optional', offer: null, standIn: true, text: 'Stand-in card' }, 'the filler\'s element alone');
  assert.deepEqual(was.emptied, { entry: 'Extension', shows: 'panelLibrary', offer, standIn: false, text: null });
  assert.deepEqual(was.emptiedShown, { entry: 'Extension', shows: 'panelLibrary', offer, standIn: false, text: null }, 'Library, the offer back');
});

test('in Firefox: its own package, opened in the page\'s own tab, and its own words', async (t) => {
  if (skip(t)) return;
  const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0';
  const now = await one(t, (page) => read(page), { agent });
  const was = record(FILE, 'firefox');
  assert.deepEqual(now, was);
  assert.deepEqual(was.offer.words, ['Download the extension', 'Firefox asks whether to let this site install it: choose Continue to Installation, then Add.']);
  assert.deepEqual([was.offer.href, was.offer.target, was.offer.rel], ['https://github.com/hikarin-dev/shiori/releases/latest/download/extension-firefox.xpi', null, null]);
});

test('a change of language: the app\'s name for the entry and the offer follow it; a filler\'s name stays its own', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await run(page, async () => (await import('/app/js/i18n.js')).setLang('ja'));
    await until(page, () => window.__o.read().entry !== 'Extension', null, { what: 'Japanese' });
    const offer = await read(page);
    await run(page, () => window.__o.fill('代わり'));
    await until(page, () => window.__o.read().entry === '代わり', null, { what: 'filled' });
    await run(page, async () => (await import('/app/js/i18n.js')).setLang('de'));
    await pause(300);
    const filled = await read(page);
    await run(page, () => window.__o.empty());
    await until(page, () => window.__o.read().entry !== '代わり', null, { what: 'emptied' });
    return { offer, filled, emptied: await read(page) };
  });
  const was = record(FILE, 'language');
  assert.deepEqual(now, was);
  assert.equal(was.offer.entry, '拡張機能');
  assert.equal(was.filled.entry, '代わり');
  assert.equal(was.emptied.entry, 'Erweiterung');
});

test('filled a moment after the first paint, nothing else moves: the entry\'s name and the panel\'s content alone', async (t) => {
  if (skip(t)) return;
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const page = await open(t, NEW, { viewport });
    const boxes = () => run(page, () => [...document.querySelectorAll('#settingsNav .nav-item, #panelLibrary > *, header *')]
      .map((el) => { const r = el.getBoundingClientRect(); return `${el.id || el.className}:${r.x},${r.y},${r.width},${r.height}`; }));
    const first = await boxes();
    const entry = await run(page, () => document.getElementById('navOptional').getBoundingClientRect().height);
    await run(page, () => window.__o.fill('Stand-in'));
    await until(page, () => window.__o.read().entry === 'Stand-in', null, { what: 'filled' });
    assert.deepEqual(await boxes(), first, `${viewport.width}: nothing moved`);
    assert.equal(await run(page, () => document.getElementById('navOptional').getBoundingClientRect().height), entry);
    assert.deepEqual(page.problems, []);
  }
});

test('the mount: the same node across a panel switch, a language change and a preference change; the meta says "settings"', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW);
  assert.equal(await run(page, () => document.querySelector('meta[name="shiori-app"]').content), 'settings');
  assert.equal(await run(page, () => { window.__mount = document.getElementById('settingsMount'); return window.__mount.childNodes.length; }), 0, 'empty');
  await run(page, () => window.__o.fill('Stand-in'));
  const same = () => run(page, () => document.getElementById('settingsMount') === window.__mount && window.__mount.isConnected
    && window.__mount.firstChild?.id === 'standIn' && window.__mount.childNodes.length === 1 && window.__mount.dataset.label === 'Stand-in');
  assert.equal(await same(), true);
  await showOptional(page);
  await run(page, () => document.getElementById('navReader').click());
  await until(page, () => window.__o.read().shows === 'panelReader', null, { what: 'Reader' });
  assert.equal(await same(), true, 'after a panel switch');
  await run(page, async () => (await import('/app/js/i18n.js')).setLang('fr'));
  await pause(300);
  assert.equal(await same(), true, 'after a language change');
  await run(page, () => document.getElementById('navLibrary').click());
  await (await page.evaluateHandle(() => document.getElementById('libMergeSeries').parentElement.querySelector('[role="switch"]'))).click();
  await until(page, () => localStorage.getItem('shiori:libMergeSeries') === 'false', null, { what: 'stored' });
  assert.equal(await same(), true, 'after a preference change');
  assert.deepEqual(page.problems, []);
});

test('leaving and returning: a new, empty mount each time; no observer or listener left behind after five visits', async (t) => {
  if (skip(t)) return;
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(helpers);
  await page.evaluateOnNewDocument(() => {
    // Observers watching something, kept as they start and stop.
    const live = window.__observers = new Set();
    const MO = window.MutationObserver;
    window.MutationObserver = class extends MO {
      observe(...a) { live.add(this); return super.observe(...a); }
      disconnect() { live.delete(this); return super.disconnect(); }
    };
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate((to) => { const a = document.createElement('a'); a.href = to; a.id = 'toSettings'; document.body.append(a); }, NEW);
  const held = async () => {
    const cdp = await page.createCDPSession();
    const listeners = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort();
    };
    const out = { window: await listeners('window'), document: await listeners('document'),
      ...await page.evaluate(() => ({ observers: window.__observers.size, nodes: document.getElementsByTagName('*').length })) };
    await cdp.detach();
    return out;
  };
  const mounts = [];
  const visit = async (i, first) => {
    if (first) await page.$eval('#toSettings', (a) => a.click()); else await page.evaluate(() => history.forward());
    await until(page, () => !!document.getElementById('settingsMount') && document.querySelector('meta[name="shiori-app"]')?.content === 'settings', null, { what: 'Settings' });
    mounts.push(await run(page, () => { const m = document.getElementById('settingsMount'); const fresh = !(window.__seen ??= new Set()).has(m); window.__seen.add(m); return { fresh, empty: m.childNodes.length === 0 && !m.hasAttribute('data-label') }; }));
    await run(page, () => window.__o.fill('Stand-in'));
    await until(page, () => window.__o.read().entry === 'Stand-in', null, { what: 'filled' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsMount') && document.querySelector('meta[name="shiori-app"]')?.content === 'tasks', null, { what: `Tasks again (${i})` });
  };
  await visit(0, true);
  await pause(300);
  const first = await held();
  for (let i = 1; i <= 5; i++) await visit(i, false);
  await pause(300);
  assert.deepEqual(await held(), first, 'after five more visits, what is held is what it was after the first');
  assert.deepEqual(mounts, Array(6).fill({ fresh: true, empty: true }), 'a new, empty mount each visit');
  assert.deepEqual(page.problems, []);
});

test('a filler written for 1.3\'s page finds nothing to hook, and returns before touching anything', async (t) => {
  if (skip(t)) return;
  // Its entry: the meta saying "options", then an element of the class `content`, then nothing of its
  // own there yet. (The new page's grid still carries the class `content`: the meta stops it first.)
  const entry = () => {
    const touched = [];
    const watch = new MutationObserver((records) => touched.push(...records.map((r) => r.type)));
    watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const reached = (() => {
      if (!document.querySelector('meta[name="shiori-app"][content="options"]')) return 'stopped at the meta';
      const content = document.querySelector('.content');
      if (!content || document.getElementById('standInCards')) return 'stopped at the page';
      return 'hooked';
    })();
    return new Promise((resolve) => setTimeout(() => { watch.disconnect(); resolve({ reached, touched }); }, 100));
  };
  const page = await open(t, NEW);
  assert.deepEqual(await run(page, entry), { reached: 'stopped at the meta', touched: [] });
  assert.deepEqual(page.problems, []);
});
