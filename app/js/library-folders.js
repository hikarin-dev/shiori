// library-folders.js — Settings → Storage → Library storage: where the library is kept, one card on
// the website and in the desktop app's window alike. A site chooses at its top between this
// browser's library and Shiori Desktop's (desktop-link.js mountLocation); under it, the places the
// library keeps galleries in — this browser's own storage (IndexedDB) and the folders added, or the
// desktop app's folders — each in a row of its own: its galleries and size, the default (where new
// galleries go), what it is doing (a check or a removal under way, as its task says), and a
// menu of what can be done with it (make it the default, check it again, open it in the desktop app,
// hide or show it, remove it). Adding a folder is "Add folder" under the list: the folder's row shows
// at once and fills in as it is checked. One another app uses (its claim, folder-owner.js) is added
// only once the person chooses to anyway; a folder another app took over is marked so on its row, and
// "Take back" (asked first) makes it this app's again. Removing one asks first, with an optional move of its
// galleries elsewhere (asked again, as it can't easily be undone); what it still owes the folder runs
// as a task. Hiding one keeps it listed while its galleries leave the library; showing it brings them
// back — both at once.
// The header checks every folder again. In the desktop app's window a card of its own holds when and
// how galleries left alone are archived (the desktop app's settings, through its window's bridge). A
// site that keeps its library in the desktop app shows only the location: its folders are the app's.
// What a row says, what its menu offers and the card's flow are folder-card.js's; this draws them.
//
// Also: on every page of a browser library, a prompt while one of its folders waits for this
// page's permission (promptFolderAccess).
import * as api from './api.js';
import * as platform from './platform.js';
import { refusalKey } from './backend-error.js';
import { t, applyTranslations } from './i18n.js';
import { formatCount } from './format.js';
import { ask, showProgress, alertDialog, showToast } from './notice.js';
import { resumeFolderWork } from './folder-scan.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shell = (action, ...args) => globalThis.shioriDesktop.shell(action, ...args);
const desktop = () => api.capabilities.desktopWindow;

const SVG = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  browser: SVG('<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>'),
  more: SVG('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  rescan: SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>'),
  plus: SVG('<path d="M12 5v14"/><path d="M5 12h14"/>'),
};

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

// A menu of `items` ({ label, danger, run }) under `anchor` (base.css .ctx-menu): closes on a pick,
// Escape, a click outside, scrolling or resizing.
let _menu = null;
function closeMenu() {
  if (!_menu) return;
  const { el, anchor, off } = _menu;
  _menu = null;
  el.remove();
  off();
  anchor.setAttribute('aria-expanded', 'false');
  if (anchor.isConnected) anchor.focus();
}
function openMenu(anchor, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu lf-menu';
  el.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') { el.append(Object.assign(document.createElement('div'), { className: 'lf-menu-sep' })); continue; }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ctx-menu-item${item.danger ? ' danger' : ''}`;
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.addEventListener('click', () => { closeMenu(); item.run(); });
    el.append(button);
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), m = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, r.right - m.width))}px`;
  el.style.top = `${r.bottom + 4 + m.height > innerHeight ? Math.max(8, r.top - m.height - 4) : r.bottom + 4}px`;
  const buttons = [...el.querySelectorAll('button')];
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
  _menu = { el, anchor, off: () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', closeMenu, true);
    window.removeEventListener('resize', closeMenu);
  } };
  anchor.setAttribute('aria-expanded', 'true');
  buttons[0]?.focus();
}

// The card, first in Storage: drawn here from what folder-card.js says (its rows, menus and flow).
export async function initLibraryFolders() {
  const panel = document.getElementById('panelStorage');
  if (!panel || document.getElementById('foldersSection')) return;
  const card = await import('./folder-card.js');
  const { manage, readOnly, withLocation, shown } = card.cardShape();
  if (!shown || document.getElementById('foldersSection')) return;
  const section = document.createElement('div');
  section.className = 'section';
  section.id = 'foldersSection';
  panel.prepend(section);
  section.innerHTML = `
    <div class="section-header">
      <h2 class="section-title" data-i18n="lf.card_title"></h2>
      ${manage ? `<button class="icon-btn lf-rescan-all" id="lfRescan" type="button">${ICON.rescan}</button>` : ''}
    </div>
    <div class="section-body">
      ${withLocation ? '<div id="lfLocation"></div>' : ''}
      ${readOnly ? '' : `<div class="lf-folders">
        <div class="lf-head"><span class="lf-head-title" data-i18n="lf.title"></span><span class="lf-head-hint" data-i18n="lf.desc"></span></div>
        <div class="lf-list" id="lfRows"></div>
        ${manage ? `<button class="lf-add" id="lfAdd" type="button">${ICON.plus}<span data-i18n="lf.add"></span></button>`
          : `<div class="lf-note" data-i18n="${card.unsupportedKey()}"></div>`}
      </div>`}
      <div class="status-msg hidden" id="lfStatus" role="status" aria-live="polite"></div>
    </div>`;
  const $ = (id) => section.querySelector(`#${id}`);
  const tips = () => {
    const rescan = $('lfRescan');
    if (!rescan) return;
    rescan.dataset.tip = card.rescanTip();
    rescan.setAttribute('aria-label', t('lf.rescan'));
  };
  applyTranslations(section);
  tips();

  const status = (text, type = 'ok') => {
    const el = $('lfStatus');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
    el.classList.remove('ok', 'err');
    el.classList.add(type);
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.classList.add('hidden'); el.textContent = ''; }, 8000);
  };
  if (withLocation) import('./desktop-link.js').then(m => m.mountLocation($('lfLocation'), status)).catch(() => {});
  if (readOnly) return;

  const folders = card.createFolderCard({ status });
  const badge = ({ text, warn, tip }) => `<span class="key-status-badge${warn ? ' unset' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${esc(text)}</span>`;
  // A folder's Needs attention list: a line per kind of item, its actions at the line's end.
  const attentionHtml = (lines) => {
    if (!lines.length) return '';
    const items = lines.map(({ reason, text, path, more, del }) => {
      const where = path ? ` · <code>${esc(path)}</code>${more > 0 ? ` (+${formatCount(more)})` : ''}` : '';
      const remove = del ? `<button class="btn-mini" type="button" data-act="att-delete" data-reason="${esc(reason)}">${esc(t('lf.att_delete'))}</button>` : '';
      return `<li class="lf-att-item"><span class="lf-att-text">${esc(text)}${where}</span><span class="lf-att-acts">${remove}`
        + `<button class="btn-mini" type="button" data-act="att-dismiss" data-reason="${esc(reason)}">${esc(t('lf.att_dismiss'))}</button></span></li>`;
    });
    return `<div class="lf-att"><span class="lf-att-title">${esc(t('lf.attention'))}</span><ul class="lf-att-list">${items.join('')}</ul></div>`;
  };
  const rowHtml = (f) => {
    const v = folders.row(f);
    const meta = [v.where && `<code>${esc(v.where)}</code>`, v.counts && esc(v.counts)].filter(Boolean).join(' · ');
    return `<div class="lf-item${v.busy ? ' busy' : ''}${v.hidden ? ' is-hidden' : ''}" data-folder="${esc(v.id)}">
      <span class="lf-icon">${v.kind === 'browser' ? ICON.browser : ICON.folder}</span>
      <div class="lf-main">
        <div class="lf-name"><span class="lf-title">${esc(v.name)}</span>${v.badges.map(badge).join('')}</div>
        ${meta ? `<div class="lf-meta">${meta}</div>` : ''}
        ${v.busy ? '<div class="lf-job"><div class="lf-bar"><span></span></div><span class="lf-job-text"></span></div>' : ''}
        ${attentionHtml(v.attention)}
      </div>
      ${v.button || v.actions ? `<div class="lf-actions">
        ${v.button ? `<button class="btn-mini" type="button" data-act="${v.button[0]}">${esc(v.button[1])}</button>` : ''}
        ${v.actions ? `<button class="icon-btn lf-more" type="button" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('lf.more'))}" data-tip="${esc(t('lf.more'))}">${ICON.more}</button>` : ''}
      </div>` : ''}
    </div>`;
  };
  // A row's job shown as it goes (only its bar and text change).
  const paintJob = (id) => {
    const row = $('lfRows').querySelector(`[data-folder="${CSS.escape(id)}"]`);
    if (!row) return;
    const bar = row.querySelector('.lf-bar');
    if (!bar) return;
    const v = folders.job(id);
    bar.classList.toggle('indeterminate', v.pct == null);
    bar.firstElementChild.style.width = v.pct == null ? '' : `${v.pct}%`;
    const text = row.querySelector('.lf-job-text');
    if (text.textContent !== v.text) text.textContent = v.text;
  };
  const draw = () => {
    const { rows, rescanHidden } = folders.get();
    const html = rows.map(rowHtml).join('');
    // Rebuilt only when something it shows changed, so nothing moves under the pointer otherwise.
    if ($('lfRows').dataset.html !== html) { $('lfRows').dataset.html = html; $('lfRows').innerHTML = html; }
    for (const id of folders.jobIds()) paintJob(id);
    const rescan = $('lfRescan');
    if (rescan) rescan.hidden = rescanHidden;
  };
  folders.subscribe(draw);
  await folders.start();
  window.addEventListener('shiori-lang-change', () => { applyTranslations(section); tips(); $('lfRows').dataset.html = ''; folders.refresh(); });

  $('lfAdd')?.addEventListener('click', () => folders.pick());

  $('lfRows').addEventListener('click', (e) => {
    const button = e.target.closest?.('[data-act]');
    const row = button?.closest('[data-folder]');
    const f = row && folders.place(row.dataset.folder);
    if (!f) return;
    if (button.dataset.act === 'more') {
      if (_menu?.anchor === button) { closeMenu(); return; }
      openMenu(button, folders.menu(f));
      return;
    }
    folders.act(f.id, button.dataset.act, button.dataset.reason);
  });

  $('lfRescan')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try { await folders.rescanAll(); } finally { button.disabled = false; }
  });

  if (desktop()) await initArchiving(section, card);
}

// The desktop app's window: when and how galleries left alone are archived, a card after the library's.
async function initArchiving(after, { ARCHIVE_AFTER, ARCHIVE_FORMATS }) {
  let state = await shell('state').catch(() => null);
  if (!state) return;
  const section = document.createElement('div');
  section.className = 'section';
  section.id = 'archiveSection';
  section.innerHTML = `
    <div class="section-header"><h2 class="section-title" data-i18n="lf.archive_title"></h2></div>
    <div class="section-body">
      <div class="field">
        <label class="field-label" for="deskArchiveAfter" data-i18n="set.desk_archive"></label>
        <div class="field-desc" data-i18n="set.desk_archive_desc"></div>
        <select class="field-input" id="deskArchiveAfter"></select>
      </div>
      <div class="field">
        <label class="field-label" for="deskArchiveFormat" data-i18n="set.desk_archive_format"></label>
        <div class="field-desc" data-i18n="set.desk_archive_format_desc"></div>
        <select class="field-input" id="deskArchiveFormat"></select>
      </div>
    </div>`;
  after.after(section);
  const $ = (id) => section.querySelector(`#${id}`);
  const render = () => {
    applyTranslations(section);
    $('deskArchiveAfter').innerHTML = Object.entries(ARCHIVE_AFTER).map(([v, key]) =>
      `<option value="${v}"${v === state.archiveAfter ? ' selected' : ''}>${esc(t(key))}</option>`).join('');
    $('deskArchiveFormat').innerHTML = ARCHIVE_FORMATS.map(v =>
      `<option value="${v}"${v === state.archiveFormat ? ' selected' : ''}>${esc(t(`set.lib_export_${v}`))}</option>`).join('');
  };
  render();
  window.addEventListener('shiori-lang-change', render);
  const set = async (key, value) => { state = await shell('set', key, value); render(); };
  $('deskArchiveAfter').addEventListener('change', (e) => set('archiveAfter', e.target.value));
  $('deskArchiveFormat').addEventListener('change', (e) => set('archiveFormat', e.target.value));
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
