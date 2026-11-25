// import-tracker.js — starting a batch of imports (import-batch.js) from what a drop or pick holds: where
// it runs (the desktop app's runner, this browser's service worker, or this page), the question a drop of
// several titles asks first, and how a single title ended. The batches are followed by the app's
// tracker (src/components/import-tracker.tsx, its panel control src/lib/import-batches.ts).

import * as platform from './platform.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { confirmDialog, alertDialog, showToast } from './notice.js';
import { runImportBatch, runningHere } from './import-batch.js';
import { handImportBatch, handBatchToWorker, workerAvailable } from './submit-job.js';

// ── Starting a batch ──
// Import what a drop or pick holds (`groups`, import-files.js groupImports; `files` and `folders` as
// dropped, which name the batch; `leftOut` the files that are none of what imports): several titles
// ask first. The batch goes to the desktop app's runner when there is one; else to this browser's
// service worker, which carries on whatever this page does while any app page is open (not a batch
// with a PDF: pdf.js draws its pages in a page); else it runs in this page, which then asks before it
// is left. A single title says how it ended unless it simply imported. `attachTo` and `meta` as
// import-batch.js runImportBatch takes them.
export async function importDropped(groups, { files = [], folders = [], leftOut = 0, attachTo = null, meta = {} }) {
  if (!groups.length) return;
  const name = folders.length === 1 && !files.length ? folders[0].name
    : groups.length === 1 ? groups[0].name.replace(/\.[^.]+$/, '') : t('imp.name_items', { n: formatCount(files.length + folders.length) });
  const desktop = typeof globalThis.shioriDesktop?.shell === 'function';
  const pdf = groups.some((g) => !g.paths && /\.pdf$/i.test(g.files[0]?.name || ''));
  const runsIn = desktop ? 'app' : !pdf && workerAvailable() ? 'worker' : 'page';
  if (groups.length > 1 && !await confirmImport(groups, { name, leftOut, runsIn })) return;
  const batch = { id: `import-${Date.now()}`, name, groups, attachTo, meta };
  if (groups.length === 1) _followTitle(batch.id);
  if (await handImportBatch(batch)) return;
  if (!pdf && await handBatchToWorker(batch)) return;
  _guardLeaving();
  await runImportBatch(batch);
}

let _guarded = false;
function _guardLeaving() {
  if (_guarded) return;
  _guarded = true;
  window.addEventListener('beforeunload', (e) => { if (runningHere()) { e.preventDefault(); e.returnValue = ''; } });
}

function _followTitle(id) {
  const off = platform.jobs.subscribe((e) => {
    if (e?.type !== 'IMPORT_TITLE' || e.batch !== id) return;
    off();
    if (e.status === 'skipped') showToast({ text: t('imp.already', { name: e.name }), closeLabel: t('common.close') });
    else if (e.status === 'failed') alertDialog({ title: t('imp.fail_title'), body: e.error || '', detail: e.name, tone: 'error' });
  });
}

// ── The question before a drop of several titles ──
// `groups` (import-files.js groupImports), `name` the batch's, `leftOut` the files that are none of
// what imports, `runsIn` where it will run: 'page', 'worker' or 'app'). Resolves true to go ahead.
export function confirmImport(groups, { name, leftOut = 0, runsIn = 'page' }) {
  const bytes = groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.size, 0), 0);
  const unreadable = groups.filter((g) => g.unreadable?.length);
  const lines = [t('imp.ask_total', { n: formatCount(groups.length), size: formatBytes(bytes) })];
  if (unreadable.length) lines.push(t('imp.ask_unreadable', { n: formatCount(unreadable.length), path: unreadable[0].unreadable[0] }));
  if (leftOut) lines.push(t('imp.ask_left_out', { n: formatCount(leftOut) }));
  lines.push(t('imp.ask_skip'));
  if (runsIn === 'page') lines.push(t('imp.ask_keep_open'));
  else if (runsIn === 'worker') lines.push(t('imp.ask_keep_tab'));
  return confirmDialog({ title: t('imp.ask_title', { name }), body: lines.join('\n'), ok: t('imp.ask_ok', { n: formatCount(groups.length) }) });
}
