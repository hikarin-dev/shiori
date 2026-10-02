// search-field.js — the library's search box. The query is typed as plain text, and each finished
// filter in it (`artist:"ann"`) shows as a solid block. A list under the box helps with the syntax:
// the filters first, then the library's tags matching the word being typed — or, once inside a
// filter, that filter's values, most used first. Plain words keep searching as they're typed.

import * as api from './api.js';
import { t } from './i18n.js';
import { escHtml } from './sanitize.js';
import { formatCompact } from './format.js';
import { siteMap, siteName } from './sites.js';
import { TAG_TYPE_LABEL, TAG_VALUES, LANG_TAG_NAME } from './tag-editor.js';

// The filters, in the order the list offers them: the key typed before the colon, and the tag
// type (or gallery state) it searches.
const FILTERS = [
  ['tag', 'tag'], ['artist', 'artist'], ['group', 'group'], ['parody', 'parody'],
  ['character', 'character'], ['female', 'tag:female'], ['male', 'tag:male'],
  ['language', 'language'], ['category', 'category'], ['rating', 'rating'],
  ['source', 'source'], ['translated', 'translated'], ['favorite', 'favorite'],
].map(([key, type]) => ({ key, type }));
const FILTER_OF = new Map(FILTERS.map((f) => [f.key, f]));
const KEY_OF = new Map(FILTERS.map((f) => [f.type, f.key]));   // 'tag:female' → 'female'
// Every type a filter searches, as the search parser names them.
export const SEARCH_TYPES = new Set(FILTERS.map((f) => f.type));

// A finished filter: `key:"value"` (the key may be a tag type such as tag:female).
const TOKEN = /([a-z]+(?::[a-z]+)?):"([^"]+)"/gi;
// A filter typed without quotes and finished by a space: `artist:ann ` (only a known filter's key —
// a word like `re:zero` stays a word).
const BARE = /(^|\s)([a-z]+(?::(?:fe)?male)?):([^\s"]+)(?=\s)/gi;
const SUGGEST_MAX = 12;

const _keyOf = (typed) => {
  const lower = typed.toLowerCase();
  return FILTER_OF.has(lower) ? lower : (KEY_OF.get(lower) ?? lower);
};
const _label = (f) => t(TAG_TYPE_LABEL[f.type]
  || { source: 'page.source', translated: 'search.f_translated', favorite: 'search.f_favorite' }[f.type]);
// A filter's fixed values, or null when they come from the library's tags.
function _fixedValues(f) {
  if (f.type === 'language') return [...new Set(Object.values(LANG_TAG_NAME))];
  if (f.type === 'translated' || f.type === 'favorite') return ['yes', 'no'];
  if (f.type === 'source') return Object.keys(siteMap());
  return TAG_VALUES[f.type] || null;
}
// What a filter's value looks like, under its name in the list.
function _hint(f) {
  if (f.type === 'source') return t('search.hint_site');
  const values = _fixedValues(f);
  if (!values) return t('search.hint_name');
  return values.length > 3 ? `${values.slice(0, 3).join(', ')}, …` : values.join(', ');
}
const _display = (key, value) => key === 'source' ? siteName(value) : value;

const _chipHtml = (key, value) =>
  `<span class="search-chip-key">${escHtml(key)}:</span>${escHtml(_display(key, value))}`;
function _chip(key, value) {
  const chip = document.createElement('span');
  chip.className = 'search-chip';
  chip.contentEditable = 'false';
  chip.dataset.token = `${key}:"${value}"`;
  chip.innerHTML = _chipHtml(key, value);
  return chip;
}

let _el = null;

// ── The query ──
export function searchQuery() {
  if (!_el) return '';
  let q = '';
  for (const node of _el.childNodes) q += node.dataset?.token ? ` ${node.dataset.token} ` : node.textContent;
  return q.replace(/\s+/g, ' ').trim();
}

// Show `q` in the box, its finished filters as blocks. A block is always followed by text, so the
// caret has somewhere to go after it.
export function setSearchQuery(q) {
  if (!_el) return;
  const text = String(q || '');
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    nodes.push(_chip(_keyOf(m[1]), m[2]));
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail || nodes.length) nodes.push(document.createTextNode(tail || ' '));
  _el.replaceChildren(...nodes);
  if (document.activeElement === _el) _setCaret(_el, _el.childNodes.length);
}

export function appendSearchToken(token) {
  const q = searchQuery();
  setSearchQuery(q ? `${q} ${token}` : token);
}

function _setCaret(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// Filters finished by hand — a closing quote, or a space after a bare one — become blocks, with
// the caret after the last one made. Line breaks (from a paste) become spaces.
function _convertTyped() {
  let caret = null;
  for (let node of [..._el.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    if (node.data.includes('\n')) node.data = node.data.replace(/\n/g, ' ');
    for (;;) {
      TOKEN.lastIndex = 0;
      const quoted = TOKEN.exec(node.data);
      const bare = [...node.data.matchAll(BARE)].find((m) => FILTER_OF.has(_keyOf(m[2])));
      const found = [
        quoted && { at: quoted.index, len: quoted[0].length, key: _keyOf(quoted[1]), value: quoted[2] },
        bare && { at: bare.index + bare[1].length, len: bare[0].length - bare[1].length, key: _keyOf(bare[2]), value: bare[3].toLowerCase() },
      ].filter(Boolean).sort((a, b) => a.at - b.at)[0];
      if (!found) break;
      const after = node.splitText(found.at);
      after.deleteData(0, found.len);
      if (!/^\s/.test(after.data)) after.insertData(0, ' ');
      after.before(_chip(found.key, found.value));
      node = caret = after;
    }
  }
  if (caret) _setCaret(caret, 1);
}

// An emptied box goes back to truly empty (browsers leave a <br> behind), so its placeholder shows.
function _tidy() {
  if (!_el.querySelector('.search-chip') && !_el.textContent.trim()) _el.replaceChildren();
}

// ── Suggestions ──
let _dd = null;          // the list, built on first use
let _rows = [];          // what it shows: { filter } or { filter, value, n }
let _sel = -1;
let _tags = [];          // the library's tags, [{ type, name, n }], read when the box gains focus
let _tagsSeq = 0;
let _raf = 0;

const ICON_FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

async function _loadTags() {
  const seq = ++_tagsSeq;
  const counts = await api.galleries.tagCounts();
  if (seq !== _tagsSeq) return;
  _tags = [...counts].map(([key, n]) => {
    const two = /^tag:(?:fe)?male:/.exec(key);
    const at = two ? two[0].length - 1 : key.indexOf(':');
    return { type: key.slice(0, at), name: key.slice(at + 1), n };
  });
  _schedule();
}

// What the caret is in: a filter's value being typed (`artist:an`, `tag:"big br`), or a plain word.
// `start`–`end` is the typed text in `node` that a pick replaces.
function _caretContext() {
  const sel = getSelection();
  const node = sel.rangeCount && sel.isCollapsed ? sel.anchorNode : null;
  if (!node || node.nodeType !== Node.TEXT_NODE || !_el.contains(node)) return { node: null, filter: null, term: '' };
  const end = sel.anchorOffset, before = node.data.slice(0, end);
  const m = before.match(/(?:^|\s)([a-z]+(?::(?:fe)?male)?):("?)([^"]*)$/i);
  const filter = m && (m[2] || !/\s/.test(m[3])) && FILTER_OF.get(_keyOf(m[1]));
  if (filter) return { node, start: end - m[0].trimStart().length, end, filter, term: m[3] };
  const word = before.match(/\S*$/)[0];
  return { node, start: end - word.length, end, filter: null, term: word.replace(/"/g, '') };
}

// Best matches first: names starting with the term, then with a word starting with it, then
// containing it; the most used first within each.
function _ranked(entries, term) {
  const scored = [];
  for (const e of entries) {
    const at = term ? e.name.indexOf(term) : 0;
    if (at < 0) continue;
    scored.push([at === 0 ? 0 : /[\s\-_(/]/.test(e.name[at - 1]) ? 1 : 2, e]);
  }
  return scored.sort((a, b) => a[0] - b[0] || b[1].n - a[1].n || a[1].name.localeCompare(b[1].name)).map(([, e]) => e);
}

function _valueRows(filter, term) {
  const fixed = _fixedValues(filter);
  if (!fixed) return _ranked(_tags.filter((e) => e.type === filter.type), term).map((e) => ({ filter, value: e.name, n: e.n }));
  const counts = new Map(_tags.filter((e) => e.type === filter.type).map((e) => [e.name, e.n]));
  return fixed
    .filter((v) => !term || v.includes(term) || _display(filter.key, v).toLowerCase().includes(term))
    .map((value) => ({ filter, value, n: counts.get(value) || 0 }));
}

function _render() {
  _raf = 0;
  if (!_dd || document.activeElement !== _el) return _close();
  const ctx = _caretContext();
  const term = ctx.term.toLowerCase();
  const inQuery = new Set([..._el.querySelectorAll('.search-chip')].map((c) => c.dataset.token));
  const fresh = (r) => !inQuery.has(`${r.filter.key}:"${r.value}"`);
  const sections = [];
  if (ctx.filter) {
    // A fixed vocabulary is listed whole; the library's own tags only the best few.
    const rows = _valueRows(ctx.filter, term).filter(fresh);
    sections.push([_label(ctx.filter), _fixedValues(ctx.filter) ? rows : rows.slice(0, SUGGEST_MAX)]);
  } else {
    sections.push([t('search.filters'), FILTERS
      .filter((f) => !term || f.key.startsWith(term) || _label(f).toLowerCase().includes(term))
      .map((filter) => ({ filter }))]);
    if (term) sections.push([t('search.tags'), _ranked(_tags, term)
      .map((e) => ({ filter: FILTER_OF.get(KEY_OF.get(e.type)) || { key: e.type, type: e.type }, value: e.name, n: e.n }))
      .filter(fresh).slice(0, SUGGEST_MAX)]);
  }
  const shown = sections.filter(([, rows]) => rows.length);
  _rows = shown.flatMap(([, rows]) => rows);
  _sel = -1;
  _el.removeAttribute('aria-activedescendant');
  if (!_rows.length) return _close();
  let i = 0;
  _dd.innerHTML = shown.map(([head, rows]) =>
    `<div class="search-suggest-head" role="presentation">${escHtml(head)}</div>${rows.map((r) => _rowHtml(r, i++)).join('')}`)
    .join('<div class="search-suggest-sep" role="presentation"></div>');
  _place();
  _dd.classList.add('open');
  _el.setAttribute('aria-expanded', 'true');
}

function _rowHtml(r, i) {
  const attrs = `class="search-suggest-opt" role="option" id="searchOpt${i}" data-i="${i}" aria-selected="false"`;
  if (r.value == null) {
    return `<div ${attrs}>${ICON_FILTER}<div class="search-suggest-text"><div class="search-suggest-title">${escHtml(_label(r.filter))}</div><div class="search-suggest-hint"><b>${escHtml(r.filter.key)}:</b> ${escHtml(_hint(r.filter))}</div></div></div>`;
  }
  return `<div ${attrs}>${ICON_SEARCH}<span class="search-chip">${_chipHtml(r.filter.key, r.value)}</span>${r.n ? `<span class="search-suggest-n">${formatCompact(r.n)}</span>` : ''}</div>`;
}

function _schedule() {
  if (!_raf) _raf = requestAnimationFrame(_render);
}

function _close() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  _dd?.classList.remove('open');
  _el.setAttribute('aria-expanded', 'false');
  _el.removeAttribute('aria-activedescendant');
  _sel = -1;
}

// Under the box — the list lives on <body>, so the header can't clip it.
function _place() {
  const r = _el.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 320), innerWidth - 16);
  const top = r.bottom + 6;
  _dd.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  _dd.style.top = `${top}px`;
  _dd.style.width = `${width}px`;
  _dd.style.maxHeight = `${Math.max(160, Math.min(480, innerHeight - top - 12))}px`;
}

function _move(delta) {
  _sel = Math.max(-1, Math.min(_rows.length - 1, _sel + delta));
  _dd.querySelectorAll('.search-suggest-opt').forEach((opt, i) => {
    const on = i === _sel;
    opt.classList.toggle('sel', on);
    opt.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) opt.scrollIntoView({ block: 'nearest' });
  });
  if (_sel >= 0) _el.setAttribute('aria-activedescendant', `searchOpt${_sel}`);
  else _el.removeAttribute('aria-activedescendant');
}

// The text node and range a pick replaces — one is made at the caret when it sits between blocks.
function _typed(ctx) {
  if (ctx.node) return ctx;
  const node = document.createTextNode('');
  const sel = getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (range && _el.contains(range.startContainer)) range.insertNode(node);
  else _el.append(node);
  return { ...ctx, node, start: 0, end: 0 };
}

// A filter starts its value (`artist:`); a value finishes the filter as a block.
function _pick(row) {
  const ctx = _typed(_caretContext());
  if (row.value == null) {
    const text = `${row.filter.key}:`;
    ctx.node.replaceData(ctx.start, ctx.end - ctx.start, text);
    _setCaret(ctx.node, ctx.start + text.length);
  } else {
    const after = ctx.node.splitText(ctx.start);
    after.deleteData(0, ctx.end - ctx.start);
    if (!/^\s/.test(after.data)) after.insertData(0, ' ');
    after.before(_chip(row.filter.key, row.value));
    _setCaret(after, 1);
  }
  _el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function initSearchField(el) {
  _el = el;
  _dd = document.createElement('div');
  _dd.className = 'search-suggest';
  _dd.id = 'searchSuggest';
  _dd.setAttribute('role', 'listbox');
  document.body.appendChild(_dd);
  el.setAttribute('aria-controls', _dd.id);

  el.addEventListener('input', (e) => {
    if (!e.isComposing) _convertTyped();
    _tidy();
    _schedule();
  });
  el.addEventListener('focus', () => { _loadTags(); _schedule(); });
  el.addEventListener('blur', _close);
  document.addEventListener('selectionchange', () => { if (document.activeElement === el) _schedule(); });
  el.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const open = _dd.classList.contains('open');
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      e.preventDefault();
      _move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      // One line only. Enter picks the highlighted suggestion, or finishes the filter being typed.
      e.preventDefault();
      if (open && _sel >= 0) { _pick(_rows[_sel]); return; }
      const ctx = _caretContext();
      if (ctx.filter && ctx.term.trim()) _pick({ filter: ctx.filter, value: ctx.term.trim().toLowerCase() });
      else _close();
    } else if (e.key === 'Tab' && open && _sel >= 0) {
      e.preventDefault();
      _pick(_rows[_sel]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      _close();
    }
  });
  // mousedown, not click: the box keeps focus (and its caret), so the pick lands where it was.
  _dd.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const opt = e.target.closest('.search-suggest-opt');
    if (opt) _pick(_rows[Number(opt.dataset.i)]);
  });
  const follow = () => { if (_dd.classList.contains('open')) _place(); };
  window.addEventListener('resize', follow);
  window.addEventListener('scroll', follow, { capture: true, passive: true });
}
