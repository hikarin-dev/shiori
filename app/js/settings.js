// settings.js — the app's Settings page: preferences, translator config, backups and storage.

import './boot.js';
import { clearAll } from './db.js';
import * as platform from './platform.js';
import { pingServer, serverUrlFromSettings } from './translate.js';
import { exportMetadata, exportFull, importBackup } from './backup.js';
import { t, getLang, setLang, SUPPORTED, LANG_NAMES } from './i18n.js';
import { formatBytes, formatCount } from './format.js';

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
  updateTranslateSummary();
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
  loadTranslateSettings(r.translateSettings || {});
});

// ── Clear all cache ────────────────────────────────────────────────────────

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm('Clear ALL cached galleries and images?\n\nThis cannot be undone.')) return;
  if (!confirm('Second confirmation: permanently delete everything?')) return;
  await clearAll();
  showStatus('clearAllStatus', 'Cache cleared.', 'ok');
});

// ── Translation server status ───────────────────────────────────────────────

let _lastBadge = 'checking';
function setTranslatorBadge(state) {
  _lastBadge = state;
  const b = document.getElementById('translateStatusBadge');
  if (state === 'checking') { b.className = 'key-status-badge unset'; b.textContent = t('set.tr_checking'); }
  else if (state === 'online') { b.className = 'key-status-badge set'; b.textContent = t('set.tr_online'); }
  else { b.className = 'key-status-badge unset'; b.textContent = t('set.tr_offline'); }
}

async function checkTranslatorStatus(settings = null) {
  setTranslatorBadge('checking');
  const translateSettings = settings || (await platform.kv.get(['translateSettings'])).translateSettings;
  setTranslatorBadge((await pingServer(serverUrlFromSettings(translateSettings), translateSettings)) ? 'online' : 'offline');
}

document.getElementById('checkTranslateBtn').addEventListener('click', () => checkTranslatorStatus(gatherTranslateSettings()));
checkTranslatorStatus();

// ── Translation settings (inline server + full config modal) ────────────────

function loadTranslateSettings(ts) {
  const set = (id, v) => setChoiceValue(id, v);
  document.getElementById('translateServerInput').value = ts.serverUrl || '';
  set('translateTokenInput', ts.serverToken || '');
  set('cfgTranslator', ts.translator === 'custom_openai' ? 'qwen2_big' : (ts.translator || 'sugoi'));
  set('cfgTargetLang', ts.targetLang || 'ENG');
  set('cfgDetector', ts.detector || 'default');
  set('cfgDetectionSize', String(ts.detectionSize ?? 1536));
  set('cfgTextThreshold', ts.textThreshold ?? 0.5);
  set('cfgBoxThreshold', ts.boxThreshold ?? 0.7);
  set('cfgUnclipRatio', ts.unclipRatio ?? 2.3);
  set('cfgOcr', ts.ocr || '48px');
  document.getElementById('cfgEstFontColor').checked = !!ts.estimateFontColor;
  document.getElementById('cfgEstOutlineColor').checked = !!ts.estimateOutlineColor;
  set('cfgInpainter', ts.inpainter || 'lama_large');
  set('cfgInpaintingSize', String(ts.inpaintingSize ?? 1536));
  set('cfgInpaintingPrecision', ts.inpaintingPrecision || 'bf16');
  set('cfgMaskDilation', ts.maskDilationOffset ?? 30);
  set('cfgKernelSize', ts.kernelSize ?? 5);
  set('cfgRenderer', ts.renderer || 'manga2eng');
  set('cfgDirection', ts.direction || 'auto');
  set('cfgAlignment', ts.alignment || 'auto');
  set('cfgFontSizeOffset', ts.fontSizeOffset ?? 0);
  set('cfgFontColor', ts.fontColor || '');
  document.getElementById('cfgUppercase').checked = !!ts.uppercase;
  document.getElementById('cfgNoHyphenation').checked = !!ts.noHyphenation;
  const caps = ts.batchCaps || {};
  set('cfgCapGemini', caps.gemini ?? 8);
  set('cfgCapChatgpt', caps.chatgpt ?? 6);
  set('cfgPriceIn', ts.priceIn ?? 1.5);
  set('cfgPriceOut', ts.priceOut ?? 9);
  set('studyModeGeneration', ts.studyModeGeneration || 'disabled');
  document.getElementById('cfgScreenEnabled').checked = !!ts.screenEnabled;
  set('cfgScreenTranslator', ts.screenTranslator || 'qwen2_big');
  set('cfgScreenFallback',   ts.screenFallback   || 'qwen2_big');
  document.getElementById('cfgScreenPrompt').value = ts.screenPrompt
    ?? 'For each numbered line below, reply with only "true" or "false" on a new numbered line. true = the text is sexually explicit or graphic; false = it is not. Err on the side of true.\n';
  document.getElementById('cfgClearingPreset').value = matchClearingPreset();
  updateTranslateSummary();
}

function gatherTranslateSettings() {
  const v = (id) => document.getElementById(id).value;
  const n = (id, d) => { const x = parseFloat(v(id)); return Number.isFinite(x) ? x : d; };
  const i = (id, d) => { const x = parseInt(v(id), 10); return Number.isFinite(x) ? x : d; };
  const serverUrl = v('translateServerInput').trim().replace(/\/+$/, '');
  return {
    serverUrl: serverUrl || 'http://127.0.0.1:5003',
    serverToken: v('translateTokenInput').trim(),
    translator: v('cfgTranslator'),
    targetLang: v('cfgTargetLang'),
    detector: v('cfgDetector'),
    detectionSize: i('cfgDetectionSize', 1536),
    textThreshold: n('cfgTextThreshold', 0.5),
    boxThreshold: n('cfgBoxThreshold', 0.7),
    unclipRatio: n('cfgUnclipRatio', 2.3),
    ocr: v('cfgOcr'),
    estimateFontColor: document.getElementById('cfgEstFontColor').checked,
    estimateOutlineColor: document.getElementById('cfgEstOutlineColor').checked,
    inpainter: v('cfgInpainter'),
    inpaintingSize: i('cfgInpaintingSize', 1536),
    inpaintingPrecision: v('cfgInpaintingPrecision'),
    maskDilationOffset: i('cfgMaskDilation', 30),
    kernelSize: i('cfgKernelSize', 5),
    renderer: v('cfgRenderer'),
    direction: v('cfgDirection'),
    alignment: v('cfgAlignment'),
    fontSizeOffset: i('cfgFontSizeOffset', 0),
    fontColor: document.getElementById('cfgFontColor').value.trim(),
    uppercase: document.getElementById('cfgUppercase').checked,
    noHyphenation: document.getElementById('cfgNoHyphenation').checked,
    batchCaps: {
      gemini:   i('cfgCapGemini', 8),
      chatgpt:  i('cfgCapChatgpt', 6),
    },
    priceIn: n('cfgPriceIn', 1.5),
    priceOut: n('cfgPriceOut', 9),
    studyModeGeneration: v('studyModeGeneration'),
    screenEnabled:    document.getElementById('cfgScreenEnabled').checked,
    screenTranslator: v('cfgScreenTranslator'),
    screenFallback:   v('cfgScreenFallback'),
    screenPrompt:     document.getElementById('cfgScreenPrompt').value,
  };
}

function updateTranslateSummary() {
  const el = document.getElementById('translateSummary');
  if (!el) return;
  const tr = document.getElementById('cfgTranslator');
  const trLabel = tr.options[tr.selectedIndex] ? tr.options[tr.selectedIndex].text.split(' — ')[0] : tr.value;
  el.textContent = `Current: ${trLabel} → ${document.getElementById('cfgTargetLang').value} · detect ${document.getElementById('cfgDetectionSize').value} · inpaint ${document.getElementById('cfgInpaintingSize').value} · mask ${document.getElementById('cfgMaskDilation').value}`;
}

function saveTranslateSettings(statusId, after) {
  const serverRaw = document.getElementById('translateServerInput').value.trim();
  if (serverRaw && !/^https?:\/\//i.test(serverRaw)) {
    showStatus(statusId, 'Server URL must start with http:// or https://', 'err');
    return;
  }
  platform.kv.set({ translateSettings: gatherTranslateSettings() });
  showStatus(statusId, 'Translation settings saved.', 'ok');
  updateTranslateSummary();
  checkTranslatorStatus();
  if (after) after();
}

document.getElementById('saveTranslateBtn').addEventListener('click', () => saveTranslateSettings('translateStatus'));
document.getElementById('saveTranslateModalBtn').addEventListener('click',
  () => saveTranslateSettings('translateModalStatus', () => setTimeout(() => setTranslateModalOpen(false), 600)));

// Modal open/close
function setTranslateModalOpen(open) {
  setDialogOpen(document.getElementById('translateModal'), open, '#translateClose');
}
document.getElementById('openTranslateModalBtn').addEventListener('click', () => setTranslateModalOpen(true));
document.getElementById('translateClose').addEventListener('click', () => setTranslateModalOpen(false));
document.getElementById('translateModal').addEventListener('click', (e) => { if (e.target.id === 'translateModal') setTranslateModalOpen(false); });

// The "Advanced settings" header collapses everything below it at once.
function setAdvancedCollapsed(collapsed) {
  const h = document.getElementById('cfgAdvancedHeader');
  h.classList.toggle('collapsed', collapsed);
  h.setAttribute('aria-expanded', String(!collapsed));
  let el = h.nextElementSibling;
  while (el) { el.classList.toggle('tcfg-hidden', collapsed); el = el.nextElementSibling; }
}
document.getElementById('cfgAdvancedHeader').addEventListener('click', function () {
  setAdvancedCollapsed(!this.classList.contains('collapsed'));
});
setAdvancedCollapsed(true);

// Reset translator behavior to defaults while keeping the server connection details.
document.getElementById('resetTranslateBtn').addEventListener('click', () => {
  if (!confirm('Reset all translator settings to defaults? (Your server URL and access token are kept.)')) return;
  loadTranslateSettings({
    serverUrl: document.getElementById('translateServerInput').value || 'http://127.0.0.1:5003',
    serverToken: document.getElementById('translateTokenInput').value,
  });
  saveTranslateSettings('translateModalStatus');
});

// Clearing preset ↔ the inpainting/mask/kernel fields. Picking a preset fills them in;
// editing any of them by hand flips the preset to "Custom".
const CLEARING_PRESETS = {
  fast:     { sz: 1024, md: 20, ks: 3 },
  balanced: { sz: 1536, md: 30, ks: 5 },
  thorough: { sz: 2048, md: 40, ks: 7 },
};
function applyClearingPreset(name) {
  const p = CLEARING_PRESETS[name];
  if (!p) return; // "custom": leave fields as they are
  document.getElementById('cfgInpaintingSize').value = String(p.sz);
  document.getElementById('cfgMaskDilation').value = p.md;
  document.getElementById('cfgKernelSize').value = p.ks;
}
function matchClearingPreset() {
  const sz = parseInt(document.getElementById('cfgInpaintingSize').value, 10);
  const md = parseInt(document.getElementById('cfgMaskDilation').value, 10);
  const ks = parseInt(document.getElementById('cfgKernelSize').value, 10);
  for (const [name, p] of Object.entries(CLEARING_PRESETS))
    if (p.sz === sz && p.md === md && p.ks === ks) return name;
  return 'custom';
}
document.getElementById('cfgClearingPreset').addEventListener('change', (e) => applyClearingPreset(e.target.value));
['cfgInpaintingSize', 'cfgMaskDilation', 'cfgKernelSize'].forEach(id => {
  const el = document.getElementById(id);
  const sync = () => { document.getElementById('cfgClearingPreset').value = matchClearingPreset(); };
  el.addEventListener('input', sync);
  el.addEventListener('change', sync);
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

function updateWritesDisplay(bytes) {
  document.getElementById('totalWritesCount').textContent = formatBytes(bytes || 0);
}

platform.kv.get(['totalWrittenBytes']).then(r => updateWritesDisplay(r.totalWrittenBytes));

document.getElementById('resetWritesBtn').addEventListener('click', () => {
  if (!confirm('Reset the lifetime write counter to zero?')) return;
  platform.kv.set({ totalWrittenBytes: 0 });
  updateWritesDisplay(0);
  showStatus('writesStatus', 'Counter reset.', 'ok');
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
