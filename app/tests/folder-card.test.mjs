// folder-card.test.mjs — Settings → Storage → Library storage's rules (app/js/folder-card.js), held
// against 1.3's own code: what a place's row said, what its task's line said and what its menu
// offered, as library-folders.js had them, copied verbatim below as oracles, are said the same for the
// same places, tasks and libraries. (The card's flow is held by the browser tests, on 1.3's page and
// the new one: library-folders.browser.mjs, settings-storage.browser.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document ??= { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const { t } = await import('../js/i18n.js');
const { formatBytes, formatCount } = await import('../js/format.js');
const api = await import('../js/api.js');
const { placeName } = await import('../js/library-folders.js');
const { rowView, folderJobView, createFolderCard } = await import('../js/folder-card.js');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ── 1.3's code, verbatim but for what it reads from around it (`manage`, `desktop`, its maps) ────────
function oracle({ manage, desktop: isDesktop, jobs = new Map(), showing = new Set() }) {
  const desktop = () => isDesktop;
  const usable = (f) => f.access === 'granted' || f.access === 'prompt';
  const ATTENTION = { conflict: 'lf.att_conflict', unreadable: 'lf.att_unreadable', corrupt: 'lf.att_corrupt', 'missing-file': 'lf.att_missing_file',
    unsupported: 'lf.att_unsupported', 'adopt-failed': 'lf.att_adopt_failed', 'changed-both': 'lf.att_changed_both', unreferenced: 'lf.att_unreferenced',
    outside: 'lf.att_outside', left: 'lf.att_left', duplicate: 'lf.att_duplicate' };
  const ownerName = (o) => (o?.app === 'desktop' && o.host ? t('lf.owner_desktop', { host: o.host })
    : o?.app === 'web' && o.browser ? t('lf.owner_web', { browser: o.browser, site: o.site || '' }) : t('lf.owner_unknown'));
  const noop = () => {};
  const actionsOf = (f) => {
    if (f.ghost || showing.has(f.id)) return [];
    const out = [];
    if (f.hidden) out.push({ label: t('lf.show'), run: noop });
    if (!f.hidden && !f.isDefault && usable(f)) out.push({ label: t('lf.make_default'), run: noop });
    if (!f.hidden && f.kind === 'folder' && f.access === 'granted' && manage) out.push({ label: t('lf.rescan_one'), run: noop });
    if (desktop() && f.path) out.push({ label: t('lf.open'), run: noop });
    if (!f.hidden && !f.isDefault && manage) out.push({ label: t('lf.hide'), run: noop });
    if (f.removable && manage) out.push('-', { label: t('lf.remove'), danger: true, run: noop });
    return out[0] === '-' ? out.slice(1) : out;
  };
  const badge = (text, warn, tip = '') => `<span class="key-status-badge${warn ? ' unset' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${esc(text)}</span>`;
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
  const ICON = { browser: '<b/>', folder: '<f/>', more: '<m/>' };
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
  function jobView(job) {
    const total = job.total || 0, done = job.done || 0;
    const label = job.labelKey ? t(job.labelKey, job.labelArgs) : '';
    const tally = total ? `${formatCount(done)} / ${formatCount(total)}` : '';
    const found = job.found && job.foundKey !== '' ? t(job.foundKey || 'lf.task_found', { n: formatCount(job.found) }) : '';
    const updated = job.updated ? t('lf.task_updated', { n: formatCount(job.updated) }) : '';
    return { pct: total ? Math.round((done / total) * 100) : null, text: [label, tally, found, updated].filter(Boolean).join(' · ') };
  }
  return { actionsOf, rowHtml, jobView, ICON };
}

// The row drawn from rowView as 1.3's page draws it now (library-folders.js initLibraryFolders).
function drawn(v, ICON) {
  const badge = ({ text, warn, tip }) => `<span class="key-status-badge${warn ? ' unset' : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${esc(text)}</span>`;
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
}

// Places of every kind a row can show.
const base = { kind: 'folder', galleries: 12, size: 3_400_000, access: 'granted', removable: true };
const PLACES = [
  { id: 'browser', kind: 'browser', galleries: 42, size: 568_900, access: 'granted', isDefault: true },
  { id: 'browser', kind: 'browser', galleries: 0, size: 0, access: 'granted' },
  { ...base, id: 'a', name: 'Lib A', path: '' },
  { ...base, id: 'b', name: 'Lib <B> & "c"', path: 'D:\\Books\\Lib B', isDefault: true },
  { ...base, id: 'c', name: 'Lib C', hidden: true },
  { ...base, id: 'd', name: 'Lib D', access: 'prompt' },
  { ...base, id: 'e', name: 'Lib E', access: 'prompt', hidden: true },
  { ...base, id: 'f', name: 'Lib F', access: 'unavailable' },
  { ...base, id: 'g', name: 'Lib G', access: 'other-library' },
  { ...base, id: 'h', name: 'Lib H', access: 'taken', owner: { app: 'desktop', host: 'OTHER-PC', active: true } },
  { ...base, id: 'i', name: 'Lib I', access: 'taken', owner: { app: 'web', browser: 'Chrome', site: 'example.test', active: false } },
  { ...base, id: 'j', name: 'Lib J', access: 'taken', owner: null, removable: false },
  { ...base, id: 'k', name: '', path: '/x/y/z' },
  { ...base, id: 'l', name: 'Lib L', attention: [
    { reason: 'conflict', path: 'A/one', gid: '1' }, { reason: 'unreadable', path: 'B/two' }, { reason: 'unreadable', path: 'B/three' },
    { reason: 'unreadable' }, { reason: 'mystery' }, { reason: 'changed-both', path: 'C' }] },
  { ...base, id: 'm', name: 'Lib M', attention: [{ reason: 'conflict', path: 'A', gid: '1' }, { reason: 'conflict', path: 'B', gid: '2' }, { reason: 'left' }] },
  { id: 'n', kind: 'folder', name: 'Going', ghost: true },
  { id: 'adding-1', kind: 'folder', name: 'New one', ghost: true },
];
const JOBS = [
  {}, { total: 10, done: 3 }, { total: 0, done: 5, labelKey: 'lf.task_checking', labelArgs: { name: 'Lib A' } },
  { labelKey: 'lf.task_removing', labelArgs: { name: 'X' }, found: 4, foundKey: '' },
  { labelKey: 'lf.task_checking', labelArgs: { name: 'X' }, found: 4, total: 7, done: 7, updated: 2 },
  { found: 3 }, { found: 3, foundKey: 'lf.task_moved' }, { total: 3, done: 1, updated: 1, found: 0 },
];

test('a row says what 1.3\'s said, for every kind of place, with and without a task, being shown, on each kind of library', () => {
  for (const manage of ['pick', 'path', null]) for (const isDesktop of [false, true]) {
    api.capabilities.desktopWindow = isDesktop;
    for (const f of PLACES) for (const job of [null, { status: 'progress' }]) for (const shown of [false, true]) {
      const jobs = new Map(job ? [[f.id, job]] : []);
      const showing = new Set(shown ? [f.id] : []);
      const o = oracle({ manage, desktop: isDesktop, jobs, showing });
      const v = rowView(f, { job, showing: shown, manage, actions: o.actionsOf(f).length });
      assert.equal(drawn(v, o.ICON), o.rowHtml(f), JSON.stringify({ manage, isDesktop, f, job, shown }));
    }
  }
  api.capabilities.desktopWindow = false;
});

test('a task\'s line says what 1.3\'s said', () => {
  const o = oracle({});
  for (const job of JOBS) assert.deepEqual(folderJobView(job), o.jobView(job), JSON.stringify(job));
});

test('a place\'s menu offers what 1.3\'s offered, in its order, on each kind of library', () => {
  const folders = api.capabilities.folders;
  try {
    for (const manage of ['pick', 'path', null]) for (const isDesktop of [false, true]) {
      api.capabilities.folders = manage;
      api.capabilities.desktopWindow = isDesktop;
      const card = createFolderCard();
      const o = oracle({ manage, desktop: isDesktop });
      const items = (list) => list.map((i) => (i === '-' ? '-' : `${i.label}${i.danger ? ' (danger)' : ''}`));
      for (const f of PLACES) assert.deepEqual(items(card.menu(f)), items(o.actionsOf(f)), JSON.stringify({ manage, isDesktop, f }));
    }
  } finally {
    api.capabilities.folders = folders;
    api.capabilities.desktopWindow = false;
  }
});
