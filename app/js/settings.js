// settings.js — the app's Settings page: preferences, translator config, backups and storage.

import './boot.js';
import { clearAll } from './db.js';
import * as platform from './platform.js';
import { cancelJob } from './submit-job.js';
import { pingServer, serverUrlFromSettings, hasConfiguredServer, isLocalServer } from './translate.js';
import { getCapabilities, cachedCapabilities } from './capabilities.js';
import { migrateTranslateSettings, settingsModel, GROUP_HEADING_KEYS } from './translate-config.js';
import { exportMetadata, exportFull, importBackup } from './backup.js';
import { t, applyTranslations, getLang, setLang, SUPPORTED, LANG_NAMES } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { initTooltips } from './tooltip.js';
import { initDropdowns } from './dropdown.js';
import { initBenchmarkCard } from './benchmark-ui.js';

initTooltips();
initDropdowns();
initBenchmarkCard();

// ── Side nav ────────────────────────────────────────────────────────────────
// Panel switching is pure show/hide, so hidden panels keep unsaved form state.
(function initNav() {
  const nav = document.getElementById('settingsNav');
  const panels = document.querySelector('.settings-panels');
  if (!nav || !panels) return;
  const show = (id) => {
    if (!id || !document.getElementById(id)) return;
    nav.querySelectorAll('.nav-item').forEach((button) => {
      const active = button.dataset.panel === id;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    panels.querySelectorAll('.panel').forEach((panel) => {
      const active = panel.id === id;
      panel.classList.toggle('active', active);
      panel.setAttribute('aria-hidden', String(!active));
    });
  };
  nav.addEventListener('click', (e) => {
    const item = e.target.closest && e.target.closest('.nav-item');
    if (!item || !nav.contains(item) || item.hidden) return;
    show(item.dataset.panel);
  });
  // The optional panel stays out of navigation until it contains independently supplied cards.
  const optionalPanel = document.getElementById('panelExtension');
  const optionalNav = document.getElementById('navExtension');
  if (optionalPanel && optionalNav) {
    const syncOptionalPanel = () => {
      optionalNav.hidden = optionalPanel.children.length === 0;
      if (optionalNav.hidden && optionalNav.classList.contains('active')) show('panelLibrary');
    };
    new MutationObserver(syncOptionalPanel).observe(optionalPanel, { childList: true });
    syncOptionalPanel();
  }
  show(nav.querySelector('.nav-item.active:not([hidden])')?.dataset.panel || 'panelLibrary');
})();

// ── Companion download ────────────────────────────────────────────
// The optional panel carries the download from the first paint, so the nav item is there without
// waiting on anything. If the panel is populated independently it is handed over outright — the
// card goes and the label is released, leaving whatever arrived in sole possession. One-way by
// design: the app never asks what is out there, it only notices that the panel stopped being its
// own. Restores itself if the panel is ever emptied again.
const COMPANION_ZIP_URL = 'https://github.com/hikarin-dev/shiori/releases/latest/download/extension.zip';

(function initCompanionPanel() {
  const panel = document.getElementById('panelExtension');
  const navItem = document.getElementById('navExtension');
  if (!panel || !navItem) return;

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
      <div class="section-header">
        <h2 class="section-title" data-i18n="set.nav_extension"></h2>
      </div>
      <div class="section-body">
        <div class="toggle-row">
          <div class="toggle-info">
            <div class="toggle-name" data-i18n="set.ext_download"></div>
            <div class="toggle-desc" data-i18n="set.ext_download_desc"></div>
          </div>
          <a class="btn-save" href="${COMPANION_ZIP_URL}" target="_blank" rel="noopener"
             data-i18n="set.ext_download_btn"></a>
        </div>
      </div>`;

  const mount = () => {
    if (panel.children.length) return;   // the panel already belongs to someone else
    navItem.dataset.i18n = 'set.nav_extension';
    panel.appendChild(section);          // the nav observer reveals the item once this lands
    applyTranslations(navItem.parentElement);
    applyTranslations(section);
  };

  const handOver = () => {
    section.remove();
    delete navItem.dataset.i18n;         // stop competing over the label on the next re-translate
  };

  new MutationObserver(() => {
    if ([...panel.children].some((child) => child !== section)) handOver();
    else mount();
  }).observe(panel, { childList: true });

  mount();
})();

// ── Segmented choices ─────────────────────────────────────────────────────
// Segmented choices keep a native select as their single source of truth. This preserves the
// existing save/load paths while presenting directly comparable options in the UI.
function syncChoiceToggle(id) {
  const source = document.getElementById(id);
  const group = document.querySelector(`[data-choice-for="${id}"]`);
  if (!source || !group) return;
  const label = group.closest('.field')?.querySelector('.field-label')
    || group.closest('.study-control-group')?.querySelector('.study-control-title');
  if (label) group.setAttribute('aria-label', label.textContent);
  group.querySelectorAll('[data-value]').forEach((button, index) => {
    const active = button.dataset.value === source.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (active) group.dataset.position = String(index);
  });
}

function setChoiceValue(id, value, notify = false) {
  const source = document.getElementById(id);
  if (!source) return;
  source.value = value;
  syncChoiceToggle(id);
  if (notify) source.dispatchEvent(new Event('change', { bubbles: true }));
}

(function initChoiceToggles() {
  document.querySelectorAll('[data-choice-for]').forEach((group) => {
    const id = group.dataset.choiceFor;
    group.setAttribute('role', 'group');
    group.addEventListener('click', (e) => {
      const button = e.target.closest('[data-value]');
      if (!button || button.disabled) return;
      setChoiceValue(id, button.dataset.value, true);
    });
    syncChoiceToggle(id);
  });
})();

// ── Language selector ──────────────────────────────────────────────────────
(function initLanguage() {
  const sel = document.getElementById('langSelect');
  if (!sel) return;
  for (const code of SUPPORTED) {
    const o = document.createElement('option');
    o.value = code; o.textContent = LANG_NAMES[code] || code;
    sel.appendChild(o);
  }
  sel.value = getLang();
  sel.addEventListener('change', () => { setLang(sel.value); });
})();
// Re-render anything JS-built when the language changes.
window.addEventListener('shiori-lang-change', () => {
  document.querySelectorAll('[data-choice-for]').forEach(group => syncChoiceToggle(group.dataset.choiceFor));
  setTranslatorBadge(_lastBadge);
  renderTranslateSettings();
});

function showStatus(id, msg, type, durationMs = 2500) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden', 'ok', 'err');
  el.classList.add(type);
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('ok', 'err');
    el.classList.add('hidden');
    el.textContent = '';
  }, durationMs);
}

function setDialogOpen(modal, open, initialFocusSelector) {
  if (!modal) return;
  if (open) {
    modal._returnFocus = document.activeElement;
    modal.classList.add('show');
    requestAnimationFrame(() => {
      const initial = initialFocusSelector && modal.querySelector(initialFocusSelector);
      (initial || modal.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))?.focus();
    });
    return;
  }
  modal.classList.remove('show');
  const returnFocus = modal._returnFocus;
  modal._returnFocus = null;
  if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
}

document.addEventListener('keydown', (event) => {
  const modal = [...document.querySelectorAll('.modal-backdrop.show')].at(-1);
  if (!modal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    setDialogOpen(modal, false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.getClientRects().length && !el.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// ── Load saved values ──────────────────────────────────────────────────────

platform.kv.get(['translateSettings']).then((r) => {
  loadTranslateSettings(r.translateSettings);
});

// ── Reset (two tiers) ──────────────────────────────────────────────────────
// Clear Library removes committed library content, durable job state and staged import files
// while keeping preferences; Factory Reset additionally clears every shiori-owned storage key
// (settings, credentials, repair flags). Both cancel running work first so nothing can
// repopulate the stores, and broadcast one reset so every other context drops its caches.

async function performReset(factory) {
  try {
    for (const rec of await platform.translateResume.all()) {
      cancelJob('translate', { galleryId: rec.gid, token: rec.token, serverUrl: rec.serverUrl, settings: rec.settings });
    }
  } catch {}
  await platform.clearJobsData();
  await clearAll();
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (/^cbz-.*\.bin$/.test(name)) await root.removeEntry(name).catch(() => {});
    }
  } catch {}
  if (factory) {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        for (const key of Object.keys(storage)) {
          if (/^(shiori[:-]|_shiori)/.test(key)) storage.removeItem(key);
        }
      } catch {}
    }
  }
  platform.control.send({ type: 'LIBRARY_RESET', context: platform.contextId, factory: !!factory });
}

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm(t('set.clear_confirm1'))) return;
  if (!confirm(t('set.clear_confirm2'))) return;
  await performReset(false);
  showStatus('clearAllStatus', t('set.clear_done'), 'ok');
});

document.getElementById('factoryResetBtn').addEventListener('click', async () => {
  if (!confirm(t('set.factory_confirm1'))) return;
  if (!confirm(t('set.factory_confirm2'))) return;
  await performReset(true);
  showStatus('clearAllStatus', t('set.factory_done'), 'ok');
  setTimeout(() => location.reload(), 1200);   // re-initialize this page with defaults
});

// ── Translation server status ───────────────────────────────────────────────

let _lastBadge = 'checking';
function setTranslatorBadge(state) {
  _lastBadge = state;
  const b = document.getElementById('translateStatusBadge');
  if (state === 'checking') { b.className = 'key-status-badge unset'; b.textContent = t('set.tr_checking'); }
  else if (state === 'online') { b.className = 'key-status-badge set'; b.textContent = t('set.tr_online'); }
  else { b.className = 'key-status-badge unset'; b.textContent = t('set.tr_offline'); }
  document.getElementById('checkTranslateBtn').setAttribute('aria-busy', String(state === 'checking'));
}

// `auto` marks a status refresh nobody asked for (page load). Those must not contact the default
// local address before the user has configured a server — the browser would prompt for
// local-network access on a first visit. Pressing Check, or saving, is an explicit request and
// always pings.
async function checkTranslatorStatus(settings = null, { auto = false } = {}) {
  const translateSettings = settings || (await platform.kv.get(['translateSettings'])).translateSettings;
  if (auto && !hasConfiguredServer(translateSettings)) { setTranslatorBadge('offline'); return; }
  setTranslatorBadge('checking');
  const serverUrl = serverUrlFromSettings(translateSettings);
  const online = await pingServer(serverUrl, translateSettings);
  setTranslatorBadge(online ? 'online' : 'offline');
  // The benchmark is for whoever runs the translation server on this machine.
  document.getElementById('translationBenchmark').hidden = !(online && isLocalServer(serverUrl));
}

document.getElementById('checkTranslateBtn').addEventListener('click', () => {
  checkTranslatorStatus(gatherTranslateSettings());
  refreshCapabilities();
});
checkTranslatorStatus(null, { auto: true });

// ── Translation settings (inline server + full config modal) ────────────────
// The server decides what can be chosen (GET /capabilities); this page draws its choices and
// stores the user's picks keyed by the server's parameter names. With no server answer and no
// cached copy there is nothing to choose from, so the controls stay away and saved picks are kept.

let _settings = migrateTranslateSettings();
let _caps = null;            // capabilities document for the configured server (or null)
let _capsOffline = false;    // true when _caps is a cached copy the server didn't just confirm
let _capsServer = '';

const DEFAULT_SCREEN_PROMPT_KEY = 'translator.content_screen_prompt';
// App-owned presentation: which implementation choices span the full modal width, and the icon
// drawn for each pipeline step (any stage the app doesn't know gets the scan icon).
const WIDE_STAGES = new Set(['translate', 'ocr']);
const SCAN_ICON = 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2';
const STEP_ICONS = {
  detect: SCAN_ICON,
  ocr: `${SCAN_ICON}M7 8h8M7 12h10M7 16h6`,
  translate: 'M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6',
  inpaint: 'M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9',
  render: 'M4 7V4h16v3M9 20h6M12 4v16',
};

function loadTranslateSettings(stored) {
  _settings = migrateTranslateSettings(stored);
  if (stored && stored.schema !== _settings.schema) platform.kv.set({ translateSettings: _settings });  // one-time migration
  document.getElementById('translateServerInput').value = stored?.serverUrl || '';
  setChoiceValue('translateTokenInput', _settings.serverToken || '');
  setChoiceValue('studyModeGeneration', _settings.studyModeGeneration || 'disabled');
  document.getElementById('translateSaveSnapshots').checked = !!_settings.saveSnapshots;
  document.getElementById('translateKeepSnapshots').checked = !!_settings.keepSnapshotsOnRevert;
  refreshCapabilities({ auto: true });
}

// Draw from the cached answer at once, then ask the server (If-None-Match) and redraw.
async function refreshCapabilities({ auto = false } = {}) {
  const serverUrl = serverUrlFromSettings(gatherTranslateSettings());
  if (serverUrl !== _capsServer) { _caps = null; _capsServer = serverUrl; }
  const cached = await cachedCapabilities(serverUrl);
  if (cached?.doc && !_caps) { _caps = cached.doc; _capsOffline = true; }
  renderTranslateSettings();
  if (auto && !hasConfiguredServer(_settings)) return;
  const { doc, offline } = await getCapabilities(serverUrl, gatherTranslateSettings());
  if (serverUrl !== _capsServer) return;   // the address changed meanwhile
  _caps = doc;
  _capsOffline = offline;
  renderTranslateSettings();
}

// The page's current settings: stored picks plus the connection/study fields on the panel.
function gatherTranslateSettings() {
  const serverUrl = document.getElementById('translateServerInput').value.trim().replace(/\/+$/, '');
  return {
    ..._settings,
    serverUrl: serverUrl || 'http://127.0.0.1:5003',
    serverToken: document.getElementById('translateTokenInput').value.trim(),
    studyModeGeneration: document.getElementById('studyModeGeneration').value,
    saveSnapshots: document.getElementById('translateSaveSnapshots').checked,
    keepSnapshotsOnRevert: document.getElementById('translateKeepSnapshots').checked,
  };
}


const optionLabel = (choice, unavailable) => choice.missing || unavailable
  ? `${choice.label} — ${t(choice.missing ? 'tm.not_offered' : 'tm.unavailable')}` : choice.label;

function makeSelect(choices, value, { param, stepMirror = false } = {}) {
  const sel = document.createElement('select');
  sel.className = stepMirror ? 'translate-step-select' : 'field-input';
  if (param) sel.dataset.param = param;
  for (const choice of choices) {
    const unavailable = choice.available === false && !choice.missing;
    const label = stepMirror ? (choice.short || choice.label.replace(/\s+[(—].*$/, '')) : optionLabel(choice, unavailable);
    const opt = new Option(label, JSON.stringify(choice.value));
    if (stepMirror) opt.title = optionLabel(choice, unavailable);
    else if (choice.version) opt.title = t('tm.version', { version: choice.version });
    if (unavailable) opt.disabled = true;
    sel.append(opt);
  }
  sel.value = JSON.stringify(value);
  return sel;
}

function field(labelText, control, { wide = false, forId = true } = {}) {
  const box = document.createElement('div');
  box.className = 'tcfg-field' + (wide ? ' tcfg-wide' : '');
  const id = `tp-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  const label = document.createElement('label');
  label.textContent = labelText;
  if (forId) label.htmlFor = id;
  box.append(label, control);
  return box;
}

function paramControl(p) {
  const label = p.labelKey ? t(p.labelKey) : p.label;
  if (p.type === 'bool') {
    const box = document.createElement('div');
    box.className = 'tcfg-field tcfg-check' + (p.group ? ' tcfg-wide' : '');
    const lab = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.param = p.key;
    input.checked = !!p.value;
    const span = document.createElement('span');
    span.textContent = label;
    lab.append(input, ' ', span);
    box.append(lab);
    return box;
  }
  if (p.type === 'enum' || p.type === 'language') {
    return field(label, makeSelect(p.choices, p.value, { param: p.key }), { wide: !!(p.primary || p.group) });
  }
  const input = document.createElement(p.multiline ? 'textarea' : 'input');
  input.className = 'field-input' + (p.multiline ? ' tcfg-textarea' : '');
  input.dataset.param = p.key;
  if (p.multiline) { input.rows = 3; input.spellcheck = false; }
  if (p.type === 'number') {
    input.type = 'number';
    for (const k of ['min', 'max', 'step']) if (p[k] != null) input[k] = p[k];
    input.dataset.integer = p.integer ? '1' : '';
  } else if (!p.multiline) {
    input.type = 'text';
    input.spellcheck = false;
  }
  if (p.placeholder) input.placeholder = p.placeholder;
  input.value = p.value ?? '';
  return field(label, input, { wide: !!(p.primary || p.group || p.multiline) });
}

function heading(text, extraClass = '') {
  const h = document.createElement('div');
  h.className = 'tcfg-h' + extraClass;
  h.textContent = text;
  return h;
}

function numberField(labelText, id, value, { step = 1, min = null } = {}) {
  const input = document.createElement('input');
  input.className = 'field-input';
  input.type = 'number';
  input.step = step;
  if (min != null) input.min = min;
  input.value = value;
  const box = field(labelText, input);
  input.id = id;
  box.querySelector('label').htmlFor = id;
  return box;
}

let _advancedCollapsed = true;

function renderTranslateSettings() {
  const model = settingsModel(_caps, _settings);
  renderSummary(model);
  renderLanguage(model);
  const grid = document.getElementById('tcfgGrid');
  const note = document.getElementById('translateCapsNote');
  grid.replaceChildren();
  if (model.offline) {
    note.textContent = t('tm.caps_offline');
    note.hidden = false;
    document.getElementById('resetTranslateBtn').disabled = true;
    return;
  }
  document.getElementById('resetTranslateBtn').disabled = false;
  const notes = [];
  if (_capsOffline) notes.push(t('tm.caps_cached'));
  if (model.problems.length) notes.push(t('tm.caps_problem', { names: model.problems.map(p => p.value).join(', ') }));
  note.textContent = notes.join(' ');
  note.hidden = !notes.length;

  const byId = new Map(model.stages.map(s => [s.id, s]));
  const implField = (stage) => field(stage.implLabelKey ? t(stage.implLabelKey) : stage.label,
    makeSelect(stage.choices, stage.value, { param: stage.implParam }), { wide: WIDE_STAGES.has(stage.id) });
  const stageHeading = (stage) => heading(stage.headingKey ? t(stage.headingKey) : stage.label);

  // Translator first: engine, its primary options, and the clearing presets.
  const translate = byId.get('translate');
  if (translate) {
    grid.append(stageHeading(translate), implField(translate));
    for (const p of translate.params.filter(p => p.primary && !p.group)) grid.append(paramControl(p));
  }
  if (model.presets.length) {
    const choices = [...model.presets.map(p => ({ value: p.id, label: p.label })), { value: 'custom', label: t('tm.preset_custom') }];
    const sel = makeSelect(choices, model.preset);
    sel.dataset.preset = '1';
    grid.append(field(t('tm.clearing'), sel, { wide: true }));
  }
  // Grouped options (content screening) keep their own heading.
  const groups = new Map();
  for (const stage of model.stages) for (const p of stage.params) if (p.group) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  for (const [group, params] of groups) {
    grid.append(heading(GROUP_HEADING_KEYS[group] ? t(GROUP_HEADING_KEYS[group]) : group));
    for (const p of params) grid.append(paramControl(p));
  }

  // Everything else, stage by stage, behind the collapsible "Pipeline details" header.
  const advanced = document.createElement('button');
  advanced.className = 'tcfg-h tcfg-collapsible';
  advanced.type = 'button';
  advanced.id = 'cfgAdvancedHeader';
  advanced.textContent = t('tm.advanced');
  advanced.addEventListener('click', () => { _advancedCollapsed = !_advancedCollapsed; setAdvancedCollapsed(_advancedCollapsed); });
  grid.append(advanced);
  for (const stage of model.stages) {
    if (stage.id === 'translate') continue;
    grid.append(stageHeading(stage), implField(stage));
    for (const p of stage.params.filter(p => !p.group)) grid.append(paramControl(p));
  }
  for (const p of (translate?.params || []).filter(p => !p.primary && !p.group)) grid.append(paramControl(p));
  if (model.batching.length) {
    grid.append(heading(t('tm.batch')));
    const noteEl = document.createElement('div');
    noteEl.className = 'tcfg-note';
    noteEl.textContent = t('tm.batch_note');
    grid.append(noteEl);
    for (const b of model.batching) {
      const box = numberField(b.label, `cfgCap-${b.translator}`, b.value, { min: 1 });
      box.querySelector('input').dataset.batch = b.translator;
      grid.append(box);
    }
  }
  grid.append(heading(t('tm.cost')),
    numberField(t('tm.price_in'), 'cfgPriceIn', _settings.priceIn ?? 1.5, { step: 0.01, min: 0 }),
    numberField(t('tm.price_out'), 'cfgPriceOut', _settings.priceOut ?? 9, { step: 0.01, min: 0 }));
  setAdvancedCollapsed(_advancedCollapsed);
}

function setAdvancedCollapsed(collapsed) {
  const h = document.getElementById('cfgAdvancedHeader');
  if (!h) return;
  h.classList.toggle('collapsed', collapsed);
  h.setAttribute('aria-expanded', String(!collapsed));
  let el = h.nextElementSibling;
  while (el) { el.classList.toggle('tcfg-hidden', collapsed); el = el.nextElementSibling; }
}

// Pipeline overview — one quick-select per stage (the server's stages, in order), each a mirror of
// the modal's own choice. Steps show short model names; the tooltip gives the full name and
// version, then the rest of that stage's options, one per line.
const svgIcon = (cls, d) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function stepTip(stage) {
  const chosen = stage.choices.find(c => c.value === stage.value);
  const lines = [chosen ? chosen.label + (chosen.version ? ` (${chosen.version})` : '') : String(stage.value)];
  for (const p of stage.params.filter(p => !p.group)) {
    const label = p.labelKey ? t(p.labelKey) : p.label;
    let value = p.value;
    if (p.type === 'bool') { lines.push(`${value ? '✓' : '✗'} ${label}`); continue; }
    if (p.choices?.length) value = p.choices.find(c => c.value === value)?.label ?? value;
    lines.push(`${label}: ${value === '' || value == null ? (p.placeholder || '—') : value}`);
  }
  return lines.join('\n');
}

function renderSummary(model) {
  const el = document.getElementById('translateSummary');
  if (!el) return;
  if (model.offline) {
    el.style.gridTemplateColumns = '';
    const msg = document.createElement('div');
    msg.className = 'translate-summary-offline';
    msg.textContent = t('tm.caps_offline');
    el.replaceChildren(msg);
    return;
  }
  const stages = model.stages;
  el.style.gridTemplateColumns = `minmax(0, 1fr)${' auto minmax(0, 1fr)'.repeat(Math.max(0, stages.length - 1))}`;
  el.replaceChildren(...stages.flatMap((stage, i) => {
    const step = document.createElement('div');
    step.className = 'translate-step';
    step.dataset.tip = stepTip(stage);
    const sel = makeSelect(stage.choices, stage.value, { param: stage.implParam, stepMirror: true });
    sel.id = `step-${stage.id}`;
    step.innerHTML = `<label class="translate-step-head" for="${sel.id}">${svgIcon('translate-step-icon', STEP_ICONS[stage.id] || SCAN_ICON)}<span class="translate-step-name"></span></label>`;
    step.querySelector('.translate-step-name').textContent = stage.stepKey ? t(stage.stepKey) : stage.label;
    step.append(sel);
    if (!i) return [step];
    const sep = document.createElement('span');
    sep.innerHTML = svgIcon('translate-step-sep', 'm9 18 6-6-6-6');
    return [sep.firstChild, step];
  }));
}

// Target language — the translator's language option (also in the advanced window), in the
// Config card below the pipeline. Only while the server offers one; the pipeline row says when
// nothing is offered.
function renderLanguage(model) {
  document.getElementById('translateLanguageField')?.remove();
  const target = model.stages.find(s => s.id === 'translate')?.params.find(p => p.type === 'language');
  if (model.offline || !target) return;
  const box = document.createElement('div');
  box.className = 'field';
  box.id = 'translateLanguageField';
  const select = makeSelect(target.choices, target.value, { param: target.key });
  select.id = 'translateLanguage';
  const name = document.createElement('label');
  name.className = 'field-label';
  name.htmlFor = select.id;
  name.textContent = target.labelKey ? t(target.labelKey) : target.label;
  const note = document.createElement('div');
  note.className = 'field-desc';
  note.textContent = t('set.tr_lang_desc');
  box.append(name, note, select);
  document.getElementById('translateSummary').after(box);
}

// Read one edited control back into the stored picks.
function applyControl(el) {
  if (el.dataset.preset) {
    const preset = (_caps?.presets || []).find(p => p.id === JSON.parse(el.value));
    if (preset) Object.assign(_settings.params, preset.values);
    return;
  }
  if (el.dataset.batch) {
    const n = parseInt(el.value, 10);
    _settings.batchCaps = { ...(_settings.batchCaps || {}) };
    if (Number.isFinite(n) && n > 0) _settings.batchCaps[el.dataset.batch] = n;
    return;
  }
  if (el.id === 'cfgPriceIn' || el.id === 'cfgPriceOut') {
    const n = parseFloat(el.value);
    if (Number.isFinite(n)) _settings[el.id === 'cfgPriceIn' ? 'priceIn' : 'priceOut'] = n;
    return;
  }
  const key = el.dataset.param;
  if (!key) return;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.tagName === 'SELECT') value = JSON.parse(el.value);
  else if (el.type === 'number') {
    const n = el.dataset.integer ? parseInt(el.value, 10) : parseFloat(el.value);
    if (!Number.isFinite(n)) return;
    value = n;
  } else value = el.value;
  _settings.params = { ..._settings.params, [key]: key === DEFAULT_SCREEN_PROMPT_KEY ? value : (typeof value === 'string' ? value.trim() : value) };
}

// Saves the whole settings object and says so in `statusId`. Only a server address or token change
// needs the connection re-checked.
function saveTranslateSettings(statusId, { recheck = false } = {}) {
  const serverRaw = document.getElementById('translateServerInput').value.trim();
  if (serverRaw && !/^https?:\/\//i.test(serverRaw)) {
    showStatus(statusId, 'Server URL must start with http:// or https://', 'err');
    return;
  }
  _settings = gatherTranslateSettings();
  platform.kv.set({ translateSettings: _settings });
  showStatus(statusId, 'Saved.', 'ok');
  if (recheck) { checkTranslatorStatus(); refreshCapabilities(); }
}

// Every field on the panel and in the advanced window saves as it changes — selects and boxes at
// once, typed fields once committed (blur / Enter). The note shows in the card the edit came from.
const CONNECTION_FIELDS = new Set(['translateServerInput', 'translateTokenInput']);
document.getElementById('panelTranslation').addEventListener('change', (e) => {
  const status = e.target.closest('.section')?.querySelector('.status-msg');
  if (e.target.closest('#translateSummary, #translateLanguageField')) {
    applyControl(e.target);
    saveTranslateSettings(status.id);
    renderTranslateSettings();
    return;
  }
  if (status) saveTranslateSettings(status.id, { recheck: CONNECTION_FIELDS.has(e.target.id) });
});
document.getElementById('translateBox').addEventListener('change', (e) => {
  applyControl(e.target);
  saveTranslateSettings('translateModalStatus');
  if (e.target.dataset.preset) renderTranslateSettings();   // a preset fills in several fields
  else refreshDerived();
});

// After a single edit only the overview and the preset match change; keep the modal (and focus).
function refreshDerived() {
  const model = settingsModel(_caps, _settings);
  renderSummary(model);
  const presetSel = document.querySelector('#tcfgGrid select[data-preset]');
  if (presetSel) presetSel.value = JSON.stringify(model.preset);
}

// Modal open/close
function setTranslateModalOpen(open) {
  setDialogOpen(document.getElementById('translateModal'), open, '#translateClose');
}
document.getElementById('openTranslateModalBtn').addEventListener('click', () => setTranslateModalOpen(true));
document.getElementById('translateClose').addEventListener('click', () => setTranslateModalOpen(false));
document.getElementById('translateModal').addEventListener('click', (e) => { if (e.target.id === 'translateModal') setTranslateModalOpen(false); });

// Reset translator behavior to the server's recommendations while keeping the connection details.
document.getElementById('resetTranslateBtn').addEventListener('click', () => {
  if (!confirm('Reset all translator settings to defaults? (Your server URL and access token are kept.)')) return;
  _settings = { ...gatherTranslateSettings(), params: {}, batchCaps: {}, priceIn: 1.5, priceOut: 9 };
  saveTranslateSettings('translateModalStatus');
  renderTranslateSettings();
});

// ── Library — gallery card preferences, saved on change ───────────────

const QUICK_ACTION_MODES = new Set(['hover', 'always', 'hidden']);
const DEFAULT_QUICK_ACTIONS_MODE = 'hover';
const normalizeQuickActionsMode = (mode) => QUICK_ACTION_MODES.has(mode) ? mode : DEFAULT_QUICK_ACTIONS_MODE;

platform.kv.get(['libQuickActionsMode']).then((r) => {
  setChoiceValue('libQuickActionsMode', normalizeQuickActionsMode(r.libQuickActionsMode));
});
document.getElementById('libQuickActionsMode').addEventListener('change', (e) => {
  platform.kv.set({ libQuickActionsMode: normalizeQuickActionsMode(e.target.value) });
  showStatus('libStatus', 'Saved.', 'ok');
});

platform.kv.get(['libHideAppLangFlag']).then((r) => {
  document.getElementById('libAppLangFlag').checked = r.libHideAppLangFlag !== false;
});
document.getElementById('libAppLangFlag').addEventListener('change', (e) => {
  platform.kv.set({ libHideAppLangFlag: e.target.checked });
  showStatus('libStatus', 'Saved.', 'ok');
});

platform.kv.get(['libMergeSeries']).then((r) => {
  document.getElementById('libMergeSeries').checked = r.libMergeSeries !== false;
});
document.getElementById('libMergeSeries').addEventListener('change', (e) => {
  platform.kv.set({ libMergeSeries: e.target.checked });
  showStatus('libStatus', 'Saved.', 'ok');
});

// ── Reader — study display, saved on change ───────────────────────────────

function drawRasterStudyPreview(canvas, text, original) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = original ? '700 15px serif' : '400 14px "CC Victory Speech", "Comic Sans MS", sans-serif';
  ctx.fillText(text, width / 2, height / 2);
}

function syncStudyPreview() {
  const preview = document.getElementById('studyPreview');
  if (!preview) return;
  const original = document.getElementById('readerStudyOriginal').value;
  preview.dataset.original = original;
  preview.dataset.translation = document.getElementById('readerStudyDisplay').value;
  preview.dataset.font = document.getElementById('readerStudySrcFont').value;
  preview.dataset.furigana = document.getElementById('readerFurigana').checked ? 'on' : 'off';
  const textOptions = document.getElementById('studyTextOptions');
  textOptions.disabled = original !== 'text';
  textOptions.setAttribute('aria-disabled', String(textOptions.disabled));
  drawRasterStudyPreview(preview.querySelector('[data-raster="original"]'), '頑張って！', true);
  drawRasterStudyPreview(preview.querySelector('[data-raster="translation"]'), 'Good Luck!', false);
}

platform.kv.get(['readerStudyDisplay']).then((r) => {
  setChoiceValue('readerStudyDisplay', (r.readerStudyDisplay === 'text') ? 'text' : 'hardcoded_images');
  syncStudyPreview();
});
platform.kv.get(['readerStudyOriginal']).then((r) => {
  setChoiceValue('readerStudyOriginal', (r.readerStudyOriginal === 'text') ? 'text' : 'image');
  syncStudyPreview();
});
document.getElementById('readerStudyOriginal').addEventListener('change', (e) => {
  platform.kv.set({ readerStudyOriginal: e.target.value });
  syncStudyPreview();
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerStudySrcFont']).then((r) => {
  setChoiceValue('readerStudySrcFont', (r.readerStudySrcFont === 'kiwi') ? 'kiwi' : 'yasashisa');
  syncStudyPreview();
});
document.getElementById('readerStudySrcFont').addEventListener('change', (e) => {
  platform.kv.set({ readerStudySrcFont: e.target.value });
  syncStudyPreview();
  showStatus('readerStatus', 'Saved.', 'ok');
});
document.getElementById('readerStudyDisplay').addEventListener('change', (e) => {
  platform.kv.set({ readerStudyDisplay: e.target.value });
  syncStudyPreview();
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerFurigana']).then((r) => {
  document.getElementById('readerFurigana').checked = r.readerFurigana === 'on';
  syncStudyPreview();
});
document.getElementById('readerFurigana').addEventListener('change', (e) => {
  platform.kv.set({ readerFurigana: e.target.checked ? 'on' : 'off' });
  syncStudyPreview();
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerTranslateDisplay']).then((r) => {
  setChoiceValue('readerTranslateDisplay', (r.readerTranslateDisplay === 'text') ? 'text' : 'image');
});
document.getElementById('readerTranslateDisplay').addEventListener('change', (e) => {
  platform.kv.set({ readerTranslateDisplay: e.target.value });
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerSkipOverview']).then((r) => {
  document.getElementById('readerSkipOverview').checked = !r.readerSkipOverview;
});
document.getElementById('readerSkipOverview').addEventListener('change', (e) => {
  platform.kv.set({ readerSkipOverview: !e.target.checked });
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerChapterDivider']).then((r) => {
  document.getElementById('readerChapterDivider').checked = r.readerChapterDivider !== false;
});
document.getElementById('readerChapterDivider').addEventListener('change', (e) => {
  platform.kv.set({ readerChapterDivider: e.target.checked });
  showStatus('readerStatus', 'Saved.', 'ok');
});

platform.kv.get(['readerStripMode']).then((r) => {
  document.getElementById('readerStripMode').checked = r.readerStripMode !== 'chapter';
});
document.getElementById('readerStripMode').addEventListener('change', (e) => {
  platform.kv.set({ readerStripMode: e.target.checked ? 'series' : 'chapter' });
  showStatus('readerStatus', 'Saved.', 'ok');
});

syncStudyPreview();
document.fonts.ready.then(syncStudyPreview);

// ── Library Backup — one export button, prompting metadata-only vs full ───

const backupModal = document.getElementById('backupModal');
const setBackupModalOpen = (open) => setDialogOpen(backupModal, open, '#backupMetaBtn');

document.getElementById('exportBackupBtn').addEventListener('click', () => setBackupModalOpen(true));
document.getElementById('backupCancelBtn').addEventListener('click', () => setBackupModalOpen(false));
backupModal.addEventListener('click', (e) => { if (e.target === backupModal) setBackupModalOpen(false); });
document.getElementById('importBackupBtn').addEventListener('click', () => {
  document.getElementById('backupImportFile').click();
});

function _saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

document.getElementById('backupMetaBtn').addEventListener('click', async () => {
  setBackupModalOpen(false);
  try {
    const { blob, suggestedName, count } = await exportMetadata();
    _saveBlob(blob, suggestedName);
    showStatus('backupStatus', `Exported metadata for ${formatCount(count)} galleries.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Export failed: ' + (err && err.message || err), 'err'); }
});

document.getElementById('backupFullBtn').addEventListener('click', async () => {
  setBackupModalOpen(false);
  try {
    const result = await exportFull((phase, done, total) => showStatus('backupStatus', `Exporting ${phase}: ${formatCount(done)}/${formatCount(total)}`, 'ok', 120000));
    if (result.aborted) showStatus('backupStatus', 'Export cancelled.', 'ok');
    else if (result.archive) {
      _saveBlob(result.archive, result.suggestedName || 'shiori.shioridb');
      showStatus('backupStatus', `Exported ${formatCount(result.counts.galleries)} galleries / ${formatCount(result.counts.images)} images — downloaded.`, 'ok');
    } else showStatus('backupStatus', `Exported ${formatCount(result.counts.galleries)} galleries / ${formatCount(result.counts.images)} images — saved.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Export failed: ' + (err && err.message || err), 'err'); }
});

document.getElementById('backupImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const { kind, counts } = await importBackup(file, (phase, done, total) => showStatus('backupStatus', `Importing ${phase}: ${formatCount(done)}/${formatCount(total)}`, 'ok', 120000));
    showStatus('backupStatus', kind === 'metadata'
      ? `Imported metadata for ${formatCount(counts.galleries)} galleries.`
      : `Imported ${formatCount(counts.galleries)} galleries, ${formatCount(counts.images)} images. Open the library to see them.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Import failed: ' + (err && err.message || err), 'err'); }
  e.target.value = '';
});

// ── Storage Writes ────────────────────────────────────────────────────────

// Everything the app has written to this browser's storage; hovering the total splits it by kind.
const WRITE_KINDS = ['pages', 'covers', 'library', 'jobs', 'settings', 'app', 'other'];
function updateWritesDisplay(writes) {
  const el = document.getElementById('totalWritesCount');
  el.textContent = formatBytes(writes?.total || 0);
  el.dataset.tip = WRITE_KINDS.filter(kind => writes?.by?.[kind])
    .map(kind => `${t(`set.writes_${kind}`)}: ${formatBytes(writes.by[kind])}`).join('\n');
}

platform.writes.get().then(updateWritesDisplay, () => {});
platform.writes.subscribe(updateWritesDisplay);

document.getElementById('resetWritesBtn').addEventListener('click', async () => {
  if (!confirm('Reset the lifetime write counter to zero?')) return;
  await platform.writes.reset();
  showStatus('writesStatus', 'Counter reset.', 'ok');
});

// ── Storage layout ────────────────────────────────────────────────────────
// Pages stored before images were kept apart convert as their galleries change, or all at once here.

async function updateLayoutDisplay() {
  const { storageEstimate } = await import('./storage-upgrade.js');
  const est = await storageEstimate();
  document.getElementById('layoutStatus').textContent = est.remaining
    ? t('set.layout_status', { converted: formatCount(est.converted), pages: formatCount(est.pages), size: formatBytes(est.bytes) })
    : t('set.layout_done');
  document.getElementById('convertNowBtn').disabled = !est.remaining;
}
updateLayoutDisplay().catch(() => {});

document.getElementById('convertNowBtn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  const { convertNow } = await import('./storage-upgrade.js');
  platform.kv.set({ storageLayout: 'now' });
  await convertNow().catch(() => {});
  await updateLayoutDisplay().catch(() => {});
});

// ── About modal ───────────────────────────────────────────────────────────

const aboutModal = document.getElementById('aboutModal');
const aboutBtn   = document.getElementById('aboutBtn');
const aboutClose = document.getElementById('aboutClose');

function setAboutOpen(open) {
  setDialogOpen(aboutModal, open, '#aboutClose');
}

aboutBtn.addEventListener('click', () => setAboutOpen(true));
aboutClose.addEventListener('click', () => setAboutOpen(false));
aboutModal.addEventListener('click', (e) => { if (!e.target.closest('#aboutBox')) setAboutOpen(false); });

// Version comes from the app's own web manifest.
fetch('manifest.webmanifest').then(r => r.json()).then(m => { if (m.version) document.getElementById('aboutVersion').textContent = 'v' + m.version; }).catch(() => {});

// Render CHANGELOG.md using marked, with a custom renderer to split version/date in h2.
marked.use({
  gfm: true,
  renderer: {
    heading({ text, depth }) {
      if (depth === 1) return '';
      if (depth === 2) {
        const m = text.match(/^(.+?) — (.+)$/);
        if (m) return `<h2><span class="cl-ver">${m[1]}</span><span class="cl-date">${m[2]}</span></h2>\n`;
        return `<h2>${text}</h2>\n`;
      }
      return false;
    }
  }
});

(async () => {
  try {
    const text = await fetch('../CHANGELOG.md').then(r => r.text());
    document.getElementById('aboutChangelog').innerHTML = marked.parse(text);
  } catch {
    document.getElementById('aboutChangelog').innerHTML =
      '<p>Changelog unavailable.</p>';
  }
})();
