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

// `steps` is injectable so the runner's completion semantics can be exercised directly.
export async function runMigrations(steps = STEPS) {
  const stored = await platform.kv.get(['schemaSteps', ...LEGACY_FLAGS]);
  const done = new Set(Array.isArray(stored.schemaSteps) ? stored.schemaSteps : []);
  for (const flag of LEGACY_FLAGS) if (stored[flag]) done.add(flag);

  for (const step of steps) {
    if (done.has(step.id)) continue;
    try {
      await step.run();
    } catch (err) {
      // Leave the flag unset so the next boot retries; later steps may depend on this one.
      console.warn(`[shiori] migration ${step.id} failed, will retry next boot`, err);
      break;
    }
    done.add(step.id);
    platform.kv.set({ schemaSteps: [...done] });
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
}
