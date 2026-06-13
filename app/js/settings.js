// settings.js — the app's Settings page: translator config, backups, stats, danger zone.
// The API-key and capture-behaviour cards are NOT here: they are extension concerns, injected
// into this page by the extension's content script (extension/content/settings-app.js).

import './boot.js';
import { clearAll } from './db.js';
import * as platform from './platform.js';
import { pingServer, serverUrlFromSettings } from './translate.js';
import { exportMetadata, exportFull, importBackup } from './backup.js';
import { t, getLang, setLang, SUPPORTED, LANG_NAMES } from './i18n.js';

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
window.addEventListener('shiori-lang-change', () => { setTranslatorBadge(_lastBadge); updateTranslateSummary(); });

function showStatus(id, msg, type, durationMs = 2500) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'status-msg hidden'; }, durationMs);
}

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

async function checkTranslatorStatus() {
  setTranslatorBadge('checking');
  const { translateSettings } = await platform.kv.get(['translateSettings']);
  setTranslatorBadge((await pingServer(serverUrlFromSettings(translateSettings))) ? 'online' : 'offline');
}

document.getElementById('checkTranslateBtn').addEventListener('click', checkTranslatorStatus);
checkTranslatorStatus();

// ── Translation settings (inline server + full config modal) ────────────────

function loadTranslateSettings(ts) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  document.getElementById('translateServerInput').value = ts.serverUrl || '';
  set('cfgTranslator', ts.translator === 'custom_openai' ? 'qwen2_big' : (ts.translator || 'sugoi'));
  set('cfgTargetLang', ts.targetLang || 'ENG');
  set('cfgDetector', ts.detector || 'default');
  set('cfgDetectionSize', String(ts.detectionSize ?? 1536));
  set('cfgTextThreshold', ts.textThreshold ?? 0.5);
  set('cfgBoxThreshold', ts.boxThreshold ?? 0.7);
  set('cfgUnclipRatio', ts.unclipRatio ?? 2.3);
  set('cfgOcr', ts.ocr || '48px');
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
  set('cfgCapDeepseek', caps.deepseek ?? 8);
  set('cfgCapChatgpt', caps.chatgpt ?? 6);
  set('cfgPriceIn', ts.priceIn ?? 1.5);
  set('cfgPriceOut', ts.priceOut ?? 9);
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
    translator: v('cfgTranslator'),
    targetLang: v('cfgTargetLang'),
    detector: v('cfgDetector'),
    detectionSize: i('cfgDetectionSize', 1536),
    textThreshold: n('cfgTextThreshold', 0.5),
    boxThreshold: n('cfgBoxThreshold', 0.7),
    unclipRatio: n('cfgUnclipRatio', 2.3),
    ocr: v('cfgOcr'),
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
      deepseek: i('cfgCapDeepseek', 8),
      chatgpt:  i('cfgCapChatgpt', 6),
    },
    priceIn: n('cfgPriceIn', 1.5),
    priceOut: n('cfgPriceOut', 9),
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
function setTranslateModalOpen(open) { document.getElementById('translateModal').classList.toggle('show', open); }
document.getElementById('openTranslateModalBtn').addEventListener('click', () => setTranslateModalOpen(true));
document.getElementById('translateClose').addEventListener('click', () => setTranslateModalOpen(false));
document.getElementById('translateModal').addEventListener('click', (e) => { if (e.target.id === 'translateModal') setTranslateModalOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTranslateModalOpen(false); });

// The "Advanced settings" header collapses everything below it at once.
function setAdvancedCollapsed(collapsed) {
  const h = document.getElementById('cfgAdvancedHeader');
  h.classList.toggle('collapsed', collapsed);
  let el = h.nextElementSibling;
  while (el) { el.classList.toggle('tcfg-hidden', collapsed); el = el.nextElementSibling; }
}
document.getElementById('cfgAdvancedHeader').addEventListener('click', function () {
  setAdvancedCollapsed(!this.classList.contains('collapsed'));
});
setAdvancedCollapsed(true);

// Reset all translator settings to defaults (keeps the server URL).
document.getElementById('resetTranslateBtn').addEventListener('click', () => {
  if (!confirm('Reset all translator settings to defaults? (Your server URL is kept.)')) return;
  loadTranslateSettings({ serverUrl: document.getElementById('translateServerInput').value || 'http://127.0.0.1:5003' });
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

// ── Library Backup — one export button, prompting metadata-only vs full ───

const backupModal = document.getElementById('backupModal');
const setBackupModalOpen = (open) => { backupModal.style.display = open ? 'flex' : 'none'; };

document.getElementById('exportBackupBtn').addEventListener('click', () => setBackupModalOpen(true));
document.getElementById('backupCancelBtn').addEventListener('click', () => setBackupModalOpen(false));
backupModal.addEventListener('click', (e) => { if (e.target === backupModal) setBackupModalOpen(false); });

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
    showStatus('backupStatus', `Exported metadata for ${count} galleries.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Export failed: ' + (err && err.message || err), 'err'); }
});

document.getElementById('backupFullBtn').addEventListener('click', async () => {
  setBackupModalOpen(false);
  try {
    const result = await exportFull((phase, done, total) => showStatus('backupStatus', `Exporting ${phase}: ${done}/${total}`, 'ok', 120000));
    if (result.aborted) showStatus('backupStatus', 'Export cancelled.', 'ok');
    else if (result.archive) {
      _saveBlob(result.archive, result.suggestedName || 'shiori.shioridb');
      showStatus('backupStatus', `Exported ${result.counts.galleries} galleries / ${result.counts.images} images — downloaded.`, 'ok');
    } else showStatus('backupStatus', `Exported ${result.counts.galleries} galleries / ${result.counts.images} images — saved.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Export failed: ' + (err && err.message || err), 'err'); }
});

document.getElementById('backupImportFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const { kind, counts } = await importBackup(file, (phase, done, total) => showStatus('backupStatus', `Importing ${phase}: ${done}/${total}`, 'ok', 120000));
    showStatus('backupStatus', kind === 'metadata'
      ? `Imported metadata for ${counts.galleries} galleries.`
      : `Imported ${counts.galleries} galleries, ${counts.images} images. Open the library to see them.`, 'ok');
  } catch (err) { showStatus('backupStatus', 'Import failed: ' + (err && err.message || err), 'err'); }
  e.target.value = '';
});

// ── Storage Writes ────────────────────────────────────────────────────────

function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

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
  aboutModal.classList.toggle('show', open);
}

aboutBtn.addEventListener('click', () => setAboutOpen(true));
aboutClose.addEventListener('click', () => setAboutOpen(false));
aboutModal.addEventListener('click', (e) => { if (!e.target.closest('#aboutBox')) setAboutOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setAboutOpen(false); });

// Version from the app's own web manifest — the app no longer reads the extension manifest.
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
      '<p style="font-size:11px;color:var(--muted)">Changelog unavailable.</p>';
  }
})();
