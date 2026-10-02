// harness.mjs — the app in a real browser, for smoke tests: a static server for the repo at the clean
// URLs the dev server gives (/reader, /overview…), Chrome with a throwaway profile, and pages that
// record everything the app leaves unhandled. Requests that leave the test server are refused, so a
// test never reaches a real translation server or the internet.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/markdown', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mjs.map': 'application/json',
};
const PAGES = { '/': 'app/library.html', '/library': 'app/library.html', '/settings': 'app/settings.html',
  '/reader': 'app/reader.html', '/overview': 'app/overview.html' };

const _file = async (path) => { try { return (await stat(path)).isFile(); } catch { return false; } };

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://test').pathname);
      let full = normalize(join(ROOT, PAGES[path.replace(/\/+$/, '') || '/'] ?? path.slice(1)));
      if (!full.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
      if (!await _file(full) && !extname(full) && await _file(full + '.html')) full += '.html';
      if (!await _file(full)) {   // what the static host does: its 404 page, which routes to the app
        res.writeHead(404, { 'Content-Type': 'text/html' }).end(await readFile(join(ROOT, '404.html')));
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(full));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
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

// A page that keeps `page.problems`: uncaught errors, unhandled rejections and console errors — but
// not the refusals of requests that left the test server, which are the harness's own doing.
export async function openPage(browser, origin) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setBypassServiceWorker(true);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`uncaught: ${e?.message || e}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url || '';
    if (/^Failed to load resource/.test(msg.text()) && !url.startsWith(origin)) return;
    problems.push(`console: ${msg.text()}${url ? ` (${url})` : ''}`);
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) req.continue();
    else req.abort();
  });
  page.problems = problems;
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
