// settings-storage.browser.mjs — Settings → Storage as the one page draws it (src/routes/settings/
// storage.tsx, folders.tsx), held to what 1.3's page gave: each table below has its record
// (records/settings-storage.browser.mjs.<table>.json, records.mjs), 1.3's behaviour as measured on
// 2026-11-24, which a deliberate change edits in the same commit. Each page runs in a browser context of
// its own (its own storage and private file system), seeded as 1.3's was; the library's folders are
// folders of the browser's private file system (as library-folders.browser.mjs stands them in: a folder
// picked by hand can't be handed to a headless browser). Nothing here reaches a real folder, the desktop
// app or any other address: the harness refuses every address the test server isn't, and downloads are
// refused.
//
//   - One table of actions on the library's card: after each, the library, the stored keys and the
//     words on the card (rows, marks, tasks, menus, questions, status) as 1.3's page left them.
//   - The location choice as far as it goes without the desktop app; a library kept by the desktop app
//     seen from a site (only the location, no upgrades, its own write count); a browser that can't pick
//     folders; the desktop app's window by a stand-in for its bridge (the archiving card, its check).
//   - Backup: the export choice (focus, Escape, focus back, each choice starting what 1.3 starts), Import
//     and Check; a backup running in another window holding both resets back.
//   - The upgrades' rows, the write counter (its tip, Reset; a library kept as files' count read every
//     3 s, by stand-in), Clear All and Factory Reset (each asked twice).
//   - A change of language, the phone form, and leaving the page five times leaving nothing behind.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/settings';
const FILE = 'settings-storage.browser.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const skip = (t) => { if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return true; } return false; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// A desktop library's address where nothing answers: never one of the desktop app's own ports, where a
// real one may be running (the harness refuses what a page asks of another address either way).
const AWAY = 'http://127.0.0.1:9';

// What every page reads and does, the same on both (installed before any script of the page runs).
function helpers() {
  const api = () => import('/app/js/api.js');
  const shown = (el) => !!el && el.getClientRects().length > 0;
  // The dialog on top: notice.js's on 1.3's page, the notice host's on the new one (both say role).
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(shown)
    .filter((d) => !d.closest('#backupBox, #aboutBox, #translateBox') || d.matches('#backupBox'));
  window.__s = {
    rows: () => [...document.querySelectorAll('#foldersSection .lf-item')].map((r) => ({
      name: r.querySelector('.lf-title')?.textContent ?? '',
      meta: r.querySelector('.lf-meta')?.textContent ?? '',
      badges: [...r.querySelectorAll('.key-status-badge')].map((b) => [b.textContent, b.classList.contains('unset'), b.dataset.tip || '']),
      busy: r.classList.contains('busy'), hidden: r.classList.contains('is-hidden'),
      job: r.querySelector('.lf-job-text')?.textContent ?? null,
      button: r.querySelector('[data-act="allow"], [data-act="claim"]')?.textContent ?? '',
      menu: !!r.querySelector('.lf-more'),
      attention: [...r.querySelectorAll('.lf-att-item')].map((li) => li.textContent),
    })),
    // A status line's words while it shows ('' while not).
    status: (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const on = el.hasAttribute('data-slot') ? el.hasAttribute('data-shown') : !el.classList.contains('hidden');
      return on ? el.textContent : '';
    },
    dialog: () => {
      const d = dialogs().at(-1);
      if (!d) return null;
      // (A choice from a list: 1.3's native select, the new page's drawn one; said by what it shows.)
      const list = d.querySelector('select, [data-slot="select-trigger"]');
      return { title: d.querySelector('h2')?.textContent ?? '', text: d.querySelector('p')?.textContent ?? '',
        // A progress or operation window (its bar), not a question.
        busy: !!d.querySelector('[role="progressbar"]'),
        choice: list ? (list.tagName === 'SELECT' ? list.selectedOptions[0]?.textContent : list.textContent) ?? '' : null,
        buttons: [...d.querySelectorAll('button')].filter((b) => shown(b) && !b.matches('[data-slot="select-trigger"]')).map((b) => b.textContent.trim()).filter(Boolean) };
    },
    dialogs: () => dialogs().length,
    // Presses the top dialog's button named `label`; true once pressed.
    answer: (label) => {
      const b = [...(dialogs().at(-1)?.querySelectorAll('button') || [])].find((x) => shown(x) && x.textContent.trim() === label);
      b?.click();
      return !!b;
    },
    // The remove question's switch (moving the galleries first).
    flip: () => {
      const d = dialogs().at(-1);
      const s = d?.querySelector('[role="switch"]');
      s?.click();
      return !!s;
    },
    switchOn: () => { const s = dialogs().at(-1)?.querySelector('[role="switch"]'); return s ? (s.checked ?? s.getAttribute('aria-checked') === 'true') : null; },
    row: (name) => [...document.querySelectorAll('#foldersSection .lf-item')].find((r) => r.querySelector('.lf-title')?.textContent === name) || null,
    more: (name) => { const b = window.__s.row(name)?.querySelector('.lf-more'); b?.click(); return !!b; },
    menu: () => { const m = [...document.querySelectorAll('.lf-menu')].filter(shown).at(-1); return m ? [...m.querySelectorAll('.ctx-menu-item')].map((b) => b.textContent) : null; },
    choose: (label) => { const b = [...document.querySelectorAll('.lf-menu .ctx-menu-item')].filter(shown).find((x) => x.textContent === label); b?.click(); return !!b; },
    act: (name, act) => { const b = window.__s.row(name)?.querySelector(`[data-act="${act}"]`); b?.click(); return !!b; },
    library: async () => {
      const a = await api();
      return { places: (await a.folders.list()).map((f) => ({ name: f.kind === 'browser' ? '(browser)' : f.name, hidden: !!f.hidden, isDefault: !!f.isDefault,
        access: f.access, galleries: f.galleries, removable: !!f.removable })), ids: (await a.transfer.ids()).map(String).sort() };
    },
    stored: () => Object.fromEntries(Object.keys(localStorage).filter((k) => /^(shiori[:-]|_shiori)/.test(k)).sort().map((k) => [k, localStorage.getItem(k)])),
    // Folder `name`'s claim as another app's (`epoch` up: it took it over).
    claim: async (name, epoch) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
      const w = await (await (await dir.getDirectoryHandle('.shiori', { create: true })).getFileHandle('owner.json', { create: true })).createWritable();
      await w.write(JSON.stringify({ format: 'shiori-owner', version: 1, owner: 'a1b2c3d4e5f60708', by: { app: 'desktop', host: 'OTHER-PC' }, at: 1, epoch }));
      await w.close();
    },
    // Folder `id`'s hand-over (S32): the other app's moment passed (its mark aged) rather than waited out.
    passWait: async (id) => {
      const db = await new Promise((r) => { const q = indexedDB.open('shiori-cache'); q.onsuccess = () => r(q.result); });
      try {
        await new Promise((r) => {
          const tx = db.transaction('folders', 'readwrite'), store = tx.objectStore('folders'), q = store.get(id);
          q.onsuccess = () => { const f = q.result; if (f?.handover) store.put({ ...f, handover: { ...f.handover, at: f.handover.at - 60000 } }); };
          tx.oncomplete = r;
        });
      } finally { db.close(); }
    },
    idOf: async (name) => (await (await api()).folders.list()).find((f) => f.name === name)?.id,
  };
}

// The library both pages start from: this browser's storage (the default) with a gallery, Lib A empty,
// Lib B with two galleries.
async function seed(page) {
  await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const root = await navigator.storage.getDirectory();
    const png = async (hue) => { const c = new OffscreenCanvas(60, 90); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, 60, 90); return c.convertToBlob({ type: 'image/png' }); };
    const put = async (gid, name, hue) => {
      await api.meta.put({ galleryId: gid, title: { english: name, japanese: '', pretty: '' }, tags: [], numPages: 2 });
      for (let n = 1; n <= 2; n++) await api.pages.put(gid, n, await png(hue + n * 20));
    };
    await put('1790000000001', 'Alpha', 0);
    const a = await api.folders.add(await root.getDirectoryHandle('Lib A', { create: true }));
    const b = await api.folders.add(await root.getDirectoryHandle('Lib B', { create: true }));
    const browserId = (await api.folders.list()).find((f) => f.kind === 'browser').id;
    await api.folders.setDefault(b.id);
    await put('1790000000002', 'Beta', 120);
    await put('1790000000003', 'Gamma', 240);
    await api.folders.setDefault(browserId);
    void a;
  });
  // A page of the app once, until what it makes of the galleries at start (their covers) is made and
  // the places' sizes stand still: both pages then start from the same sizes.
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  let last = '', still = 0;
  for (let i = 0; i < 50 && still < 4; i++) {
    const now = await page.evaluate(async () => JSON.stringify((await (await import('/app/js/api.js')).folders.list()).map((f) => f.size)));
    still = now === last ? still + 1 : 0;
    last = now;
    await pause(300);
  }
}

// A page of `path` in a browser context of its own, its storage seeded (`library`) or not, Storage shown.
async function open(t, path, { library = true, storage = {}, before: early, viewport, seedMore = false } = {}) {
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  await page.evaluateOnNewDocument(helpers);
  if (library) await seed(page);
  if (seedMore) {
    // A gallery with its source's details and no rating or category yet (what the upgrade fills in).
    await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      const api = await import('/app/js/api.js');
      await api.meta.put({ galleryId: '1790000000004', title: { english: 'Delta', japanese: '', pretty: '' }, tags: [], numPages: 0,
        source: 'source-1', sourceMetadata: { kind: 'stand-in' } });
    });
  }
  await page.evaluateOnNewDocument((storage) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const [key, raw] of Object.entries(storage)) localStorage.setItem(key, raw);
  }, storage);
  if (early) await page.evaluateOnNewDocument(early);
  if (viewport) await page.setViewport(viewport);
  page.problems.length = 0;   // (the file seeded from has no icon of its own)
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await shownStorage(page);
  return page;
}
async function shownStorage(page) {
  await until(page, () => !!document.getElementById('navStorage') && !!document.getElementById('clearAllBtn'), null, { what: 'the Storage panel' });
  // (Pressed again until it shows: 1.3's markup is there before its script listens. A question may
  // stand over the page: pressed by script.)
  await until(page, () => { const panel = document.getElementById('panelStorage'); if (!panel.classList.contains('active')) document.getElementById('navStorage').click(); return panel.classList.contains('active'); }, null, { what: 'Storage shown' });
}

const run = (page, fn, arg) => page.evaluate(fn, arg);
// What the card shows once it has settled: the same twice in a row, 300 ms apart.
async function settled(page, { rows = 0 } = {}) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    const now = JSON.stringify(await run(page, () => ({ rows: window.__s.rows(), dialog: window.__s.dialog(), status: window.__s.status('lfStatus') })));
    if (now === last && JSON.parse(now).rows.length >= rows) return JSON.parse(now);
    last = now;
    await pause(300);
  }
  return JSON.parse(last);
}
async function snapshot(page) {
  const card = await settled(page);
  return { card, library: await run(page, () => window.__s.library()), stored: await run(page, () => window.__s.stored()) };
}
async function menuOf(page, name) {
  await page.bringToFront();
  await until(page, (n) => window.__s.more(n), name, { what: `${name}'s menu button` });
  const items = await until(page, () => window.__s.menu(), null, { what: `${name}'s menu` });
  return items;
}
async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await until(page, () => !window.__s.menu(), null, { what: 'the menu closed' });
}
async function choose(page, name, item) {
  await menuOf(page, name);
  await until(page, (i) => window.__s.choose(i), item, { what: `${item} in ${name}'s menu` });
}
const answer = (page, label) => until(page, (l) => window.__s.answer(l), label, { what: `the question's ${label}` });
const asked = (page, n = 1) => until(page, (n) => window.__s.dialogs() >= n && window.__s.dialog(), n, { what: 'a question' });
const job = (page, id, news) => run(page, async ({ id, news }) => {
  const platform = await import('/app/js/platform.js');
  await platform.jobs.publish({ gid: `folder-${id}`, kind: 'folder', at: Date.now(), ...news });
}, { id, news });

// ── The library's card: one table on both pages ──────────────────────────────────────────────────
// Each step: what it does (and what it waits for, the same on both pages).
const STEPS = [
  ['drawn', async (p) => { await settled(p, { rows: 3 }); }],
  ['each place\'s menu', async (p) => {
    const menus = {};
    for (const { name, menu } of await run(p, () => window.__s.rows())) if (menu) { menus[name] = await menuOf(p, name); await closeMenu(p); }
    return menus;
  }],
  ['Lib A made the default', (p) => choose(p, 'Lib A', 'Set as default')],
  ['This browser the default again', (p) => choose(p, 'This browser', 'Set as default')],
  ['Lib B hidden (no question)', async (p) => { await choose(p, 'Lib B', 'Hide'); await until(p, () => window.__s.row('Lib B')?.classList.contains('is-hidden') && !window.__s.row('Lib B').classList.contains('busy'), null, { what: 'hidden' }); }],
  ['a hidden place\'s menu', async (p) => { const m = await menuOf(p, 'Lib B'); await closeMenu(p); return m; }],
  ['Lib B shown again', async (p) => { await choose(p, 'Lib B', 'Show'); await until(p, () => !window.__s.row('Lib B')?.classList.contains('is-hidden') && !window.__s.row('Lib B').classList.contains('busy'), null, { what: 'shown' }); }],
  ['a task on Lib A, under way', async (p) => {
    const id = await run(p, () => window.__s.idOf('Lib A'));
    await job(p, id, { status: 'progress', title: 'Lib A', labelKey: 'lf.task_checking', labelArgs: { name: 'Lib A' }, done: 1, total: 4, found: 2 });
    await until(p, () => window.__s.row('Lib A')?.classList.contains('busy'), null, { what: 'busy' });
  }],
  ['its task ending, with what it couldn\'t read', async (p) => {
    const id = await run(p, () => window.__s.idOf('Lib A'));
    await job(p, id, { status: 'done', title: 'Lib A', labelKey: 'lf.task_checking', done: 4, total: 4, found: 2, problems: 3 });
    await until(p, () => !window.__s.row('Lib A')?.classList.contains('busy'), null, { what: 'not busy' });
  }],
  ['Remove Lib A asked, then cancelled', async (p) => { await choose(p, 'Lib A', 'Remove'); await asked(p); await answer(p, 'Cancel'); await until(p, () => !window.__s.dialog(), null, { what: 'no question' }); }],
  ['Lib A removed', async (p) => {
    await choose(p, 'Lib A', 'Remove'); await asked(p); await answer(p, 'Remove folder');
    await until(p, () => !window.__s.row('Lib A'), null, { what: 'Lib A gone', timeout: 20000 });
  }],
  ['Remove Lib B: moving its galleries asked again, refused, the switch off', async (p) => {
    await choose(p, 'Lib B', 'Remove'); await asked(p);
    await until(p, () => window.__s.flip(), null, { what: 'the switch' });
    await asked(p, 2);
    const second = await run(p, () => window.__s.dialog());
    await answer(p, 'Cancel');
    await until(p, () => window.__s.dialogs() === 1 && window.__s.switchOn() === false, null, { what: 'the switch off' });
    return second;
  }],
  ['…then the switch on, moving to This browser, and removed', async (p) => {
    await until(p, () => window.__s.flip(), null, { what: 'the switch' });
    await asked(p, 2);
    await answer(p, 'Move');
    await until(p, () => window.__s.dialogs() === 1 && window.__s.switchOn() === true, null, { what: 'the switch on' });
    await answer(p, 'Remove folder');
    await until(p, () => !window.__s.row('Lib B'), null, { what: 'Lib B gone', timeout: 30000 });
    await until(p, async () => (await window.__s.library()).ids.length === 3, null, { what: 'its galleries moved', timeout: 30000 });
  }],
  ['Lib C added: its row at once, then checked', async (p) => {
    await run(p, () => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Lib C', { create: true }); });
    await run(p, () => document.getElementById('lfAdd').click());
    await until(p, () => !!window.__s.row('Lib C') && !window.__s.row('Lib C').classList.contains('busy'), null, { what: 'Lib C added', timeout: 20000 });
  }],
  ['Lib C taken over by another app: marked, Take back', async (p) => {
    await run(p, () => window.__s.claim('Lib C', 5));
    await run(p, () => document.dispatchEvent(new Event('visibilitychange')));
    await until(p, () => !!window.__s.row('Lib C')?.querySelector('[data-act="claim"]'), null, { what: 'taken' });
  }],
  ['Take back asked, then cancelled', async (p) => {
    await until(p, () => window.__s.act('Lib C', 'claim'), null, { what: 'Take back' });
    const q = await asked(p);
    await answer(p, 'Cancel');
    await until(p, () => !window.__s.dialog(), null, { what: 'no question' });
    return q;
  }],
  ['Lib C taken back', async (p) => {
    await until(p, () => window.__s.act('Lib C', 'claim'), null, { what: 'Take back' });
    await asked(p);
    await answer(p, 'Take back');
    await until(p, () => !window.__s.row('Lib C')?.querySelector('[data-act="claim"]'), null, { what: 'taken back' });
    await run(p, async () => window.__s.passWait(await window.__s.idOf('Lib C')));
    await until(p, () => !window.__s.row('Lib C')?.classList.contains('busy'), null, { what: 'read', timeout: 20000 });
  }],
  ['the header\'s check of every folder', async (p) => {
    await run(p, () => document.getElementById('lfRescan').click());
    await until(p, () => !window.__s.row('Lib C')?.classList.contains('busy'), null, { what: 'checked', timeout: 20000 });
  }],
  ['Lib D added, then out of reach (its folder gone)', async (p) => {
    await run(p, () => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Lib D', { create: true }); });
    await run(p, () => document.getElementById('lfAdd').click());
    await until(p, () => !!window.__s.row('Lib D') && !window.__s.row('Lib D').classList.contains('busy'), null, { what: 'Lib D added', timeout: 20000 });
    await run(p, async () => (await navigator.storage.getDirectory()).removeEntry('Lib D', { recursive: true }));
    await run(p, () => document.dispatchEvent(new Event('visibilitychange')));
    await pause(800);
  }],
  ['an out-of-reach place\'s menu', async (p) => { const m = await menuOf(p, 'Lib D'); await closeMenu(p); return m; }],
];

test('the library\'s card: every action leaves the library, stored keys and words on the card 1.3\'s page left', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW);
  const steps = [];
  for (const [what, step] of STEPS) {
    const extra = await step(page);
    steps.push({ what, extra: extra ?? null, ...await snapshot(page) });
  }
  assert.deepEqual(page.problems, []);
  const now = normalised({ steps, refused: page.refused }, { site: origin });
  const was = record(FILE, 'card');
  // (The card's status line stays 8 s: a step after the one that made it say something may find it
  // there on one run and gone on the other. Each step's own words are compared; a step that says
  // nothing new leaves either the last words or none.)
  let said = '';
  for (let i = 0; i < STEPS.length; i++) {
    const [a, b] = [was.steps[i], now.steps[i]].map(({ card: { status, ...card }, ...rest }) => ({ ...rest, card, status }));
    const statuses = [a.status, b.status];
    delete a.status; delete b.status;
    assert.deepEqual(b, a, STEPS[i][0]);
    const fresh = statuses.filter((s) => s && s !== said);
    if (fresh.length) { assert.deepEqual(statuses, [fresh[0], fresh[0]], `${STEPS[i][0]}: the status line`); said = fresh[0]; }
  }
  assert.deepEqual(now.refused, was.refused);
});

test('a browser that can\'t pick folders is told so, and has no Add folder, as 1.3\'s page', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { library: false, before: () => { delete window.showDirectoryPicker; delete Window.prototype.showDirectoryPicker; } });
  const now = await until(page, () => document.querySelector('#foldersSection .lf-note') && document.querySelector('#foldersSection .lf-item') && {
    note: document.querySelector('#foldersSection .lf-note').textContent, add: !!document.getElementById('lfAdd'), rescan: !!document.getElementById('lfRescan'),
    rows: window.__s.rows().map((r) => r.name) }, null, { what: 'the note' });
  const was = record(FILE, 'no-picker');
  assert.deepEqual(now, was);
  assert.equal(was.add, false);
});

// ── Questions answered by their place: OK (the last button) or Cancel (the first, of two) ────────
const ok = (page) => until(page, () => { const d = window.__s.dialog(); return d && !d.busy && window.__s.answer(d.buttons.at(-1)); }, null, { what: 'the question\'s OK' });
const cancel = (page) => until(page, () => { const d = window.__s.dialog(); return d && !d.busy && d.buttons.length > 1 && window.__s.answer(d.buttons[0]); }, null, { what: 'the question\'s Cancel' });
const noDialog = (page) => until(page, () => !window.__s.dialog(), null, { what: 'no question' }).catch(async (e) => { throw new Error(`${e.message} — still: ${JSON.stringify(await run(page, () => window.__s.dialog()))}`); });
const words = (page, ids) => run(page, (ids) => Object.fromEntries(ids.map((id) => {
  const el = document.getElementById(id);
  // (Not shown: as good as not there — 1.3 kept a hidden row, the new page draws none.)
  return [id, el && el.getClientRects().length > 0 ? { text: el.textContent.trim(), disabled: !!el.disabled, tip: el.dataset.tip ?? '' } : null];
})), ids);
// The page in a context of its own: what `drive(page)` resolves, normalised (records.mjs), to compare
// with 1.3's record.
async function one(t, drive, opts = {}) {
  const page = await open(t, NEW, opts);
  const seen = await drive(page);
  assert.deepEqual(page.problems, []);
  return normalised(seen, { site: origin });
}

test('the location: choosing the desktop app asks first; cancelled nothing changes; not found, the question says so', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    const location = () => run(page, () => ({ choice: [...document.querySelectorAll('[data-loc]')].map((b) => [b.dataset.loc, b.getAttribute('aria-pressed')]),
      desc: document.getElementById('lfLocation')?.textContent.replace(/\s+/g, '') }));
    await until(page, () => document.querySelectorAll('[data-loc]').length === 2, null, { what: 'the location' });
    const first = await location();
    await run(page, () => document.querySelector('[data-loc="desktop"]').click());
    const asked1 = await asked(page);
    await cancel(page);
    await noDialog(page);
    const kept = { location: await location(), stored: await run(page, () => window.__s.stored()) };
    await run(page, () => document.querySelector('[data-loc="desktop"]').click());
    await asked(page);
    await ok(page);
    // Looked for on this computer (the harness refuses every address: nothing answers), then asked.
    const asked2 = await until(page, () => { const d = window.__s.dialog(); return d && d.buttons.length === 3 && d; }, null, { what: 'not found', timeout: 30000 });
    await until(page, (label) => window.__s.answer(label), asked2.buttons.at(-1), { what: 'Cancel' });
    await noDialog(page);
    return { first, asked1, kept, asked2, after: await location(), stored: await run(page, () => window.__s.stored()),
      refused: [...new Set(page.refused.map((u) => new URL(u).host))].sort() };
  });
  const was = record(FILE, 'location');
  assert.deepEqual(now, was);
  assert.ok(was.refused.length > 0, 'the desktop app was looked for (and nothing answered)');
});

test('continuing in this browser for now: the location says so, and Retry says the desktop app is still away', async (t) => {
  if (skip(t)) return;
  const storage = { 'shiori:libraryLocation': JSON.stringify({ kind: 'desktop', url: AWAY, token: 't' }), 'shiori:libraryFallback': JSON.stringify({ since: 1 }) };
  const now = await one(t, async (page) => {
    const retry = await until(page, () => document.getElementById('locRetry')?.textContent, null, { what: 'Retry' });
    const desc = await run(page, () => document.getElementById('lfLocation').textContent.replace(/\s+/g, ''));
    await run(page, () => document.getElementById('locRetry').click());
    const said = await asked(page);
    await ok(page);
    await noDialog(page);
    return { retry, desc, said, rows: (await settled(page)).rows.map((r) => r.name) };
  }, { library: false, storage });
  const was = record(FILE, 'fallback');
  assert.deepEqual(now, was);
});

test('a library the desktop app keeps, seen from a site: only the location, no upgrades, its own write count', async (t) => {
  if (skip(t)) return;
  const storage = { 'shiori:libraryLocation': JSON.stringify({ kind: 'desktop', url: AWAY, token: 't' }) };
  const now = await one(t, async (page) => {
    await until(page, () => document.getElementById('lfLocation')?.textContent, null, { what: 'the location' });
    await pause(500);
    return run(page, () => ({
      card: document.getElementById('foldersSection').textContent.replace(/\s+/g, ''),
      rows: !!document.getElementById('lfRows'), add: !!document.getElementById('lfAdd'), rescan: !!document.getElementById('lfRescan'),
      upgrades: document.getElementById('upgradesSection').getClientRects().length > 0,
      stats: document.getElementById('statsSection').getClientRects().length > 0,
      statsText: document.getElementById('statsSection').textContent.replace(/\s+/g, ''),
      // (The app's own question while the desktop app can't be reached, over the page.)
      gate: window.__s.dialog()?.title ?? null,
    }));
  }, { library: false, storage });
  const was = record(FILE, 'desktop-library');
  assert.deepEqual(now, was);
  assert.equal(was.upgrades, false);
  assert.equal(was.rows, false);
});

test('Export…: the choice opens with its first card focused; Escape closes it and focus goes back; each choice starts what 1.3 starts', async (t) => {
  if (skip(t)) return;
  const open1 = () => !!document.querySelector('#backupBox');
  const now = await one(t, async (page) => {
    await page.click('#exportBackupBtn');
    await until(page, open1, null, { what: 'the choice' });
    await pause(100);
    const focus = await run(page, () => document.activeElement?.id);
    const choice = await run(page, () => [...document.querySelectorAll('#backupMetaBtn, #backupFullBtn, #backupCancelBtn')].map((b) => b.textContent.trim()));
    await page.keyboard.press('Escape');
    await until(page, (s) => !document.querySelector(s), '#backupBox', { what: 'closed' });
    const back = await until(page, () => document.activeElement?.id === 'exportBackupBtn' && 'exportBackupBtn', null, { what: 'focus back' });
    const results = {};
    for (const kind of ['backupMetaBtn', 'backupFullBtn']) {
      await page.click('#exportBackupBtn');
      await until(page, open1, null, { what: 'the choice' });
      await pause(100);
      await page.click(`#${kind}`);
      results[kind] = await until(page, () => { const d = window.__s.dialog(); return d && !d.busy && d.buttons.length === 1 && d.title; }, null, { what: 'how it went', timeout: 30000 });
      await ok(page);
      await noDialog(page);
    }
    // Cancel closes it too.
    await page.click('#exportBackupBtn');
    await until(page, open1, null, { what: 'the choice' });
    await pause(100);
    await page.click('#backupCancelBtn');
    await until(page, (s) => !document.querySelector(s), '#backupBox', { what: 'closed' });
    return { focus, choice, back, results };
  });
  const was = record(FILE, 'export');
  assert.deepEqual(now, was);
  assert.equal(was.focus, 'backupMetaBtn');
});

test('Import… and Check… pick a file and say what it is, as 1.3', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    const said = {};
    for (const id of ['importBackupBtn', 'checkBackupBtn']) {
      const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(`#${id}`)]);
      const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-st-'));
      const file = path.join(dir, 'not-a-backup.shioridb');
      fs.writeFileSync(file, 'nothing of a backup here');
      await chooser.accept([file]);
      said[id] = await until(page, () => { const d = window.__s.dialog(); return d && !d.busy && d.buttons.length === 1 && d; }, null, { what: 'what it is', timeout: 20000 });
      await ok(page);
      await noDialog(page);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { said, ids: (await run(page, () => window.__s.library())).ids };
  });
  const was = record(FILE, 'import-check');
  assert.deepEqual(now, was);
});

test('a backup running in another window holds Clear All and Factory Reset back, with a notice; nothing is cleared', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    const other = await page.browserContext().newPage();
    await other.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
    await other.evaluate(() => { navigator.locks.request('shiori-backup', () => new Promise(() => {})); });
    await until(other, () => navigator.locks.query().then((q) => q.held.some((l) => l.name === 'shiori-backup')), null, { what: 'the lock' });
    const said = [];
    for (const id of ['clearAllBtn', 'factoryResetBtn']) {
      await run(page, (id) => document.getElementById(id).click(), id);
      said.push(await until(page, () => { const d = window.__s.dialog(); return d && !d.busy && d.buttons.length === 1 && d; }, null, { what: 'the notice' }));
      await ok(page);
      await noDialog(page);
    }
    await other.close();
    return { said, library: await run(page, () => window.__s.library()), stored: await run(page, () => window.__s.stored()) };
  });
  const was = record(FILE, 'backup-held');
  assert.deepEqual(now, was);
  assert.equal(was.library.ids.length, 3);
});

test('Clear All and Factory Reset: each asked twice; cancelled at either question, nothing changes', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    const before = { library: await run(page, () => window.__s.library()), stored: await run(page, () => window.__s.stored()) };
    const said = [];
    for (const id of ['clearAllBtn', 'factoryResetBtn']) {
      for (const at of [1, 2]) {
        await run(page, (id) => document.getElementById(id).click(), id);
        said.push(await asked(page));
        if (at === 2) { await ok(page); said.push(await until(page, (t1) => { const d = window.__s.dialog(); return d && d.title !== t1 && d; }, said.at(-1).title, { what: 'the second question' })); }
        await cancel(page);
        await noDialog(page);
      }
    }
    const after = { library: await run(page, () => window.__s.library()), stored: await run(page, () => window.__s.stored()) };
    assert.deepEqual(after, before, 'nothing changed');
    return { said, status: await run(page, () => window.__s.status('clearAllStatus')) };
  });
  const was = record(FILE, 'danger-asked');
  assert.deepEqual(now, was);
});

test('Clear All done: the library cleared, preferences kept, said so', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await run(page, () => document.getElementById('clearAllBtn').click());
    await asked(page); await ok(page);
    await until(page, () => window.__s.dialogs() === 1 && /Delete|delete|削除/.test(window.__s.dialog().buttons.at(-1)), null, { what: 'the second question' }).catch(() => {});
    await ok(page);
    const status = await until(page, () => window.__s.status('clearAllStatus'), null, { what: 'said so', timeout: 20000 });
    await pause(500);
    return { status, library: await run(page, () => window.__s.library()), stored: await run(page, () => window.__s.stored()) };
  }, { storage: { 'shiori:libMergeSeries': 'false' } });
  const was = record(FILE, 'clear-all');
  assert.deepEqual(now, was);
  assert.deepEqual(was.library.ids, []);
  assert.equal(was.stored['shiori:libMergeSeries'], 'false', 'preferences kept');
});

test('Factory Reset done: every setting cleared, said so, and the page loaded again 1.2 s later', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await run(page, () => { window.__before = true; });
    await run(page, () => document.getElementById('factoryResetBtn').click());
    await asked(page); await ok(page);
    await until(page, () => window.__s.dialogs() === 1, null, { what: 'the second question' });
    await pause(100);
    await ok(page);
    const status = await until(page, () => window.__s.status('clearAllStatus'), null, { what: 'said so', timeout: 20000 });
    const said = Date.now();
    const kept = await run(page, () => window.__s.stored());
    await until(page, () => !window.__before, null, { what: 'the page loaded again' });
    const after = Date.now() - said;
    await shownStorage(page);
    return { status, kept, reloaded: after > 800 && after < 4000, library: await run(page, () => window.__s.library()) };
  }, { storage: { 'shiori:libMergeSeries': 'false' } });
  const was = record(FILE, 'factory-reset');
  assert.deepEqual(now, was);
  assert.equal(was.kept['shiori:libMergeSeries'], undefined, 'settings cleared');
  assert.equal(was.reloaded, true);
});

test('the write counter: its figure and its tip by kind; Reset asked, cancelled, then done and said so', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await run(page, async () => {
      const platform = await import('/app/js/platform.js');
      await platform.writes.reset();
      await platform.writes.add({ pages: 123456789, covers: 45678, app: 900000, exports: 12 });
    });
    const figure = await until(page, () => /MB/.test(document.getElementById('totalWritesCount').textContent), null, { what: 'the figure' }).then(() => words(page, ['totalWritesCount']));
    await page.click('#resetWritesBtn');
    const q = await asked(page);
    await cancel(page); await noDialog(page);
    const kept = await words(page, ['totalWritesCount']);
    await page.click('#resetWritesBtn');
    await asked(page); await ok(page);
    const status = await until(page, () => window.__s.status('writesStatus'), null, { what: 'said so' });
    await pause(300);
    return { figure, q, kept, status, after: await words(page, ['totalWritesCount', 'resetWritesBtn']) };
  }, { library: false });
  const was = record(FILE, 'writes');
  assert.deepEqual(now, was);
  assert.notEqual(was.figure.totalWritesCount.tip, '');
});

test('the library upgrades: the stored layout\'s row, its button off with nothing left; category and rating only while something answers the bridge', async (t) => {
  if (skip(t)) return;
  const quiet = await one(t, async (page) => {
    await until(page, () => document.getElementById('layoutStatus')?.textContent !== '—', null, { what: 'the layout row' });
    await pause(1800);   // (nothing answers the bridge within 1.5 s)
    return words(page, ['layoutStatus', 'convertNowBtn', 'classifyRow', 'classifyStatus', 'classifyNowBtn']).then((w) => ({ ...w, classifyRow: !!w.classifyRow }));
  });
  const wasQuiet = record(FILE, 'upgrades-quiet');
  assert.deepEqual(quiet, wasQuiet);
  assert.equal(wasQuiet.convertNowBtn.disabled, true);
  assert.equal(wasQuiet.classifyRow, false);
  // A stand-in that answers the bridge: a ping, and category and rating for a gallery that has none.
  const answering = () => window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__shiori !== 'to-ext' || e.data.id == null) return;
    const { type } = e.data.msg || {};
    const response = type === 'PING' ? { ok: true } : type === 'EXT_DERIVE_META' ? { ok: true, tags: [{ type: 'rating', name: 'safe' }, { type: 'category', name: 'misc' }] } : null;
    window.postMessage({ __shiori: 'from-ext', replyTo: e.data.id, response }, location.origin);
  });
  const now = await one(t, async (page) => {
    const pending = await until(page, () => document.getElementById('classifyRow')?.getClientRects().length > 0 && !document.getElementById('classifyNowBtn').disabled, null, { what: 'the row, something to do' })
      .then(() => words(page, ['classifyStatus', 'classifyNowBtn']));
    await page.click('#classifyNowBtn');
    await until(page, () => document.getElementById('classifyNowBtn').disabled && /0|none|All|all|every/.test(document.getElementById('classifyStatus').textContent) && !window.__s.dialog(), null, { what: 'done', timeout: 20000 }).catch(() => {});
    await until(page, () => document.getElementById('classifyNowBtn').disabled && !window.__s.dialog(), null, { what: 'done', timeout: 20000 });
    await pause(300);
    const meta = await run(page, async () => (await (await import('/app/js/api.js')).meta.get('1790000000004')).tags);
    return { pending, done: await words(page, ['classifyStatus', 'classifyNowBtn']), meta };
  }, { library: false, before: answering, seedMore: true });
  const was = record(FILE, 'upgrades');
  assert.deepEqual(now, was);
  assert.ok(was.meta.some((tg) => tg.type === 'rating'));
});

test('the desktop app\'s window (a stand-in for its bridge): the archiving card, its choices stored; the header\'s check says what the app found', async (t) => {
  if (skip(t)) return;
  const bridge = () => {
    let state = { archiveAfter: 'week', archiveFormat: 'zip' };
    window.__shell = [];
    window.shioriDesktop = { shell: async (action, ...args) => {
      window.__shell.push([action, ...args]);
      if (action === 'state') return state;
      if (action === 'set') { state = { ...state, [args[0]]: args[1] }; return state; }
      if (action === 'rescan') return { added: 2, updated: 1, moved: 0, missing: 3, found: 0 };
      return null;
    } };
  };
  const now = await one(t, async (page) => {
    await until(page, () => !!document.getElementById('deskArchiveAfter'), null, { what: 'the archiving card' });
    const read = () => run(page, () => ({
      after: ((el) => (el.tagName === 'SELECT' ? el.value : el.dataset.value))(document.getElementById('deskArchiveAfter')),
      format: ((el) => (el.tagName === 'SELECT' ? el.value : el.dataset.value))(document.getElementById('deskArchiveFormat')),
      // (Its words but a list's: 1.3's native one holds every option, the drawn one its choice.)
      text: (() => { const c = document.getElementById('archiveSection').cloneNode(true); c.querySelectorAll('select, [data-slot^="select"]').forEach((x) => x.remove()); return c.textContent.replace(/\s+/g, ''); })(),
      chosen: ['deskArchiveAfter', 'deskArchiveFormat'].map((id) => { const el = document.getElementById(id); return el.tagName === 'SELECT' ? el.selectedOptions[0].textContent : el.textContent; }),
      order: [...document.getElementById('panelStorage').children].map((c) => c.id).filter(Boolean).slice(0, 3),
    }));
    const first = await read();
    // Archived after a month: 1.3's native select, the new page's drawn one (the list's third choice).
    if (await run(page, () => document.getElementById('deskArchiveAfter').tagName === 'SELECT')) await page.select('#deskArchiveAfter', 'month');
    else {
      await page.click('#deskArchiveAfter');
      await page.waitForSelector('[data-slot="select-list"][data-open] [data-slot="select-option"]');
      await pause(300);
      await (await page.$$('[data-slot="select-list"][data-open] [data-slot="select-option"]'))[3].click();
    }
    await until(page, () => window.__shell.some((c) => c[0] === 'set'), null, { what: 'stored' });
    await pause(300);
    const chosen = await read();
    await run(page, () => document.getElementById('lfRescan').click());
    const status = await until(page, () => window.__s.status('lfStatus'), null, { what: 'what the app found' });
    return { first, chosen, status,
      sets: await run(page, () => window.__shell.filter((c) => c[0] === 'set' || c[0] === 'rescan')) };
  }, { before: bridge });
  const was = record(FILE, 'archive');
  assert.deepEqual(now, was);
  assert.deepEqual(was.sets, [['set', 'archiveAfter', 'month'], ['rescan']]);
});

test('the desktop app\'s window (a stand-in): a backup left by a reload is asked for once a page load, however often the panel is drawn', async (t) => {
  if (skip(t)) return;
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(() => {
    window.__shell = [];
    window.shioriDesktop = { pathOf: () => '', shell: async (action) => {
      window.__shell.push(action);
      return action === 'state' ? { archiveAfter: 'week', archiveFormat: 'zip' } : null;
    } };
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate((to) => { const a = document.createElement('a'); a.href = to; a.id = 'toSettings'; document.body.append(a); }, NEW);
  const asked = () => run(page, () => window.__shell.filter((action) => action === 'backupCurrent').length);
  for (let i = 0; i < 3; i++) {
    if (i === 0) await page.$eval('#toSettings', (a) => a.click()); else await page.evaluate(() => history.forward());
    await shownStorage(page);
    await until(page, () => window.__shell.includes('backupCurrent'), null, { what: 'asked' });
    await pause(300);
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsNav') && !!document.getElementById('tkList'), null, { what: `Tasks again (${i})` });
  }
  // (Asked again, it would take a backup this window itself is making for one left behind: a second
  // progress window, or an import waiting for an answer cancelled.)
  assert.equal(await asked(), 1);
});

test('a change of language redraws the panel in it at once', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await settled(page, { rows: 3 });
    await run(page, async () => (await import('/app/js/i18n.js')).setLang('ja'));
    await pause(800);
    return run(page, () => ({
      titles: [...document.querySelectorAll('#panelStorage h2')].filter((h) => h.getClientRects().length).map((h) => h.textContent),
      buttons: ['exportBackupBtn', 'importBackupBtn', 'checkBackupBtn', 'convertNowBtn', 'resetWritesBtn', 'clearAllBtn', 'factoryResetBtn'].map((id) => document.getElementById(id).textContent.trim()),
      rows: window.__s.rows().map((r) => [r.name, r.meta, r.badges.map((b) => b[0])]),
      add: document.getElementById('lfAdd').textContent.trim(), location: [...document.querySelectorAll('[data-loc]')].map((b) => b.textContent.trim()),
      layout: document.getElementById('layoutStatus').textContent,
    }));
  });
  const was = record(FILE, 'language');
  // (The image storage row's words: 1.3 kept the language they were first read in; the new page reads
  // them again in the new one.)
  assert.equal(now.layout, 'すべてのページが新しい形式です。');
  delete was.layout; delete now.layout;
  assert.deepEqual(now, was);
  assert.notEqual(was.titles[0], 'Library storage');
});

test('the phone form: nothing runs past the cards or the screen, the buttons under their words', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await settled(page, { rows: 3 });
    return run(page, () => {
      const out = [];
      for (const card of document.querySelectorAll('#panelStorage > [id], #panelStorage > .section, #panelStorage > [data-slot="card"]')) {
        const box = card.getBoundingClientRect();
        if (!box.width) continue;
        for (const el of card.querySelectorAll('button, .lf-item, .lf-meta, code')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) out.push(el.id || el.className);
        }
      }
      const exp = document.getElementById('exportBackupBtn').getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth - innerWidth, out, exportFull: exp.width > 200, rows: document.querySelectorAll('#foldersSection .lf-item').length };
    });
  }, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  const was = record(FILE, 'phone');
  assert.deepEqual(now, was);
  assert.deepEqual(was, { scroll: 0, out: [], exportFull: true, rows: 3 });
});

test('leaving the page leaves nothing behind: /settings → /tasks → /settings, five times, a folder\'s menu and the export choice opened each time', async (t) => {
  if (skip(t)) return;
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(helpers);
  await seed(page);
  await page.evaluateOnNewDocument(() => {
    const live = window.__live = { intervals: new Set(), channels: new Set() };
    const { setInterval: si, clearInterval: ci } = window;
    window.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
    window.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC { constructor(name) { super(name); live.channels.add(this); } close() { live.channels.delete(this); super.close(); } };
  });
  page.problems.length = 0;
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/settings'; a.id = 'toSettings'; document.body.append(a); });
  const held = async () => {
    const cdp = await page.createCDPSession();
    const listeners = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort();
    };
    const out = { window: await listeners('window'), document: await listeners('document'),
      ...await page.evaluate(() => ({ intervals: window.__live.intervals.size, channels: window.__live.channels.size, nodes: document.getElementsByTagName('*').length })) };
    await cdp.detach();
    return out;
  };
  const visit = async (i, first) => {
    if (first) await page.$eval('#toSettings', (a) => a.click()); else await page.evaluate(() => history.forward());
    await shownStorage(page);
    await settled(page, { rows: 3 });
    await menuOf(page, 'Lib A');
    await closeMenu(page);
    await page.click('#exportBackupBtn');
    await until(page, () => !!document.getElementById('backupBox'), null, { what: 'the choice' });
    await page.keyboard.press('Escape');
    await until(page, () => !document.getElementById('backupBox'), null, { what: 'closed' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsNav') && !!document.getElementById('tkList'), null, { what: `Tasks again (${i})` });
  };
  await visit(0, true);
  await pause(300);
  const first = await held();
  for (let i = 1; i <= 5; i++) await visit(i, false);
  await pause(300);
  assert.deepEqual(await held(), first, 'after five more visits, what is held is what it was after the first');
  assert.deepEqual(page.problems, []);
});

test('a library kept as files (stand-ins for its count): its own figure and tip, read every 3 s while the page shows and not while hidden; Reset resets both counts', async (t) => {
  if (skip(t)) return;
  const context = await browser.createBrowserContext();
  t.after(() => context.close().catch(() => {}));
  const page = await openPage(context, origin);
  await page.evaluateOnNewDocument(helpers);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  // (The library's capabilities and counts as such a library's, before the page is drawn.)
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    const desk = { total: 9_000_000, by: { pages: 1_000_000, pictures: 2_000_000, archive: 4_000_000, database: 50_000, thumbnails: 600_000, exports: 10 } };
    const own = { total: 777_000, by: { exports: 500, staging: 1000 } };
    window.__counts = { get: 0, reset: 0, desk, own };
    api.capabilities.archive = true;
    api.diskWrites.get = async () => { window.__counts.get++; return window.__counts.desk; };
    api.diskWrites.reset = async () => { window.__counts.reset++; window.__counts.desk = { total: 0, by: {} }; };
    platform.writes.get = async () => window.__counts.own;
    const a = document.createElement('a'); a.href = '/settings'; a.id = 'toSettings'; document.body.append(a);
  });
  await page.$eval('#toSettings', (a) => a.click());
  await shownStorage(page);
  const expected = await page.evaluate(async () => (await import('/app/js/storage-settings.js')).desktopWritesView(window.__counts.desk, window.__counts.own));
  const shown = await until(page, (text) => document.getElementById('totalWritesCount').textContent === text, expected.text, { what: 'the figure' })
    .then(() => words(page, ['totalWritesCount']));
  assert.deepEqual(shown.totalWritesCount, { text: expected.text, disabled: false, tip: expected.tip });
  assert.match(await page.evaluate(() => document.getElementById('statsSection').textContent), /library folder/, 'its own description');
  const at = await page.evaluate(() => window.__counts.get);
  await pause(6600);
  const read = await page.evaluate(() => window.__counts.get) - at;
  assert.ok(read >= 2 && read <= 3, `read every 3 s (${read} in 6.6 s)`);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  const hiddenAt = await page.evaluate(() => window.__counts.get);
  await pause(6600);
  assert.equal(await page.evaluate(() => window.__counts.get) - hiddenAt, 0, 'not read while the page is hidden');
  await page.evaluate(() => { delete document.hidden; });
  await page.click('#resetWritesBtn');
  await asked(page); await ok(page);
  await until(page, () => window.__s.status('writesStatus'), null, { what: 'said so' });
  assert.equal(await page.evaluate(() => window.__counts.reset), 1);
  // Read again at once (not at the next tick).
  await until(page, (text) => document.getElementById('totalWritesCount').textContent !== text, expected.text, { what: 'read again', timeout: 1500 });
  assert.deepEqual(page.problems, []);
});

test('Add folder: the folder\'s row shows at once, busy, and fills in where it stands; nothing above it moves', async (t) => {
  if (skip(t)) return;
  const now = await one(t, async (page) => {
    await settled(page, { rows: 3 });
    // (The library takes its time adding it: the row is seen while it does.)
    await run(page, async () => {
      const api = await import('/app/js/api.js');
      const add = api.folders.add;
      api.folders.add = async (...args) => { await new Promise((r) => setTimeout(r, 1500)); return add(...args); };
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Lib E', { create: true });
    });
    const tops = () => run(page, () => [...document.querySelectorAll('#foldersSection .lf-item')].map((r) => Math.round(r.getBoundingClientRect().top * 64) / 64));
    const before = await tops();
    const addTop = await run(page, () => document.getElementById('lfAdd').getBoundingClientRect().top);
    await run(page, () => document.getElementById('lfAdd').click());
    const adding = await until(page, () => window.__s.rows().length === 4 && window.__s.rows()[3], null, { what: 'the row at once' });
    const during = await tops();
    const grown = await run(page, () => { const r = document.querySelectorAll('#foldersSection .lf-item')[3].getBoundingClientRect(); return r.height; });
    const addDuring = await run(page, () => document.getElementById('lfAdd').getBoundingClientRect().top);
    await until(page, () => !window.__s.row('Lib E')?.classList.contains('busy'), null, { what: 'filled in', timeout: 20000 });
    const after = await tops();
    return { adding, kept: during.slice(0, 3).join() === before.join() && after.slice(0, 4).join() === during.join(),
      addMoved: Math.abs(addDuring - addTop - grown - 8) < 0.5, filled: (await settled(page)).rows[3] };
  });
  const was = record(FILE, 'add-folder');
  assert.deepEqual(now, was);
  assert.equal(was.adding.busy, true);
  assert.equal(was.kept, true);
  assert.equal(was.addMoved, true);
});
