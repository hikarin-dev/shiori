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
//
// Also: on every page of a browser library, a prompt while one of its folders waits for this
// page's permission (promptFolderAccess).
import * as api from './api.js';
import * as platform from './platform.js';
import { t, applyTranslations } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { ask, showProgress, confirmDialog, alertDialog, showToast, toggleDialog } from './notice.js';
import { startFolderScan, startFolderRemoval, resumeFolderWork } from './folder-scan.js';
import { desktopHosted } from './library-location.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shell = (action, ...args) => globalThis.shioriDesktop.shell(action, ...args);
const desktop = () => api.capabilities.desktopWindow;
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const QUIET_MS = 20000;   // a folder's task says it is running every 5 s: one silent this long has ended

const SVG = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  browser: SVG('<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>'),
  more: SVG('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  rescan: SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>'),
  plus: SVG('<path d="M12 5v14"/><path d="M5 12h14"/>'),
};

// How long a gallery is left alone before it is archived (desktop main.js ARCHIVE_AFTER).
const ARCHIVE_AFTER = { never: 'set.desk_archive_never', day: 'set.desk_archive_day', week: 'set.desk_archive_week', month: 'set.desk_archive_month' };

// Folder `id` checked for galleries put in it outside the app, as a task: a browser library's in its
// service worker (or this page), the desktop app's in the app.
function checkFolder(id, opts) {
  if (api.capabilities.browserLibrary) startFolderScan(id, opts).catch(() => {});
  else api.folders.scan(id).catch(() => {});
}

// A place as the person knows it: this browser, or a folder by its name.
export const placeName = (f) => (f.kind === 'browser' ? t('set.loc_browser') : f.name || f.path || '');
// Whether a place can be used now (or with one click): not out of reach, another library's, or another
// app's.
const usable = (f) => f.access === 'granted' || f.access === 'prompt';
// What each kind of Needs attention item says (api.js folders.list `attention`).
const ATTENTION = { conflict: 'lf.att_conflict', unreadable: 'lf.att_unreadable', corrupt: 'lf.att_corrupt', 'missing-file': 'lf.att_missing_file',
  unsupported: 'lf.att_unsupported', 'adopt-failed': 'lf.att_adopt_failed', 'changed-both': 'lf.att_changed_both', unreferenced: 'lf.att_unreferenced',
  outside: 'lf.att_outside', left: 'lf.att_left', duplicate: 'lf.att_duplicate' };
// The app a folder's claim names (api.js `owner`), as the person knows it.
const ownerName = (o) => (o?.app === 'desktop' && o.host ? t('lf.owner_desktop', { host: o.host })
  : o?.app === 'web' && o.browser ? t('lf.owner_web', { browser: o.browser, site: o.site || '' }) : t('lf.owner_unknown'));
// Asks whether to use a folder another app holds anyway (`take`: one this app had, taken back).
const useAnyway = (owner, { take = false, name = '' } = {}) => confirmDialog({ danger: true,
  title: take ? t('lf.take_back_title', { name }) : t('lf.claimed_title'),
  body: t('lf.in_use_body', { owner: ownerName(owner) }), ok: take ? t('lf.take_back') : t('lf.use_anyway') });

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

// A deletion the library refused because its gallery's folder can't be changed now (BackendError
// 'unavailable' with the folder's refusal as its `reason`: out of reach, another library's folder at
// its place, another app's, or this page without leave), said in a dialog. Resolves whether it was one.
const DELETE_REFUSED = { 'not-owned': 'dlg.del_refused_taken', 'no-permission': 'dlg.del_refused_permission' };
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
  if (failed) await alertDialog({ title: t('lf.move_failed'), body: String(error?.message || error), tone: 'error' });
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

// A folder's job as its row says it: { pct (null: under way, how far unknown), text }.
function jobView(job) {
  const total = job.total || 0, done = job.done || 0;
  const label = job.labelKey ? t(job.labelKey, job.labelArgs) : '';
  const tally = total ? `${formatCount(done)} / ${formatCount(total)}` : '';
  const found = job.found && job.foundKey !== '' ? t(job.foundKey || 'lf.task_found', { n: formatCount(job.found) }) : '';
  const updated = job.updated ? t('lf.task_updated', { n: formatCount(job.updated) }) : '';
  return { pct: total ? Math.round((done / total) * 100) : null, text: [label, tally, found, updated].filter(Boolean).join(' · ') };
}

// The card, first in Storage.
export async function initLibraryFolders() {
  const panel = document.getElementById('panelStorage');
  if (!panel || document.getElementById('foldersSection')) return;
  const manage = api.capabilities.folders;          // 'pick', 'path', or null
  const readOnly = !manage && !api.capabilities.browserLibrary;   // the desktop app's library, from a site
  const withLocation = !desktop() && !desktopHosted();
  if (readOnly && !withLocation) return;
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
          : '<div class="lf-note" data-i18n="lf.unsupported"></div>'}
      </div>`}
      <div class="status-msg hidden" id="lfStatus" role="status" aria-live="polite"></div>
    </div>`;
  const $ = (id) => section.querySelector(`#${id}`);
  const tips = () => {
    const rescan = $('lfRescan');
    if (!rescan) return;
    rescan.dataset.tip = `${t('lf.rescan')}\n${t(desktop() ? 'set.desk_rescan_desc' : 'lf.rescan_desc')}`;
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

  let places = [];
  const jobs = new Map();     // folder id → its job under way (a check, a removal or a hiding)
  const adding = new Map();   // a folder being added → its name, until it is listed
  const showing = new Set();  // places being shown again, until they are

  const actionsOf = (f) => {
    if (f.ghost || showing.has(f.id)) return [];
    const out = [];
    if (f.hidden) out.push({ label: t('lf.show'), run: () => showPlace(f) });
    if (!f.hidden && !f.isDefault && usable(f)) out.push({ label: t('lf.make_default'), run: () => api.folders.setDefault(f.id).then(render, failed) });
    if (!f.hidden && f.kind === 'folder' && f.access === 'granted' && manage) out.push({ label: t('lf.rescan_one'), run: () => { checkFolder(f.id, { name: f.name }); render(); } });
    if (desktop() && f.path) out.push({ label: t('lf.open'), run: () => shell('openLibraryFolder', f.path) });
    if (!f.hidden && !f.isDefault && manage) out.push({ label: t('lf.hide'), run: () => hidePlace(f).catch(failed) });
    if (f.removable && manage) out.push('-', { label: t('lf.remove'), danger: true, run: () => removePlace(f).catch(failed) });
    return out[0] === '-' ? out.slice(1) : out;
  };
  const badge = (text, warn, tip = '') => `<span class="key-status-badge${warn ? ' unset' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${esc(text)}</span>`;
  // A folder's Needs attention list (D15): its items grouped by what they are, one line each — what,
  // where (the first one, the rest counted), and what can be done: put it away, or for a gallery whose
  // folder holds something else now, delete its entry (nothing in the folder is deleted).
  const attentionHtml = (f) => {
    const groups = new Map();
    for (const item of f.attention || []) {
      if (!groups.has(item.reason)) groups.set(item.reason, []);
      groups.get(item.reason).push(item);
    }
    if (!groups.size) return '';
    const lines = [...groups].map(([reason, items]) => {
      const what = t(ATTENTION[reason] || 'lf.att_other');
      const where = items[0].path ? ` · <code>${esc(items[0].path)}</code>${items.length > 1 ? ` (+${formatCount(items.length - 1)})` : ''}` : '';
      const remove = reason === 'conflict' && items.length === 1 && items[0].gid
        ? `<button class="btn-mini" type="button" data-act="att-delete" data-reason="${esc(reason)}">${esc(t('lf.att_delete'))}</button>` : '';
      return `<li class="lf-att-item"><span class="lf-att-text">${esc(what)}${where}</span><span class="lf-att-acts">${remove}`
        + `<button class="btn-mini" type="button" data-act="att-dismiss" data-reason="${esc(reason)}">${esc(t('lf.att_dismiss'))}</button></span></li>`;
    });
    return `<div class="lf-att"><span class="lf-att-title">${esc(t('lf.attention'))}</span><ul class="lf-att-list">${lines.join('')}</ul></div>`;
  };
  const rowHtml = (f) => {
    const job = jobs.get(f.id);
    const where = f.kind === 'browser' ? '<code>IndexedDB</code>' : f.path ? `<code>${esc(f.path)}</code>` : '';
    const meta = f.ghost ? '' : [where, esc(t('lf.counts', { n: formatCount(f.galleries), size: formatBytes(f.size) }))].filter(Boolean).join(' · ');
    const badges = [f.isDefault && badge(t('lf.default')), f.hidden && badge(t('lf.hidden')),
      f.access === 'prompt' && !f.hidden && badge(t('lf.needs_access'), true), f.access === 'unavailable' && badge(t('lf.unavailable'), true),
      f.access === 'other-library' && badge(t('lf.other_library'), true, t('lf.other_library_tip')),
      f.access === 'taken' && badge(t('lf.taken'), true, t(f.owner?.active === false ? 'lf.released_tip' : 'lf.taken_tip', { owner: ownerName(f.owner) }))].filter(Boolean).join('');
    const button = f.hidden ? null : f.access === 'prompt' ? ['allow', t('lf.allow')] : f.access === 'taken' && manage ? ['claim', t('lf.take_back')] : null;
    const busy = job || f.ghost || showing.has(f.id);
    const actions = actionsOf(f).length;
    return `<div class="lf-item${busy ? ' busy' : ''}${f.hidden ? ' is-hidden' : ''}" data-folder="${esc(f.id)}">
      <span class="lf-icon">${f.kind === 'browser' ? ICON.browser : ICON.folder}</span>
      <div class="lf-main">
        <div class="lf-name"><span class="lf-title">${esc(f.ghost ? f.name : placeName(f))}</span>${badges}</div>
        ${meta ? `<div class="lf-meta">${meta}</div>` : ''}
        ${busy ? '<div class="lf-job"><div class="lf-bar"><span></span></div><span class="lf-job-text"></span></div>' : ''}
        ${f.ghost ? '' : attentionHtml(f)}
      </div>
      ${button || actions ? `<div class="lf-actions">
        ${button ? `<button class="btn-mini" type="button" data-act="${button[0]}">${esc(button[1])}</button>` : ''}
        ${actions ? `<button class="icon-btn lf-more" type="button" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('lf.more'))}" data-tip="${esc(t('lf.more'))}">${ICON.more}</button>` : ''}
      </div>` : ''}
    </div>`;
  };
  // A row's job shown as it goes (only its bar and text change).
  const paintJob = (id) => {
    const row = $('lfRows').querySelector(`[data-folder="${CSS.escape(id)}"]`);
    if (!row) return;
    const job = jobs.get(id);
    const bar = row.querySelector('.lf-bar');
    if (!bar) return;
    const v = job ? jobView(job) : { pct: null, text: t(showing.has(id) ? 'lf.showing' : 'lf.adding') };
    bar.classList.toggle('indeterminate', v.pct == null);
    bar.firstElementChild.style.width = v.pct == null ? '' : `${v.pct}%`;
    const text = row.querySelector('.lf-job-text');
    if (text.textContent !== v.text) text.textContent = v.text;
  };
  const render = async () => {
    places = await api.folders.list().catch(() => places);
    const listed = new Set(places.map(f => f.id));
    // A folder being removed is off the list at once: its row stays while its task runs.
    const ghosts = [...jobs].filter(([id]) => !listed.has(id)).map(([id, job]) => ({ id, kind: 'folder', name: job.title || '', ghost: true }));
    const pending = [...adding].map(([key, name]) => ({ id: key, kind: 'folder', name, ghost: true }));
    const html = [...places, ...ghosts, ...pending].map(rowHtml).join('');
    // Rebuilt only when something it shows changed, so nothing moves under the pointer otherwise.
    if ($('lfRows').dataset.html !== html) { $('lfRows').dataset.html = html; $('lfRows').innerHTML = html; }
    for (const id of [...jobs.keys(), ...adding.keys(), ...showing]) paintJob(id);
    const rescan = $('lfRescan');
    if (rescan) rescan.hidden = !desktop() && !places.some(f => f.kind === 'folder' && f.access === 'granted' && !f.hidden);
  };

  const failed = (e) => {
    const reason = e?.reason;
    status(reason === 'nested' ? t('lf.nested') : reason === 'copy' ? t('lf.copy') : reason === 'default' ? t('lf.default_stays')
      : reason === 'taken' ? t('lf.taken_msg') : reason === 'move-to' ? t('lf.denied') : reason === 'other-library' ? t('lf.other_library_tip')
      : String(e?.message || e), 'err');
  };

  // What is under way for each folder: its task, as it says.
  const onJob = (job) => {
    if (job?.kind !== 'folder' || !String(job.gid || '').startsWith('folder-')) return;
    const id = String(job.gid).slice('folder-'.length);
    const had = jobs.has(id);
    if (TERMINAL.has(job.status)) {
      if (job.status === 'done') drawWaitingPdfs().catch(() => {});   // the PDFs a check found
      if (had) { jobs.delete(id); render(); }
      // What it couldn't do, said once it ends: things in the folder it couldn't read, galleries a move
      // couldn't take.
      const counts = [['lf.task_problems', job.problems], ['lf.task_left', job.left]].filter(([, n]) => n > 0);
      if (had && counts.length) status([job.title || '', ...counts.map(([key, n]) => t(key, { n: formatCount(n) }))].filter(Boolean).join(' · '), 'err');
      // A removal that couldn't write what it owed the folder left it in the library: asked whether to
      // remove it anyway.
      if (had && job.status === 'error' && job.errorKey === 'lf.task_kept') {
        render().then(() => { const f = places.find(p => p.id === id); if (f) removeAnyway(f, job.unsaved || 0).catch(failed); });
      }
      return;
    }
    jobs.set(id, job);
    if (had) paintJob(id); else render();
  };
  platform.jobs.subscribe(onJob);
  for (const job of await platform.jobs.current().catch(() => [])) if (Date.now() - (job.at || 0) < QUIET_MS) onJob(job);
  // A task whose page or app went away says nothing more: its row stops showing it.
  setInterval(() => {
    let gone = false;
    for (const [id, job] of jobs) if (Date.now() - (job.at || 0) > QUIET_MS) { jobs.delete(id); gone = true; }
    if (gone) render();
  }, 5000);
  await render();
  window.addEventListener('shiori-lang-change', () => { applyTranslations(section); tips(); $('lfRows').dataset.html = ''; render(); });
  platform.control.on((msg) => { if (msg?.type === 'FOLDERS_CHANGED') render(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

  // Adding: the folder's row shows at once, and its check goes on in the background. A click while
  // the folder picker is still opening does nothing (the browser would refuse a second picker).
  let picking = false;
  $('lfAdd')?.addEventListener('click', async () => {
    if (picking) return;
    picking = true;
    let target = null;
    try {
      target = manage === 'pick' ? await globalThis.showDirectoryPicker({ id: 'shiori-library', mode: 'readwrite' }) : await shell('pickLibraryFolder');
    } catch (err) { if (err?.name !== 'AbortError') failed(err); return; } finally { picking = false; }
    if (!target) return;
    const name = target.name || String(target).split(/[\\/]/).filter(Boolean).pop() || String(target);
    const key = `adding-${Date.now()}`;
    adding.set(key, name);
    render();
    try {
      let added;
      try { added = await api.folders.add(target); } catch (err) {
        // Another app uses it: added only once the person chooses to anyway.
        if (err?.reason !== 'claimed' || !(await useAnyway(err.owner))) throw err?.reason === 'claimed' ? null : err;
        added = await api.folders.add(target, { force: true });
      }
      const { id, restored, existed } = added;
      if (existed) status(t('lf.existed', { name }));
      else {
        checkFolder(id, { name, restored });
        if (restored) status(t('lf.added_back', { name, n: formatCount(restored) }));
      }
    } catch (err) { if (err) failed(err); } finally {
      adding.delete(key);
      render();
    }
  });

  $('lfRows').addEventListener('click', async (e) => {
    const button = e.target.closest?.('[data-act]');
    const row = button?.closest('[data-folder]');
    const f = row && places.find(p => p.id === row.dataset.folder);
    if (!f) return;
    if (button.dataset.act === 'more') {
      if (_menu?.anchor === button) { closeMenu(); return; }
      openMenu(button, actionsOf(f));
      return;
    }
    if (button.dataset.act === 'allow') {
      try { if (await api.folders.allow(f.id) !== 'granted') status(t('lf.denied'), 'err'); } catch (err) { failed(err); }
      render();
    }
    // Taking back a folder another app took over: asked first while that app still holds it (two apps
    // at once risk going out of sync).
    if (button.dataset.act === 'claim') {
      if (f.owner?.active !== false && !(await useAnyway(f.owner, { take: true, name: placeName(f) }))) return;
      // Then checked: what the other app changed there meanwhile is read again (not what changed here).
      try { await api.folders.claim(f.id); checkFolder(f.id, { name: f.name }); } catch (err) { failed(err); }
      render();
    }
    // A Needs attention line: put away (each of its items), or a gallery whose folder holds something
    // else now taken out of the library (asked first; nothing in the folder is deleted).
    const items = (f.attention || []).filter(i => i.reason === button.dataset.reason);
    if (button.dataset.act === 'att-dismiss') {
      try { for (const item of items) await api.folders.dismiss(f.id, item); } catch (err) { failed(err); }
      render();
    }
    if (button.dataset.act === 'att-delete' && items[0]?.gid) {
      if (!(await confirmDialog({ danger: true, title: t('lf.att_delete_title'), body: t('lf.att_delete_body'), ok: t('lf.att_delete') }))) return;
      try { await api.galleries.delete(items[0].gid); await api.folders.dismiss(f.id, items[0]); } catch (err) { if (!(await deleteRefused(err))) failed(err); }
      render();
    }
  });

  // Removing: asked first; its galleries can be moved elsewhere first (asked again: it can't easily be
  // undone) — to a place that can take them now: shown, this library's, and reachable (one this page
  // needs leave for is asked for it, from the click). Off the list at once; the rest is a task (its
  // row shows it while it runs). Changes only this library has that can't be written to the folder
  // are lost by removing it: asked again.
  const removePlace = async (f) => {
    const name = placeName(f);
    const others = places.filter(p => p.id !== f.id && (p.access === 'granted' || p.access === 'prompt') && !p.hidden);
    let moveTo = null;
    if (f.galleries && others.length && f.access === 'granted' && !f.hidden) {
      const first = others.find(p => p.isDefault) || others[0];
      const answer = await toggleDialog({ title: t('lf.remove_title', { name }), body: t('lf.remove_body', { n: formatCount(f.galleries) }),
        ok: t('lf.remove_ok'), danger: true, toggle: {
          label: t('lf.move_toggle'), value: first.id, bodyOn: t('lf.remove_body_move', { n: formatCount(f.galleries) }),
          options: others.map(p => ({ value: p.id, label: p.kind === 'browser' ? `${placeName(p)} (IndexedDB)` : placeName(p) })),
          confirm: (to) => {
            const dest = others.find(p => p.id === to);
            return confirmDialog({ title: t('lf.move_confirm_title', { name: dest ? placeName(dest) : '' }), danger: true,
              body: t('lf.move_confirm_body', { n: formatCount(f.galleries), from: name, to: dest ? placeName(dest) : '' }), ok: t('lf.move_confirm_ok') });
          } } });
      if (!answer) return;
      if (answer.toggle) moveTo = answer.option;
    } else if (!(await confirmDialog({ title: t('lf.remove_title', { name }),
      body: f.galleries ? t('lf.remove_body', { n: formatCount(f.galleries) }) : t('lf.remove_empty'), ok: t('lf.remove_ok'), danger: true }))) return;
    // The galleries go where they are moved only once this page may write there: asked now, from the
    // click that confirmed (the removal runs where nothing can ask). Not allowed, nothing is removed.
    const dest = moveTo && others.find(p => p.id === moveTo);
    if (dest?.access === 'prompt' && await api.folders.allow(dest.id).catch(() => null) !== 'granted') { status(t('lf.denied'), 'err'); return; }
    // What the library has of its galleries is written there first: this page may need leave to.
    if (f.access === 'prompt') await api.folders.allow(f.id).catch(() => {});
    await startRemoval(f, { moveTo });
  };
  async function removeAnyway(f, n, { moveTo = null } = {}) {
    const name = placeName(f);
    if (!(await confirmDialog({ title: t('lf.unsaved_title', { name }), body: t('lf.unsaved_body', { n: formatCount(n) }),
      ok: t('lf.unsaved_ok'), danger: true }))) return;
    await startRemoval(f, { moveTo, discard: true });
  }
  async function startRemoval(f, { moveTo = null, discard = false } = {}) {
    try { await api.folders.remove(f.id, { ...(moveTo ? { moveTo } : {}), ...(discard ? { discard } : {}) }); } catch (e) {
      if (e?.reason === 'unsaved' && !discard) return removeAnyway(f, e.galleries || 0, { moveTo });
      throw e;
    }
    // The desktop app runs its own; a browser library's runs in its service worker (or this page).
    if (api.capabilities.browserLibrary) startFolderRemoval(f.id, { name: placeName(f), moving: !!moveTo }).catch(() => {});
    render();
  }

  // Hiding: no question (showing undoes it). Its galleries leave the library at once; the row stays.
  const hidePlace = async (f) => {
    await api.folders.hide(f.id);
    render();
  };
  // Showing: what it hid comes back, its row busy meanwhile.
  const showPlace = async (f) => {
    showing.add(f.id);
    render();
    try { await api.folders.show(f.id); } catch (err) { failed(err); } finally {
      showing.delete(f.id);
      render();
    }
  };

  $('lfRescan')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      if (desktop()) {
        const r = await shell('rescan');
        const lines = [['set.desk_scan_added', r.added], ['lf.task_updated', r.updated], ['set.desk_scan_moved', r.moved], ['set.desk_scan_missing', r.missing], ['set.desk_scan_back', r.found]]
          .filter(([, n]) => n).map(([key, n]) => t(key, { n }));
        status(lines.length ? lines.join(' · ') : t('set.desk_scan_none'));
      } else {
        for (const f of places) if (f.kind === 'folder' && f.access === 'granted' && !f.hidden) checkFolder(f.id, { name: f.name });
      }
    } catch (err) { failed(err); } finally {
      button.disabled = false;
      render();
    }
  });

  if (desktop()) await initArchiving(section);
}

// The desktop app's window: when and how galleries left alone are archived, a card after the library's.
async function initArchiving(after) {
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
    $('deskArchiveFormat').innerHTML = ['zip', 'cbz'].map(v =>
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
          say({ status: 'error', error: String(e?.message || e) });
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
