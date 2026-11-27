// harness.mjs — the app in a real browser, for smoke tests: the built site (dist/) from the server a
// preview uses, at the app's clean addresses (/reader, /overview…), Chrome with a throwaway profile,
// and pages that record everything the app leaves unhandled. Requests and sockets that leave the test
// server are refused, so a test never reaches a real translation server, an app running on this
// machine, or the internet.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { builtSite } from '../../../build/built.mjs';
import { ROUTES } from '../../../src/routes.ts';
import { startServer as serve } from '../../../build/serve.mjs';

// Throws when there is no built site, or a source changed since it was built: `npm run build`.
export function startServer() {
  return serve({ root: builtSite() });
}

// Chrome as installed, or CHROME_PATH.
export function chromePath() {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((p) => p && existsSync(p)) || null;
}

export function launch() {
  return puppeteer.launch({ executablePath: chromePath(), headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'] });
}

// The reader's engine held, for a test (openPage's `reader`): app/js/reader.js is answered with the
// module and a few lines after it that wrap startReader, which the route calls. Each keeps startReader
// as globalThis.__startReader and the running engine as globalThis.__reader (its stop:
// globalThis.__reader.stop()). READER_START=strict in the environment does the same for every page a
// test opens: the reader's own tests run on an engine started a second time.
//   keep    started once, as the route does; <html>'s and <body>'s attributes and the title just before
//           the start kept as globalThis.__beforeStart, the route's options (its go) as
//           globalThis.__startOptions.
//   strict  started, stopped and started again in one task, on the same frame: React's strict mode.
// (Started again on a frame drawn anew is the route's own: leaving and coming back.)
const READER_ENTRY_TAIL = {
  keep: `
const __shioriStart = startReader;
globalThis.__startReader = __shioriStart;
startReader = function (options) {
  const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  globalThis.__beforeStart = { html: attrs(document.documentElement), body: attrs(document.body), title: document.title };
  globalThis.__startOptions = options;
  return (globalThis.__reader = __shioriStart(options));
};
`,
  strict: `
const __shioriStart = startReader;
globalThis.__startReader = __shioriStart;
startReader = function (options) { __shioriStart(options).stop(); return (globalThis.__reader = __shioriStart(options)); };
`,
};
function readerEntry(reader) {
  if (!READER_ENTRY_TAIL[reader]) throw new Error(`no reader entry "${reader}"`);
  return readFileSync(join(builtSite(), 'app', 'js', 'reader.js'), 'utf8') + READER_ENTRY_TAIL[reader];
}

// The stylesheet of the bare pages the scrollbar tests draw app/js/scrollbar.js on (app/tests/fixtures/
// scrollbars.css), at an address of the test server's origin: a page links SCROLLBARS_SHEET, and its
// request handler answers it with scrollbarsSheet(request, origin) (true when it did).
export const SCROLLBARS_SHEET = '/scrollbars.css';
const scrollbarsCss = readFileSync(new URL('../fixtures/scrollbars.css', import.meta.url), 'utf8');
export function scrollbarsSheet(request, origin) {
  if (request.url() !== origin + SCROLLBARS_SHEET) return false;
  request.respond({ status: 200, contentType: 'text/css', body: scrollbarsCss });
  return true;
}

// The one page's own document with `sheets` linked after its stylesheet (openPage's `onePage`).
export function onePageWith(sheets) {
  const html = readFileSync(join(builtSite(), 'index.html'), 'utf8');
  const own = html.match(/<link rel="stylesheet"[^>]*>/)[0];
  return html.replace(own, own + sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join(''));
}

// The reader's own sheets, as the route table names them (paths from the site's root).
export const readerSheets = () => [...ROUTES.reader.sheets];

// Where a refused socket is opened instead: a port the browser itself refuses to connect to.
const NOWHERE = 'ws://127.0.0.1:9/';

// A page that keeps `page.problems`: uncaught errors, unhandled rejections and console errors — but
// not the refusals of requests that left the test server, which are the harness's own doing.
// Every load fetches its files whole, the browser's own cache left out: a file kept and only asked
// about loads sooner, and some tests' steps count on the time a full load takes.
// `allow`: other origins a test serves itself (a stand-in translation server). Every refused request
// is kept in `page.refused`, so a test can say nothing was asked of an address.
// `reader`: the reader's engine held (READER_ENTRY_TAIL, above); READER_START in the environment for
// every page a test opens. `onePage`: sheets (by address) the one page's document links after its own
// stylesheet (onePageWith).
export async function openPage(browser, origin, { allow = [], reader = process.env.READER_START, onePage = null } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setBypassServiceWorker(true);
  await page.setCacheEnabled(false);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`uncaught: ${e?.message || e}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url || '';
    if (/^Failed to load resource/.test(msg.text()) && !url.startsWith(origin)) return;
    if (msg.text().startsWith(`WebSocket connection to '${NOWHERE}' failed`)) return;
    problems.push(`console: ${msg.text()}${url ? ` (${url})` : ''}`);
  });
  const refused = [];
  await page.setRequestInterception(true);
  workersInterceptedRightly(page);
  const readerModule = reader ? readerEntry(reader) : null;
  const onePageDoc = onePage ? onePageWith(onePage) : null;
  page.on('request', (req) => {
    const url = req.url();
    if (readerModule && url.startsWith(origin) && new URL(url).pathname === '/app/js/reader.js') {
      req.respond({ status: 200, contentType: 'text/javascript', body: readerModule });
      return;
    }
    if (onePageDoc && url.startsWith(origin) && req.isNavigationRequest() && /^\/[a-z]*$/.test(new URL(url).pathname)) {
      req.respond({ status: 200, contentType: 'text/html', body: onePageDoc });
      return;
    }
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') || allow.some((other) => url.startsWith(other))) req.continue();
    else { refused.push(url); req.abort(); }
  });
  // A socket is not a request the interception sees. One a document (or a frame of it) opens to
  // another address is opened at NOWHERE instead and kept in `page.refused`: nothing is sent, and it
  // fails as an address nothing answers does.
  await page.exposeFunction('__harnessRefused', (url) => { refused.push(url); });
  await page.evaluateOnNewDocument((allowed, nowhere) => {
    window.WebSocket = new Proxy(window.WebSocket, { construct(Socket, [url, ...rest]) {
      const asked = String(url).replace(/^ws/, 'http');
      if (allowed.some((other) => asked.startsWith(other))) return new Socket(url, ...rest);
      window.__harnessRefused?.(String(url));
      return new Socket(nowhere, ...rest);
    } });
  }, [origin, ...allow], NOWHERE);
  page.problems = problems;
  page.refused = refused;
  return page;
}

// Puppeteer's interception pairs each paused request with the browser's report of it, and hands the
// 'request' listeners a request bound to the session of whichever of the two came second. A request a
// dedicated worker makes (the thumbnail worker's import of its one module) is paused on the page's
// session and reported on the worker's: when the report comes second, which load makes likelier,
// puppeteer continues the pause on the worker's session, where there is none, and the request waits
// for ever. The worker never runs, and the pictures it was asked for never come (9e,
// plans/frontend-react-probes/9e/hang.mjs: 5 copies of 60, twelve at a time with the CPU slowed six
// times; none with interception off). So a Fetch command sent on a worker's session for a pause of
// the page's own session is sent on the page's. `paused` holds the pauses the page's session holds now:
// an id goes once a Fetch command for it is sent there (by puppeteer or from a worker's session here).
function workersInterceptedRightly(page) {
  const own = page._client?.();
  if (!own) throw new Error('harness: this puppeteer has no page._client(): see workersInterceptedRightly');
  const paused = new Set();
  own.on('Fetch.requestPaused', (event) => paused.add(event.requestId));
  const sendOwn = own.send.bind(own);
  own.send = (method, params, ...rest) => {
    if (method.startsWith('Fetch.')) paused.delete(params?.requestId);
    return sendOwn(method, params, ...rest);
  };
  page.on('workercreated', (worker) => {
    const session = worker.client, send = session.send.bind(session);
    session.send = (method, params, ...rest) =>
      (method.startsWith('Fetch.') && paused.has(params?.requestId) ? own.send(method, params, ...rest) : send(method, params, ...rest));
  });
}

// Waits until `fn` (run in the page) returns something truthy; fails with what it last returned.
export async function until(page, fn, arg, { timeout = 15000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg).catch((e) => `evaluate failed: ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('evaluate failed'))) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  const reported = page.problems?.length ? ` — the page reported: ${page.problems.join(' | ')}` : '';
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})${reported}`);
}

// Waits until the page has stopped scrolling (still for a few frames): scrubs and glides ease the
// page toward where they point.
export function scrollSettled(page) {
  return page.evaluate(() => new Promise((resolve) => {
    let last = scrollY, still = 0;
    const tick = () => {
      if (scrollY === last) still++; else { still = 0; last = scrollY; }
      if (still >= 4) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}
