// tag-editor.js — the metadata tag editor the library and the overview share: add a tag of any
// type to a gallery, or change the value of one it has, or remove it. A typed value suggests the
// tags already in the library, most used first; a type with a fixed vocabulary is picked from a list.

import * as store from './store.js';
import * as api from './api.js';
import { RATINGS } from './series.js';
import { t, getLang } from './i18n.js';
import { escHtml } from './sanitize.js';
import { formatCompact } from './format.js';

// Tag type → its label, in the order the editor lists the types.
export const TAG_TYPE_LABEL = {
  'tag': 'addtag.cat_tag', 'tag:female': 'addtag.cat_tagf', 'tag:male': 'addtag.cat_tagm',
  'artist': 'addtag.cat_artist', 'group': 'addtag.cat_group', 'parody': 'addtag.cat_parody',
  'character': 'addtag.cat_character', 'language': 'addtag.cat_language',
  'category': 'filter.category', 'rating': 'filter.rating',
};

// The fixed vocabularies — what the library filter offers. A gallery has at most one category and
// one rating: setting either replaces the one it had.
export const TAG_VALUES = {
  rating: RATINGS,
  category: ['manga', 'doujinshi', 'manhwa', 'manhua', 'novel', 'artist cg', 'game cg',
    'image set', 'cosplay', 'western', 'asian porn', 'anime', 'misc'],
};
const SINGLE = new Set(['category', 'rating']);

// Language code → the lowercase English name galleries are tagged with (what the flag derivation
// understands), for the language dropdown and a flag's search filter.
export const LANG_TAG_NAME = {
  en: 'english', ja: 'japanese', zh: 'chinese', 'zh-TW': 'chinese', ko: 'korean', de: 'german',
  fr: 'french', es: 'spanish', ru: 'russian', pt: 'portuguese', 'pt-BR': 'portuguese', it: 'italian',
  vi: 'vietnamese', id: 'indonesian', th: 'thai', nl: 'dutch', pl: 'polish', uk: 'ukrainian',
};
const LANG_DISPLAY = {
  en: 'English', ja: '日本語', zh: '中文（简体）', 'zh-CN': '中文（简体）', 'zh-TW': '中文（繁體）',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский', pt: 'Português',
  'pt-BR': 'Português (BR)', it: 'Italiano', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
  th: 'ไทย', nl: 'Nederlands', pl: 'Polski', uk: 'Українська',
};
// Language name shown in the app's current language (e.g. JP flag → "Japanese" in English).
let _dnInst = null, _dnLang = null;
export function langDisplayName(code) {
  const lang = getLang();
  try {
    if (_dnLang !== lang) { _dnInst = new Intl.DisplayNames([lang], { type: 'language' }); _dnLang = lang; }
    return _dnInst.of(code) || LANG_DISPLAY[code] || code;
  } catch { return LANG_DISPLAY[code] || code; }
}
// Languages a gallery can be tagged with, de-duplicated by name (zh / zh-TW both map to "chinese").
const LANG_OPTIONS = (() => {
  const seen = new Set(); const out = [];
  for (const [code, name] of Object.entries(LANG_TAG_NAME)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ code, name });
  }
  return out;
})();

// A tag's key in the tag counts (and the tagNames index).
export const tagKey = (type, name) => `${type}:${name}`.toLowerCase();

// A gallery's tag list is written where it lives: a series' combined tags, or a gallery's own.
export const tagPatchFor = (g, tags) => g?.isSeries ? { seriesTags: tags } : { tags };

// The tags one edited tag stands for: for a category or rating, every tag of that type (there is
// meant to be one); otherwise that exact tag.
const _standsFor = (tag) => (tg) => tg.type === tag.type && (SINGLE.has(tag.type) || tg.name === tag.name);

// Re-read the gallery and store edit(tags) as its tag list, unless that changes nothing. Returns
// whether it wrote.
async function updateTags(gid, edit, beforeWrite) {
  const g = await api.galleries.get(gid);
  if (!g) return false;
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const next = edit(tags);
  if (JSON.stringify(next) === JSON.stringify(tags)) return false;
  beforeWrite?.();
  await store.mutate(gid, tagPatchFor(g, next));
  return true;
}

// Remove a tag from a gallery (for a category or rating, the gallery's one of that type).
export function removeTag(gid, tag, { beforeWrite } = {}) {
  return updateTags(gid, (tags) => tags.filter((tg) => !_standsFor(tag)(tg)), beforeWrite);
}

// ── The editor ──
let _el = null;           // the modal, built on first use
let _state = null;        // { gid, edit, have, beforeWrite, resolve } while it's open
let _addType = 'tag';     // the type an add starts on: the last one added
// `live` once the value has been typed in (or asked for with the arrow keys) since the editor opened
// or the type changed — suggestions only show from then on.
const _suggest = { type: null, all: [], shown: [], sel: -1, seq: 0, live: false };
const SUGGEST_MAX = 8;
const $ = (id) => document.getElementById(id);

// The values a type is picked from, or null when its value is typed.
function _choices(type) {
  if (type === 'language') return LANG_OPTIONS.map((o) => ({ value: o.name, label: langDisplayName(o.code) }));
  if (TAG_VALUES[type]) return TAG_VALUES[type].map((v) => ({ value: v, label: v }));
  return null;
}
// The value a gallery has for a category or rating.
const _currentSingle = (type) => (SINGLE.has(type) && _state.have.find((tg) => tg.type === type)?.name) || '';

function _build() {
  _el = document.createElement('div');
  _el.className = 'modal-overlay';
  _el.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="tagEdTitle">
      <div class="modal-title" id="tagEdTitle"></div>
      <label class="modal-label" for="tagEdType" id="tagEdTypeLabel"></label>
      <select class="modal-select" id="tagEdType"></select>
      <label class="modal-label" id="tagEdValueLabel"></label>
      <div class="tag-ed-field" id="tagEdField">
        <input class="modal-input" id="tagEdValue" type="text" autocomplete="off" spellcheck="false"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tagEdList">
        <div class="tag-ed-list" id="tagEdList" role="listbox"></div>
      </div>
      <select class="modal-select" id="tagEdPick"></select>
      <div class="modal-actions">
        <button class="btn danger tag-ed-remove" id="tagEdRemove" type="button"></button>
        <button class="btn" id="tagEdCancel" type="button"></button>
        <button class="btn primary" id="tagEdOk" type="button"></button>
      </div>
    </div>`;
  document.body.appendChild(_el);

  const input = $('tagEdValue');
  $('tagEdType').addEventListener('change', (e) => {
    const type = e.target.value;
    _syncValue(SINGLE.has(type) ? _currentSingle(type) : undefined);
  });
  input.addEventListener('input', () => { _suggest.live = true; _renderSuggestions(); });
  input.addEventListener('blur', () => _openList(false));
  input.addEventListener('keydown', (e) => {
    const open = $('tagEdList').classList.contains('open');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { _suggest.live = true; _renderSuggestions(); }
      else _moveSel(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && _suggest.sel >= 0) _choose(_suggest.sel);
      else _save();
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();   // close the list, not the editor
      _openList(false);
    }
  });
  // mousedown, not click: the input keeps focus, so its blur doesn't close the list first.
  $('tagEdList').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const opt = e.target.closest('.tag-ed-opt');
    if (opt) _choose(Number(opt.dataset.i));
  });
  $('tagEdOk').addEventListener('click', _save);
  $('tagEdCancel').addEventListener('click', () => _done(false));
  $('tagEdRemove').addEventListener('click', async () => {
    const { gid, edit, beforeWrite } = _state;
    _done(await removeTag(gid, edit, { beforeWrite }));
  });
  _el.addEventListener('click', (e) => { if (e.target === _el) _done(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _state) _done(false);
  });
}

// Labels are set on every open, so they follow the app language.
function _texts() {
  const edit = !!_state.edit;
  $('tagEdTitle').textContent = t(edit ? 'addtag.edit_title' : 'addtag.title');
  $('tagEdTypeLabel').textContent = t('addtag.type');
  $('tagEdValueLabel').textContent = t('addtag.value');
  $('tagEdType').innerHTML = Object.entries(TAG_TYPE_LABEL)
    .map(([type, key]) => `<option value="${escHtml(type)}">${escHtml(t(key))}</option>`).join('');
  $('tagEdValue').placeholder = t('addtag.value_ph');
  $('tagEdRemove').textContent = t('dlg.tag_ok');
  $('tagEdCancel').textContent = t('common.cancel');
  $('tagEdOk').textContent = t(edit ? 'common.save' : 'common.add');
}

// Show the value control the selected type takes, holding `value` (undefined keeps what's typed).
function _syncValue(value) {
  const type = $('tagEdType').value;
  const choices = _choices(type);
  const pick = $('tagEdPick');
  pick.style.display = choices ? '' : 'none';
  $('tagEdField').style.display = choices ? 'none' : '';
  $('tagEdValueLabel').htmlFor = choices ? 'tagEdPick' : 'tagEdValue';
  if (choices) {
    const lower = String(value || '').toLowerCase();
    // A value outside the list (from an older or imported gallery) stays an option, so it shows.
    if (lower && !choices.some((c) => c.value === lower)) choices.unshift({ value: lower, label: value });
    pick.innerHTML = choices.map((c) => `<option value="${escHtml(c.value)}">${escHtml(c.label)}</option>`).join('');
    if (lower) pick.value = lower;
    return;
  }
  if (value !== undefined) $('tagEdValue').value = value;
  _suggest.live = false;
  _openList(false);
  _loadSuggestions(type);
}

// The library's tags of one type, most used first, for the suggestion list.
async function _loadSuggestions(type) {
  const seq = ++_suggest.seq;
  _suggest.type = type;
  _suggest.all = [];
  const prefix = `${type}:`;
  const counts = await api.galleries.tagCounts({ prefix });
  if (seq !== _suggest.seq) return;
  for (const [key, n] of counts) {
    const name = key.slice(prefix.length);
    if (type === 'tag' && /^(fe)?male:/.test(name)) continue;   // female/male tags share the prefix
    _suggest.all.push({ name, n });
  }
  _suggest.all.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (_suggest.live && document.activeElement === $('tagEdValue')) _renderSuggestions();
}

// Suggestions for what's typed: names starting with it, then names containing it — leaving out
// the tags this gallery already has.
function _renderSuggestions() {
  if (!_state) return;
  const term = $('tagEdValue').value.trim().toLowerCase();
  const have = new Set(_state.have.filter((tg) => tg.type === _suggest.type).map((tg) => String(tg.name).toLowerCase()));
  const starts = [], within = [];
  for (const s of _suggest.all) {
    if (have.has(s.name) || s.name === term) continue;
    if (s.name.startsWith(term)) starts.push(s);
    else if (s.name.includes(term)) within.push(s);
  }
  _suggest.shown = [...starts, ...within].slice(0, SUGGEST_MAX);
  _suggest.sel = -1;
  $('tagEdList').innerHTML = _suggest.shown.map((s, i) =>
    `<div class="tag-ed-opt" role="option" id="tagEdOpt${i}" data-i="${i}" aria-selected="false"><span class="tag-ed-opt-name">${escHtml(s.name)}</span><span class="tag-ed-opt-n">${formatCompact(s.n)}</span></div>`).join('');
  _openList(_suggest.shown.length > 0);
}

function _openList(open) {
  const input = $('tagEdValue');
  $('tagEdList').classList.toggle('open', open);
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) input.removeAttribute('aria-activedescendant');
}

function _moveSel(delta) {
  const n = _suggest.shown.length;
  if (!n) return;
  _suggest.sel = Math.max(-1, Math.min(n - 1, _suggest.sel + delta));
  $('tagEdList').querySelectorAll('.tag-ed-opt').forEach((opt, i) => {
    const on = i === _suggest.sel;
    opt.classList.toggle('sel', on);
    opt.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) opt.scrollIntoView({ block: 'nearest' });
  });
  const input = $('tagEdValue');
  if (_suggest.sel >= 0) input.setAttribute('aria-activedescendant', `tagEdOpt${_suggest.sel}`);
  else input.removeAttribute('aria-activedescendant');
}

function _choose(i) {
  const s = _suggest.shown[i];
  if (!s) return;
  $('tagEdValue').value = s.name;
  _openList(false);
}

async function _save() {
  const { gid, edit, beforeWrite } = _state;
  const type = edit ? edit.type : $('tagEdType').value;
  const name = (_choices(type) ? $('tagEdPick').value : $('tagEdValue').value).trim().toLowerCase();
  if (!name) { $('tagEdValue').focus(); return; }
  // What the new value replaces: the edited tag, or the category / rating the gallery had.
  const replaced = edit ? _standsFor(edit) : SINGLE.has(type) ? (tg) => tg.type === type : () => false;
  const same = (tg) => tg.type === type && String(tg.name).toLowerCase() === name;
  const written = await updateTags(gid, (tags) => {
    const out = [];
    // Already there under another tag: the replaced ones just go.
    let placed = tags.some((tg) => same(tg) && !replaced(tg));
    for (const tg of tags) {
      if (!replaced(tg)) { out.push(tg); continue; }
      if (!placed) { out.push(same(tg) ? tg : { type, name, url: '' }); placed = true; }
    }
    if (!placed) out.push({ type, name, url: '' });
    return out;
  }, beforeWrite);
  if (!edit) _addType = type;
  _done(written);
}

function _done(changed) {
  if (!_state) return;
  const { resolve } = _state;
  _state = null;
  _suggest.seq++;
  _openList(false);
  _el.classList.remove('show');
  resolve(changed);
}

// Open the editor on a gallery: to add a tag, or with `tag` ({ type, name }) to change that tag's
// value or remove it — its type stays. `beforeWrite` runs just before the gallery is written.
// Resolves once it closes, with whether the gallery's tags changed.
export async function openTagEditor(gid, { tag = null, beforeWrite = null } = {}) {
  if (!_el) _build();
  _done(false);
  const g = await api.galleries.get(gid);
  return new Promise((resolve) => {
    _state = { gid: String(gid), edit: tag, have: Array.isArray(g?.tags) ? g.tags : [], beforeWrite, resolve };
    _texts();
    const typeSel = $('tagEdType');
    typeSel.value = tag ? tag.type : _addType;
    typeSel.disabled = !!tag;
    $('tagEdRemove').style.display = tag ? '' : 'none';
    $('tagEdValue').value = '';
    _syncValue(tag ? tag.name : _currentSingle(typeSel.value));
    _el.classList.add('show');
    setTimeout(() => {
      const target = _choices(typeSel.value) ? $('tagEdPick') : $('tagEdValue');
      target.focus();
      if (tag && target.select) target.select();
    }, 30);
  });
}
