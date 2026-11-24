// storage-settings.js — Settings → Storage's rules that are not drawing, which every page drawing the
// panel uses: which of its sections show, the write counter's figure and the tip that splits it by
// kind (this browser's, and a library kept as files' own count), resetting it, the two resets of the
// danger zone (what each asks, what each clears and in what order), and the library upgrades' rows
// (what each says, and running it). Moved as they were from settings.js.

import * as api from './api.js';
import * as platform from './platform.js';
import { cancelJob } from './submit-job.js';
import { backupRunning } from './backup-ui.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { confirmDialog, alertDialog } from './notice.js';

// Library upgrades are about the library this browser keeps; a library kept by the desktop app has
// none (its disk writes it counts itself: desktopWrites), and seen from a site it has no stats either.
export const storageSections = (caps = api.capabilities) => ({ upgrades: !!caps.browserLibrary, stats: !!(caps.browserLibrary || caps.archive) });

// ── Reset (two tiers) ──────────────────────────────────────────────────────
// Clear Library removes committed library content, durable job state and staged import files
// while keeping preferences; Factory Reset additionally clears every shiori-owned storage key
// (settings, credentials, repair flags). Both cancel running work first so nothing can
// repopulate the stores, and broadcast one reset so every other context drops its caches.

export async function performReset(factory) {
  try {
    for (const rec of await platform.translateResume.all()) {
      cancelJob('translate', { galleryId: rec.gid, token: rec.token, serverUrl: rec.serverUrl, settings: rec.settings });
    }
  } catch {}
  await platform.clearJobsData();
  await api.maintenance.clearAll(factory ? { folders: true } : undefined);
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (/^cbz-.*\.bin$/.test(name)) await root.removeEntry(name).catch(() => {});
    }
  } catch {}
  if (factory) {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        for (const key of Object.keys(storage)) {
          if (/^(shiori[:-]|_shiori)/.test(key)) storage.removeItem(key);
        }
      } catch {}
    }
  }
  platform.control.send({ type: 'LIBRARY_RESET', context: platform.contextId, factory: !!factory });
}

// Never under a backup being made or restored, in this window or another.
export async function backupBlocksReset() {
  if (!(await backupRunning())) return false;
  await alertDialog({ title: t('bk.lock_title'), body: t('bk.reset_blocked'), tone: 'info' });
  return true;
}

// Clear All: asked twice. Resolves whether it was done.
export async function clearLibrary() {
  if (await backupBlocksReset()) return false;
  if (!(await confirmDialog({ title: t('dlg.clear_title'), body: t('dlg.clear_body'), ok: t('dlg.continue'), danger: true }))) return false;
  if (!(await confirmDialog({ title: t('dlg.clear2_title'), body: t('dlg.clear2_body'), ok: t('dlg.clear2_ok'), danger: true }))) return false;
  await performReset(false);
  return true;
}

// Factory Reset: asked twice. Resolves whether it was done; the page then reloads after
// FACTORY_RELOAD_MS, to start again with defaults.
export const FACTORY_RELOAD_MS = 1200;
export async function factoryReset() {
  if (await backupBlocksReset()) return false;
  if (!(await confirmDialog({ title: t('dlg.factory_title'), body: t('dlg.factory_body'), ok: t('dlg.continue'), danger: true }))) return false;
  if (!(await confirmDialog({ title: t('dlg.factory2_title'), body: t('dlg.factory2_body'), ok: t('dlg.factory2_ok'), danger: true }))) return false;
  await performReset(true);
  return true;
}

// ── Storage Writes ────────────────────────────────────────────────────────

// Everything the app has written to this browser's storage; hovering the total splits it by kind.
export const WRITE_KINDS = ['pages', 'covers', 'library', 'folder', 'jobs', 'settings', 'app', 'staging', 'exports', 'other'];
export const browserWrites = (writes) => ({
  text: formatBytes(writes?.total || 0),
  tip: WRITE_KINDS.filter(kind => writes?.by?.[kind])
    .map(kind => `${t(`set.writes_${kind}`)}: ${formatBytes(writes.by[kind])}`).join('\n'),
});

// A library kept as files (the desktop app's) counts what it writes itself: shown instead, by the
// drive it went to and by kind, with what this window stored in its own browser storage beside it.
// Read again every DESK_WRITES_EVERY while the page is visible.
export const DESK_WRITES_EVERY = 3000;
const DESK_KINDS = { pages: 'set.writes_desk_pages', pictures: 'set.writes_desk_pictures', descriptions: 'set.writes_desk_descriptions',
  archive: 'set.writes_desk_archive', database: 'set.writes_desk_database', thumbnails: 'set.writes_desk_thumbnails' };
const LIBRARY_DRIVE_KINDS = ['pages', 'pictures', 'descriptions', 'archive'], APP_DATA_KINDS = ['database', 'thumbnails'];
export function desktopWritesView(desk, own) {
  const sum = (kinds) => kinds.reduce((total, kind) => total + (desk.by[kind] || 0), 0);
  const lines = (kinds) => kinds.filter(kind => desk.by[kind]).map(kind => `  ${t(DESK_KINDS[kind])}: ${formatBytes(desk.by[kind])}`);
  // Saved files: downloads (counted by the desktop app) and backups saved through a dialog (by this
  // window); an import's staging copy, should one have been written here.
  const exports = (desk.by.exports || 0) + (own?.by?.exports || 0), staging = own?.by?.staging || 0;
  return {
    text: formatBytes(desk.total + (own?.total || 0)),
    tip: [
      t('set.writes_desk_library_drive', { size: formatBytes(sum(LIBRARY_DRIVE_KINDS)) }), ...lines(LIBRARY_DRIVE_KINDS),
      t('set.writes_desk_app_drive', { size: formatBytes(sum(APP_DATA_KINDS)) }), ...lines(APP_DATA_KINDS),
      ...(exports ? [`${t('set.writes_exports')}: ${formatBytes(exports)}`] : []),
      ...(staging ? [`${t('set.writes_staging')}: ${formatBytes(staging)}`] : []),
      t('set.writes_desk_window', { size: formatBytes((own?.total || 0) - (own?.by?.exports || 0) - staging) }),
    ].join('\n'),
  };
}
// The desktop count read now: { text, tip }, or null when there is none to show.
export async function desktopWrites() {
  const [desk, own] = await Promise.all([api.diskWrites.get().catch(() => null), platform.writes.get().catch(() => null)]);
  if (!desk) return null;
  return desktopWritesView(desk, own);
}

// Reset: asked first. Resolves whether it was done.
export async function resetWrites() {
  if (!(await confirmDialog({ title: t('dlg.writes_title'), body: t('dlg.writes_body'), ok: t('common.reset') }))) return false;
  await platform.writes.reset();
  if (api.capabilities.archive) await api.diskWrites.reset();
  return true;
}

// ── Library upgrades ──────────────────────────────────────────────────────
// Pages stored before images were kept apart convert as their galleries change, or all at once here.

// { text, remaining }: what the image storage row says, and whether anything is left to convert.
export async function layoutStatus() {
  const { storageEstimate } = await import('./storage-upgrade.js');
  const est = await storageEstimate();
  return { text: est.remaining
    ? t('set.layout_status', { converted: formatCount(est.converted), pages: formatCount(est.pages), size: formatBytes(est.bytes) })
    : t('set.layout_done'), remaining: !!est.remaining };
}

export async function convertLayout() {
  const { convertNow } = await import('./storage-upgrade.js');
  platform.kv.set({ storageLayout: 'now' });
  await convertNow().catch(() => {});
}

// Category and rating from each gallery's stored source details — offered only while something
// answers the bridge. { text, pending } (how many are left), or null while it isn't offered.
export async function classifyStatus() {
  const { classifyAvailable, classifyPending } = await import('./storage-upgrade.js');
  const [ok, pending] = await Promise.all([classifyAvailable(), classifyPending()]);
  if (!ok) return null;
  return { text: pending.length
    ? t('set.classify_status', { n: formatCount(pending.length) })
    : t('set.classify_done'), pending: pending.length };
}

export async function classifyAll() {
  const { classifyNow } = await import('./storage-upgrade.js');
  await classifyNow().catch(() => {});
}
