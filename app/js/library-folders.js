// library-folders.js — the library's places as every page meets them: a place's name as the person
// knows it (placeName), whether it can be used now (usable), what a change the library refused for now
// says (refusalText) and a deletion it refused (deleteRefused), a gallery moved to another place, asking
// where (moveGalleryTo), the PDFs its folders hold drawn into the library (drawWaitingPdfs), and on every
// page of a browser library, a prompt while one of its folders waits for this page's permission
// (promptFolderAccess). Settings' card of the places is src/routes/settings/folders.tsx, over
// folder-card.js.
import * as api from './api.js';
import * as platform from './platform.js';
import { refusalKey } from './backend-error.js';
import { t } from './i18n.js';
import { formatCount } from './format.js';
import { ask, showProgress, alertDialog, showToast } from './notice.js';
import { resumeFolderWork } from './folder-scan.js';

// A place as the person knows it: this browser, or a folder by its name.
export const placeName = (f) => (f.kind === 'browser' ? t('set.loc_browser') : f.name || f.path || '');
// Whether a place can be used now (or with one click): not out of reach, another library's, or another
// app's.
export const usable = (f) => f.access === 'granted' || f.access === 'prompt';

// Galleries to move (`ids`; `series`: each with its series) to place `to`, with a progress window.
// Resolves how many couldn't be moved (the first error with it).
async function moveAll(ids, to, { series = true } = {}) {
  const progress = showProgress({ title: t('lf.moving') });
  let failed = 0, error = null;
  try {
    for (let i = 0; i < ids.length; i++) {
      try {
        await api.galleries.move(ids[i], to, { series,
          onProgress: (done, total) => progress.update(done, total, ids.length > 1 ? t('maint.progress', { done: formatCount(i + 1), total: formatCount(ids.length) }) : ''),
        });
      } catch (e) { failed++; error ??= e; }
      if (ids.length > 1) progress.update(i + 1, ids.length, t('maint.progress', { done: formatCount(i + 1), total: formatCount(ids.length) }));
    }
  } finally { progress.close(); }
  return { failed, error };
}

// What a change the library refused for now says — another app is using its gallery's folder (one app
// changes a folder's galleries at a time: reason 'not-owned' as it commits, 'taken' for a folder's own
// work), or the folder came back and is still being scanned ('handover') — or null for any other failure
// (backend-error.js refusalKey).
export const refusalText = (err) => { const key = refusalKey(err); return key ? t(key) : null; };

// A deletion the library refused because its gallery's folder can't be changed now (BackendError
// 'unavailable' with the folder's refusal as its `reason`: out of reach, another library's folder at
// its place, another app's, still being scanned after it came back, or this page without leave), said in
// a dialog. Resolves whether it was one.
const DELETE_REFUSED = { 'not-owned': 'dlg.del_refused_taken', handover: 'lf.handover_msg', 'no-permission': 'dlg.del_refused_permission' };
export async function deleteRefused(err) {
  if (err?.code !== 'unavailable' || !err.reason) return false;
  await alertDialog({ title: t('dlg.del_refused_title'), body: t(DELETE_REFUSED[err.reason] || 'dlg.del_refused_unavailable'), tone: 'error' });
  return true;
}

// Gallery `gid` (a series owner: its series) moved to another of the library's places, asking where.
export async function moveGalleryTo(gid, current) {
  const all = await api.folders.list();
  const places = all.filter(f => f.id !== current && usable(f) && !f.hidden);
  if (!places.length) return false;
  const here = all.find(f => f.id === current);
  const choice = await ask({ title: t('lf.move_title'), body: here ? t('lf.move_body', { name: placeName(here) }) : '', choices: [
    ...places.map(f => ({ value: f.id, label: placeName(f), detail: [f.isDefault ? t('lf.default') : '', f.path || ''].filter(Boolean).join(' · ') })),
    { value: '', label: t('common.cancel') }] });
  if (!choice) return false;
  const target = places.find(f => f.id === choice);
  if (target?.access === 'prompt' && await api.folders.allow(target.id) !== 'granted') {
    await alertDialog({ title: t('lf.move_failed'), body: t('lf.denied'), tone: 'error' });
    return false;
  }
  const { failed, error } = await moveAll([gid], choice);
  if (failed) await alertDialog({ title: t('lf.move_failed'), body: refusalText(error) ?? String(error?.message || error), tone: 'error' });
  return !failed;
}

// The PDFs the library's folders hold whose pages wait to be drawn (a page draws them, as the import
// does; api.js folders.pdfsWaiting): drawn one at a time, each a task the tasks page can stop, and
// joined to the library. One that can't be drawn (damaged, or locked) is noted as such (pdfFailed):
// not tried again until its file changes.
let _drawing = null;
export function drawWaitingPdfs() {
  return _drawing ??= (async () => {
    try {
      const waiting = await api.folders.pdfsWaiting().catch(() => []);
      if (!waiting.length) return;
      const { renderPdfPages } = await import('./import-files.js');
      for (const w of waiting) {
        const job = { gid: `pdf-${w.gid}`, kind: 'folder', title: w.name, labelKey: 'lf.task_pdf', doneKey: 'lf.task_pdf_done', foundKey: '' };
        const say = (extra) => platform.jobs.publish({ ...job, ...extra }).catch(() => {});
        let stop = false;
        const off = platform.jobs.subscribe((e) => { if (e?.type === 'STOP_FOLDER_SCAN' && e.job === job.gid) stop = true; });
        say({ status: 'started', done: 0, total: 0 });
        let token = null;   // the version of the file drawn: what is kept, or noted, is for it alone
        try {
          // Stopped between two pages: the drawing ends there, and nothing is kept.
          const source = await api.folders.pdfSource(w.folder, w.gid);
          token = source.token;
          const pages = await renderPdfPages(source.file, ({ done, total }) => {
            if (stop) throw Object.assign(new Error('stopped'), { stopped: true });
            say({ status: 'progress', done, total });
          });
          if (stop) throw Object.assign(new Error('stopped'), { stopped: true });
          await api.folders.addRendered(w.folder, w.gid, pages, token);
          say({ status: 'done', done: pages.length, total: pages.length, found: pages.length });
        } catch (e) {
          if (e?.stopped) { say({ status: 'cancelled' }); continue; }
          // The PDF couldn't be drawn (the library refusing, or out of reach, is not the PDF's doing).
          if (e?.name !== 'BackendError' && token) await api.folders.pdfFailed(w.folder, w.gid, token).catch(() => {});
          const key = refusalKey(e);   // a refusal for now, said by its own key (S33)
          say({ status: 'error', error: String(e?.message || e), ...(key ? { errorKey: key } : {}) });
        } finally { off(); }
      }
    } finally { _drawing = null; }
  })();
}

// Every page of a browser library: what a removal cut short carried on, what waited in this browser
// moved out to the folders this page may write to, and their PDFs drawn — and, while a folder shown
// that it keeps galleries in waits for this page's permission (the browser asks once a visit, unless
// the person chose to allow it on every visit), a prompt to allow it; once allowed, what waited for
// that one moves out too.
export async function promptFolderAccess() {
  if (!api.capabilities.browserLibrary || !api.capabilities.folders) return;
  resumeFolderWork().catch(() => {});
  api.folders.settle().catch(() => {});
  drawWaitingPdfs().catch(() => {});
  const waiting = await api.folders.waiting().catch(() => []);
  if (!waiting.length) return;
  const names = waiting.map(f => f.name).join(', ');
  showToast({ text: t('lf.prompt', { name: names }), action: t('lf.allow'), closeLabel: t('common.close'), onAction: async () => {
    let allowed = false;
    for (const f of waiting) if (await api.folders.allow(f.id).catch(() => null) === 'granted') allowed = true;
    // The page shows them again from the start (what it read meanwhile came back missing).
    if (allowed) location.reload();
  } });
}
