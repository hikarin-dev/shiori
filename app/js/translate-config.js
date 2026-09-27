// translate-config.js — translation settings as the server's parameters.
//
// The translation server owns what can be chosen (GET /capabilities): stages, models, options,
// presets and target languages. The app stores the user's choices keyed by the server's
// parameter names (`translateSettings.params`) and never keeps its own copy of those lists.
// This module is pure (no DOM, no network) so the page, the service worker and the tests share
// it: storage migration, the Settings view model, and the config a translation job sends.

export const SETTINGS_SCHEMA = 2;

// ── One-time migration from the pre-capabilities settings ───────────────────────────────────
// Earlier builds stored camelCase fields and filled in their own defaults when sending. The
// migration materializes exactly the config those builds sent, defaults included, so a migrated
// user's translations keep the same settings (and speed). It is storage compatibility, not model
// knowledge; delete it once every client has migrated.
const LEGACY_FIELDS = ['translator', 'targetLang', 'detector', 'detectionSize', 'textThreshold', 'boxThreshold',
  'unclipRatio', 'ocr', 'estimateFontColor', 'estimateOutlineColor', 'inpainter', 'inpaintingSize',
  'inpaintingPrecision', 'maskDilationOffset', 'kernelSize', 'renderer', 'direction', 'alignment', 'fontSizeOffset',
  'fontColor', 'uppercase', 'noHyphenation', 'screenEnabled', 'screenTranslator', 'screenFallback', 'screenPrompt'];
// Fields the app itself decides on every job; never stored as user parameters.
const APP_OWNED = new Set(['study_mode_generation', 'translator.enable_post_translation_check']);

export function legacyConfig(ts) {
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

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix + k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key + '.', out);
    else out[key] = v;
  }
  return out;
}

export function migrateTranslateSettings(ts) {
  if (!ts || typeof ts !== 'object') return { schema: SETTINGS_SCHEMA, params: {} };
  if (ts.schema === SETTINGS_SCHEMA && ts.params && typeof ts.params === 'object') return ts;
  // The old Settings page already showed (and saved) Qwen2-7B for this retired choice.
  const legacy = { ...ts, translator: ts.translator === 'custom_openai' ? 'qwen2_big' : ts.translator };
  const params = {};
  for (const [key, value] of Object.entries(flatten(legacyConfig(legacy)))) {
    if (!APP_OWNED.has(key)) params[key] = value;
  }
  // Earlier builds sent no prompt when it was blank: keep it blank (left out) rather than
  // letting the server's recommended prompt fill in.
  if (legacy.screenEnabled && !legacy.screenPrompt) params['translator.content_screen_prompt'] = '';
  const rest = {};
  for (const [key, value] of Object.entries(ts)) if (!LEGACY_FIELDS.includes(key)) rest[key] = value;
  return { ...rest, schema: SETTINGS_SCHEMA, params };
}

// ── Capabilities helpers ─────────────────────────────────────────────────────────────────────
export function stageOf(caps, id) {
  return (caps?.stages || []).find((s) => s.id === id) || null;
}

export function paramSpecs(caps) {
  const specs = new Map();
  for (const stage of caps?.stages || []) {
    if (stage.implementation_param) {
      const impl = stage.implementations.find((i) => i.default) || stage.implementations[0];
      specs.set(stage.implementation_param, { key: stage.implementation_param, type: 'implementation',
        stage: stage.id, default: impl?.id });
    }
    for (const param of stage.params || []) specs.set(param.key, { ...param, stage: stage.id });
  }
  return specs;
}

export function languageTag(caps, code) {
  return (caps?.languages || []).find((l) => l.id === code)?.bcp47 || '';
}

// Pages per translation request for the chosen translator: its declared batching, with the
// user's own cap where the server marks it tunable.
export function batchCap(caps, translator, userCaps = {}) {
  const impl = stageOf(caps, 'translate')?.implementations.find((i) => i.id === translator);
  const batching = impl?.batching;
  if (!batching) return 1;
  const own = parseInt(userCaps?.[translator], 10);
  return Math.max(1, batching.user_tunable && Number.isFinite(own) ? own : batching.default || 1);
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
  node[parts[parts.length - 1]] = value;
}

// The effective parameter values: the user's choices over the server's recommended defaults.
export function effectiveParams(settings, caps) {
  const values = {};
  for (const [key, spec] of paramSpecs(caps)) if (spec.default !== undefined) values[key] = spec.default;
  return { ...values, ...(migrateTranslateSettings(settings).params || {}) };
}

// Whether a parameter's `requires` hold: each named param must have the given value, or one of
// them when a list is given.
export function requiresMet(requires, values) {
  return Object.entries(requires || {}).every(([k, v]) => (Array.isArray(v) ? v.includes(values[k]) : values[k] === v));
}

// The config one translation job sends. Parameters whose `requires` aren't met, or that are
// empty where the server says empty means "unset", are left out.
export function buildConfig(ts, caps = null) {
  const settings = migrateTranslateSettings(ts);
  const values = effectiveParams(settings, caps);
  const specs = paramSpecs(caps);
  const config = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = specs.get(key);
    if (spec?.omit_empty && (value === '' || value == null)) continue;
    if (spec && 'omit_when' in spec && value === spec.omit_when) continue;
    if (spec?.requires && !requiresMet(spec.requires, values)) continue;
    setPath(config, key, value);
  }
  setPath(config, 'translator.enable_post_translation_check', false);   // app policy
  config.study_mode_generation = settings.studyModeGeneration || 'disabled';
  return config;
}

// Choices the server no longer offers (or can't run), so a job can say so instead of failing.
export function unavailableChoices(settings, caps) {
  if (!caps) return [];
  const values = effectiveParams(settings, caps);
  const problems = [];
  for (const stage of caps.stages || []) {
    const chosen = values[stage.implementation_param];
    const impl = stage.implementations.find((i) => i.id === chosen);
    if (chosen != null && (!impl || !impl.available)) problems.push({ stage: stage.id, value: chosen, reason: impl?.unavailable_reason || 'not offered' });
  }
  return problems;
}

// ── Settings view model ───────────────────────────────────────────────────────────────────────
// App-owned localization for known stages/parameters; anything else shows the server's label.
export const STAGE_HEADING_KEYS = { detect: 'tm.detection', ocr: 'tm.ocr', translate: 'tm.translator',
  inpaint: 'tm.inpaint', render: 'tm.appearance' };
export const IMPLEMENTATION_LABEL_KEYS = { detect: 'tm.detector', ocr: 'tm.ocr_model', translate: 'tm.engine',
  inpaint: 'tm.inpainter', render: 'tm.renderer' };
export const STEP_NAME_KEYS = { detect: 'tm.detector', ocr: 'tm.ocr', translate: 'tm.translator',
  inpaint: 'tm.inpainter', render: 'tm.renderer' };
export const PARAM_LABEL_KEYS = {
  'detector.detection_size': 'tm.det_size', 'detector.text_threshold': 'tm.text_thr',
  'detector.box_threshold': 'tm.box_thr', 'detector.unclip_ratio': 'tm.unclip',
  'render.estimate_font_color': 'tm.est_font_color', 'render.estimate_outline_color': 'tm.est_outline_color',
  'translator.target_lang': 'tm.target', 'translator.content_screen_enabled': 'tm.screen_enable',
  'translator.content_screen_translator': 'tm.screen_model',
  'translator.content_screen_fallback_translator': 'tm.screen_fallback',
  'translator.content_screen_prompt': 'tm.screen_prompt', 'inpainter.inpainting_size': 'tm.inpaint_size',
  'inpainter.inpainting_precision': 'tm.precision', mask_dilation_offset: 'tm.mask', kernel_size: 'tm.kernel',
  'render.direction': 'tm.direction', 'render.alignment': 'tm.alignment', 'render.font_size_offset': 'tm.font_offset',
  'render.font_color': 'tm.font_color', 'render.uppercase': 'tm.uppercase', 'render.no_hyphenation': 'tm.no_hyphen',
  'ocr.bubble_ocr': 'tm.bubble_ocr',
};
export const GROUP_HEADING_KEYS = { screening: 'tm.screening' };

export function matchPreset(caps, values) {
  for (const preset of caps?.presets || []) {
    if (Object.entries(preset.values).every(([k, v]) => values[k] === v)) return preset.id;
  }
  return 'custom';
}

// Everything the Settings page draws, from a capabilities document (null: none known).
export function settingsModel(caps, ts) {
  const settings = migrateTranslateSettings(ts);
  if (!caps) return { offline: true, stages: [], presets: [], batching: [], problems: [], values: settings.params };
  const values = effectiveParams(settings, caps);
  const stages = (caps.stages || []).map((stage) => {
    const chosen = values[stage.implementation_param];
    const choices = stage.implementations.map((i) => ({
      value: i.id, label: i.label, short: i.short || null, version: i.version || '',
      available: i.available !== false, reason: i.unavailable_reason || null,
    }));
    const known = choices.some((c) => c.value === chosen);
    if (chosen != null && !known) {
      choices.push({ value: chosen, label: String(chosen), short: null, version: '', available: false, reason: 'not offered', missing: true });
    }
    const params = (stage.params || []).map((p) => {
      const choicesFor = p.type === 'language'
        ? (caps.languages || []).map((l) => ({ value: l.id, label: l.label }))
        : (p.choices || []);
      const value = values[p.key];
      const out = { ...p, value, labelKey: PARAM_LABEL_KEYS[p.key] || null, choices: choicesFor };
      if ((p.type === 'enum' || p.type === 'language') && value != null && !choicesFor.some((c) => c.value === value)) {
        out.choices = [...choicesFor, { value, label: String(value), missing: true }];
      }
      if (p.requires) out.inactive = !requiresMet(p.requires, values);
      return out;
    });
    return {
      id: stage.id, label: stage.label, headingKey: STAGE_HEADING_KEYS[stage.id] || null,
      implParam: stage.implementation_param, implLabelKey: IMPLEMENTATION_LABEL_KEYS[stage.id] || null,
      stepKey: STEP_NAME_KEYS[stage.id] || null, value: chosen, choices, params,
    };
  });
  const translate = stageOf(caps, 'translate');
  const batching = (translate?.implementations || []).filter((i) => i.batching?.user_tunable).map((i) => ({
    translator: i.id, label: i.short || i.label, default: i.batching.default,
    value: parseInt(settings.batchCaps?.[i.id], 10) || i.batching.default,
  }));
  return {
    offline: false, stages, values, batching,
    presets: (caps.presets || []).map((p) => ({ ...p })),
    preset: matchPreset(caps, values),
    problems: unavailableChoices(settings, caps),
  };
}
