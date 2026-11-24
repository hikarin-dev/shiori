// frame.browser.mjs — what every page the one page draws stands on (src/app.tsx, src/frame.tsx):
// each route's title and its shiori-app meta, t() for components following the language, and links —
// a plain link to an address the one page draws is followed inside the app, any other loads as always.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { builtSite } from '../../../build/built.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(t, path) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}

const componentsDrawn = () => document.title === 'Shiori — Components' && !!document.querySelector('#pageNames li');
const meta = () => document.querySelector('meta[name="shiori-app"]')?.content ?? null;

test('each route sets the title, and the shiori-app meta is there only on the app\'s own pages', async (t) => {
  const page = await open(t, '/components');
  if (!page) return;
  await until(page, componentsDrawn, undefined, { what: 'the components page' });
  assert.equal(await page.evaluate(meta), null, '/components is none of the app\'s own pages');

  // Not found, reached inside the app.
  await page.evaluate(() => { window.stayed = true; history.pushState(null, '', '/nowhere'); dispatchEvent(new PopStateEvent('popstate')); });
  await until(page, () => /Not found\./.test(document.getElementById('root').textContent), undefined, { what: 'not found' });
  assert.deepEqual(await page.evaluate(() => [document.title, window.stayed]), ['Shiori', true]);
  assert.equal(await page.evaluate(meta), null, 'no meta where nothing is found');
  assert.deepEqual(page.problems, []);
});

test('a route the table marks as one of the app\'s own pages carries the meta, by its name, while it shows', async (t) => {
  // No page of the app's own is drawn by the one page yet: the route table in the built app chunk is
  // changed on its way to the page so /components counts as one, and the frame's own code is watched.
  const assets = join(builtSite(), 'assets');
  const entry = /(page:[`"']components[`"'],app:)!1/;
  const chunk = readdirSync(assets).find((f) => /^app-.*\.js$/.test(f) && entry.test(readFileSync(join(assets, f), 'utf8')));
  assert.ok(chunk, 'the route table is in the app chunk');
  const body = readFileSync(join(assets, chunk), 'utf8').replace(entry, '$1!0');
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setBypassServiceWorker(true);   // the worker another test installed would answer from its cache
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url() === `${origin}/assets/${chunk}`) req.respond({ status: 200, contentType: 'text/javascript', body });
    else if (req.url().startsWith(origin)) req.continue();
    else req.abort();
  });
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, componentsDrawn, undefined, { what: 'the components page' });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content)), ['components'],
    'one meta, naming the page');
  await page.evaluate(() => { history.pushState(null, '', '/nowhere'); dispatchEvent(new PopStateEvent('popstate')); });
  await until(page, () => /Not found\./.test(document.getElementById('root').textContent), undefined, { what: 'not found' });
  assert.equal(await page.evaluate(meta), null, 'gone on a route that is none of them');
  await page.evaluate(() => history.back());
  await until(page, componentsDrawn, undefined, { what: 'the components page again' });
  assert.equal(await page.evaluate(meta), 'components', 'back with the page');
});

test('useT(): a component draws again in the language chosen, here or in another tab', async (t) => {
  const page = await open(t, '/components');
  if (!page) return;
  await until(page, componentsDrawn, undefined, { what: 'the components page' });
  const names = () => page.evaluate(() => [...document.querySelectorAll('#pageNames li')].map((li) => li.textContent).join('|'));
  assert.equal(await names(), 'Library|Overview|Reader|Settings|Tasks');
  await page.evaluate(() => import('/app/js/i18n.js').then((m) => m.setLang('ja')));
  await until(page, () => document.querySelector('#pageNames li').textContent === 'ライブラリ', undefined, { what: 'Japanese names' });
  // Another tab's choice reaches this one through storage.
  await page.evaluate(() => {
    localStorage.setItem('shiori-lang', 'de');
    dispatchEvent(new StorageEvent('storage', { key: 'shiori-lang', newValue: 'de' }));
  });
  await until(page, () => document.querySelector('#pageNames li').textContent === 'Bibliothek', undefined, { what: 'German names' });
  await page.evaluate(() => import('/app/js/i18n.js').then((m) => m.setLang('en')));
  assert.deepEqual(page.problems, []);
});

test('a plain link to an address the one page draws is followed inside the app; others load as always', async (t) => {
  const page = await open(t, '/components');
  if (!page) return;
  await until(page, componentsDrawn, undefined, { what: 'the components page' });
  // Links as markup the app didn't write as components would have them, outside React's tree.
  await page.evaluate(() => {
    const add = (id, href, attrs = {}) => {
      const a = document.body.insertBefore(document.createElement('a'), document.body.firstChild);
      Object.assign(a, { id, href, textContent: id }, attrs);
      a.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;display:block;width:40px;height:20px;background:#000';
    };
    add('toComponents', 'components?from=link#top');
    add('toTasks', 'tasks');
    add('toSettings', 'settings');
    add('toBlank', 'components?blank', { target: '_blank' });
    add('toDownload', 'components?file', { download: 'x' });
    window.stayed = true;
  });
  const click = (id) => page.evaluate((id) => document.getElementById(id).click(), id);

  // An address the one page draws: no page load, the address and the route follow.
  await click('toComponents');
  await until(page, () => location.search === '?from=link', undefined, { what: 'the address' });
  assert.deepEqual(await page.evaluate(() => [window.stayed, location.pathname + location.search + location.hash, document.title]),
    [true, '/components?from=link#top', 'Shiori — Components']);

  // Asked of the browser — a modifier key, another window, a download — or another page on this same
  // one: left alone. (Whether the browser then followed it is the browser's affair: the default is
  // kept from happening here once the app has had its say.)
  const leftAlone = await page.evaluate(() => {
    const seen = [];
    const record = (e) => { seen.push(`${e.target.id}${e.ctrlKey ? '+ctrl' : ''}:${e.defaultPrevented ? 'app' : 'browser'}`); e.preventDefault(); };
    addEventListener('click', record);
    const fire = (id, init = {}) => document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
    fire('toComponents', { ctrlKey: true });
    fire('toBlank');
    fire('toDownload');
    const here = document.body.insertBefore(document.createElement('a'), document.body.firstChild);
    here.id = 'toHere'; here.href = '#top';
    fire('toHere');
    removeEventListener('click', record);
    return seen;
  });
  assert.deepEqual(leftAlone, ['toComponents+ctrl:browser', 'toBlank:browser', 'toDownload:browser', 'toHere:browser']);
  assert.equal(await page.evaluate(() => window.stayed), true);

  // Tasks, which the one page draws too: no page load.
  await click('toTasks');
  await until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkList'), undefined, { what: 'the tasks page' });
  assert.equal(await page.evaluate(() => window.stayed), true, 'no page load');

  // A page that still has a file of its own: loaded as always.
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), click('toSettings')]);
  await until(page, () => document.title === 'Shiori — Settings' && !!document.querySelector('header'), undefined, { what: 'the settings page' });
  assert.equal(await page.evaluate(() => window.stayed), undefined, 'a page load');
  assert.deepEqual(page.problems, []);
});
