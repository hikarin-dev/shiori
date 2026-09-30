// storage-upgrade.js — bringing a library saved by an older version up to the current standards,
// behind Settings → Library upgrades:
//   · image storage: moving a library stored before images were kept apart (db.js) to the new
//     layout — a one-time prompt after the update (convert gradually, as galleries change, or all
//     now) and the conversion with its progress;
//   · category and rating: filled in from the source details a gallery already holds.

import * as platform from './platform.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { ask, showProgress } from './notice.js';
import { storageLayoutStatus, convertStorage, getStats, metaGetAll, metaGet, mutateGallery } from './db.js';

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

// ── Category and rating ──
// A gallery saved before these were kept gets them from its stored source details: the bridge
// answers with generic tags read from that record (nothing is downloaded), merged in here without
// moving the gallery in the "Last updated" order.

const CLASS_TYPES = new Set(['category', 'rating']);

// Galleries that hold source details but no rating yet.
export async function classifyPending() {
  const metas = await metaGetAll();
  return metas
    .filter(m => m.source && m.sourceMetadata && !m.isStub && !(m.tags || []).some(tg => tg?.type === 'rating'))
    .map(m => ({ id: String(m.galleryId), source: m.source }));
}

// Whether anything can answer; without it the upgrade isn't offered.
export async function classifyAvailable() {
  const { available } = await import('./ext-bridge.js');
  return available();
}

async function _applyClassTags(gid, tags) {
  const add = (tags || []).filter(tg => CLASS_TYPES.has(tg?.type) && tg.name)
    .map(tg => ({ type: tg.type, name: String(tg.name), url: '' }));
  if (!add.length) return;
  const meta = await metaGet(gid);
  if (!meta) return;
  const types = new Set(add.map(tg => tg.type));
  const merge = (list) => [...add, ...(list || []).filter(tg => !types.has(tg?.type))];
  const patch = { tags: merge(meta.tags) };
  if (Array.isArray(meta.seriesTags)) patch.seriesTags = merge(meta.seriesTags);
  await mutateGallery(gid, patch, { touch: false });
}

// Update every pending gallery behind a progress modal; Stop keeps what's done. Resolves the
// number of galleries processed.
export async function classifyNow() {
  const { request } = await import('./ext-bridge.js');
  const pending = await classifyPending();
  let stop = false, next = 0, done = 0;
  const modal = showProgress({ title: t('classify.title'), body: t('classify.body'),
    stopLabel: t('storage.stop'), onStop: () => { stop = true; } });
  const worker = async () => {
    while (!stop && next < pending.length) {
      const { id, source } = pending[next++];
      const res = await request({ type: 'EXT_DERIVE_META', galleryId: id, source }, 15000);
      if (!res) { stop = true; break; }   // nothing answered — don't walk the rest into timeouts
      if (res.ok) await _applyClassTags(id, res.tags);
      done++;
      modal.update(done, pending.length, t('classify.progress', { done: formatCount(done), total: formatCount(pending.length) }));
    }
  };
  try {
    await Promise.all(Array.from({ length: 4 }, worker));
  } finally {
    modal.close();
  }
  return done;
}
