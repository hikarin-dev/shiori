// translate-config.test.mjs — settings built from a server's capabilities, and the migration from
// the pre-capabilities settings that must keep every user's translations on the same config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  migrateTranslateSettings, buildConfig, settingsModel, batchCap, languageTag,
  unavailableChoices, SETTINGS_SCHEMA,
} from '../js/translate-config.js';

const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));

// The config the app sent before capabilities existed — copied verbatim as the oracle.
function oldBuildConfig(ts) {
  const target = ts.targetLang || 'ENG';
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    translator: {
      translator: ts.translator || 'sugoi',
      target_lang: target,
      enable_post_translation_check: false,
      ...(ts.screenEnabled ? {
        content_screen_enabled: true,
        content_screen_translator: ts.screenTranslator || 'qwen2',
        content_screen_fallback_translator: ts.screenFallback || 'qwen2',
        content_screen_prompt: ts.screenPrompt || undefined,
      } : {}),
    },
    detector: {
      detector: ts.detector || 'default',
      detection_size: num(ts.detectionSize, 1536),
      text_threshold: num(ts.textThreshold, 0.5),
      box_threshold: num(ts.boxThreshold, 0.7),
      unclip_ratio: num(ts.unclipRatio, 2.3),
    },
    ocr: { ocr: ts.ocr || '48px' },
    inpainter: {
      inpainter: ts.inpainter || 'lama_large',
      inpainting_size: num(ts.inpaintingSize, 1536),
      inpainting_precision: ts.inpaintingPrecision || 'bf16',
    },
    render: {
      renderer: ts.renderer || (target === 'ENG' ? 'manga2eng' : 'default'),
      direction: ts.direction || 'auto',
      alignment: ts.alignment || 'auto',
      font_size_offset: num(ts.fontSizeOffset, 0),
      uppercase: !!ts.uppercase,
      no_hyphenation: !!ts.noHyphenation,
      estimate_font_color: !!ts.estimateFontColor,
      estimate_outline_color: !!ts.estimateOutlineColor,
      ...(ts.fontColor ? { font_color: ts.fontColor } : {}),
    },
    mask_dilation_offset: num(ts.maskDilationOffset, 30),
    kernel_size: num(ts.kernelSize, 5),
    study_mode_generation: ts.studyModeGeneration || 'disabled',
  };
}

const drop = (value) => JSON.parse(JSON.stringify(value));   // what actually goes over the wire

// What the schema-3 defaults set over any older settings; every other choice is kept.
function withDefaults(config) {
  const c = structuredClone(drop(config));
  c.translator.translator = 'deepseek';
  c.ocr.ocr = 'hayai';
  c.render.renderer = 'shiori';
  Object.assign(c.detector, { detection_size: 2560, box_threshold: 0.75 });
  c.inpainter.inpainting_size = 2048;
  Object.assign(c, { mask_dilation_offset: 40, kernel_size: 7, study_mode_generation: 'text_only' });
  return c;
}

const LEGACY = [
  {},
  { serverUrl: 'http://127.0.0.1:5003' },
  { serverUrl: 'https://x.example', serverToken: 't', translator: 'deepseek', targetLang: 'ENG', detector: 'default',
    detectionSize: 2560, textThreshold: 0.5, boxThreshold: 0.75, unclipRatio: 2.3, ocr: 'mocr_fast',
    estimateFontColor: true, inpainter: 'lama_large', inpaintingSize: 2048, inpaintingPrecision: 'bf16',
    maskDilationOffset: 40, kernelSize: 7, renderer: 'shiori_v2', direction: 'auto', alignment: 'auto',
    fontSizeOffset: 0, fontColor: '', uppercase: false, noHyphenation: false, batchCaps: { gemini: 4, chatgpt: 6 },
    priceIn: 1.5, priceOut: 9, studyModeGeneration: 'text_and_image', screenEnabled: false,
    screenTranslator: 'qwen2_big', screenFallback: 'qwen2_big', screenPrompt: 'classify' },
  { translator: 'gemini', screenEnabled: true, screenTranslator: 'qwen2', screenFallback: 'sugoi', screenPrompt: 'p' },
  { translator: 'gemini', screenEnabled: true },
  { targetLang: 'KOR', fontColor: 'FFFFFF:000000', uppercase: true },
  { detectionSize: 'not a number', kernelSize: 3 },
];

test('a migrated user keeps the config the previous app sent, moved onto the current defaults', () => {
  for (const ts of LEGACY) {
    assert.deepEqual(drop(buildConfig(migrateTranslateSettings(ts), CAPS)), withDefaults(oldBuildConfig(ts)), JSON.stringify(ts));
    // Also without a server answer (an older server): the stored picks alone reproduce it.
    assert.deepEqual(drop(buildConfig(migrateTranslateSettings(ts), null)).detector, withDefaults(oldBuildConfig(ts)).detector);
  }
});

test('settings saved before schema 3 move onto the new defaults once, keeping every other choice', () => {
  const saved = { schema: 2, serverUrl: 'https://x.example', serverToken: 't', studyModeGeneration: 'text_and_image',
    saveSnapshots: true, keepSnapshotsOnRevert: true, batchCaps: { gemini: 4 },
    params: { 'translator.translator': 'gemini', 'translator.target_lang': 'KOR', 'ocr.ocr': 'mocr_fast', 'render.uppercase': true } };
  const once = migrateTranslateSettings(saved);
  assert.equal(once.schema, SETTINGS_SCHEMA);
  assert.equal(migrateTranslateSettings(once), once);
  assert.deepEqual([once.studyModeGeneration, once.saveSnapshots, once.keepSnapshotsOnRevert], ['text_only', false, false]);
  assert.equal(once.params['translator.translator'], 'deepseek');
  assert.equal(once.params['ocr.ocr'], 'hayai');
  for (const key of ['serverUrl', 'serverToken', 'batchCaps']) assert.deepEqual(once[key], saved[key], key);
  assert.equal(once.params['translator.target_lang'], 'KOR');
  assert.equal(once.params['render.uppercase'], true);
});

test('migration is idempotent and keeps app-owned fields', () => {
  const ts = LEGACY[2];
  const once = migrateTranslateSettings(ts);
  assert.equal(once.schema, SETTINGS_SCHEMA);
  assert.equal(migrateTranslateSettings(once), once);
  for (const key of ['serverUrl', 'serverToken', 'batchCaps', 'priceIn', 'priceOut']) {
    assert.deepEqual(once[key], ts[key], key);
  }
  for (const key of ['translator', 'detectionSize', 'renderer', 'screenPrompt']) assert.ok(!(key in once), key);
  assert.equal(once.params['detector.detection_size'], 2560);
});

test('a new user starts from the app\'s defaults and the server\'s recommended ones', () => {
  const config = buildConfig(undefined, CAPS);
  const recommended = (stage) => CAPS.stages.find(s => s.id === stage);
  const fresh = migrateTranslateSettings();
  assert.deepEqual([fresh.studyModeGeneration, fresh.saveSnapshots, fresh.keepSnapshotsOnRevert], ['text_only', false, false]);
  assert.equal(config.study_mode_generation, 'text_only');
  assert.equal(config.translator.translator, 'deepseek');
  assert.equal(config.ocr.ocr, 'hayai');
  assert.equal(config.render.renderer, 'shiori');
  assert.equal(config.detector.detection_size, 2560);
  assert.equal(config.detector.detector, recommended('detect').implementations.find(i => i.default).id);
  assert.equal(config.detector.text_threshold, recommended('detect').params.find(p => p.key === 'detector.text_threshold').default);
  assert.ok(!('content_screen_translator' in config.translator), 'options that do not apply are left out');
  assert.deepEqual(unavailableChoices(migrateTranslateSettings(), CAPS), [], 'every first-run pick is on offer');
});

test('settings are drawn from the capabilities document', () => {
  const model = settingsModel(CAPS, migrateTranslateSettings(LEGACY[2]));
  assert.equal(model.offline, false);
  assert.deepEqual(model.stages.map(s => s.id), CAPS.stages.map(s => s.id));
  const ocr = model.stages.find(s => s.id === 'ocr');
  assert.equal(ocr.value, 'hayai');
  assert.equal(ocr.implLabelKey, 'tm.ocr_model');
  assert.ok(ocr.choices.every(c => typeof c.label === 'string' && c.version !== undefined));
  const size = model.stages.find(s => s.id === 'detect').params.find(p => p.key === 'detector.detection_size');
  assert.equal(size.value, 2560);
  assert.equal(size.labelKey, 'tm.det_size');
  assert.equal(model.preset, 'thorough');
  assert.deepEqual(Object.fromEntries(model.batching.map(b => [b.translator, b.value])), { gemini: 4, chatgpt: 6 });
  assert.deepEqual(model.problems, []);
});

test('a model the server no longer offers is shown as such and blocks translation', () => {
  const trimmed = structuredClone(CAPS);
  const ocr = trimmed.stages.find(s => s.id === 'ocr');
  ocr.implementations = ocr.implementations.filter(i => i.id !== 'hayai');
  const settings = migrateTranslateSettings(LEGACY[2]);
  const model = settingsModel(trimmed, settings);
  const choice = model.stages.find(s => s.id === 'ocr').choices.find(c => c.value === 'hayai');
  assert.ok(choice.missing && !choice.available);
  assert.deepEqual(unavailableChoices(settings, trimmed).map(p => p.value), ['hayai']);
  // An implementation the server lists as unavailable (e.g. no API key there) blocks too.
  const noKey = structuredClone(CAPS);
  noKey.stages.find(s => s.id === 'translate').implementations.find(i => i.id === 'deepseek').available = false;
  assert.deepEqual(unavailableChoices(settings, noKey).map(p => p.stage), ['translate']);
});

test('without any server answer nothing is offered and saved picks are untouched', () => {
  const settings = migrateTranslateSettings(LEGACY[2]);
  const model = settingsModel(null, settings);
  assert.equal(model.offline, true);
  assert.deepEqual(model.stages, []);
  assert.equal(model.values, settings.params);
});

test('batch caps and language tags come from the server', () => {
  assert.equal(batchCap(CAPS, 'gemini', { gemini: 4 }), 4);
  assert.equal(batchCap(CAPS, 'deepseek', { deepseek: 99 }), 10, 'not user-tunable');
  assert.equal(batchCap(CAPS, 'sugoi', {}), 1);
  assert.equal(batchCap(null, 'gemini', { gemini: 4 }), 1);
  assert.equal(languageTag(CAPS, 'PTB'), 'pt-BR');
  assert.equal(languageTag(null, 'ENG'), '');
});

// A parameter whose `requires` names a list applies when the other param has any value on it:
// bubble OCR goes out only for Hayai with a shiori renderer, and shows inactive otherwise.
test('list-valued requires: bubble OCR only with Hayai and a shiori renderer', () => {
  const caps = { stages: [
    { id: 'ocr', implementation_param: 'ocr.ocr', implementations: [{ id: 'hayai', default: true }, { id: '48px' }],
      params: [{ key: 'ocr.bubble_ocr', type: 'bool', default: false, omit_when: false,
        requires: { 'ocr.ocr': 'hayai', 'render.renderer': ['shiori', 'shiori_v2'] } }] },
    { id: 'render', implementation_param: 'render.renderer',
      implementations: [{ id: 'shiori', default: true }, { id: 'shiori_v2' }, { id: 'manga2eng' }], params: [] },
  ] };
  const ts = (renderer, ocr = 'hayai') => ({ schema: SETTINGS_SCHEMA,
    params: { 'ocr.ocr': ocr, 'render.renderer': renderer, 'ocr.bubble_ocr': true } });
  assert.equal(buildConfig(ts('shiori'), caps).ocr.bubble_ocr, true);
  assert.equal(buildConfig(ts('shiori_v2'), caps).ocr.bubble_ocr, true);
  assert.equal(buildConfig(ts('manga2eng'), caps).ocr.bubble_ocr, undefined);
  assert.equal(buildConfig(ts('shiori', '48px'), caps).ocr.bubble_ocr, undefined);
  const param = (model) => model.stages.find((s) => s.id === 'ocr').params.find((p) => p.key === 'ocr.bubble_ocr');
  assert.equal(param(settingsModel(caps, ts('shiori'))).inactive, false);
  assert.equal(param(settingsModel(caps, ts('manga2eng'))).inactive, true);
});
