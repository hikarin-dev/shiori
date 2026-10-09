// backup-ui.js — a backup made, checked or restored from any of the app's pages (Settings' buttons,
// the library's Import button, a backup dropped on the library): one blocking progress window while
// it runs (notice.js showOperation — the page can't be used or left meanwhile, and no other window
// can start another backup or clear the library), the questions a restore needs answered before
// anything is written, and what happened — every problem included — said plainly at the end.
//
// In the desktop app's own window a full backup is made and restored by the app itself
// (desktop/main.js 'backup…' actions: straight to and from the file, the pictures never passing
// through the window); everywhere else this page does it (backup.js).

import * as api from './api.js';
import { t, getLang } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { pickTitle } from './titles.js';
import { showOperation, alertDialog, confirmDialog, choiceDialog } from './notice.js';
import { exportFull, exportMetadata, openBackup, restoreBackup, probeBackup, BackupError } from './backup.js';
import { openArchive, inspectArchive, verifyArchive, snapshotSettings, restoreSettings } from './backup-core.js';

// One backup at a time, in every window of this browser (and Settings won't clear the library
// meanwhile: backupRunning).
const LOCK = 'shiori-backup';
const desktop = () => globalThis.shioriDesktop;
const native = () => !!(api.capabilities.desktopWindow && desktop()?.shell && typeof desktop().pathOf === 'function');

export async function backupRunning() {
  try { return !!(await navigator.locks?.query?.())?.held?.some(l => l.name === LOCK); } catch { return false; }
}

async function withLock(fn) {
  if (!navigator.locks?.request) return fn();
  return navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) { await alertDialog({ title: t('bk.lock_title'), body: t('bk.lock_body'), tone: 'info' }); return null; }
    return fn();
  });
}

// The desktop app is told while this window runs a backup, so it doesn't reload, navigate or quit
// under it without asking.
const busy = (on) => { try { desktop()?.shell?.('busy', { on, label: on ? t('bk.busy_label') : '' })?.catch?.(() => {}); } catch {} };

// ── Wording ──
const titleOf = (title) => pickTitle({ title }, getLang()) || '';
const dateOf = (ms) => { try { return new Date(ms).toLocaleDateString(getLang(), { dateStyle: 'medium' }); } catch { return ''; } };
const reasonOf = (reason) => t(`bk.reason_${reason}`) || reason;

// Up to `max` problems as lines ("Title — why"), and how many more there are.
function problemLines(problems, max = 6) {
  const lines = problems.slice(0, max).map(p => `${titleOf(p.title) || `#${p.gid}`} — ${reasonOf(p.reason)}`);
  if (problems.length > max) lines.push(t('bk.more', { n: formatCount(problems.length - max) }));
  return lines.join('\n');
}

// "1.2 GB of 23 GB · About 4 min left", once there is enough to tell.
function progressLines({ done, total, bytes = 0, totalBytes = 0 }, started, unit = 'bk.gallery_progress') {
  const lines = [total ? t(unit, { done: formatCount(done), total: formatCount(total) }) : ''];
  if (totalBytes) {
    let line = t('bk.bytes_progress', { done: formatBytes(bytes), total: formatBytes(totalBytes) });
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed > 5 && bytes > 0 && bytes < totalBytes) {
      const left = ((totalBytes - bytes) / bytes) * elapsed;
      line += ' · ' + (left < 60 ? t('bk.left_soon') : t('bk.left_minutes', { n: formatCount(Math.ceil(left / 60)) }));
    }
    lines.push(line);
  }
  return lines;
}
const fraction = ({ done, total, bytes = 0, totalBytes = 0 }) => (totalBytes ? [bytes, totalBytes] : [done, total]);

// A failure, said for what it is.
function errorText(e) {
  const code = String(e?.code || '');
  const known = ['not-backup', 'truncated', 'newer', 'too-large', 'corrupt', 'unsafe', 'unreadable', 'quota', 'unavailable'];
  const body = known.includes(code) ? t(`bk.err_${code.replace('-', '_')}`) : t('bk.err_other');
  const lines = [];
  if (e?.written?.length) lines.push(t('bk.err_written', { n: formatCount(e.written.length) }));
  const detail = e?.detail || (known.includes(code) ? '' : String(e?.message || e || ''));
  return { body: [body, ...lines].join('\n\n'), detail };
}

const save = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  // The browser's download holds the file once it starts; the address goes a while after.
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
};

// ── Restoring ──

// Ask before anything is written: what the backup holds, what can't be restored, and — when a
// restore of it was cut short — whether to carry on. Resolves { resume } or null (not now).
async function askRestore(inspection, done, exportedAt) {
  const total = inspection.galleries.length;
  if (!inspection.ok) {
    await alertDialog({ title: t('bk.nothing_title'), body: t('bk.problems_list', { n: formatCount(inspection.bad) }),
      detail: problemLines(inspection.galleries.filter(g => g.problem).map(g => ({ gid: g.gid, title: g.title, ...g.problem }))), tone: 'error' });
    return null;
  }
  const body = [t('bk.confirm_body', { date: dateOf(exportedAt), g: formatCount(inspection.ok), p: formatCount(inspection.pages), size: formatBytes(inspection.bytes) })];
  if (inspection.missingPages) body.push(t('bk.confirm_missing', { n: formatCount(inspection.missingPages) }));
  const bad = inspection.galleries.filter(g => g.problem).map(g => ({ gid: g.gid, title: g.title, ...g.problem }));
  const detail = bad.length ? `${t('bk.confirm_bad', { n: formatCount(bad.length), total: formatCount(total) })}\n${problemLines(bad)}` : '';
  if (done.size) {
    const answer = await choiceDialog({ title: t('bk.confirm_title'), body: body.join('\n\n'), detail, ok: t('bk.confirm_ok'),
      choices: [
        { value: 'resume', label: t('bk.resume'), detail: t('bk.resume_detail', { n: formatCount(done.size) }) },
        { value: 'all', label: t('bk.restart'), detail: t('bk.restart_detail') },
      ] });
    return answer ? { resume: answer.value === 'resume' } : null;
  }
  return await confirmDialog({ title: t('bk.confirm_title'), body: body.join('\n\n'), detail, ok: t('bk.confirm_ok') }) ? { resume: false } : null;
}

// What a finished restore did.
async function tellRestored(result, inspection) {
  if (result.kind === 'metadata') {
    await alertDialog({ title: t('bk.done_title'), body: t('dlg.import_meta_body', { n: formatCount(result.written.length) }), tone: 'success' });
    return;
  }
  const byId = new Map((inspection?.galleries || []).map(g => [g.gid, g]));
  const pages = [...result.written, ...(result.resumed || [])].reduce((n, gid) => n + (byId.get(gid)?.pages || 0), 0);
  const galleries = result.written.length + (result.skipped || 0);
  const notes = [];
  if (result.settings?.failed?.length) notes.push(t('bk.settings_failed', { n: formatCount(result.settings.failed.length) }));
  if (result.seriesNotRefreshed?.length) notes.push(t('bk.series_failed', { n: formatCount(result.seriesNotRefreshed.length) }));
  if (result.missingPages) notes.push(t('bk.confirm_missing', { n: formatCount(result.missingPages) }));
  if (result.cancelled) {
    await alertDialog({ title: t('bk.stopped_title'), tone: 'info',
      body: [t('bk.stopped_body', { g: formatCount(galleries), total: formatCount(inspection?.ok ?? galleries) }), ...notes].join('\n\n') });
    return;
  }
  const problems = result.problems || [];
  await alertDialog({
    title: problems.length ? t('bk.done_problems_title') : t('bk.done_title'),
    tone: problems.length ? 'info' : 'success',
    body: [t('bk.done_body', { g: formatCount(galleries), p: formatCount(pages) }), ...notes].join('\n\n'),
    detail: problems.length ? `${t('bk.problems_list', { n: formatCount(problems.length) })}\n${problemLines(problems)}` : '',
  });
}

// Restore one file (any name: what it is is read from it). Resolves whether it restored settings.
async function restoreOne(file) {
  const stop = new AbortController();
  const op = showOperation({ title: t('bk.reading_title'), body: t('bk.reading_body'), stopLabel: t('common.cancel'),
    onStop: () => { op.stopping(t('bk.stopping')); stop.abort(); } });
  busy(true);
  let restoredSettings = false;
  try {
    const kind = await probeBackup(file);
    if (kind === 'full' && native()) {
      const path = desktop().pathOf(file);
      if (path) { restoredSettings = await restoreNative(path, op, stop); return restoredSettings; }
    }
    const opened = await openBackup(file, { signal: stop.signal,
      onProgress: (p) => op.update({ done: p.done, total: p.total, lines: [t('bk.checking_progress', { done: formatCount(p.done), total: formatCount(p.total) })] }) });
    let resume = false;
    if (opened.kind === 'full') {
      op.hide();
      const answer = await askRestore(opened.inspection, opened.done, opened.archive.exportedAt);
      if (!answer) return;
      resume = answer.resume;
      op.show();
    }
    const started = performance.now();
    op.update({ title: opened.kind === 'full' ? t('bk.restoring_title') : t('bk.meta_restoring_title'), body: t('bk.restoring_body'), lines: [] });
    const result = await restoreBackup(opened, { resume, signal: stop.signal,
      onProgress: (p) => { const [d, n] = fraction(p); op.update({ done: d, total: n, lines: progressLines(p, started) }); } });
    if (resume) { result.resumed = [...opened.done]; }
    op.close();
    await tellRestored(result, opened.inspection);
    restoredSettings = !!result.settings?.restored;
  } catch (e) {
    op.close();
    if (e?.code === 'cancelled') return;
    const { body, detail } = errorText(e);
    await alertDialog({ title: t('bk.err_title'), body, detail, tone: 'error' });
  } finally {
    op.close();
    busy(false);
  }
  return restoredSettings;
}

// The desktop app restores the file itself; this window shows it and answers its questions.
async function restoreNative(path, op, stop) {
  const shell = desktop().shell;
  const opened = await shell('backupOpen', { path });
  if (!opened?.ok) throw Object.assign(new Error(opened?.code || 'aborted'), { code: opened?.code });
  const id = opened.id;
  stop.signal.addEventListener('abort', () => { shell('backupCancel', { id }).catch(() => {}); }, { once: true });
  try {
    let state = await follow(id, (s) => op.update({ done: s.done, total: s.total,
      lines: [s.total ? t('bk.checking_progress', { done: formatCount(s.done), total: formatCount(s.total) }) : ''] }), ['inspected']);
    const inspection = state.inspection;
    op.hide();
    const answer = await askRestore(inspection, new Set(inspection.done || []), inspection.exportedAt);
    if (!answer) return false;
    op.show();
    const started = performance.now();
    op.update({ title: t('bk.restoring_title'), body: t('bk.restoring_body'), lines: [] });
    const go = await shell('backupRestore', { id, resume: answer.resume });
    if (!go?.ok) throw Object.assign(new Error(go?.code || 'aborted'), { code: go?.code });
    state = await follow(id, (s) => { const [d, n] = fraction(s); op.update({ done: d, total: n, lines: progressLines(s, started) }); });
    const result = { kind: 'full', ...state.result };
    if (answer.resume) result.resumed = inspection.done || [];
    let restored = 0;
    if (!result.cancelled && result.settings) {
      result.settings = restoreSettings(result.settings, localStorage);
      restored = result.settings.restored;
    }
    op.close();
    await tellRestored(result, inspection);
    return restored > 0;
  } finally {
    shell('backupClose', { id }).catch(() => {});
  }
}

// A desktop app backup job followed until it reaches one of `until` (or ends): its state then.
// Throws its error when it failed; a cancelled one throws `cancelled`.
async function follow(id, onState, until = []) {
  for (;;) {
    const res = await desktop().shell('backupState', { id });
    const state = res?.state;
    if (!res?.ok || !state) throw Object.assign(new Error('the backup job is gone'), { code: 'aborted' });
    onState(state);
    if (state.phase === 'failed') throw Object.assign(new Error(state.error?.detail || state.error?.code || 'failed'), { code: state.error?.code, detail: state.error?.detail, written: state.result?.written });
    if (state.phase === 'cancelled' && !state.result) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    if (state.phase === 'done' || until.includes(state.phase) || (state.phase === 'cancelled' && state.result)) return state;
    await new Promise(r => setTimeout(r, 400));
  }
}

// Restore each of `files` in turn (a backup dropped on the library, picked in Settings).
export async function importBackups(files) {
  let settings = false;
  for (const file of files) {
    const ran = await withLock(async () => { settings = (await restoreOne(file)) || settings; return true; });
    if (!ran) break;
  }
  // Restored preferences take effect on a fresh page.
  if (settings) location.reload();
}

// ── Checking ──
// Read a backup through and check every picture, writing nothing.
export async function checkBackup(file) {
  await withLock(async () => {
    const stop = new AbortController();
    const op = showOperation({ title: t('bk.check_title'), body: t('bk.check_body'), stopLabel: t('common.cancel'),
      onStop: () => { op.stopping(t('bk.stopping_check')); stop.abort(); } });
    try {
      if (await probeBackup(file) === 'metadata') {
        const opened = await openBackup(file);
        op.close();
        await alertDialog({ title: t('bk.check_ok_title'), body: t('bk.check_meta_body', { n: formatCount(opened.entries.length) }), tone: 'success' });
        return;
      }
      const archive = await openArchive(file);
      const inspection = await inspectArchive(archive, { signal: stop.signal,
        onProgress: (p) => op.update({ done: p.done, total: p.total, lines: [t('bk.checking_progress', { done: formatCount(p.done), total: formatCount(p.total) })] }) });
      const started = performance.now();
      const checked = await verifyArchive(archive, inspection, { signal: stop.signal,
        onProgress: (p) => { const [d, n] = fraction(p); op.update({ done: d, total: n, lines: progressLines(p, started) }); } });
      op.close();
      const facts = { g: formatCount(inspection.ok), p: formatCount(inspection.pages), size: formatBytes(inspection.bytes), date: dateOf(archive.exportedAt) };
      if (checked.problems.length) {
        await alertDialog({ title: t('bk.check_bad_title'), tone: 'error',
          body: [t('bk.check_bad_body', facts), inspection.missingPages ? t('bk.confirm_missing', { n: formatCount(inspection.missingPages) }) : ''].filter(Boolean).join('\n\n'),
          detail: `${t('bk.problems_list', { n: formatCount(checked.problems.length) })}\n${problemLines(checked.problems)}` });
      } else {
        await alertDialog({ title: t('bk.check_ok_title'), tone: 'success',
          body: [t(checked.hashed ? 'bk.check_ok_body' : 'bk.check_legacy_body', facts),
            inspection.missingPages ? t('bk.confirm_missing', { n: formatCount(inspection.missingPages) }) : ''].filter(Boolean).join('\n\n') });
      }
    } catch (e) {
      op.close();
      if (e?.code === 'cancelled') return;
      const { body, detail } = errorText(e);
      await alertDialog({ title: t('bk.check_bad_title'), body, detail, tone: 'error' });
    } finally {
      op.close();
    }
  });
}

// ── Making a backup ──
// kind: 'full' (.shioridb) or 'metadata' (.shi).
export async function exportBackup(kind) {
  if (kind === 'full' && !api.capabilities.browserLibrary && !api.capabilities.desktopWindow) {
    // A library the desktop app keeps: its pictures would all pass through this browser.
    await alertDialog({ title: t('bk.desktop_export_title'), body: t('bk.desktop_export_body'), tone: 'info' });
    return;
  }
  await withLock(async () => {
    const stop = new AbortController();
    if (kind === 'full' && native()) { await exportNative(stop); return; }
    const op = showOperation({ title: kind === 'full' ? t('bk.making_title') : t('bk.making_meta_title'),
      body: kind === 'full' ? t('bk.making_body') : '', stopLabel: t('common.cancel'),
      onStop: () => { op.stopping(t('bk.stopping_export')); stop.abort(); } });
    busy(true);
    try {
      const started = performance.now();
      if (kind === 'metadata') {
        const { blob, suggestedName, count } = await exportMetadata({ signal: stop.signal,
          onProgress: (p) => op.update({ done: p.done, total: p.total, lines: progressLines(p, started) }) });
        save(blob, suggestedName);
        op.close();
        await alertDialog({ title: t('bk.meta_done_title'), body: t('bk.meta_done_body', { n: formatCount(count), name: suggestedName }), tone: 'success' });
        return;
      }
      const made = await exportFull({ signal: stop.signal,
        onProgress: (p) => { const [d, n] = fraction(p); op.update({ done: d, total: n, lines: progressLines(p, started) }); } });
      save(made.archive, made.suggestedName);
      op.close();
      const notes = [];
      if (made.archive.size > 1024 ** 3) notes.push(t('bk.handed_large'));
      if (made.missing.length) notes.push(t('bk.export_missing', { n: formatCount(made.missing.length) }));
      if (made.changed.length) notes.push(t('bk.export_changed', { n: formatCount(made.changed.length) }));
      await alertDialog({ title: t('bk.handed_title'), tone: made.missing.length ? 'info' : 'success',
        body: [t('bk.handed_body', { g: formatCount(made.counts.galleries), p: formatCount(made.counts.images),
          size: formatBytes(made.archive.size), name: made.suggestedName }), ...notes].join('\n\n') });
    } catch (e) {
      op.close();
      if (e?.code === 'cancelled') return;
      const { body, detail } = errorText(e);
      await alertDialog({ title: t('bk.export_err_title'), body, detail, tone: 'error' });
    } finally {
      op.close();
      busy(false);
    }
  });
}

// The desktop app makes the backup itself, straight into the file the person chooses.
async function exportNative(stop) {
  const shell = desktop().shell;
  const started = await shell('backupExport', { settings: snapshotSettings(localStorage) });
  if (!started?.ok) {
    if (started?.code === 'cancelled') return;
    await alertDialog({ title: t('bk.export_err_title'), body: errorText(started).body, tone: 'error' });
    return;
  }
  const id = started.id;
  const op = showOperation({ title: t('bk.making_title'), body: t('bk.making_native_body'), stopLabel: t('common.cancel'),
    onStop: () => { op.stopping(t('bk.stopping_export')); stop.abort(); shell('backupCancel', { id }).catch(() => {}); } });
  try {
    const begun = performance.now();
    const state = await follow(id, (s) => { const [d, n] = fraction(s); op.update({ done: d, total: n, lines: progressLines(s, begun) }); });
    op.close();
    const made = state.result;
    if (!made || state.phase === 'cancelled') return;
    const notes = [];
    if (made.missing?.length) notes.push(t('bk.export_missing', { n: formatCount(made.missing.length) }));
    if (made.changed?.length) notes.push(t('bk.export_changed', { n: formatCount(made.changed.length) }));
    const reveal = await confirmDialog({ title: t('bk.saved_title'),
      body: [t('bk.saved_body', { g: formatCount(made.counts.galleries), p: formatCount(made.counts.images), size: formatBytes(made.bytes) }), ...notes].join('\n\n'),
      detail: made.path, ok: t('bk.show_folder'), cancel: t('common.close') });
    if (reveal) shell('revealPath', { path: made.path }).catch(() => {});
  } catch (e) {
    op.close();
    if (e?.code === 'cancelled') return;
    const { body, detail } = errorText(e);
    await alertDialog({ title: t('bk.export_err_title'), body, detail, tone: 'error' });
  } finally {
    op.close();
    shell('backupClose', { id }).catch(() => {});
  }
}

// A backup the desktop app is still making or restoring for this window (it was reloaded meanwhile):
// shown again until it ends.
export async function attachNativeBackup() {
  if (!native()) return;
  const current = await desktop().shell('backupCurrent').catch(() => null);
  if (!current?.ok || !current.id) return;
  const id = current.id;
  const first = (await desktop().shell('backupState', { id }).catch(() => null))?.state;
  // One that ended, or that was waiting for this window's answer, is let go.
  if (!first || !['preparing', 'exporting', 'restoring'].includes(first.phase)) {
    if (first?.phase === 'inspected' || first?.phase === 'inspecting') desktop().shell('backupCancel', { id }).catch(() => {});
    desktop().shell('backupClose', { id }).catch(() => {});
    return;
  }
  const op = showOperation({ title: first.kind === 'export' ? t('bk.making_title') : t('bk.restoring_title'), stopLabel: t('common.cancel'),
    onStop: () => { op.stopping(t('bk.stopping')); desktop().shell('backupCancel', { id }).catch(() => {}); } });
  try {
    const begun = performance.now();
    await follow(id, (s) => { const [d, n] = fraction(s); op.update({ done: d, total: n, lines: progressLines(s, begun) }); });
  } catch {} finally {
    op.close();
    desktop().shell('backupClose', { id }).catch(() => {});
  }
}
