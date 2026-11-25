// tasks-page.browser.mjs — the Tasks page as the one page draws it (src/routes/tasks.tsx): what a
// page of its own never had to prove. The header is the frame's, filled and emptied by the route and
// never drawn again; leaving the page leaves nothing behind (listeners, timers, subscriptions,
// channels, markup), however often; a row is the same node through its job's news; the 4 s linger
// and the pointer; Stop's "Stopping…" and its 3 s; Stop all asked first; the quiet note; the rows
// found at load from each of the three records; the tooltips; a change of language; the phone form.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { a: '1790000000401', b: '1790000000402', c: '1790000000403', d: '1790000000404', e: '1790000000405', f: '1790000000406' };
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await page.evaluate(async (G) => {
    const api = await import('/app/js/api.js');
    for (const [gid, name] of Object.entries(G)) {
      await api.meta.put({ galleryId: gid, title: { english: `Gallery ${name.toUpperCase()}`, japanese: '', pretty: '' }, tags: [], numPages: 1 });
    }
  }, Object.fromEntries(Object.entries(G).map(([k, v]) => [v, k])));
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function visit(t, path, viewport) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  if (viewport) await page.setViewport(viewport);
  t.after(async () => {
    // Every job a test made, gone from the registry, so the next test's load finds none of them.
    await page.evaluate(async (gids) => {
      const platform = await import('/app/js/platform.js');
      for (const gid of gids) for (const kind of ['download', 'translate', 'upload', 'sync', 'folder']) await platform.jobs.clear(gid, kind);
      for (const gid of gids) { await platform.translateResume.remove?.(gid); await platform.jobsPending.remove(`${gid}:download`); }
    }, [...Object.values(G), 'folder-tp']).catch(() => {});
    await page.close();
  });
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}
const publish = (page, job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);
const tasksDrawn = (page) => until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkList'), null, { what: 'the Tasks page' });
// From /components to /tasks by a page menu there (its specimen: the frame has none on /components): a
// route change.
const SPECIMEN_MENU = '[data-specimen="page-menu"][data-variant="library"][data-specimen-state="rest"]';
async function menuToTasks(page) {
  await page.$eval(SPECIMEN_MENU, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(SPECIMEN_MENU);
  await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
  await new Promise((r) => setTimeout(r, 300));   // (a press in the list's first moments is not taken as a choice)
  await page.click('[data-slot="select-list"] [data-slot="select-option"]:nth-child(3)');
  await tasksDrawn(page);
}

test('the header is the frame\'s: filled by the route, never drawn again, the brand unmoved; the title and the meta follow', async (t) => {
  const page = await visit(t, '/components');
  if (!page) return;
  const look = () => page.evaluate(() => {
    const band = document.querySelector('#root > header');
    const brand = band.querySelector('.brand-wrap').getBoundingClientRect();
    const right = band.querySelector('.header-right');
    return { same: window.__band ? window.__band === band : null, brand: [brand.x, brand.y, brand.width, brand.height],
      page: band.querySelector('#pageNav')?.dataset.page ?? null, sep: !!band.querySelector('.brand-sep'),
      right: [...right.children].map((el) => el.id || el.dataset.slot), rightShown: getComputedStyle(right).display !== 'none',
      title: document.title, meta: document.querySelector('meta[name="shiori-app"]')?.content ?? null };
  });
  await page.waitForSelector('#root > main');   // React's header (index.html's painted one is replaced as React draws)
  await page.evaluate(() => { window.__band = document.querySelector('#root > header'); window.stayed = true; });
  const components = await look();
  assert.deepEqual([components.same, components.page, components.sep, components.right, components.rightShown], [true, null, false, [], false],
    '/components: the frame alone');
  await menuToTasks(page);
  const tasks = await look();
  assert.deepEqual(tasks, { ...tasks, same: true, page: 'tasks', sep: true, rightShown: true, title: 'Shiori — Tasks', meta: 'tasks' });
  assert.deepEqual(tasks.right, ['stat', 'stopAllBtn', 'settingsBtn']);
  assert.deepEqual(tasks.brand, components.brand, 'the brand where it was');
  await page.evaluate(() => history.back());
  await until(page, () => location.pathname === '/components' && document.title === 'Shiori — Components', null, { what: 'back on /components' });
  const back = await look();
  assert.deepEqual([back.same, back.page, back.sep, back.right, back.rightShown, back.meta], [true, null, false, [], false, null], 'the band kept, the route\'s parts gone with it');
  assert.equal(await page.evaluate(() => window.stayed), true, 'no page load');
  assert.deepEqual(page.problems, []);
});

// What a page holds that outlives it unless released: listeners on the window and the document, timers,
// channels, subscriptions to the jobs channel, the library's feed and the control channel, and markup.
async function instrument(page) {
  await page.evaluateOnNewDocument(() => {
    const live = window.__live = { intervals: new Set(), timeouts: new Set(), channels: new Set() };
    const { setInterval: si, clearInterval: ci, setTimeout: st, clearTimeout: ct } = window;
    window.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
    window.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
    window.setTimeout = function (fn, ms, ...rest) {
      let id;
      const run = typeof fn === 'function' ? function (...x) { live.timeouts.delete(id); return fn.apply(this, x); } : fn;
      id = st.call(this, run, ms, ...rest);
      live.timeouts.add(id);
      return id;
    };
    window.clearTimeout = function (id) { live.timeouts.delete(id); return ct.call(this, id); };
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC {
      constructor(name) { super(name); live.channels.add(this); }
      close() { live.channels.delete(this); super.close(); }
    };
  });
}
async function held(page) {
  const cdp = await page.createCDPSession();
  const listeners = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.length;
  };
  const counts = { window: await listeners('window'), document: await listeners('document'), ...await page.evaluate(() => ({
    intervals: window.__live.intervals.size, channels: window.__live.channels.size, subs: { ...window.__subs },
    nodes: document.getElementsByTagName('*').length,
  })) };
  await cdp.detach();
  return counts;
}

test('leaving the page leaves nothing behind: /tasks → /components → /tasks, five times', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  t.after(async () => {
    await page.evaluate(async (gids) => {
      const p = await import('/app/js/platform.js');
      for (const gid of gids) for (const k of ['download', 'translate']) await p.jobs.clear(gid, k);
      await p.jobs.clear('import-tp', 'import');
    }, [G.a, G.b]).catch(() => {});
    await page.close();
  });
  await instrument(page);
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  // Subscriptions counted from here on: the jobs channel, the control channel (onControl), the feed.
  await page.evaluate(async () => {
    const platform = await import('/app/js/platform.js');
    const subs = window.__subs = { jobs: 0, control: 0, feed: 0 };
    const count = (holder, method, name) => {
      const own = holder[method].bind(holder);
      holder[method] = (cb) => { subs[name]++; const off = own(cb); let done = false; return () => { if (!done) { done = true; subs[name]--; } return off(); }; };
    };
    count(platform.jobs, 'subscribe', 'jobs');
    count(platform.control, 'on', 'control');
    count(platform.feed, 'subscribe', 'feed');
  });
  // Jobs with rows: covers asked for, galleries read, the tracker's channel open.
  await publish(page, { gid: G.a, kind: 'download', status: 'progress', done: 1, total: 4 });
  await publish(page, { gid: G.b, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' });
  await page.evaluate(async () => (await import('/app/js/platform.js')).jobs.publish({ gid: 'import-tp', kind: 'import', status: 'progress', name: 'Shelf', total: 3, done: 1, bytes: 1e6, bytesDone: 1e5, startedAt: Date.now(), movedAt: Date.now() }));

  await menuToTasks(page);
  await until(page, () => document.querySelectorAll('.tk-row').length === 2 && !!document.querySelector('#tkImports .ib'), null, { what: 'two rows and a batch' });
  const onTasks = await held(page);
  assert.ok(onTasks.subs.jobs >= 2 && onTasks.subs.control >= 2 && onTasks.channels >= 1, `the page holds its subscriptions while it shows: ${JSON.stringify(onTasks)}`);
  await page.evaluate(() => history.back());
  await until(page, () => location.pathname === '/components' && !document.getElementById('tkList'), null, { what: '/components' });
  await new Promise((r) => setTimeout(r, 300));
  const first = await held(page);
  // The page's own: the rows' and the tracker's stores on the jobs channel, a row's cover on the control
  // channel. (Modules the page brought in for the first time keep their own one listener each for the
  // page's life, as on any page: the five visits below hold that to no more.)
  assert.deepEqual([onTasks.subs.jobs - first.subs.jobs, onTasks.subs.control, first.subs.control, first.subs.feed - onTasks.subs.feed], [2, 2, 0, 0],
    `the page's subscriptions go with it: ${JSON.stringify({ onTasks: onTasks.subs, after: first.subs })}`);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => history.forward());
    await until(page, () => document.querySelectorAll('.tk-row').length === 2 && !!document.querySelector('#tkImports .ib'), null, { what: `Tasks again (${i + 1})` });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/components' && !document.getElementById('tkList'), null, { what: `/components again (${i + 1})` });
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await held(page), first, 'after five more visits, what is held is what it was after the first');
  assert.deepEqual(page.problems, []);
});

test('a row is the same node through its job\'s news: only its words, its bar and its classes change', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  await publish(page, { gid: G.c, kind: 'download', status: 'progress', done: 1, total: 4 });
  const key = `${G.c}:download`;
  await until(page, (key) => document.querySelector(`.tk-row[data-key="${key}"] .tk-title`)?.textContent === 'Gallery C', key, { what: 'the row with its gallery' });
  await page.evaluate((key) => {
    const row = document.querySelector(`.tk-row[data-key="${key}"]`);
    window.__nodes = [row, ...row.querySelectorAll('*')];
    window.__removed = 0;
    new MutationObserver((list) => { for (const m of list) window.__removed += m.removedNodes.length; }).observe(document.getElementById('tkList'), { childList: true, subtree: true });
  }, key);
  await publish(page, { gid: G.c, kind: 'download', status: 'progress', done: 3, total: 4 });
  await until(page, (key) => /3 \/ 4/.test(document.querySelector(`.tk-row[data-key="${key}"] .tk-label`).textContent), key, { what: 'the news' });
  await publish(page, { gid: G.c, kind: 'download', status: 'done', done: 4, total: 4 });
  await until(page, (key) => document.querySelector(`.tk-row[data-key="${key}"]`).classList.contains('done'), key, { what: 'its end' });
  const kept = await page.evaluate((key) => {
    const row = document.querySelector(`.tk-row[data-key="${key}"]`);
    const now = [row, ...row.querySelectorAll('*')];
    return { same: now.length === window.__nodes.length && now.every((el, i) => el === window.__nodes[i]), removed: window.__removed,
      fill: row.querySelector('.prog-fill').className.includes('done'), stop: getComputedStyle(row.querySelector('.tk-stop')).visibility };
  }, key);
  assert.deepEqual(kept, { same: true, removed: 0, fill: true, stop: 'hidden' }, 'the same nodes, none removed; done shows; Stop keeps its place, hidden');
  assert.deepEqual(page.problems, []);
});

test('a finished row stays 4 s, and goes only once the pointer is off the list', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  await publish(page, { gid: G.d, kind: 'download', status: 'progress', done: 1, total: 2 });
  await publish(page, { gid: G.e, kind: 'upload', status: 'progress', done: 1, total: 2 });
  await until(page, () => document.querySelectorAll('.tk-row').length === 2, null, { what: 'two rows' });
  const box = await page.$eval(`.tk-row[data-key="${G.e}:upload"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + 100, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await publish(page, { gid: G.d, kind: 'download', status: 'error', error: 'No answer' });
  await until(page, (gid) => document.querySelector(`.tk-row[data-key="${gid}:download"]`)?.classList.contains('error'), G.d, { what: 'the failed row' });
  await new Promise((r) => setTimeout(r, 4700));
  assert.equal(await page.$$eval('.tk-row', (rows) => rows.length), 2, 'the pointer on the list: nothing under it moves');
  await page.mouse.move(5, 5);
  await until(page, () => document.querySelectorAll('.tk-row').length === 1, null, { what: 'swept once the pointer left', timeout: 1000 });
  // Off the list: a finished row goes after its 4 s, not before.
  await publish(page, { gid: G.e, kind: 'upload', status: 'done', done: 2, total: 2 });
  await until(page, (gid) => document.querySelector(`.tk-row[data-key="${gid}:upload"]`)?.classList.contains('done'), G.e, { what: 'the finished row' });
  const ended = Date.now();
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await page.$$eval('.tk-row', (rows) => rows.length), 1, 'still there at 3.5 s');
  await until(page, () => !document.querySelector('.tk-row') && !document.getElementById('tkEmpty').hidden, null, { what: 'gone, and the page says nothing runs', timeout: 3000 });
  assert.ok(Date.now() - ended < 5600);
  assert.deepEqual(page.problems, []);
});

test('Stop: "Stopping…" until the job\'s word; with none in 3 s, Stop can be pressed again', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  // A library folder's check that nothing runs: its stop is asked for and no word comes back (the app
  // ends it itself only after 12 s).
  await publish(page, { gid: 'folder-tp', kind: 'folder', status: 'progress', title: 'Shelf folder', done: 1, total: 3 });
  const row = '.tk-row[data-key="folder-tp:folder"]';
  await page.waitForSelector(`${row} .tk-stop:not([disabled])`);
  assert.equal(await page.$eval(`${row} .tk-title`, (el) => el.textContent), 'Shelf folder');
  await page.click(`${row} .tk-stop`);
  const pressed = Date.now();
  const stopping = await until(page, (row) => { const r = document.querySelector(row); return r.querySelector('.tk-stop').disabled && r.querySelector('.tk-label').textContent; }, row, { what: 'Stopping…' });
  assert.equal(stopping, 'Stopping…');
  assert.equal(await page.$eval('#stopAllBtn', (el) => el.disabled), true, 'nothing left to stop');
  await until(page, (row) => !document.querySelector(row).querySelector('.tk-stop').disabled, row, { what: 'Stop again', timeout: 6000 });
  const after = Date.now() - pressed;
  assert.ok(after >= 2900, `pressable again after 3 s (${after} ms)`);
  assert.match(await page.$eval(`${row} .tk-label`, (el) => el.textContent), /1 \/ 3/, 'its own words back');
  assert.deepEqual(page.problems, []);
});

test('Stop all asks first: cancelled, every job runs on; confirmed, every job and batch is stopped', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  await publish(page, { gid: G.f, kind: 'download', status: 'progress', done: 1, total: 4 });
  await page.waitForSelector('#stopAllBtn:not([disabled])');
  await page.click('#stopAllBtn');
  await page.waitForSelector('[data-notice="dialog"]');
  assert.equal(await page.$eval('[data-notice="dialog"]', (el) => el.textContent.includes('Stop')), true);
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('[data-notice="dialog"]'), null, { what: 'the question gone' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.$eval(`.tk-row[data-key="${G.f}:download"]`, (el) => el.classList.contains('cancelled')), false, 'cancelled: nothing stopped');
  await page.click('#stopAllBtn');
  await page.click('[data-notice="dialog"] [data-slot="button"][data-variant="danger"]');
  await until(page, (gid) => document.querySelector(`.tk-row[data-key="${gid}:download"]`).classList.contains('cancelled'), G.f, { what: 'stopped' });
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '0');
  assert.deepEqual(page.problems, []);
});

test('a running job silent over 2 min says for how long', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  await page.evaluate(async (gid) => {
    const platform = await import('/app/js/platform.js');
    await platform.jobs.receive({ gid, kind: 'download', status: 'progress', done: 1, total: 4, at: Date.now() - 3.5 * 60000, runner: platform.runner });
  }, G.a);
  const label = await until(page, (gid) => document.querySelector(`.tk-row[data-key="${gid}:download"] .tk-label`)?.textContent, G.a, { what: 'the row' });
  assert.equal(label, '1 / 4 · No news for 3 min');
  assert.equal(await page.$eval(`.tk-row[data-key="${G.a}:download"] .tk-quiet`, (el) => el.textContent), ' · No news for 3 min');
  assert.deepEqual(page.problems, []);
});

// The store's third source, a job waiting to be resumed, is held in Node (task-store.test.mjs: the
// order of the three, the first of a key winning). It is not asked of a page: there such an entry
// lives only until the app's next heartbeat (boot-core's poll, 3 s at most, in any tab or the worker),
// which replays it or, when nothing in the app runs its kind, drops it. This test once added one and
// waited for its row: under the whole suite's load the page opened after the heartbeat, and the row
// never came (eight of eight with eight copies at once, 2026-11-25: the two other rows there).
test('rows found at load: the live list, then a translation under way on the server', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const first = await visit(t, '/components');
  await first.evaluate(async (G) => {
    const platform = await import('/app/js/platform.js');
    await platform.jobs.publish({ gid: G.b, kind: 'download', status: 'progress', done: 1, total: 4 });
    await platform.translateResume.set({ gid: G.c, phase: 'collecting' });
  }, G);
  const page = await visit(t, '/tasks');
  let rows;
  try {
    rows = await until(page, () => {
      const r = [...document.querySelectorAll('.tk-row')].map((el) => el.dataset.key);
      return r.length >= 2 && r;
    }, null, { what: 'two rows' });
  } finally {
    await page.evaluate(async (G) => {
      const platform = await import('/app/js/platform.js');
      await platform.translateResume.remove(G.c);
    }, G);
  }
  assert.deepEqual(rows, [`${G.b}:download`, `${G.c}:translate`], 'the live list, then the server\'s translation');
  assert.deepEqual(page.problems, []);
});

test('tooltips: Stop, and where a job runs', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  await tasksDrawn(page);
  await publish(page, { gid: G.e, kind: 'download', status: 'progress', done: 1, total: 4 });
  const row = `.tk-row[data-key="${G.e}:download"]`;
  await page.waitForSelector(`${row} .tk-stop`);
  const tip = async (sel) => {
    await page.hover(sel);
    return until(page, () => { const el = document.querySelector('.shiori-tip'); return el && getComputedStyle(el).display !== 'none' && el.textContent; }, null, { what: `the tip of ${sel}` });
  };
  assert.equal(await tip(`${row} .tk-stop`), 'Stop');
  assert.equal(await page.$eval(`${row} .run-tag`, (el) => el.textContent), 'This tab');
  assert.equal(await tip(`${row} .run-tag`), 'Stops if the tab is closed or reloaded.');
  assert.equal(await tip('#stopAllBtn'), 'Stop all');
  assert.deepEqual(page.problems, []);
});

test('a change of language redraws the page in it', async (t) => {
  const page = await visit(t, '/tasks');
  if (!page) return;
  t.after(() => page.evaluate(async () => (await import('/app/js/i18n.js')).setLang('en')).catch(() => {}));
  await tasksDrawn(page);
  await publish(page, { gid: G.f, kind: 'download', status: 'progress', done: 1, total: 4 });
  const row = `.tk-row[data-key="${G.f}:download"]`;
  await page.waitForSelector(row);
  const words = () => page.evaluate((row) => ({ kind: document.querySelector(`${row} .tk-kind`).textContent, stop: document.querySelector(`${row} .tk-stop`).dataset.tip,
    running: document.querySelector('[data-slot="stat-label"]').textContent, menu: document.getElementById('pageNav').textContent }), row);
  assert.deepEqual(await words(), { kind: 'Download', stop: 'Stop', running: 'Running', menu: 'Tasks' });
  await page.evaluate(async () => (await import('/app/js/i18n.js')).setLang('ja'));
  await until(page, (row) => document.querySelector(`${row} .tk-kind`).textContent === 'ダウンロード', row, { what: 'Japanese' });
  assert.deepEqual(await words(), { kind: 'ダウンロード', stop: '停止', running: '実行中', menu: 'タスク' });
  assert.deepEqual(page.problems, []);
});

test('the phone form: Stop all an icon a finger can press, rows 12px in, nothing wider than the screen', async (t) => {
  const page = await visit(t, '/tasks', { width: 390, height: 844, isMobile: true, hasTouch: true });
  if (!page) return;
  await tasksDrawn(page);
  await publish(page, { gid: G.a, kind: 'download', status: 'progress', done: 1, total: 4 });
  await page.waitForSelector('.tk-row');
  const phone = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]; };
    const row = document.querySelector('.tk-row');
    return { stopAll: box(document.getElementById('stopAllBtn')), label: getComputedStyle(document.querySelector('.btn-stop-all-label')).display,
      settings: box(document.getElementById('settingsBtn')), stop: box(row.querySelector('.tk-stop')), row: box(row),
      padding: getComputedStyle(row).padding, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  assert.deepEqual([phone.stopAll[1], phone.stopAll[2], phone.label], [40, 40, 'none'], 'Stop all: its icon alone, 40×40');
  assert.deepEqual([phone.settings[1], phone.settings[2]], [40, 40]);
  assert.deepEqual([phone.stop[1], phone.stop[2]], [44, 44], 'a row\'s Stop: 44×44');
  assert.deepEqual([phone.row[0], phone.row[1], phone.padding], [12, 366, '8px 10px']);
  assert.equal(phone.fits, true);
  assert.deepEqual(page.problems, []);
});
