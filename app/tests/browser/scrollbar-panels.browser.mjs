import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function fresh(t, fixture = false) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => localStorage.removeItem('shiori:customScrollbar'));
  if (fixture) {
    page.removeAllListeners('request');
    page.on('request', request => {
      if (request.url() === origin + '/panel-fixture') request.respond({ status: 200, contentType: 'text/html',
        body: '<!doctype html><link rel="icon" href="data:,">' +
          ['base', 'dropdown', 'library', 'overview', 'settings', 'reader', 'notice', 'benchmark']
            .map(name => `<link rel="stylesheet" href="/app/${name}.css">`).join('') +
          '<body><script type="module" src="/app/js/scrollbar.js"></script>' });
      else if (request.url().startsWith(origin) || request.url().startsWith('data:')) request.continue();
      else request.abort();
    });
  }
  await page.goto(origin + (fixture ? '/panel-fixture' : '/settings'));
  return page;
}

const nativeStyle = (page, selector, pseudo = null) => page.$eval(selector, (el, pseudo) => {
  const style = getComputedStyle(el, pseudo);
  return { width: style.scrollbarWidth, color: style.scrollbarColor };
}, pseudo);

async function preference(page, enabled) {
  await page.evaluate(async enabled => {
    localStorage.setItem('shiori:customScrollbar', String(enabled));
    (await import('/app/js/scrollbar.js')).applyScrollbarPreference();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, enabled);
}

async function paintedTrack(page, selector) {
  const point = await page.$eval(selector, el => {
    const rect = el.getBoundingClientRect();
    return { x: Math.floor(rect.right - 2), y: Math.floor(rect.top + rect.height / 2) };
  });
  const png = await page.screenshot({ captureBeyondViewport: false });
  return page.evaluate(async ({ source, point }) => {
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data).slice(0, 3);
  }, { source: 'data:image/png;base64,' + png.toString('base64'), point });
}

test('settings dialogs share the dropdown native profile and switch to overlays', { skip: !chromePath() }, async t => {
  const page = await fresh(t);
  const dropdown = await nativeStyle(page, '#langSelect', '::picker(select)');
  assert.deepEqual(dropdown, { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' });
  for (const [modal, scroller] of [
    ['#aboutModal', '#aboutChangelog'], ['#translateModal', '#translateModal .about-scroll'],
    ['#backupModal', '#backupModal .dialog-body'],
  ]) {
    await page.evaluate(({ modal, scroller }) => {
      const target = document.querySelector(scroller);
      const content = document.createElement('div');
      content.style.cssText = 'min-height:2400px;flex:none';
      target.append(content);
      document.querySelector(modal).classList.add('show');
    }, { modal, scroller });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.$eval(scroller, el => el.scrollHeight > el.clientHeight));
    assert.deepEqual(await nativeStyle(page, scroller), dropdown, modal);
    assert.deepEqual(await paintedTrack(page, scroller), [22, 22, 26], `${modal} track must reveal the dialog background`);
    await preference(page, true);
    await page.waitForSelector(scroller + ' > .scrollbar-host');
    assert.equal(await page.$eval(scroller, el => el.offsetWidth - el.clientWidth), 0, modal);
    await preference(page, false);
    assert.deepEqual(await nativeStyle(page, scroller), dropdown, `${modal} must restore native styling`);
    await page.$eval(modal, el => el.classList.remove('show'));
  }
  assert.deepEqual(await nativeStyle(page, 'html'), { width: 'auto', color: 'rgb(149, 149, 149) rgb(23, 23, 23)' });
});

test('other modal bodies, lists and nested details share native styling and accept overlays', { skip: !chromePath() }, async t => {
  const page = await fresh(t, true);
  const count = await page.evaluate(() => {
    const examples = [
      ['Library filter', '<div class="modal-box filter-box"></div>', '.filter-box'],
      ['Search suggestions', '<div class="search-suggest open"></div>', '.search-suggest'],
      ['Tag suggestions', '<div class="tag-ed-list open"></div>', '.tag-ed-list'],
      ['Overview results', '<div class="add-results open"></div>', '.add-results'],
      ['Reader settings', '<div id="readerSettingsBox"></div>', '#readerSettingsBox'],
      ['Feedback dialog', '<dialog class="feedback-dialog" open></dialog>', '.feedback-dialog'],
      ['Related feedback', '<fieldset class="feedback-related"></fieldset>', '.feedback-related'],
      ['Page properties body', '<div class="pp-body"></div>', '.pp-body'],
      ['Page properties settings', '<details class="pp-details" open><summary>Settings</summary><div class="pp-detail-scroll"><dl class="pp-grid"></dl></div></details>', '.pp-detail-scroll'],
      ['Page properties text', '<details class="pp-details" open><summary>Text</summary><table class="pp-text"></table></details>', '.pp-text'],
      ['Notice details', '<div class="notice-detail-box"></div>', '.notice-detail-box'],
      ['Benchmark dialog', '<dialog class="benchmark-dialog" open></dialog>', '.benchmark-dialog'],
      ['Benchmark models', '<div class="benchmark-models"><fieldset></fieldset></div>', 'fieldset'],
      ['Benchmark galleries', '<div class="benchmark-galleries"></div>', '.benchmark-galleries'],
      ['Benchmark report', '<div class="benchmark-dialog"><pre></pre></div>', 'pre'],
    ];
    for (const [index, [name, html, selector]] of examples.entries()) {
      const owner = document.createElement('div');
      owner.id = 'audit-' + index;
      owner.dataset.name = name;
      owner.style.cssText = 'display:none;position:fixed;left:100px;top:100px;background:var(--surface);z-index:1000';
      owner.innerHTML = html;
      const viewport = owner.querySelector(selector);
      viewport.dataset.auditViewport = '';
      viewport.style.cssText += 'position:relative;inset:auto;width:280px;height:200px;max-height:200px;min-height:0;margin:0';
      if (viewport.matches('.pp-text')) {
        const body = document.createElement('tbody');
        for (let i = 0; i < 80; i++) {
          const row = body.insertRow(); row.insertCell().textContent = 'Text ' + i;
        }
        viewport.append(body);
      } else if (viewport.matches('.pp-detail-scroll')) {
        const grid = viewport.querySelector('dl');
        for (let i = 0; i < 80; i++) {
          const term = document.createElement('dt'), value = document.createElement('dd');
          term.textContent = 'Setting ' + i; value.textContent = 'Value ' + i; grid.append(term, value);
        }
      } else {
        const content = document.createElement('div');
        content.style.cssText = 'height:1600px;flex:none';
        viewport.append(content);
      }
      document.body.append(owner);
    }
    return examples.length;
  });
  for (let index = 0; index < count; index++) {
    const selector = `#audit-${index} [data-audit-viewport]`;
    await page.evaluate(index => {
      document.querySelectorAll('[id^="audit-"]').forEach(el => { el.style.display = el.id === 'audit-' + index ? 'block' : 'none'; });
    }, index);
    const name = await page.$eval('#audit-' + index, el => el.dataset.name);
    assert.ok(await page.$eval(selector, el => el.scrollHeight > el.clientHeight), name);
    assert.deepEqual(await nativeStyle(page, selector), { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' }, name);
    const initial = await page.$eval(selector, el => {
      const rect = el.getBoundingClientRect(), content = el.firstElementChild.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, contentTop: content.top };
    });
    await preference(page, true);
    await page.waitForSelector(selector + ' > .scrollbar-host');
    const overlay = await page.$eval(selector, el => {
      const rect = el.getBoundingClientRect(), content = el.children[1].getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, contentTop: content.top };
    });
    assert.deepEqual(overlay, initial, `${name} overlay must preserve the surrounding layout`);
    await page.$eval(selector, el => { el.scrollTop = 150; });
    await preference(page, false);
    assert.deepEqual(await nativeStyle(page, selector), { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' }, `${name} native restoration`);
  }
});

test('rendered Page properties grids keep their layout inside native and overlay scroll areas', { skip: !chromePath() }, async t => {
  const page = await fresh(t, true);
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const gid = '1790000000401';
    const canvas = new OffscreenCanvas(32, 32);
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await api.meta.put({ galleryId: gid, title: { english: 'Properties scrollbar fixture' }, numPages: 1,
      translations: { fixture: { at: 1, config: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['setting' + i, i])),
        builds: { detect: 'build-token-'.repeat(900) } } } });
    await api.pages.put(gid, 1, blob);
    await api.derived.putTranslation(gid, 1, { image: blob, pipeline: { job: 'fixture', lines: [], regions: [] } });
    const { openPageProperties } = await import('/app/js/reader-properties.js');
    await openPageProperties({ gid, pageNum: 1, number: 1, total: 1 });
    document.querySelectorAll('.pp-details').forEach(el => { el.open = true; });
  });
  const selector = '.pp-detail-scroll';
  assert.equal(await page.$$eval(selector, elements => elements.length), 2);
  assert.ok(await page.$$eval(selector, elements => elements.every(el => el.scrollHeight > el.clientHeight)));
  const spacing = () => page.$$eval(selector, elements => elements.map(el => {
    const rect = el.getBoundingClientRect(), first = el.querySelector('dt').getBoundingClientRect();
    return { x: first.x - rect.x, y: first.y - rect.y, columns: getComputedStyle(el.querySelector('dl')).display };
  }));
  const native = await spacing();
  assert.deepEqual(await nativeStyle(page, selector), { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' });
  await preference(page, true);
  await page.waitForFunction(() => document.querySelectorAll('.pp-detail-scroll > .scrollbar-host').length === 2);
  assert.deepEqual(await spacing(), native, 'overlay controls must not consume a grid cell or move the rows');
  await preference(page, false);
  assert.deepEqual(await spacing(), native);
});

test('thin native modal scrollbars reveal their background and stay composited at 20x CPU throttling', { skip: !chromePath() }, async t => {
  const page = await fresh(t, true);
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'native-modal-panel';
    panel.style.cssText = 'position:fixed;left:100px;top:100px;width:280px;height:240px;overflow:auto;background:#123';
    panel.innerHTML = '<div style="height:3200px"></div>';
    document.body.append(panel);
  });
  assert.deepEqual(await paintedTrack(page, '#native-modal-panel'), [17, 34, 51]);
  const cdp = await page.createCDPSession();
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers || []; });
  await cdp.send('LayerTree.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.mouse.move(375, 112);
  await page.mouse.down();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await page.mouse.move(375, 310, { steps: 36 });
    let composited = false;
    for (const layer of layers.filter(layer => layer.width === 10 && layer.height === 240)) {
      const { compositingReasonIds } = await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId });
      composited ||= compositingReasonIds.includes('Scrollbar');
    }
    assert.ok(composited, 'the thin native thumb must have its own compositor scrollbar layer');
    assert.ok(await page.$eval('#native-modal-panel', el => el.scrollTop > 1000));
  } finally {
    await page.mouse.up();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
});
