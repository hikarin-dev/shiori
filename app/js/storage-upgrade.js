// storage-upgrade.js — moving a library stored before images were kept apart (db.js) to the new
// layout: a one-time prompt after the update (convert gradually, as galleries change, or all now)
// and the conversion with its progress, which Settings → Storage also offers any time.

import * as platform from './platform.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { ask, showProgress } from './notice.js';
import { storageLayoutStatus, convertStorage, getStats } from './db.js';

// { pages, converted, remaining, bytes }: bytes estimates what converting the rest writes.
export async function storageEstimate() {
  const [status, stats] = await Promise.all([storageLayoutStatus(), getStats()]);
  const bytes = status.pages ? Math.round(stats.totalSize * status.remaining / status.pages) : 0;
  return { ...status, bytes };
}

// Convert everything now behind a progress modal; Stop leaves the rest to convert as it changes.
// Resolves true when everything was converted.
export async function convertNow() {
  let stop = false;
  const modal = showProgress({ title: t('storage.converting'), body: t('storage.converting_body'),
    stopLabel: t('storage.stop'), onStop: () => { stop = true; } });
  try {
    const done = await convertStorage({
      stopped: () => stop,
      onProgress: ({ phase, done, total }) => modal.update(done, total,
        t(phase === 'covers' ? 'storage.covers_progress' : 'storage.pages_progress', { done: formatCount(done), total: formatCount(total) })),
    });
    if (done) platform.kv.set({ storageLayout: 'done' });
    return done;
  } finally {
    modal.close();
  }
}

// Once, after the update, when pages are still stored the old way: how to convert them. One tab
// asks; the answer is kept.
export async function offerStorageUpgrade() {
  const ask1 = async () => {
    const { storageLayout } = await platform.kv.get(['storageLayout']);
    if (storageLayout) return;
    const est = await storageEstimate();
    if (!est.remaining) { platform.kv.set({ storageLayout: 'done' }); return; }
    const choice = await ask({
      title: t('storage.title'),
      body: t('storage.body', { pages: formatCount(est.remaining), size: formatBytes(est.bytes) }),
      choices: [
        { value: 'gradual', label: t('storage.gradual'), detail: t('storage.gradual_desc') },
        { value: 'now', label: t('storage.now'), detail: t('storage.now_desc', { size: formatBytes(est.bytes) }) },
      ],
    });
    platform.kv.set({ storageLayout: choice });
    if (choice === 'now') await convertNow();
  };
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request('shiori-storage-upgrade', { ifAvailable: true }, (lock) => lock && ask1()) : ask1();
}
