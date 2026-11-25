// harness.mjs — the app in a real browser, for smoke tests: the built site (dist/) from the server a
// preview uses, at the app's clean addresses (/reader, /overview…), Chrome with a throwaway profile,
// and pages that record everything the app leaves unhandled. Requests and sockets that leave the test
// server are refused, so a test never reaches a real translation server, an app running on this
// machine, or the internet.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { builtSite } from '../../../build/built.mjs';
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

// Entries for the reader's page, in place of app/js/reader-page.js (openPage's `reader`). Each runs
// boot.js as the page's own does, and keeps startReader as globalThis.__startReader and the running
// engine as globalThis.__reader (its stop: globalThis.__reader.stop()).
//   keep    started once, as the page's own entry does; <html>'s and <body>'s attributes and the title
//           just before the start kept as globalThis.__beforeStart.
//   strict  started, stopped and started again in one task, on the same frame: React's strict mode.
//   again   started, stopped, the frame drawn again as the page had it, and started again.
const READER_ENTRY_HEAD = `import './boot.js';
import { startReader } from './reader.js';
globalThis.__startReader = startReader;
`;
export const READER_ENTRIES = {
  keep: `${READER_ENTRY_HEAD}const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
globalThis.__beforeStart = { html: attrs(document.documentElement), body: attrs(document.body), title: document.title };
globalThis.__reader = startReader();
`,
  strict: `${READER_ENTRY_HEAD}startReader().stop();
globalThis.__reader = startReader();
`,
  again: `${READER_ENTRY_HEAD}const frame = document.body.innerHTML;
startReader().stop();
document.body.innerHTML = frame;
globalThis.__reader = startReader();
`,
};

// The reader's page has sheets the route that will draw it inside the one page does not load: the
// old pages' shared sheets. The rest of its sheets are the reader's own.
export const OLD_PAGE_SHEETS = ['base.css', 'reader-aliases.css', 'notice.css'];

// The reader's page as the document of its route will be (openPage's `styles: 'route'`): the old
// pages' sheets taken out, the one page's built stylesheets put in before the reader's own (its
// entry's, and with `all` every route's too: a route's sheet stays once it has been loaded), and
// <html class="dark"> as the one page has it.
export function routeDocument({ all = true } = {}) {
  const dist = builtSite();
  const index = readFileSync(join(dist, 'index.html'), 'utf8');
  const entry = [...index.matchAll(/<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/g)].map((m) => `/${m[1]}`);
  const routes = all ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.css')).map((f) => `/assets/${f}`).filter((f) => !entry.includes(f)) : [];
  let html = readFileSync(join(dist, 'app', 'reader.html'), 'utf8');
  for (const sheet of OLD_PAGE_SHEETS) {
    const link = new RegExp(`\\s*<link rel="stylesheet" href="${sheet.replace('.', '\\.')}">`);
    if (!link.test(html)) throw new Error(`reader.html has no ${sheet}`);
    html = html.replace(link, '');
  }
  const first = html.match(/\s*<link rel="stylesheet"[^>]*>/);
  html = html.replace(first[0], [...entry, ...routes].map((href) => `\n  <link rel="stylesheet" href="${href}">`).join('') + first[0]);
  return html.replace(/<html lang="en"/, '<html lang="en" class="dark"');
}

// The reader's own sheets, as the reader's page links them (after <base href="app/">).
export function readerSheets() {
  const html = readFileSync(join(builtSite(), 'app', 'reader.html'), 'utf8');
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]).filter((href) => !OLD_PAGE_SHEETS.includes(href));
}

// Where a refused socket is opened instead: a port the browser itself refuses to connect to.
const NOWHERE = 'ws://127.0.0.1:9/';

// A page that keeps `page.problems`: uncaught errors, unhandled rejections and console errors — but
// not the refusals of requests that left the test server, which are the harness's own doing.
// Every load fetches its files whole, the browser's own cache left out: a file kept and only asked
// about loads sooner, and some tests' steps count on the time a full load takes.
// `allow`: other origins a test serves itself (a stand-in translation server). Every refused request
// is kept in `page.refused`, so a test can say nothing was asked of an address.
// `reader`: the reader's page starts its engine from app/js/reader-page.js; one of READER_ENTRIES
// answers that file instead, so a test can hold the engine and stop it. READER_START=strict or again
// in the environment does the same for every page a test opens: the reader's own tests run on an
// engine started a second time.
export async function openPage(browser, origin, { allow = [], reader = process.env.READER_START } = {}) {
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
  if (reader && !READER_ENTRIES[reader]) throw new Error(`no reader entry "${reader}"`);
  page.on('request', (req) => {
    const url = req.url();
    if (reader && url.startsWith(origin) && new URL(url).pathname === '/app/js/reader-page.js') {
      req.respond({ status: 200, contentType: 'text/javascript', body: READER_ENTRIES[reader] });
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
