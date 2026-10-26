// source-links.browser.mjs — links out of the app, in Chrome. A chapter row's id opens the chapter's
// source page in a new tab (only for a safe http(s) source URL), and the About dialog's header has
// the project's repository link beside its close button, matching it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { a: '1790000000301', b: '1790000000302', c: '1790000000303' };
const SOURCE = 'https://example.com/g/301/';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed, { G, SOURCE });
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: a series of three chapters — one with a source URL, one without, and one whose
// stored URL must never become a link.
async function seed({ G, SOURCE }) {
  const api = await import('/app/js/api.js');
  const gallery = (gid, name, extra = {}) =>
    api.meta.put({ galleryId: gid, title: { english: name, japanese: '', pretty: '' }, tags: [], numPages: 1, ...extra });
  await gallery(G.a, 'Alpha', { sourceId: '301', sourceUrl: SOURCE });
  await gallery(G.b, 'Bravo');
  await gallery(G.c, 'Charlie', { sourceId: '303', sourceUrl: 'javascript:alert(1)' });
  await api.series.write(G.a, [{ id: G.a, title: '' }, { id: G.b, title: '' }, { id: G.c, title: '' }],
    { seriesTitle: { english: 'Series', japanese: '', pretty: '' }, seriesTags: [] });
}

async function finish(page) {
  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
}

test('a chapter row\'s id links to its source page in a new tab', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/overview.html?g=${G.a}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.ch-row .ch-meta').length === 3, null, { what: 'three chapter rows' });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.ch-row .ch-meta')].map((meta) => {
    const first = meta.firstElementChild;
    return { tag: first.tagName, text: first.textContent, href: first.getAttribute('href'),
      target: first.getAttribute('target'), rel: first.getAttribute('rel') };
  }));
  assert.deepEqual(ids, [
    { tag: 'A', text: '#301', href: 'https://example.com/g/301/', target: '_blank', rel: 'noopener noreferrer' },
    { tag: 'SPAN', text: `#${G.b}`, href: null, target: null, rel: null },
    { tag: 'SPAN', text: '#303', href: null, target: null, rel: null },
  ]);
  await finish(page);
});

test('the About dialog links to the repository beside its close button', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/settings.html`, { waitUntil: 'load' });
  await page.click('#aboutBtn');
  await until(page, () => document.getElementById('aboutModal').classList.contains('show'), null, { what: 'the About dialog' });
  const got = await page.evaluate(() => {
    const repo = document.getElementById('aboutRepo');
    const close = document.getElementById('aboutClose');
    const header = repo.closest('.about-header');
    const r = repo.getBoundingClientRect(), c = close.getBoundingClientRect(), h = header.getBoundingClientRect();
    return {
      href: repo.getAttribute('href'), target: repo.getAttribute('target'), label: repo.getAttribute('aria-label'),
      same: { w: r.width === c.width, h: r.height === c.height, top: r.top === c.top },
      before: r.right <= c.left,
      inHeader: r.top >= h.top && r.bottom <= h.bottom,
      icon: getComputedStyle(repo.querySelector('svg')).fill === getComputedStyle(repo).color,
    };
  });
  assert.deepEqual(got, {
    href: 'https://github.com/hikarin-dev/shiori', target: '_blank', label: 'GitHub',
    same: { w: true, h: true, top: true }, before: true, inHeader: true, icon: true,
  });
  await finish(page);
});
