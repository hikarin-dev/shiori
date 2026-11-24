// storage-settings.test.mjs — Settings → Storage's rules (app/js/storage-settings.js), held against
// 1.3's own code: the functions as settings.js had them, copied verbatim below as oracles over
// stand-in elements, say the same figure and the same tip for the same counts; and the sections show
// for the same libraries.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document ??= { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const { t } = await import('../js/i18n.js');
const { formatBytes } = await import('../js/format.js');
const { storageSections, browserWrites, desktopWritesView, WRITE_KINDS: MOVED_KINDS } = await import('../js/storage-settings.js');

// ── 1.3's code, verbatim but for its element (a stand-in with the same properties) ─────────────────
function oracle() {
  const el = { textContent: '', dataset: {} };
  const document = { getElementById: () => el };
  const WRITE_KINDS = ['pages', 'covers', 'library', 'folder', 'jobs', 'settings', 'app', 'staging', 'exports', 'other'];
  function updateWritesDisplay(writes) {
    const el = document.getElementById('totalWritesCount');
    el.textContent = formatBytes(writes?.total || 0);
    el.dataset.tip = WRITE_KINDS.filter(kind => writes?.by?.[kind])
      .map(kind => `${t(`set.writes_${kind}`)}: ${formatBytes(writes.by[kind])}`).join('\n');
  }
  const DESK_KINDS = { pages: 'set.writes_desk_pages', pictures: 'set.writes_desk_pictures', descriptions: 'set.writes_desk_descriptions',
    archive: 'set.writes_desk_archive', database: 'set.writes_desk_database', thumbnails: 'set.writes_desk_thumbnails' };
  const LIBRARY_DRIVE_KINDS = ['pages', 'pictures', 'descriptions', 'archive'], APP_DATA_KINDS = ['database', 'thumbnails'];
  async function updateDeskWrites(desk, own) {
    if (!desk) return;
    const sum = (kinds) => kinds.reduce((total, kind) => total + (desk.by[kind] || 0), 0);
    const lines = (kinds) => kinds.filter(kind => desk.by[kind]).map(kind => `  ${t(DESK_KINDS[kind])}: ${formatBytes(desk.by[kind])}`);
    const exports = (desk.by.exports || 0) + (own?.by?.exports || 0), staging = own?.by?.staging || 0;
    const el = document.getElementById('totalWritesCount');
    el.textContent = formatBytes(desk.total + (own?.total || 0));
    el.dataset.tip = [
      t('set.writes_desk_library_drive', { size: formatBytes(sum(LIBRARY_DRIVE_KINDS)) }), ...lines(LIBRARY_DRIVE_KINDS),
      t('set.writes_desk_app_drive', { size: formatBytes(sum(APP_DATA_KINDS)) }), ...lines(APP_DATA_KINDS),
      ...(exports ? [`${t('set.writes_exports')}: ${formatBytes(exports)}`] : []),
      ...(staging ? [`${t('set.writes_staging')}: ${formatBytes(staging)}`] : []),
      t('set.writes_desk_window', { size: formatBytes((own?.total || 0) - (own?.by?.exports || 0) - staging) }),
    ].join('\n');
  }
  // What the page hid: style.display of the two sections ('' shown, 'none' hidden).
  function sections(capabilities) {
    const shown = { upgradesSection: '', statsSection: '' };
    const api = { capabilities };
    if (!api.capabilities.browserLibrary) {
      shown.upgradesSection = 'none';
      if (!api.capabilities.archive) shown.statsSection = 'none';
    }
    return shown;
  }
  return { el, WRITE_KINDS, updateWritesDisplay, updateDeskWrites, sections };
}

const BROWSER = [
  undefined, null, { total: 0, by: {} },
  { total: 123456789, by: { pages: 123456789 } },
  { total: 5_500_000, by: { pages: 4_000_000, covers: 300_000, library: 1000, folder: 2000, jobs: 0, settings: 12, app: 900_000, staging: 50, exports: 7, other: 1 } },
  { total: 42, by: { unknown: 42 } },
];
const DESK = [
  [{ total: 0, by: {} }, null],
  [{ total: 9_000_000, by: { pages: 1_000_000, pictures: 2_000_000, descriptions: 3000, archive: 4_000_000, database: 50_000, thumbnails: 600_000, exports: 10 } },
    { total: 777_000, by: { exports: 500, staging: 1000, pages: 100 } }],
  [{ total: 1, by: { database: 1 } }, { total: 3000, by: {} }],
  [{ total: 0, by: {} }, { total: 10, by: { staging: 10 } }],
];

test('the write counter: the browser\'s figure and its tip by kind, as 1.3\'s page said them', () => {
  const o = oracle();
  assert.deepEqual(MOVED_KINDS, o.WRITE_KINDS);
  for (const writes of BROWSER) {
    o.updateWritesDisplay(writes);
    assert.deepEqual(browserWrites(writes), { text: o.el.textContent, tip: o.el.dataset.tip }, JSON.stringify(writes));
  }
});

test('the write counter: a library kept as files\' figure and its tip by drive and kind, as 1.3\'s page said them', async () => {
  const o = oracle();
  for (const [desk, own] of DESK) {
    await o.updateDeskWrites(desk, own);
    assert.deepEqual(desktopWritesView(desk, own), { text: o.el.textContent, tip: o.el.dataset.tip }, JSON.stringify([desk, own]));
  }
});

test('the sections shown for each kind of library, as 1.3\'s page showed them', () => {
  const o = oracle();
  for (const browserLibrary of [true, false]) for (const archive of [true, false]) {
    const shown = o.sections({ browserLibrary, archive });
    assert.deepEqual(storageSections({ browserLibrary, archive }),
      { upgrades: shown.upgradesSection !== 'none', stats: shown.statsSection !== 'none' }, JSON.stringify({ browserLibrary, archive }));
  }
});
