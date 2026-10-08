import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

let server, origin, browser;
before(async () => {
  ({ server, origin } = await startServer());
  if (!chromePath()) return;
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function fresh(t, route = '/settings') {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => localStorage.removeItem('shiori:customScrollbar'));
  if (route === '/scrollbar-fixture') {
    page.removeAllListeners('request');
    page.on('request', request => {
      if (request.url() === origin + route) request.respond({ status: 200, contentType: 'text/html',
        body: '<!doctype html><link rel="icon" href="/icons/icon16.png"><link rel="stylesheet" href="/app/base.css"><body><script type="module" src="/app/js/scrollbar.js"></script>' });
      else if (request.url().startsWith(origin)) request.continue();
      else request.abort();
    });
  }
  await page.goto(origin + route);
  return page;
}

test('native defaults use space only when the page scrolls and keep panel scrollbars slim', { skip: !chromePath() }, async t => {
  const page = await fresh(t, '/scrollbar-fixture');
  await page.evaluate(() => {
    document.body.replaceChildren();
    const panel = document.createElement('div');
    panel.id = 'panel';
    panel.style.cssText = 'width:200px;height:150px;overflow:auto';
    panel.innerHTML = '<div style="height:1500px"></div>';
    document.body.append(panel);
  });
  const measure = () => page.evaluate(() => ({
    width: innerWidth, body: document.body.getBoundingClientRect().width,
    gutter: getComputedStyle(document.documentElement).scrollbarGutter,
    pageStyle: getComputedStyle(document.documentElement).scrollbarWidth,
    panelGutter: document.querySelector('#panel').offsetWidth - document.querySelector('#panel').clientWidth,
    overlays: document.querySelectorAll('.scrollbar-host').length,
  }));
  const short = await measure();
  assert.equal(short.gutter, 'auto');
  assert.equal(short.pageStyle, 'auto');
  assert.equal(short.width - short.body, 0);
  assert.equal(short.panelGutter, 10);
  assert.equal(short.overlays, 0);
  await page.evaluate(() => { document.body.style.minHeight = '300vh'; });
  assert.deepEqual(await measure(), { ...short, body: short.body - 15 }, 'the native page scrollbar takes space only when needed');
  // Native scrollbar hit testing remains available on both the page and the inner panel.
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.mouse.move(198, 12);
  await page.mouse.down();
  await page.mouse.move(198, 75, { steps: 5 });
  await page.mouse.up();
  assert.ok(await page.$eval('#panel', el => el.scrollTop > 400));
  await page.mouse.move(short.width - 7, 80);
  await page.mouse.down();
  await page.mouse.move(short.width - 7, 220, { steps: 5 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => scrollY > 100));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.evaluate(() => { document.body.style.minHeight = ''; });
  assert.deepEqual(await measure(), short, 'removing overflow releases the scrollbar space');
});

const firefox = [process.env.FIREFOX_PATH, 'C:/Program Files/Mozilla Firefox/firefox.exe',
  '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox'].find(path => path && existsSync(path));
test('Firefox keeps its own scrollbars even with the experimental preference saved', { skip: !firefox }, async () => {
  const firefoxBrowser = await puppeteer.launch({ browser: 'firefox', executablePath: firefox, headless: true });
  try {
    const page = await firefoxBrowser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(origin) ? request.continue() : request.abort());
    await page.evaluateOnNewDocument(() => localStorage.setItem('shiori:customScrollbar', 'true'));
    await page.goto(origin + '/settings');
    const state = await page.evaluate(async () => {
      const { customScrollbarAvailable } = await import('/app/js/scrollbar.js');
      const root = document.documentElement, style = getComputedStyle(root);
      return { available: customScrollbarAvailable, gutter: style.scrollbarGutter,
        width: style.scrollbarWidth, color: style.scrollbarColor,
        classes: root.className, overlays: document.querySelectorAll('.scrollbar-host, .dd-options').length,
        hidden: document.querySelector('#experimentalSection').hidden };
    });
    assert.equal(state.available, false);
    assert.equal(state.gutter, 'auto');
    assert.equal(state.width, 'auto');
    assert.equal(state.color, 'auto');
    assert.doesNotMatch(state.classes, /(?:chromium|custom|desktop)-scrollbars/);
    assert.equal(state.overlays, 0);
    assert.equal(state.hidden, true);
  } finally { await firefoxBrowser.close(); }
});

test('experimental toggle persists and restores native controls and picker structure', { skip: !chromePath() }, async t => {
  const page = await fresh(t);
  assert.equal(await page.$eval('#customScrollbar', el => el.checked), false);
  assert.equal(await page.$eval('#experimentalSection', el => el.closest('.panel').id), 'panelLibrary');
  assert.equal(await page.$('.scrollbar-host'), null);
  assert.equal(await page.$('#langSelect .dd-options'), null);
  const selection = await page.$eval('#langSelect', el => el.value);
  await page.click('label[for="customScrollbar"]');
  await page.waitForSelector('.page-scrollbar');
  assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 0);
  assert.ok(await page.$('#langSelect .dd-options'));
  assert.equal(await page.$eval('#langSelect', el => el.value), selection);
  // A second tab reads the persisted preference and follows later changes.
  const other = await openPage(browser, origin);
  t.after(() => other.close());
  await other.goto(origin + '/settings');
  await other.waitForSelector('.page-scrollbar');
  assert.equal(await other.$eval('#customScrollbar', el => el.checked), true);
  await page.bringToFront();
  await page.click('label[for="customScrollbar"]');
  await page.waitForFunction(() => !document.querySelector('.scrollbar-host'));
  await other.waitForFunction(() => !document.querySelector('.scrollbar-host'), { polling: 50 });
  assert.equal(await page.$('#langSelect .dd-options'), null);
  assert.equal(await page.$eval('#langSelect', el => el.value), selection);
  assert.equal(await other.$eval('#customScrollbar', el => el.checked), false);
  const cdp = await page.createCDPSession();
  const scripts = new Map();
  cdp.on('Debugger.scriptParsed', ({ scriptId, url }) => scripts.set(scriptId, url));
  await cdp.send('Debugger.enable');
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  assert.ok([...scripts.values()].some(url => url.endsWith('/scrollbar.js')));
  assert.deepEqual(listeners.filter(el => scripts.get(el.scriptId)?.endsWith('/scrollbar.js')), [], 'disabling the experiment must remove its document listeners');
  await page.reload();
  assert.equal(await page.$('.scrollbar-host'), null);
  assert.equal(await page.$eval('#customScrollbar', el => el.checked), false);
});
