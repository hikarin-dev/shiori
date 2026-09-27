// migrations.js — one-time data repairs, run in order from the boot maintenance window.
//
// Each step records completion ONLY after it actually succeeded: the previous hand-rolled
// flags were set even when the repair threw, so a repair that failed once was marked done
// forever. A throwing step leaves its flag unset and is retried on the next boot.
//
// Completion lives under one kv key (`schemaSteps`, an array of finished step ids) instead of
// one flag per repair, so adding a step is a single array entry.

import * as platform from './platform.js';

// Ordered — a later step may assume every earlier one has run.
export const STEPS = [
  {
    id: 'countsRepaired',
    // Fix any gallery whose stored count drifted from its actual image records (a pre-guard
    // dbPut could double-count on overwrites).
    async run() {
      const { repairGalleryCounts } = await import('./db.js');
      const fixed = await repairGalleryCounts();
      if (fixed) console.log(`[shiori] repaired stat records for ${fixed} galleries`);
    },
  },
  {
    id: 'seriesShellStatsRepaired',
    // Early metadata-only series members could keep numerically invalid zero-page stat rows
    // after their first images arrived.
    async run() {
      const { repairSeriesShellStats } = await import('./db.js');
      const fixed = await repairSeriesShellStats();
      if (fixed) console.log(`[shiori] repaired stat records for ${fixed} series chapters`);
    },
  },
  {
    id: 'exportSizes',
    // A gallery's size became its export archive's: translations, study data, snapshots, covers
    // and metadata too, not only the original pages.
    async run(progress) {
      const { galleryGetAll, refreshGallerySize, publishFeed } = await import('./db.js');
      const entries = await galleryGetAll();
      let changed = 0;
      for (const [i, entry] of entries.entries()) {
        if (await refreshGallerySize(entry.galleryId)) { publishFeed(entry.galleryId); changed++; }
        progress(i + 1, entries.length);
      }
      if (changed) console.log(`[shiori] recomputed the size of ${changed} galleries`);
    },
  },
  {
    id: 'uploadDateBackfilled',
    // Copy each gallery's published date into its stat record so the "Published date" sort
    // runs off the galleries index.
    async run() {
      const { backfillUploadDates } = await import('./db.js');
      const filled = await backfillUploadDates();
      if (filled) console.log(`[shiori] backfilled uploadDate for ${filled} galleries`);
    },
  },
];

// Legacy per-repair flags. A profile that already ran them must not run them again.
const LEGACY_FLAGS = ['countsRepaired', 'seriesShellStatsRepaired', 'uploadDateBackfilled'];

// `steps` is injectable so the runner's completion semantics can be exercised directly. A step's
// run(progress) may report progress(done, total); `report` ({ step(), progress(), end() }) shows it.
// One context runs them at a time, so two tabs never repeat a step.
export async function runMigrations(steps = STEPS, report = null) {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request('shiori-migrations', () => _run(steps, report)) : _run(steps, report);
}

async function _run(steps, report) {
  const stored = await platform.kv.get(['schemaSteps', ...LEGACY_FLAGS]);
  const done = new Set(Array.isArray(stored.schemaSteps) ? stored.schemaSteps : []);
  for (const flag of LEGACY_FLAGS) if (stored[flag]) done.add(flag);

  try {
    for (const step of steps) {
      if (done.has(step.id)) continue;
      report?.step();
      try {
        await step.run((n, total) => report?.progress(n, total));
      } catch (err) {
      // Leave the flag unset so the next boot retries; later steps may depend on this one.
        console.warn(`[shiori] migration ${step.id} failed, will retry next boot`, err);
        break;
      }
      done.add(step.id);
      platform.kv.set({ schemaSteps: [...done] });
    }
  } finally {
    report?.end();
  }
}

// Recurring maintenance (not one-time): sweeps that run every boot.
export async function runMaintenance() {
  try {
    const { purgePagelessStubs } = await import('./db.js');
    const purged = await purgePagelessStubs();
    if (purged) console.log(`[shiori] purged ${purged} pageless stub records`);
  } catch {}

  // Bounded retention for staged import files: a failed import keeps its cbz-*.bin staged so a
  // retry can reuse it; ones old enough (a week, from the timestamp in the name) are abandoned.
  try {
    const root = await navigator.storage.getDirectory();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for await (const name of root.keys()) {
      const m = name.match(/^cbz-.*-(\d{13,})\.bin$/);
      if (m && Number(m[1]) < cutoff) await root.removeEntry(name).catch(() => {});
    }
  } catch {}

  // Measure the typical page of galleries stored before it was kept. Not awaited: the first run
  // reads every stored page's header. One context at a time, so two tabs don't repeat it.
  const measure = async () => {
    const { backfillMedianPages } = await import('./db.js');
    const measured = await backfillMedianPages();
    if (measured) console.log(`[shiori] measured the typical page of ${measured} galleries`);
  };
  const locks = globalThis.navigator?.locks;
  (locks ? locks.request('shiori-median-pages', { ifAvailable: true }, lock => lock && measure()) : measure()).catch(() => {});
}
