// translate-settings.js — what Settings' Translation panel and its advanced window store under
// `translateSettings`, and how they read it back, for 1.3's page (settings.js) and the port to share
// while both run. Pure: no DOM, no network (app/tests/translate-settings.test.mjs).
//
// The stored object is the migrated settings (translate-config.js) with the panel's own fields laid
// over it, and each edit in the advanced window applied to it as a control describes it; its keys keep
// their order, so what is stored is the same text whichever page stored it.

import { migrateTranslateSettings } from './translate-config.js';
import { isLocalServer } from './translate.js';

// Study data's choices (the panel's select); a stored value it doesn't offer shows as none chosen.
export const STUDY_GENERATIONS = ['disabled', 'text_only', 'text_and_image'];
// What the token cost of a remote translator is reckoned at until set (USD per million tokens).
export const DEFAULT_PRICES = { priceIn: 1.5, priceOut: 9 };
// The screening prompt is kept as typed; every other text option is trimmed.
const DEFAULT_SCREEN_PROMPT_KEY = 'translator.content_screen_prompt';
// Said when the server's address is not a web address (English only, as it has always been).
export const SERVER_URL_ERROR = 'Server URL must start with http:// or https://';

// The settings as stored, and what the panel's fields show of them. `migrated`: the stored copy was of
// an older schema, so the migrated one is stored once.
export function readTranslateSettings(stored) {
  const settings = migrateTranslateSettings(stored);
  const generation = settings.studyModeGeneration || 'disabled';
  return {
    settings,
    migrated: !!stored && stored.schema !== settings.schema,
    fields: {
      serverUrl: stored?.serverUrl || '',
      serverToken: settings.serverToken || '',
      studyModeGeneration: STUDY_GENERATIONS.includes(generation) ? generation : '',
      saveSnapshots: !!settings.saveSnapshots,
      keepSnapshotsOnRevert: !!settings.keepSnapshotsOnRevert,
    },
  };
}

// The page's current settings: the stored picks plus the connection and study fields on the panel
// (a blank address stands for the default server).
export function gatherTranslateSettings(settings, fields) {
  const serverUrl = fields.serverUrl.trim().replace(/\/+$/, '');
  return {
    ...settings,
    serverUrl: serverUrl || 'http://127.0.0.1:5003',
    serverToken: fields.serverToken.trim(),
    studyModeGeneration: fields.studyModeGeneration,
    saveSnapshots: fields.saveSnapshots,
    keepSnapshotsOnRevert: fields.keepSnapshotsOnRevert,
  };
}

// Whether the address typed is one the settings can't be saved with.
export function serverUrlInvalid(raw) {
  const serverRaw = raw.trim();
  return !!serverRaw && !/^https?:\/\//i.test(serverRaw);
}

// One edited control read back into the stored picks; a value that can't be read leaves them as they
// are. A control is one of
//   { preset }                       a clearing preset's id (its values fill in several options)
//   { batch, value }                 a translator's pages-per-request cap, as typed
//   { price: 'in' | 'out', value }   a token price, as typed
//   { param, type, value, checked, integer }   a server parameter: type 'checkbox' (checked),
//                                    'select' (value, JSON), 'number' (value, as typed) or 'text'
export function applyControl(settings, caps, control) {
  if (control.preset !== undefined) {
    const preset = (caps?.presets || []).find(p => p.id === control.preset);
    if (preset) return { ...settings, params: Object.assign({ ...settings.params }, preset.values) };
    return settings;
  }
  if (control.batch !== undefined) {
    const n = parseInt(control.value, 10);
    const batchCaps = { ...(settings.batchCaps || {}) };
    if (Number.isFinite(n) && n > 0) batchCaps[control.batch] = n;
    return { ...settings, batchCaps };
  }
  if (control.price !== undefined) {
    const n = parseFloat(control.value);
    if (Number.isFinite(n)) return { ...settings, [control.price === 'in' ? 'priceIn' : 'priceOut']: n };
    return settings;
  }
  const key = control.param;
  if (!key) return settings;
  let value;
  if (control.type === 'checkbox') value = control.checked;
  else if (control.type === 'select') value = JSON.parse(control.value);
  else if (control.type === 'number') {
    const n = control.integer ? parseInt(control.value, 10) : parseFloat(control.value);
    if (!Number.isFinite(n)) return settings;
    value = n;
  } else value = control.value;
  return { ...settings, params: { ...settings.params, [key]: key === DEFAULT_SCREEN_PROMPT_KEY ? value : (typeof value === 'string' ? value.trim() : value) } };
}

// Reset to the server's recommendations, keeping the connection and the panel's fields.
export function resetTranslateSettings(gathered) {
  return { ...gathered, params: {}, batchCaps: {}, ...DEFAULT_PRICES };
}

// The benchmark is for whoever runs the translation server on this machine.
export function benchmarkOffered(online, serverUrl) {
  return online && isLocalServer(serverUrl);
}

// ── What the choices say ──────────────────────────────────────────────────────────────────────
// A choice the server lists but can't run now (a missing one says it isn't offered instead).
export const unavailableChoice = (choice) => choice.available === false && !choice.missing;

export const optionLabel = (choice, unavailable, t) => choice.missing || unavailable
  ? `${choice.label} — ${t(choice.missing ? 'tm.not_offered' : 'tm.unavailable')}` : choice.label;

// A pipeline step's box shows the model's short name.
export const stepLabel = (choice) => choice.short || choice.label.replace(/\s+[(—].*$/, '');

// A pipeline step's tip: the full name and version of the model chosen, then the rest of that stage's
// options, one per line.
export function stepTip(stage, t) {
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

// The clearing presets, then "Custom" (shown while the options match none).
export const presetChoices = (model, t) => [...model.presets.map(p => ({ value: p.id, label: p.label })), { value: 'custom', label: t('tm.preset_custom') }];

// The translator's target language, which the panel shows too, while the server offers one.
export const targetLanguageParam = (model) => model.stages.find(s => s.id === 'translate')?.params.find(p => p.type === 'language') || null;

// Why the advanced window's choices are stale or partly unavailable ('' when they are neither).
export function capsNote(model, capsOffline, t) {
  const notes = [];
  if (capsOffline) notes.push(t('tm.caps_cached'));
  if (model.problems.length) notes.push(t('tm.caps_problem', { names: model.problems.map(p => p.value).join(', ') }));
  return notes.join(' ');
}
