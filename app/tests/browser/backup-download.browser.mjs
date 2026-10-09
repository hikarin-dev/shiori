// backup-download.browser.mjs — a full backup is one file Chrome's own downloads save: Settings'
// full export runs behind a progress window that holds the page, hands the file over, and says so;
// the download folder ends up with a single whole .shioridb; restoring it — picked in Settings, or
// dropped on the library under the name a cut-short download leaves ("… .crdownload") — asks first,
// shows its progress, and brings the library back; checking it writes nothing.
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

// The top notice dialog's text once it matches `pattern` (run in the page), or 0.
const dialogText = (pattern) => {
  const text = [...document.querySelectorAll('.notice-overlay')].at(-1)?.innerText || '';
  return new RegExp(pattern).test(text) ? text : 0;
};
const clickDialog = (label) => {
  const top = [...document.querySelectorAll('.notice-overlay')].at(-1);
  const button = [...(top?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === label);
  if (!button) return 0;
  button.click();
  return 1;
};

async function seed(page) {
  return page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    for (const [gid, n] of [['1790000000301', 2], ['1790000000302', 3]]) {
      const pages = [];
      for (let i = 0; i < n; i++) {
        const canvas = new OffscreenCanvas(40, 60);
        canvas.getContext('2d').fillRect(0, 0, 10 * (i + 1), 60);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        pages.push({ url: `local://${gid}/${i + 1}.png`, galleryId: gid, blob, size: blob.size, cachedAt: Date.now() });
      }
      await api.transfer.write({ galleryId: gid, meta: { galleryId: gid, title: { english: `G${gid}`, japanese: '', pretty: '' }, tags: [], numPages: n },
        stat: { galleryId: gid, count: n, size: pages.reduce((s, p) => s + p.size, 0), latestAt: Date.now(), addedAt: Date.now(), coverPage: 1 }, pages, cover: null });
    }
    return (await api.transfer.ids()).sort();
  });
}

test("a full backup is saved as one file by the browser's downloads, and restores", { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/settings`, { waitUntil: 'load' });
  const library = await seed(page);

  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const saved = new Promise((resolve) => cdp.on('Browser.downloadProgress', (e) => { if (e.state !== 'inProgress') resolve(e); }));
  await page.evaluate(() => document.getElementById('exportBackupBtn').click());
  await page.evaluate(() => document.getElementById('backupFullBtn').click());
  const told = await until(page, dialogText, 'saving the backup|couldn', { what: 'the export outcome' });
  assert.match(told, /Your browser is saving the backup/);
  assert.match(told, /2 galleries and 5 pages/);
  const download = await saved;
  assert.equal(download.state, 'completed');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `one file: ${files}`);
  assert.match(files[0], /^shiori-\d{4}-\d{2}-\d{2}\.shioridb$/);
  const local = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  assert.equal(files[0], `shiori-${local}.shioridb`, 'named for the local date');
  assert.equal(fs.statSync(path.join(dir, files[0])).size, download.totalBytes);
  await page.evaluate(clickDialog, 'OK');

  await page.evaluate(async () => (await import('/app/js/api.js')).maintenance.clearAll());
  await (await page.$('#backupImportFile')).uploadFile(path.join(dir, files[0]));
  const asked = await until(page, dialogText, 'Restore this backup|can.t be restored', { what: 'the restore question' });
  assert.match(asked, /Restore this backup\?/);
  assert.match(asked, /2 galleries, 5 pages/);
  await page.evaluate(clickDialog, 'Restore');
  assert.match(await until(page, () => { const t = [...document.querySelectorAll('.notice-overlay')].at(-1)?.innerText || ''; return /Backup restored/.test(t) ? t : 0; }, null, { what: 'the restore outcome' }),
    /2 galleries and 5 pages are in your library/);
  assert.deepEqual(await page.evaluate(async () => (await (await import('/app/js/api.js')).transfer.ids()).sort()), library);
  await page.evaluate(clickDialog, 'OK');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('while a backup runs the page behind it is held: no keys, no focus, no drops, no leaving unasked', { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  const held = await page.evaluate(async () => {
    const { showOperation } = await import('/app/js/notice.js');
    let heard = 0;
    document.addEventListener('keydown', () => { heard++; }, true);
    document.addEventListener('drop', () => { heard++; }, true);
    const op = showOperation({ title: 'Working', stopLabel: 'Cancel' });
    op.update({ done: 3, total: 10, lines: ['3 of 10', ''] });
    const inertBehind = [...document.body.children].filter(el => !el.classList.contains('notice-overlay')).every(el => el.inert);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    document.body.dispatchEvent(drop);
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    const bar = document.querySelector('.notice-operation [role=progressbar]');
    // Focus lost to the page: Tab brings it back to the box's button.
    document.activeElement?.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const backInBox = document.activeElement?.textContent === 'Cancel';
    const out = { inertBehind, heard, dropRefused: drop.defaultPrevented, leaveAsked: leave.defaultPrevented, now: bar?.getAttribute('aria-valuenow'), backInBox };
    op.close();
    out.released = [...document.body.children].every(el => !el.inert);
    return out;
  });
  assert.deepEqual(held, { inertBehind: true, heard: 0, dropRefused: true, leaveAsked: true, now: '30', backInBox: true, released: true });
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('a cut-short download dropped on the library is recognised by its content, checked, and restored', { skip: !chromePath() }, async () => {
  const backup = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.shioridb')));
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/settings`, { waitUntil: 'load' });
  await page.evaluate(async () => (await import('/app/js/api.js')).maintenance.clearAll());
  // Checking reads the whole file and writes nothing.
  await (await page.$('#backupCheckFile')).uploadFile(backup);
  assert.match(await until(page, dialogText, 'intact|problems', { what: 'the check outcome' }), /complete and intact[\s\S]*2 galleries and 5 pages/);
  await page.evaluate(clickDialog, 'OK');
  assert.deepEqual(await page.evaluate(async () => (await import('/app/js/api.js')).transfer.ids()), []);

  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'pick'; i.hidden = true; document.body.append(i); });
  await (await page.$('#pick')).uploadFile(backup);
  await page.evaluate(() => {
    const original = document.getElementById('pick').files[0];
    const file = new File([original], 'Unconfirmed 912345.crdownload');
    const data = new DataTransfer();
    data.items.add(file);
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  assert.match(await until(page, dialogText, 'Restore this backup|can.t be restored', { what: 'the restore question' }), /Restore this backup\?/);
  await page.evaluate(clickDialog, 'Restore');
  await until(page, () => /Backup restored/.test([...document.querySelectorAll('.notice-overlay')].at(-1)?.innerText || '') ? 1 : 0, null, { what: 'the restore outcome' });
  await page.evaluate(clickDialog, 'OK');
  assert.equal((await page.evaluate(async () => (await import('/app/js/api.js')).transfer.ids())).length, 2);
  assert.deepEqual(page.problems, []);
  await page.close();
});
