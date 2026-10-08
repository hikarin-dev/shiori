// backup-download.browser.mjs — a full backup is one file Chrome's own downloads save: Settings'
// full export hands it over, the download folder ends up with a single whole .shioridb, and
// importing that file restores the library.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser, dir;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-download-'));
});

after(async () => {
  await browser?.close();
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// Settings' backup status once it matches `pattern` (run in the page).
const statusMatching = (pattern) => { const t = document.getElementById('backupStatus')?.textContent || ''; return new RegExp(pattern).test(t) ? t : 0; };

test("a full backup is saved as one file by the browser's downloads, and restores", { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/settings`, { waitUntil: 'load' });
  const library = await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    for (const [gid, n] of [['1790000000301', 2], ['1790000000302', 3]]) {
      const pages = [];
      for (let i = 0; i < n; i++) {
        const canvas = new OffscreenCanvas(40, 60);
        canvas.getContext('2d').fillRect(0, 0, 10 * (i + 1), 60);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        pages.push({ url: `local://${gid}/${i + 1}.png`, galleryId: gid, blob, size: blob.size, cachedAt: Date.now() });
      }
      await api.transfer.write({ galleryId: gid, meta: { galleryId: gid, title: { english: gid, japanese: '', pretty: '' }, tags: [], numPages: n },
        stat: { galleryId: gid, count: n, size: pages.reduce((s, p) => s + p.size, 0), latestAt: Date.now(), addedAt: Date.now(), coverPage: 0 }, pages, cover: null });
    }
    return (await api.transfer.ids()).sort();
  });

  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const saved = new Promise((resolve) => cdp.on('Browser.downloadProgress', (e) => { if (e.state !== 'inProgress') resolve(e); }));
  await page.evaluate(() => document.getElementById('exportBackupBtn').click());
  await page.evaluate(() => document.getElementById('backupFullBtn').click());
  const status = await until(page, statusMatching, 'downloads|failed', { what: 'the export status' });
  assert.match(status, /^Exported 2 galleries \/ 5 images — saving to your downloads\.$/);
  const download = await saved;
  assert.equal(download.state, 'completed');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `one file: ${files}`);
  assert.match(files[0], /^shiori-\d{4}-\d{2}-\d{2}\.shioridb$/);
  assert.equal(fs.statSync(path.join(dir, files[0])).size, download.totalBytes);

  await page.evaluate(async () => (await import('/app/js/api.js')).maintenance.clearAll());
  await (await page.$('#backupImportFile')).uploadFile(path.join(dir, files[0]));
  assert.match(await until(page, statusMatching, '^Imported|failed', { what: 'the import status' }), /^Imported 2 galleries, 5 images/);
  assert.deepEqual(await page.evaluate(async () => (await (await import('/app/js/api.js')).transfer.ids()).sort()), library);
  assert.deepEqual(page.problems, []);
  await page.close();
});
