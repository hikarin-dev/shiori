// folder-card.js — Settings → Storage → Library storage without its drawing, which the card uses
// (src/routes/settings/folders.tsx): what the card holds
// for this library (cardShape), what a place's row says (rowView, folderJobView), what its menu offers
// and what each item asks first (createFolderCard's menu), and the card's flow — the places listed again
// as the library says they changed, each one's task followed as it says how it goes, adding a folder,
// removing one (with its galleries moved first, or not), hiding and showing one, taking one back from
// another app, a folder's Needs attention items, checking every folder. Moved as they were from
// library-folders.js; how the library does each (folders, claims, tasks) stays where it was (api.js,
// folder-scan.js, folder-owner.js).
import * as api from './api.js';
import * as platform from './platform.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { confirmDialog, toggleDialog } from './notice.js';
import { startFolderScan, startFolderRemoval } from './folder-scan.js';
import { desktopHosted } from './library-location.js';
import { placeName, usable, refusalText, deleteRefused, drawWaitingPdfs } from './library-folders.js';

const shell = (action, ...args) => globalThis.shioriDesktop.shell(action, ...args);
const desktop = () => api.capabilities.desktopWindow;
export const TERMINAL = new Set(['done', 'error', 'cancelled']);
export const QUIET_MS = 20000;   // a folder's task says it is running every 5 s: one silent this long has ended
const SWEEP_EVERY = 5000;
// What a browser that can't pick folders is told: a Chromium one on a computer has the picker
// switched off (its flags switch it on); any other has none.
export const unsupportedKey = () => {
  const ua = navigator.userAgentData;
  return ua && !ua.mobile && ua.brands.some((b) => b.brand === 'Chromium') ? 'lf.unsupported_flag' : 'lf.unsupported';
};

// How long a gallery is left alone before it is archived (desktop main.js ARCHIVE_AFTER), and the
// archive's formats: the desktop app's window's archiving card.
export const ARCHIVE_AFTER = { never: 'set.desk_archive_never', day: 'set.desk_archive_day', week: 'set.desk_archive_week', month: 'set.desk_archive_month' };
export const ARCHIVE_FORMATS = ['zip', 'cbz'];

// What the card holds here: `manage` how folders are added ('pick', 'path', or null: none here);
// `readOnly` the desktop app's library, seen from a site (its folders are the app's); `withLocation`
// the choice of where the library is, at its top (a site's, not a page the desktop app serves);
// `shown` whether there is a card at all.
export function cardShape() {
  const manage = api.capabilities.folders;          // 'pick', 'path', or null
  const readOnly = !manage && !api.capabilities.browserLibrary;   // the desktop app's library, from a site
  const withLocation = !desktop() && !desktopHosted();
  return { manage, readOnly, withLocation, shown: !(readOnly && !withLocation) };
}
// The header's check of every folder: its tip.
export const rescanTip = () => `${t('lf.rescan')}\n${t(desktop() ? 'set.desk_rescan_desc' : 'lf.rescan_desc')}`;

// Folder `id` checked for galleries put in it outside the app, as a task: a browser library's in its
// service worker (or this page), the desktop app's in the app.
function checkFolder(id, opts) {
  if (api.capabilities.browserLibrary) startFolderScan(id, opts).catch(() => {});
  else api.folders.scan(id).catch(() => {});
}

// What each kind of Needs attention item says (api.js folders.list `attention`).
const ATTENTION = { conflict: 'lf.att_conflict', unreadable: 'lf.att_unreadable', corrupt: 'lf.att_corrupt', 'missing-file': 'lf.att_missing_file',
  unsupported: 'lf.att_unsupported', 'adopt-failed': 'lf.att_adopt_failed', 'changed-both': 'lf.att_changed_both', unreferenced: 'lf.att_unreferenced',
  outside: 'lf.att_outside', left: 'lf.att_left', duplicate: 'lf.att_duplicate' };
// The app a folder's claim names (api.js `owner`), as the person knows it.
export const ownerName = (o) => (o?.app === 'desktop' && o.host ? t('lf.owner_desktop', { host: o.host })
  : o?.app === 'web' && o.browser ? t('lf.owner_web', { browser: o.browser, site: o.site || '' }) : t('lf.owner_unknown'));
// Asks whether to use a folder another app holds anyway (`take`: one this app had, taken back).
const useAnyway = (owner, { take = false, name = '' } = {}) => confirmDialog({ danger: true,
  title: take ? t('lf.take_back_title', { name }) : t('lf.claimed_title'),
  body: t('lf.in_use_body', { owner: ownerName(owner) }), ok: take ? t('lf.take_back') : t('lf.use_anyway') });

// A folder's job as its row says it: { pct (null: under way, how far unknown), text }.
export function folderJobView(job) {
  const total = job.total || 0, done = job.done || 0;
  const label = job.labelKey ? t(job.labelKey, job.labelArgs) : '';
  const tally = total ? `${formatCount(done)} / ${formatCount(total)}` : '';
  const found = job.found && job.foundKey !== '' ? t(job.foundKey || 'lf.task_found', { n: formatCount(job.found) }) : '';
  const updated = job.updated ? t('lf.task_updated', { n: formatCount(job.updated) }) : '';
  return { pct: total ? Math.round((done / total) * 100) : null, text: [label, tally, found, updated].filter(Boolean).join(' · ') };
}

// A folder's Needs attention list (D15): its items grouped by what they are, one line each — what,
// where (the first one, the rest counted: `more`), and what can be done: put it away, or for a gallery
// whose folder holds something else now, delete its entry (`del`; nothing in the folder is deleted).
function attentionOf(f) {
  const groups = new Map();
  for (const item of f.attention || []) {
    if (!groups.has(item.reason)) groups.set(item.reason, []);
    groups.get(item.reason).push(item);
  }
  return [...groups].map(([reason, items]) => ({
    reason, text: t(ATTENTION[reason] || 'lf.att_other'), path: items[0].path || '', more: items.length - 1,
    del: reason === 'conflict' && items.length === 1 && !!items[0].gid,
  }));
}

// What a place's row says: its name; where it is (`where`: 'IndexedDB' for this browser's own storage,
// else its path, if known) and its galleries and size (`counts`), neither for one still being added or
// removed (a ghost); its marks (`badges`: { text, warn, tip }); the button beside its menu (`button`:
// [act, label]: allow, or take back); whether it is busy (a task, being added, being shown); and its
// Needs attention lines. `job`: its task, `showing`: being shown again, `actions`: its menu's length.
export function rowView(f, { job = null, showing = false, manage = null, actions = 0 } = {}) {
  const badge = (text, warn = false, tip = '') => ({ text, warn, tip });
  const badges = [f.isDefault && badge(t('lf.default')), f.hidden && badge(t('lf.hidden')),
    f.access === 'prompt' && !f.hidden && badge(t('lf.needs_access'), true), f.access === 'unavailable' && badge(t('lf.unavailable'), true),
    f.access === 'other-library' && badge(t('lf.other_library'), true, t('lf.other_library_tip')),
    f.access === 'taken' && badge(t('lf.taken'), true, t(f.owner?.active === false ? 'lf.released_tip' : 'lf.taken_tip', { owner: ownerName(f.owner) }))].filter(Boolean);
  const button = f.hidden ? null : f.access === 'prompt' ? ['allow', t('lf.allow')] : f.access === 'taken' && manage ? ['claim', t('lf.take_back')] : null;
  return {
    id: f.id, kind: f.kind, ghost: !!f.ghost, hidden: !!f.hidden,
    name: f.ghost ? f.name : placeName(f),
    where: f.ghost ? '' : f.kind === 'browser' ? 'IndexedDB' : f.path || '',
    counts: f.ghost ? '' : t('lf.counts', { n: formatCount(f.galleries), size: formatBytes(f.size) }),
    badges, button, busy: !!(job || f.ghost || showing), actions,
    attention: f.ghost ? [] : attentionOf(f),
  };
}

// The card's flow for this library: start() follows the places and their tasks, stop() lets go (a page
// that never leaves never stops it). `status(text, tone)`: the card's status line ('ok' or 'err').
// subscribe(changed) hears every change; get() is the card as it stands: { rows (the places listed,
// then those being removed, then those being added), rescanHidden }. row(f) and job(id) say what a
// row shows, menu(f) what its menu offers ({ label, danger, run } and '-' for a line), act(id, act,
// reason) what its buttons do, pick() is Add folder, rescanAll() the header's check.
export function createFolderCard({ status = () => {} } = {}) {
  const { manage } = cardShape();
  let places = [];
  const jobs = new Map();     // folder id → its job under way (a check, a removal or a hiding)
  const adding = new Map();   // a folder being added → its name, until it is listed
  const showing = new Set();  // places being shown again, until they are
  const listeners = new Set();
  let state = { rows: [], rescanHidden: true };
  let live = false, run = 0;
  const offs = [];

  const changed = () => {
    const listed = new Set(places.map(f => f.id));
    // A folder being removed is off the list at once: its row stays while its task runs.
    const ghosts = [...jobs].filter(([id]) => !listed.has(id)).map(([id, job]) => ({ id, kind: 'folder', name: job.title || '', ghost: true }));
    const pending = [...adding].map(([key, name]) => ({ id: key, kind: 'folder', name, ghost: true }));
    state = { rows: [...places, ...ghosts, ...pending],
      rescanHidden: !desktop() && !places.some(f => f.kind === 'folder' && f.access === 'granted' && !f.hidden) };
    if (live) for (const listener of [...listeners]) listener();
  };
  const render = async () => {
    const mine = run;
    places = await api.folders.list().catch(() => places);
    if (mine === run) changed();
  };

  const failed = (e) => {
    const reason = e?.reason;
    status(reason === 'nested' ? t('lf.nested') : reason === 'copy' ? t('lf.copy') : reason === 'default' ? t('lf.default_stays')
      : refusalText(e) ?? (reason === 'move-to' ? t('lf.denied') : reason === 'other-library' ? t('lf.other_library_tip')
      : String(e?.message || e)), 'err');
  };

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
    if (had) changed(); else render();
  };

  // Adding: the folder's row shows at once, and its check goes on in the background. A click while
  // the folder picker is still opening does nothing (the browser would refuse a second picker).
  let picking = false;
  const pick = async () => {
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
  };

  // A row's buttons (`act`): allow, claim (take back), and a Needs attention line's (`reason`) dismiss
  // and delete.
  const act = async (id, action, reason) => {
    const f = places.find(p => p.id === id);
    if (!f) return;
    if (action === 'allow') {
      try { if (await api.folders.allow(f.id) !== 'granted') status(t('lf.denied'), 'err'); } catch (err) { failed(err); }
      render();
    }
    // Taking back a folder another app took over: asked first while that app still holds it (two apps
    // at once risk going out of sync).
    if (action === 'claim') {
      if (f.owner?.active !== false && !(await useAnyway(f.owner, { take: true, name: placeName(f) }))) return;
      // Then checked: what the other app changed there meanwhile is read again (not what changed here).
      try { await api.folders.claim(f.id); checkFolder(f.id, { name: f.name }); } catch (err) { failed(err); }
      render();
    }
    // A Needs attention line: put away (each of its items), or a gallery whose folder holds something
    // else now taken out of the library (asked first; nothing in the folder is deleted).
    const items = (f.attention || []).filter(i => i.reason === reason);
    if (action === 'att-dismiss') {
      try { for (const item of items) await api.folders.dismiss(f.id, item); } catch (err) { failed(err); }
      render();
    }
    if (action === 'att-delete' && items[0]?.gid) {
      if (!(await confirmDialog({ danger: true, title: t('lf.att_delete_title'), body: t('lf.att_delete_body'), ok: t('lf.att_delete') }))) return;
      try { await api.galleries.delete(items[0].gid); await api.folders.dismiss(f.id, items[0]); } catch (err) { if (!(await deleteRefused(err))) failed(err); }
      render();
    }
  };

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

  // The header's check: every folder this library can read now (the desktop app checks its own, and
  // says what it found).
  const rescanAll = async () => {
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
      render();
    }
  };

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get: () => state,
    row: (f) => rowView(f, { job: jobs.get(f.id), showing: showing.has(f.id), manage, actions: actionsOf(f).length }),
    // A busy row's task line: its task's, or being shown again or added.
    job: (id) => (jobs.has(id) ? folderJobView(jobs.get(id)) : { pct: null, text: t(showing.has(id) ? 'lf.showing' : 'lf.adding') }),
    jobIds: () => [...jobs.keys(), ...adding.keys(), ...showing],
    menu: (f) => actionsOf(f),
    place: (id) => places.find(p => p.id === id) || null,
    act, pick, rescanAll, refresh: render,
    // Follows its places and their tasks: what the library says changed, a task's news, the page shown
    // again. Resolves once the places are first listed.
    async start() {
      if (live) return;
      live = true;
      const mine = ++run;
      offs.push(platform.jobs.subscribe(onJob));
      // A task whose page or app went away says nothing more: its row stops showing it.
      const sweep = setInterval(() => {
        let gone = false;
        for (const [id, job] of jobs) if (Date.now() - (job.at || 0) > QUIET_MS) { jobs.delete(id); gone = true; }
        if (gone) render();
      }, SWEEP_EVERY);
      offs.push(() => clearInterval(sweep));
      offs.push(platform.control.on((msg) => { if (msg?.type === 'FOLDERS_CHANGED') render(); }));
      const visible = () => { if (document.visibilityState === 'visible') render(); };
      document.addEventListener('visibilitychange', visible);
      offs.push(() => document.removeEventListener('visibilitychange', visible));
      for (const job of await platform.jobs.current().catch(() => [])) if (mine === run && Date.now() - (job.at || 0) < QUIET_MS) onJob(job);
      if (mine === run) await render();
    },
    stop() {
      if (!live) return;
      live = false;
      run++;
      for (const off of offs.splice(0)) off();
    },
  };
}
