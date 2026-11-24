// library-next-table.browser.mjs — the library as the one page draws it (/library-next) against 1.3's page
// (/library), both driven alike by their address over one seeded library: for each sort, a set of
// searches, the filter's states, pages (one past the end too), series merged or not, what each shows —
// the cards' ids in order, the totals, the paging's buttons (the current one, the ones that are off),
// the address it writes back — and the same after a reload; Back from Settings lands on what it showed.
// 1.3's page is the oracle: every row of the table is read from both and compared.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

// Runs in the page: 70 galleries of one to three pages of three sizes, three tags in turn, a category
// (manga, misc), a rating (safe, pornographic, none), a language for some, an artist for a few, every
// fifth translated, every seventh a favourite, a published date for half; and a series of three
// chapters.
async function seed() {
  const api = await import('/app/js/api.js');
  const png = async (hue, size) => {
    const canvas = new OffscreenCanvas(size, Math.round(size * 1.5));
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < canvas.height; y += 7) { ctx.fillStyle = `hsl(${(hue + y) % 360} 60% 50%)`; ctx.fillRect(0, y, canvas.width, 7); }
    return canvas.convertToBlob({ type: 'image/png' });
  };
  const RATINGS = ['safe', 'pornographic', null];
  for (let i = 0; i < 70; i++) {
    const gid = String(1790000002000 + i);
    const tags = [{ type: 'tag', name: `t${i % 3}` }, { type: 'category', name: i % 4 ? 'manga' : 'misc' }];
    if (RATINGS[i % 3]) tags.push({ type: 'rating', name: RATINGS[i % 3] });
    if (i % 2) tags.push({ type: 'language', name: i % 6 === 1 ? 'chinese (traditional)' : 'japanese' });
    if (i % 9 === 0) tags.push({ type: 'artist', name: i % 2 ? 'anna' : 'bob' });
    await api.meta.put({ galleryId: gid, title: { english: `Gallery ${i}`, japanese: '', pretty: '' }, tags, numPages: 1 + (i % 3),
      translated: i % 5 === 0, uploadDate: i % 2 ? 1700000000000 + ((i * 7919) % 97) * 86400000 : undefined });
    for (let n = 1; n <= 1 + (i % 3); n++) await api.pages.put(gid, n, await png(i * 13 + n, 40 + ((i * 31) % 5) * 20));
    if (i % 7 === 0) await api.personal.favorite(gid, true);
  }
  const S = ['1790000002100', '1790000002101', '1790000002102'];
  for (const [n, gid] of S.entries()) {
    await api.meta.put({ galleryId: gid, title: { english: `Series chapter ${n + 1}`, japanese: '', pretty: '' }, tags: [{ type: 'tag', name: 'series' }], numPages: 1 });
    await api.pages.put(gid, 1, await png(n * 50, 60));
  }
  await api.series.write(S[0], S.map((id, n) => ({ id, title: '', number: n + 1 })), { seriesTitle: { english: 'A series', japanese: '', pretty: '' }, seriesTags: [{ type: 'tag', name: 'series' }] });
}

// What a page shows once it has settled: the cards, the totals, the paging, the address.
const shown = () => {
  const paging = document.querySelector('#pagination ul')
    ? [...document.querySelectorAll('#pagination li')].map((li) => {
      const b = li.querySelector('button');
      return b ? `${b.textContent}${b.getAttribute('aria-current') === 'page' ? '*' : ''}${b.disabled ? '-' : ''}` : li.textContent;
    })
    : [...document.getElementById('pagination').children].map((el) => `${el.textContent}${el.classList.contains('active') ? '*' : ''}${el.disabled ? '-' : ''}`);
  const empty = document.querySelector('#grid > .empty');
  return {
    cards: [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId),
    empty: empty ? empty.textContent : null,
    totals: ['hTotalGalleries', 'hTotalImages', 'hTotalSize'].map((id) => document.getElementById(id)?.textContent),
    paging,
    address: location.search,
  };
};

async function settled(page) {
  await until(page, () => document.getElementById('hTotalGalleries')?.textContent !== '—'
    && !!(document.querySelector('#grid > .card') || document.querySelector('#grid > .empty')), null, { what: 'the grid and the totals' });
  let last = JSON.stringify(await page.evaluate(shown));
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const now = JSON.stringify(await page.evaluate(shown));
    if (now === last) return JSON.parse(now);
    last = now;
  }
}

// Opens `path` (from the site's root) with `storage` set first (shiori:* keys), and reads it.
async function read(page, path, storage = {}) {
  await page.evaluate((storage) => {
    for (const key of ['shiori:libFilter', 'shiori:libMergeSeries']) localStorage.removeItem(key);
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, JSON.stringify(v));
  }, storage);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return settled(page);
}

const SORTS = ['', 'updated', 'size', 'count', 'uploadDate'];
const enc = (q) => encodeURIComponent(q);
const TABLE = [
  ...SORTS.flatMap((sort) => ['', 'tag:"t1"'].map((q) => ({ query: [q && `q=${enc(q)}`, sort && `sort=${sort}`].filter(Boolean).join('&') }))),
  ...['gallery 1', 'favorite:"yes"', 'favorite:"no"', 'translated:"yes"', 'language:"chinese"', 'language:"japanese"', 'artist:an', 'nothing-is-called-this', 'category:"misc" t2', 'series', '17900000020']
    .map((q) => ({ query: `q=${enc(q)}` })),
  ...[{ rating: { safe: 'include' } }, { category: { misc: 'exclude' } }, { rating: { pornographic: 'exclude', safe: 'include' }, category: { manga: 'include' } }]
    .flatMap((filter) => ['', 'q=t0'].map((query) => ({ query, storage: { 'shiori:libFilter': filter } }))),
  { query: 'page=2' }, { query: 'page=3&sort=size' }, { query: 'page=9' }, { query: 'page=2&q=t1' }, { query: 'page=0' }, { query: 'page=abc&sort=count' },
  { query: '', storage: { 'shiori:libMergeSeries': false } }, { query: 'q=series', storage: { 'shiori:libMergeSeries': false } }, { query: 'page=3', storage: { 'shiori:libMergeSeries': false } },
];

test(`each of ${TABLE.length} rows shows on the new page what 1.3's page shows`, async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  const differ = [];
  let seen = 0;
  for (const row of TABLE) {
    const qs = row.query ? `?${row.query}` : '';
    const old = await read(page, `/library${qs}`, row.storage);
    const now = await read(page, `/library-next${qs}`, row.storage);
    if (JSON.stringify(old) !== JSON.stringify(now)) differ.push({ row, old, now });
    seen += old.cards.length;
    // A reload of the address it settled on shows the same.
    if (row.query.includes('page=')) {
      await page.reload({ waitUntil: 'load' });
      const again = await settled(page);
      if (JSON.stringify(again) !== JSON.stringify(now)) differ.push({ row, reloaded: true, now, again });
    }
  }
  assert.deepEqual(differ, []);
  assert.ok(seen > 400, `the table shows cards (${seen})`);
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('Back from Settings lands on what the page showed, on both pages', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  const out = {};
  for (const path of ['/library', '/library-next']) {
    const before = await read(page, `${path}?page=2&q=t1&sort=size`);
    await page.click('#settingsBtn');
    await until(page, () => location.pathname.endsWith('settings'), null, { what: 'Settings' });
    await page.goBack();
    await until(page, (path) => location.pathname === path, path, { what: 'back' });
    const after = await settled(page);
    assert.deepEqual(after, before, `${path}: Back lands on what it showed`);
    await page.goForward();
    await until(page, () => location.pathname.endsWith('settings'), null, { what: 'Forward to Settings' });
    await page.goBack();
    await until(page, (path) => location.pathname === path, path, { what: 'back again' });
    out[path] = await settled(page);
  }
  assert.deepEqual(out['/library-next'], out['/library']);
  assert.deepEqual(page.problems, []);
  await page.close();
});
