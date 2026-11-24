// translate-settings.test.mjs — what Settings' Translation panel and its advanced window store under
// translateSettings (app/js/translate-settings.js), held against 1.3's own code: the functions as
// settings.js had them, copied verbatim below as oracles over stand-in elements, give the same stored
// text, key for key and in the same order, for the same panel and the same edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { migrateTranslateSettings, settingsModel } = await import('../js/translate-config.js');
const {
  readTranslateSettings, gatherTranslateSettings, serverUrlInvalid, SERVER_URL_ERROR, applyControl, resetTranslateSettings,
  benchmarkOffered, DEFAULT_PRICES, STUDY_GENERATIONS, unavailableChoice, optionLabel, stepLabel, stepTip, presetChoices,
  targetLanguageParam, capsNote,
} = await import('../js/translate-settings.js');

const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));
const t = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);

// ── 1.3's code, verbatim but for its elements (stand-ins with the same properties) ─────────────────
const DEFAULT_SCREEN_PROMPT_KEY = 'translator.content_screen_prompt';
function oracle(stored, caps) {
  const els = {
    translateServerInput: { value: '' }, translateTokenInput: { value: '' },
    studyModeGeneration: { value: '', options: ['disabled', 'text_only', 'text_and_image'] },
    translateSaveSnapshots: { checked: false }, translateKeepSnapshots: { checked: false },
  };
  const document = { getElementById: (id) => els[id] };
  // A native select takes only a value it offers; any other leaves none chosen ('').
  const setChoiceValue = (id, value) => { const el = els[id]; el.value = el.options && !el.options.includes(value) ? '' : value; };
  let _settings, writes = [];
  const platform = { kv: { set: (v) => writes.push(JSON.stringify(v.translateSettings)) } };
  const _caps = caps;
  function loadTranslateSettings(stored) {
    _settings = migrateTranslateSettings(stored);
    if (stored && stored.schema !== _settings.schema) platform.kv.set({ translateSettings: _settings });  // one-time migration
    document.getElementById('translateServerInput').value = stored?.serverUrl || '';
    setChoiceValue('translateTokenInput', _settings.serverToken || '');
    setChoiceValue('studyModeGeneration', _settings.studyModeGeneration || 'disabled');
    document.getElementById('translateSaveSnapshots').checked = !!_settings.saveSnapshots;
    document.getElementById('translateKeepSnapshots').checked = !!_settings.keepSnapshotsOnRevert;
  }
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
  function saveTranslateSettings() {
    const serverRaw = document.getElementById('translateServerInput').value.trim();
    if (serverRaw && !/^https?:\/\//i.test(serverRaw)) return 'Server URL must start with http:// or https://';
    _settings = gatherTranslateSettings();
    platform.kv.set({ translateSettings: _settings });
    return null;
  }
  function reset() {
    _settings = { ...gatherTranslateSettings(), params: {}, batchCaps: {}, priceIn: 1.5, priceOut: 9 };
    return saveTranslateSettings();
  }
  loadTranslateSettings(stored);
  return { els, writes, applyControl, saveTranslateSettings, reset };
}

// The same page driven through translate-settings.js, as the port drives it.
function ported(stored, caps) {
  const { settings, migrated, fields } = readTranslateSettings(stored);
  let current = settings;
  const writes = migrated ? [JSON.stringify(current)] : [];
  const state = { ...fields };
  const save = () => {
    if (serverUrlInvalid(state.serverUrl)) return SERVER_URL_ERROR;
    current = gatherTranslateSettings(current, state);
    writes.push(JSON.stringify(current));
    return null;
  };
  return {
    fields, state, writes, save,
    apply: (control) => { current = applyControl(current, caps, control); },
    reset: () => { current = resetTranslateSettings(gatherTranslateSettings(current, state)); return save(); },
  };
}

// An edit as each side takes it: a stand-in element for 1.3's code, a control for the module.
const EDITS = [
  { el: { dataset: { preset: '1' }, value: '"fast"' }, control: { preset: 'fast' } },
  { el: { dataset: { preset: '1' }, value: '"custom"' }, control: { preset: 'custom' } },
  { el: { dataset: { batch: 'gemini' }, value: '4' }, control: { batch: 'gemini', value: '4' } },
  { el: { dataset: { batch: 'chatgpt' }, value: 'x' }, control: { batch: 'chatgpt', value: 'x' } },
  { el: { dataset: { batch: 'gemini' }, value: '0' }, control: { batch: 'gemini', value: '0' } },
  { el: { dataset: {}, id: 'cfgPriceIn', value: '2.25' }, control: { price: 'in', value: '2.25' } },
  { el: { dataset: {}, id: 'cfgPriceOut', value: '' }, control: { price: 'out', value: '' } },
  { el: { dataset: { param: 'render.uppercase' }, type: 'checkbox', checked: true, value: 'on' }, control: { param: 'render.uppercase', type: 'checkbox', checked: true, value: 'on' } },
  { el: { dataset: { param: 'translator.translator' }, tagName: 'SELECT', value: '"gemini"' }, control: { param: 'translator.translator', type: 'select', value: '"gemini"' } },
  { el: { dataset: { param: 'detector.detection_size' }, tagName: 'SELECT', value: '2048' }, control: { param: 'detector.detection_size', type: 'select', value: '2048' } },
  { el: { dataset: { param: 'kernel_size', integer: '1' }, type: 'number', value: '9.7' }, control: { param: 'kernel_size', type: 'number', integer: true, value: '9.7' } },
  { el: { dataset: { param: 'detector.text_threshold', integer: '' }, type: 'number', value: '0.35' }, control: { param: 'detector.text_threshold', type: 'number', integer: false, value: '0.35' } },
  { el: { dataset: { param: 'detector.box_threshold', integer: '' }, type: 'number', value: '' }, control: { param: 'detector.box_threshold', type: 'number', integer: false, value: '' } },
  { el: { dataset: { param: 'render.font_color' }, type: 'text', value: '  #fff  ' }, control: { param: 'render.font_color', type: 'text', value: '  #fff  ' } },
  { el: { dataset: { param: DEFAULT_SCREEN_PROMPT_KEY }, tagName: 'TEXTAREA', type: 'textarea', value: '  keep me  ' }, control: { param: DEFAULT_SCREEN_PROMPT_KEY, type: 'text', value: '  keep me  ' } },
  { el: { dataset: {}, type: 'text', value: 'no param' }, control: { param: undefined, type: 'text', value: 'no param' } },
];

const STORED = [
  undefined,
  null,
  { schema: 3, serverUrl: 'http://192.168.1.5:5003/', serverToken: ' tok ', studyModeGeneration: 'text_and_image', saveSnapshots: true, keepSnapshotsOnRevert: false, params: { 'ocr.ocr': '48px' }, batchCaps: { gemini: 2 } },
  { schema: 3, params: {}, studyModeGeneration: 'sideways' },
  { schema: 2, serverUrl: 'http://127.0.0.1:5003', params: { 'translator.translator': 'sugoi' } },
  { serverUrl: 'http://127.0.0.1:5003', translator: 'chatgpt', targetLang: 'JPN', screenEnabled: true, detectionSize: '2048' },
];
const PANELS = [
  { serverUrl: '', serverToken: '', saveSnapshots: false, keepSnapshotsOnRevert: false },
  { serverUrl: ' https://mt.example.test:8443/// ', serverToken: '  secret ', saveSnapshots: true, keepSnapshotsOnRevert: true, studyModeGeneration: 'disabled' },
  { serverUrl: 'ftp://nope', serverToken: '', saveSnapshots: false, keepSnapshotsOnRevert: true },
];

test('loading, editing and saving store what 1.3 stored, for every stored form and every kind of edit', () => {
  for (const stored of STORED) for (const caps of [CAPS, null]) for (const panel of PANELS) {
    const old = oracle(structuredClone(stored), caps);
    const now = ported(structuredClone(stored), caps);
    const shown = { serverUrl: old.els.translateServerInput.value, serverToken: old.els.translateTokenInput.value,
      studyModeGeneration: old.els.studyModeGeneration.value, saveSnapshots: old.els.translateSaveSnapshots.checked,
      keepSnapshotsOnRevert: old.els.translateKeepSnapshots.checked };
    assert.deepEqual(now.fields, shown, `the panel shows what 1.3 showed of ${JSON.stringify(stored)}`);
    // The panel's fields as the person left them.
    Object.assign(old.els.translateServerInput, { value: panel.serverUrl });
    Object.assign(old.els.translateTokenInput, { value: panel.serverToken });
    if (panel.studyModeGeneration) old.els.studyModeGeneration.value = panel.studyModeGeneration;
    old.els.translateSaveSnapshots.checked = panel.saveSnapshots;
    old.els.translateKeepSnapshots.checked = panel.keepSnapshotsOnRevert;
    Object.assign(now.state, panel, panel.studyModeGeneration ? {} : { studyModeGeneration: now.state.studyModeGeneration });
    for (const edit of EDITS) {
      old.applyControl({ dataset: {}, ...edit.el });
      now.apply(edit.control);
      assert.equal(now.save(), old.saveTranslateSettings(), 'the same refusal');
    }
    assert.equal(now.reset(), old.reset());
    assert.deepEqual(now.writes, old.writes, `stored ${JSON.stringify(stored)}, panel ${JSON.stringify(panel)}, caps ${!!caps}`);
  }
});

test('what is read: the migrated settings, stored once when they were of an older schema', () => {
  const fresh = readTranslateSettings(undefined);
  assert.equal(fresh.migrated, false);
  assert.deepEqual(fresh.settings, migrateTranslateSettings(undefined));
  assert.deepEqual(fresh.fields, { serverUrl: '', serverToken: '', studyModeGeneration: 'text_only', saveSnapshots: false, keepSnapshotsOnRevert: false });
  const current = { schema: 3, params: {}, serverUrl: 'http://h:1' };
  assert.equal(readTranslateSettings(current).settings, current, 'schema 3 kept as it is');
  assert.equal(readTranslateSettings(current).migrated, false);
  assert.equal(readTranslateSettings({ schema: 2, params: {} }).migrated, true);
  assert.equal(readTranslateSettings({ translator: 'sugoi' }).migrated, true);
  assert.equal(readTranslateSettings({ schema: 3, params: {}, studyModeGeneration: 'other' }).fields.studyModeGeneration, '', 'a value Study data does not offer: none chosen');
  assert.deepEqual(STUDY_GENERATIONS, ['disabled', 'text_only', 'text_and_image']);
});

test('the stored text keeps its keys in order: the panel\'s fields where they were, new ones at the end', () => {
  const { settings } = readTranslateSettings(undefined);
  const gathered = gatherTranslateSettings(settings, { serverUrl: 'http://127.0.0.1:7000/', serverToken: '', studyModeGeneration: 'disabled', saveSnapshots: true, keepSnapshotsOnRevert: false });
  assert.equal(JSON.stringify(gathered), '{"schema":3,"studyModeGeneration":"disabled","saveSnapshots":true,"keepSnapshotsOnRevert":false,"params":{"translator.translator":"deepseek","ocr.ocr":"hayai","render.renderer":"shiori","detector.detection_size":2560,"detector.box_threshold":0.75,"inpainter.inpainting_size":2048,"mask_dilation_offset":40,"kernel_size":7},"serverUrl":"http://127.0.0.1:7000","serverToken":""}');
  const edited = applyControl(applyControl(gathered, CAPS, { price: 'in', value: '3' }), CAPS, { preset: 'balanced' });
  assert.equal(JSON.stringify(edited), '{"schema":3,"studyModeGeneration":"disabled","saveSnapshots":true,"keepSnapshotsOnRevert":false,"params":{"translator.translator":"deepseek","ocr.ocr":"hayai","render.renderer":"shiori","detector.detection_size":2560,"detector.box_threshold":0.75,"inpainter.inpainting_size":1536,"mask_dilation_offset":30,"kernel_size":5},"serverUrl":"http://127.0.0.1:7000","serverToken":"","priceIn":3}');
  assert.notEqual(edited.params, gathered.params, 'a new object: what was passed is left as it was');
  assert.equal(JSON.stringify(resetTranslateSettings(edited)), '{"schema":3,"studyModeGeneration":"disabled","saveSnapshots":true,"keepSnapshotsOnRevert":false,"params":{},"serverUrl":"http://127.0.0.1:7000","serverToken":"","priceIn":1.5,"batchCaps":{},"priceOut":9}');
  assert.deepEqual(DEFAULT_PRICES, { priceIn: 1.5, priceOut: 9 });
});

test('a server address must be a web address; blank is the default server', () => {
  for (const ok of ['', '   ', 'http://127.0.0.1:5003', 'HTTPS://x.test']) assert.equal(serverUrlInvalid(ok), false, ok);
  for (const bad of ['127.0.0.1:5003', 'ftp://x', 'localhost']) assert.equal(serverUrlInvalid(bad), true, bad);
  assert.equal(SERVER_URL_ERROR, 'Server URL must start with http:// or https://');
});

test('the benchmark is offered for a local server that answers', () => {
  assert.equal(benchmarkOffered(true, 'http://127.0.0.1:5003'), true);
  assert.equal(benchmarkOffered(true, 'http://localhost:9'), true);
  assert.equal(benchmarkOffered(true, 'http://[::1]:5003'), true);
  assert.equal(benchmarkOffered(false, 'http://127.0.0.1:5003'), false);
  assert.equal(benchmarkOffered(true, 'https://mt.example.test'), false);
});

test('what the choices say: labels, step names and tips, presets, the target language, the notes', () => {
  const model = settingsModel(CAPS, { schema: 3, params: { 'translator.translator': 'chatgpt', 'ocr.ocr': 'gone' } });
  const translate = model.stages.find((s) => s.id === 'translate');
  const chatgpt = translate.choices.find((c) => c.value === 'chatgpt');
  assert.equal(unavailableChoice(chatgpt), true);
  assert.equal(optionLabel(chatgpt, true, t), `${chatgpt.label} — tm.unavailable`);
  const gone = model.stages.find((s) => s.id === 'ocr').choices.find((c) => c.value === 'gone');
  assert.equal(unavailableChoice(gone), false, 'a missing choice is not "unavailable"');
  assert.equal(optionLabel(gone, false, t), 'gone — tm.not_offered');
  assert.equal(stepLabel({ label: 'Sugoi (offline, JA→EN)' }), 'Sugoi');
  assert.equal(stepLabel({ label: 'Big — slow', short: 'Big' }), 'Big');
  const detect = model.stages.find((s) => s.id === 'detect');
  const chosen = detect.choices.find((c) => c.value === detect.value);
  assert.equal(stepTip(detect, t).split('\n')[0], `${chosen.label} (${chosen.version})`, 'the full name and version first');
  assert.equal(stepTip(detect, t).split('\n').length, 1 + detect.params.length);
  assert.deepEqual(presetChoices(model, t).map((c) => c.value), ['fast', 'balanced', 'thorough', 'custom']);
  assert.equal(targetLanguageParam(model).key, 'translator.target_lang');
  assert.equal(targetLanguageParam(settingsModel(null, {})), null);
  assert.equal(capsNote(model, false, t), `tm.caps_problem${JSON.stringify({ names: 'gone, chatgpt' })}`, 'stage by stage');
  assert.equal(capsNote(settingsModel(CAPS, {}), true, t), 'tm.caps_cached');
  assert.equal(capsNote(settingsModel(CAPS, { schema: 3, params: {} }), false, t), '');
});
