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
        // The scrollbars' fixture sheet (base.css) and the reader's, with the reader's mark.
        body: '<!doctype html><html data-reader><link rel="icon" href="data:,">' +
          ['base', 'reader']
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
  await page.waitForSelector('#settingsNav');
  // The dropdown profile: a select's list, 1.3's native one's and the app's drawn one alike.
  const dropdown = { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' };
  await page.click('#langSelect');
  await page.waitForSelector('[data-slot="select-list"][data-open]');
  assert.deepEqual(await nativeStyle(page, '[data-slot="select-list"][data-open]'), dropdown, 'the language list');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-slot="select-list"][data-open]'));
  // Each dialog is drawn when opened: by its button, on its panel.
  for (const [nav, button, box, scroller] of [
    [null, '#aboutBtn', '#aboutBox', '#aboutChangelog'], ['#navTranslation', '#openTranslateModalBtn', '#translateBox', '#translateBox [data-slot="dialog-body"]'],
    ['#navStorage', '#exportBackupBtn', '#backupBox', '#backupBox [data-slot="dialog-body"]'],
  ]) {
    if (nav) await page.click(nav);
    await page.click(button);
    await page.waitForSelector(scroller);
    await page.evaluate((scroller) => {
      const content = document.createElement('div');
      content.style.cssText = 'min-height:2400px;flex:none';
      document.querySelector(scroller).append(content);
    }, scroller);
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.$eval(scroller, el => el.scrollHeight > el.clientHeight));
    assert.deepEqual(await nativeStyle(page, scroller), dropdown, box);
    assert.deepEqual(await paintedTrack(page, scroller), [22, 22, 26], `${box} track must reveal the dialog background`);
    await preference(page, true);
    await page.waitForSelector(scroller + ' > .scrollbar-host');
    assert.equal(await page.$eval(scroller, el => el.offsetWidth - el.clientWidth), 0, box);
    await preference(page, false);
    assert.deepEqual(await nativeStyle(page, scroller), dropdown, `${box} must restore native styling`);
    await page.keyboard.press('Escape');
    await page.waitForFunction((box) => !document.querySelector(box), {}, box);
  }
  assert.deepEqual(await nativeStyle(page, 'html'), { width: 'auto', color: 'rgb(149, 149, 149) rgb(23, 23, 23)' });
});

test('other modal bodies, lists and nested details share native styling and accept overlays', { skip: !chromePath() }, async t => {
  const page = await fresh(t, true);
  const count = await page.evaluate(() => {
    // (1.3's library page's filter box and search list were here until 2026-11-25, and its overview's tag
    // suggestions and add-a-chapter results until its switch the same day: their drawing and their rules
    // went with their pages (library.css, overview.css); the one page draws them as its Listbox.)
    const examples = [
      ['Reader settings', '<div id="readerSettingsBox"><div class="rs-panel active"></div></div>', '.rs-panel'],   // the tab shown scrolls
      ['Feedback dialog', '<dialog class="feedback-dialog" open></dialog>', '.feedback-dialog'],
      ['Related feedback', '<fieldset class="feedback-related"></fieldset>', '.feedback-related'],
      // (Page properties' body and lists left 2026-11-26 with its drawing: the app's Dialog and its own
      // boxes, held by the test after this one on the dialog itself.)
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
      const content = document.createElement('div');
      content.style.cssText = 'height:1600px;flex:none';
      viewport.append(content);
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

// Page properties in the reader (the app's Dialog since 8e): its two lists opened, each scrolling in a box of
// its own, the same rows in the native and the drawn scrollbars.
test('rendered Page properties grids keep their layout inside native and overlay scroll areas', { skip: !chromePath() }, async t => {
  const page = await fresh(t);
  const gid = '1790000000401';
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    const canvas = new OffscreenCanvas(32, 32);
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await api.meta.put({ galleryId: gid, title: { english: 'Properties scrollbar fixture' }, numPages: 1,
      translations: { fixture: { at: 1, config: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['setting' + i, i])),
        builds: { detect: 'build-token-'.repeat(900) } } } });
    await api.pages.put(gid, 1, blob);
    await api.derived.putTranslation(gid, 1, { image: blob, pipeline: { job: 'fixture', lines: [], regions: [] } });
  }, gid);
  // In by a link, as the app's own are followed.
  await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); }, `/reader?g=${gid}&page=1`);
  await page.waitForFunction(() => [...document.querySelectorAll('#stripView img, #mainImg')].some((i) => i.naturalWidth > 0));
  await page.keyboard.press('i');
  await page.waitForFunction(() => document.querySelectorAll('[data-reader-part="properties"] [data-slot="collapsible-trigger"]').length === 2);
  for (const trigger of await page.$$('[data-reader-part="properties"] [data-slot="collapsible-trigger"]')) await trigger.click();
  const selector = '[data-reader-part="properties"] [data-pp="scroll"]';
  assert.equal(await page.$$eval(selector, elements => elements.length), 2);
  assert.ok(await page.$$eval(selector, elements => elements.every(el => el.scrollHeight > el.clientHeight)));
  const spacing = () => page.$$eval(selector, elements => elements.map(el => {
    const rect = el.getBoundingClientRect(), first = el.querySelector('dt').getBoundingClientRect();
    return { x: first.x - rect.x, y: first.y - rect.y, columns: getComputedStyle(el.querySelector('dl')).display };
  }));
  const native = await spacing();
  assert.deepEqual(await nativeStyle(page, selector), { width: 'thin', color: 'rgb(82, 82, 92) rgba(0, 0, 0, 0)' });
  await preference(page, true);
  await page.waitForFunction((sel) => document.querySelectorAll(`${sel} > .scrollbar-host`).length === 2, {}, selector);
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
