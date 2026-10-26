// import-worker.browser.mjs — with the app's service worker running, a dropped batch is handed to it:
// the question says it runs in the background, the tracker says the background worker runs it, and
// closing the tab that started it doesn't stop it — another app tab keeps the worker going, and
// every title comes in.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { zipCreate } from '../../js/zip.js';

const TITLES = 120, PAGES = 4;
let server, origin, browser, dir;

function png(n, page) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(12, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 12 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [n % 256, page * 9 % 256, 77]).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-worker-'));
  fs.mkdirSync(path.join(dir, 'Lot'));
  for (let n = 1; n <= TITLES; n++) {
    fs.writeFileSync(path.join(dir, 'Lot', `Title ${String(n).padStart(3, '0')}.cbz`),
      zipCreate(Array.from({ length: PAGES }, (_, p) => ({ name: `${p + 1}.png`, data: png(n, p + 1) }))));
  }
});
after(async () => { await browser?.close(); server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// A page with the service worker in charge (unlike the harness's pages, which bypass it).
async function workerPage(pathname) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)));
  await page.goto(origin + pathname, { waitUntil: 'load' });
  await until(page, () => !!navigator.serviceWorker?.controller, null, { what: 'the service worker in charge', timeout: 30000 });
  return page;
}

test('a dropped batch runs in the service worker, and closing the tab that started it doesn\'t stop it', { skip: !chromePath() }, async () => {
  const lib = await workerPage('/library');
  const cdp = await lib.createCDPSession();
  const data = { items: [], files: [path.join(dir, 'Lot')], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 640, y: 500, data });
  const asked = await until(lib, () => document.querySelector('.notice-modal')?.innerText, null, { what: 'the question' });
  assert.match(asked, /any open Shiori tab keeps it going/, 'it says where it will run');
  await lib.click('.notice-actions .btn.primary');
  const tag = await until(lib, () => {
    const p = document.querySelector('#importTracker .ib[data-state="running"]');
    return p && p.querySelector('.run-tag').textContent;
  }, null, { what: 'the batch under way' });
  assert.equal(tag, 'Background worker');

  // Another app tab, then the one that started it closes, part-way.
  const tasks = await workerPage('/tasks');
  const before = await until(tasks, () => document.querySelector('#tkImports .ib')?.querySelector('.ib-tally')?.textContent, null, { what: 'the batch on the tasks page' });
  assert.ok(before.includes(` / ${TITLES} titles`), `still under way when its tab closes: ${before}`);
  await cdp.detach();
  await lib.close();
  const end = await until(tasks, () => {
    const p = document.querySelector('#tkImports .ib');
    return p?.dataset.state === 'done' && p.querySelector('.ib-tally').textContent;
  }, null, { what: 'the batch to end', timeout: 180000 });
  assert.equal(end, `Imported ${TITLES} titles`);
  const titles = await tasks.evaluate(async (pages) => {
    const api = await import('/app/js/api.js');
    const ids = (await api.galleries.idsSorted({})).map(String);
    return (await Promise.all(ids.map((id) => api.galleries.get(id)))).filter((g) => g?.count === pages).length;
  }, PAGES);
  assert.equal(titles, TITLES, 'every title is in, with all its pages');
  assert.deepEqual(tasks.errors, []);
  await tasks.close();
});
