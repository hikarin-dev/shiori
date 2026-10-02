// smoke.browser.mjs — every page of the app, opened in Chrome against a small library, must render
// and leave nothing unhandled: no uncaught error, no unhandled rejection, no console error. Run
// with `npm run test:browser` (needs Chrome; CHROME_PATH to point at another build).
//
// The library: a plain gallery, a translated one with study layers (a reader opens it in its
// translate view, which reads the layers before showing the page), a series of two chapters, a
// pageless chapter and two volumes, and a card an import has reserved.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { plain: '1790000000101', translated: '1790000000102', a: '1790000000103', b: '1790000000104',
  shell: '1790000000105', reserved: '1790000000106', v1: '1790000000107', v2: '1790000000108' };

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed, G);
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: builds the library through the app's own interface.
async function seed(G) {
  const api = await import('/app/js/api.js');
  const png = async (hue) => {
    const canvas = new OffscreenCanvas(600, 900);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${hue} 60% 50%)`;
    ctx.fillRect(0, 0, 600, 900);
    return canvas.convertToBlob({ type: 'image/png' });
  };
  const title = (english) => ({ english, japanese: '', pretty: '' });
  const gallery = async (gid, name, pages, extra = {}) => {
    await api.meta.put({ galleryId: gid, title: title(name), tags: [{ type: 'tag', name: 'smoke', url: '' }], numPages: pages, ...extra });
    for (let n = 1; n <= pages; n++) await api.pages.put(gid, n, await png(n * 40));
  };
  await gallery(G.plain, 'Plain', 3);

  await gallery(G.translated, 'Translated', 2);
  for (const n of [1, 2]) {
    await api.derived.putTranslation(G.translated, n, { image: await png(200), pipeline: { job: 'job1',
      lines: [{ pts: [[10, 10], [200, 10], [200, 60], [10, 60]], score: 0.9, text: 'こんにちは' }],
      read: [0], regions: [{ lines: [0], tr: 'Hello' }] } });
    await api.derived.putStudy(G.translated, n, { bg: await png(210), page: { w: 600, h: 900 },
      bubbles: [{ id: 0, box: { x: 10, y: 10, w: 190, h: 50 }, region: { x: 10, y: 10, w: 190, h: 50 }, tr: 'Hello', src: 'こんにちは', text: await png(220) }] }, 'job1');
  }
  const meta = await api.meta.get(G.translated);
  await api.meta.put({ ...meta, translated: true, translations: { job1: { at: Date.now(), config: {} } } });

  await gallery(G.a, 'Chapter A', 2);
  await gallery(G.b, 'Chapter B', 2);
  await api.galleries.create(G.shell, { title: title('Chapter C'), numPages: 3 });
  await gallery(G.v1, 'Volume One', 2, { kind: 'volume' });
  await gallery(G.v2, 'Volume Two', 2, { kind: 'volume' });
  await api.series.write(G.a, [{ id: G.a, title: 'A', number: 1 }, { id: G.b, title: 'B', number: 2 }, { id: G.shell, title: 'C', number: 2.5 },
    { id: G.v1, title: '', number: 1, kind: 'volume' }, { id: G.v2, title: '', number: 2, kind: 'volume' }],
    { seriesTitle: title('Series'), seriesTags: [] });

  await api.galleries.create(G.reserved, { title: title('Importing'), isLocalImport: true });
}

const blobImages = () => document.querySelectorAll('img[src^="blob:"]').length;

async function visit(path, t) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}
async function finish(page) {
  await new Promise((r) => setTimeout(r, 500));   // let late work surface its errors
  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
}

test('the library shows every gallery, a series as one card', async (t) => {
  const page = await visit('/app/library.html', t);
  if (!page) return;
  const cards = await until(page, () => (document.querySelectorAll('.card').length >= 4 ? [...document.querySelectorAll('.card')].map(c => c.innerText) : 0), null, { what: 'four cards' });
  assert.equal(cards.length, 4);
  const series = cards.find(c => /Series/.test(c)) || '';
  assert.match(series, /\b2 chapters\b/, 'chapters 1 and 2; 2.5 is an extra');
  assert.doesNotMatch(series, /extras/, 'the card names no extras');
  assert.ok(cards.some(c => /Importing/.test(c)), 'the reserved card shows its title');
  await finish(page);
});

test('a gallery overview shows its pages', async (t) => {
  const page = await visit(`/app/overview.html?g=${G.plain}`, t);
  if (!page) return;
  await until(page, () => document.querySelectorAll('.ov-page img[src]').length === 3, null, { what: 'three page thumbnails' });
  await finish(page);
});

test('a series overview lists its chapters by their own numbers', async (t) => {
  const page = await visit(`/app/overview.html?g=${G.a}`, t);
  if (!page) return;
  const nums = await until(page, () => (document.querySelectorAll('.ch-row').length === 3 ? [...document.querySelectorAll('.ch-row .ch-num')].map(n => n.textContent) : 0), null, { what: 'three chapter rows' });
  assert.deepEqual(nums, ['1', '2', '2.5']);
  await finish(page);
});

test('the reader shows a gallery\'s pages', async (t) => {
  const page = await visit(`/app/reader.html?g=${G.plain}`, t);
  if (!page) return;
  await until(page, blobImages, null, { what: 'a page image' });
  assert.equal(await page.evaluate(() => /Loading cached pages/.test(document.body.innerText)), false);
  await finish(page);
});

test('the reader opens a translated gallery with its study layers', async (t) => {
  const page = await visit(`/app/reader.html?g=${G.translated}`, t);
  if (!page) return;
  await until(page, blobImages, null, { what: 'a page image' });
  await until(page, () => {
    const toggle = document.getElementById('viewToggle'), study = document.getElementById('studySeg');
    return toggle && toggle.style.display !== 'none' && study && !study.classList.contains('disabled');
  }, null, { what: 'the study view to be available' });
  await finish(page);
});

test('the reader reads a series across its chapters', async (t) => {
  const page = await visit(`/app/reader.html?g=${G.a}`, t);
  if (!page) return;
  await until(page, blobImages, null, { what: 'a page image' });
  const text = await until(page, () => (/Ch\. 2\b/.test(document.body.innerText) ? document.body.innerText : 0), null, { what: 'the second chapter' });
  assert.match(text, /Ch\. 1\b/);
  await finish(page);
});

test('settings open, and a full backup restores the library it was taken from', async (t) => {
  const page = await visit('/app/settings.html', t);
  if (!page) return;
  const result = await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const backup = await import('/app/js/backup.js');
    const state = async () => JSON.stringify(await Promise.all((await api.transfer.ids()).sort().map(async (gid) => {
      const { meta, stat, pages } = await api.transfer.read(gid);
      return [gid, meta?.title, meta?.chapters?.map(c => c.id), stat?.count ?? null, pages.length];
    })));
    const before = await state();
    window.showSaveFilePicker = undefined;   // the download path: the archive comes back as a Blob
    const { archive } = await backup.exportFull();
    await api.maintenance.clearAll();
    const cleared = (await api.transfer.ids()).length;
    await backup.importBackup(new File([archive], 'library.shioridb'));
    return { same: before === await state(), cleared };
  });
  assert.equal(result.cleared, 0);
  assert.equal(result.same, true);
  await finish(page);
});

test('a series lists its volumes apart, the choice is remembered, and a volume reads on its own', async (t) => {
  const page = await visit(`/app/overview.html?g=${G.a}`, t);
  if (!page) return;
  const rows = () => [...document.querySelectorAll('.ch-row')].map(r => r.querySelector('.ch-title-input').value);
  await until(page, () => document.querySelectorAll('.ch-row').length === 3, null, { what: 'the chapters listed first' });
  await page.click('[data-view="volumes"]');
  assert.deepEqual(await until(page, () => (document.querySelectorAll('.ch-row').length === 2 ? [...document.querySelectorAll('.ch-row')].map(r => r.querySelector('.ch-title-input').value) : 0), null, { what: 'the two volumes' }),
    ['Volume One', 'Volume Two']);
  await page.reload({ waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.ch-row').length === 2 && document.querySelector('[data-view="volumes"]')?.classList.contains('active'), null, { what: 'the volume view, remembered' });
  assert.equal(page.problems.length, 0, page.problems.join('\n'));

  const library = await openPage(browser, origin);
  await library.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await until(library, () => [...document.querySelectorAll('.card')].some(c => /\b2 volumes\b/.test(c.innerText) && /Series/.test(c.innerText)), null, { what: 'the series card counting volumes' });
  await finish(library);

  const reader = await openPage(browser, origin);
  await reader.goto(`${origin}/app/reader.html?g=${G.v1}`, { waitUntil: 'load' });
  const text = await until(reader, () => (/Vol\. 2\b/.test(document.body.innerText) ? document.body.innerText : 0), null, { what: 'the volumes read in turn' });
  assert.doesNotMatch(text, /Ch\. \d/, 'no chapter among them');
  await finish(reader);

  await page.click('[data-view="chapters"]');   // leave the view as the other tests expect it
  await until(page, () => document.querySelectorAll('.ch-row').length === 3, null, { what: 'the chapters again' });
  await finish(page);
});
