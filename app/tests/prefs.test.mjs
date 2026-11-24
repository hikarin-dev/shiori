// prefs.test.mjs — Settings' preferences as its controls read and write them (src/lib/prefs.ts over
// platform.kv, with the table of app/js/settings-prefs.js): every key's stored values and what its
// control shows of each, exactly 1.3's (stored inverted, as words, normalised, an older key read); a
// control's change stored as 1.3 stored it; nothing shown before the keys are read; a change made in
// another tab followed for every key, and only while started; a read never landing over a later write.
import test from 'node:test';
import assert from 'node:assert/strict';

// platform.js opens its channels at load: silent ones, which keep nothing running.
globalThis.BroadcastChannel = class { constructor(name) { this.name = name; this.onmessage = null; } postMessage() {} close() {} };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const platform = await import('../js/platform.js');
const { SETTINGS_PREFS } = await import('../js/settings-prefs.js');
const { createPrefs } = await import('../../src/lib/prefs.ts');

const flush = () => new Promise((r) => setTimeout(r, 0));

// platform.kv as a page has it (localStorage, JSON, the 'shiori:' prefix), and another tab's changes
// told by hand.
function world() {
  storage.clear();
  const watchers = new Set();
  const kv = {
    get: (keys) => platform.kv.get(keys),
    set: (values) => platform.kv.set(values),
    watch: (changed) => { watchers.add(changed); return () => watchers.delete(changed); },
  };
  return {
    kv,
    watchers,
    // Another tab writes the raw string `raw` under `key` (null: removes it), and this tab is told.
    other(key, raw) {
      if (raw === null) storage.delete(`shiori:${key}`); else storage.set(`shiori:${key}`, raw);
      for (const w of [...watchers]) w(key);
    },
  };
}

// Every key: what its control shows with nothing stored, then for each raw string stored (as 1.3's
// page wrote it, or as anything else wrote it) what it shows; and what a change of the control stores.
const CASES = {
  libShowNavStats: { none: true, shows: [['false', false], ['true', true], ['"x"', true]], stores: [[false, 'false'], [true, 'true']] },
  libMergeSeries: { none: true, shows: [['false', false], ['true', true]], stores: [[false, 'false'], [true, 'true']] },
  libQuickActionsMode: { none: 'hover', shows: [['"always"', 'always'], ['"hidden"', 'hidden'], ['"hover"', 'hover'], ['"sideways"', 'hover']],
    stores: [['always', '"always"'], ['hidden', '"hidden"'], ['bogus', '"hover"']] },
  libHideAppLangFlag: { none: true, shows: [['false', false], ['true', true]], stores: [[false, 'false'], [true, 'true']] },
  libShowCategoryTag: { none: true, shows: [['false', false], ['true', true]], stores: [[false, 'false'], [true, 'true']] },
  libExportFormat: { none: 'ask', shows: [['"zip"', 'zip'], ['"cbz"', 'cbz'], ['"ask"', 'ask'], ['"rar"', 'ask']],
    stores: [['zip', '"zip"'], ['cbz', '"cbz"'], ['ask', '"ask"'], ['rar', '"ask"']] },
  libExportTranslations: { none: true, shows: [['false', false], ['true', true]], stores: [[false, 'false'], [true, 'true']] },
  customScrollbar: { none: false, shows: [['true', true], ['false', false], ['"true"', false]], stores: [[true, 'true'], [false, 'false']] },
  readerSkipOverview: { none: true, shows: [['true', false], ['false', true]], stores: [[false, 'true'], [true, 'false']] },
  readerStripMode: { none: true, shows: [['"chapter"', false], ['"series"', true]], stores: [[false, '"chapter"'], [true, '"series"']] },
  readerChapterDivider: { none: true, shows: [['false', false], ['true', true]], stores: [[false, 'false'], [true, 'true']] },
  readerTranslateDisplay: { none: 'image', shows: [['"text"', 'text'], ['"image"', 'image'], ['"other"', 'image']], stores: [['text', '"text"'], ['image', '"image"']] },
  readerStudyOriginal: { none: 'image', shows: [['"text"', 'text'], ['"image"', 'image']], stores: [['text', '"text"'], ['image', '"image"']] },
  readerStudySrcFont: { none: 'yasashisa', shows: [['"kiwi"', 'kiwi'], ['"yasashisa"', 'yasashisa'], ['"other"', 'yasashisa']], stores: [['kiwi', '"kiwi"'], ['yasashisa', '"yasashisa"']] },
  readerFurigana: { none: false, shows: [['"on"', true], ['"off"', false], ['true', false]], stores: [[true, '"on"'], [false, '"off"']] },
  readerStudyDisplay: { none: 'hardcoded_images', shows: [['"text"', 'text'], ['"hardcoded_images"', 'hardcoded_images']],
    stores: [['text', '"text"'], ['hardcoded_images', '"hardcoded_images"']] },
};

test('the cases name every preference of the table', () => {
  assert.deepEqual(Object.keys(CASES).toSorted(), Object.keys(SETTINGS_PREFS).toSorted());
});

test('nothing is shown until the keys are read; then each control shows its default', async () => {
  const w = world();
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  assert.equal(prefs.loaded, false);
  assert.equal(prefs.get('libMergeSeries'), undefined);
  await prefs.load();
  assert.equal(prefs.loaded, true);
  for (const [key, { none }] of Object.entries(CASES)) assert.equal(prefs.get(key), none, key);
});

test('what each control shows of each stored value, as 1.3\'s page showed it', async () => {
  for (const [key, { shows }] of Object.entries(CASES)) {
    for (const [raw, shown] of shows) {
      const w = world();
      storage.set(`shiori:${key}`, raw);
      const prefs = createPrefs(w.kv, SETTINGS_PREFS);
      await prefs.load();
      assert.equal(prefs.get(key), shown, `${key} stored as ${raw}`);
    }
  }
});

test('the export\'s translations read their older key when theirs is not set', async () => {
  const w = world();
  storage.set('shiori:libExportCbzTranslations', 'false');
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  assert.equal(prefs.get('libExportTranslations'), false);
  storage.set('shiori:libExportTranslations', 'true');
  await prefs.load();
  assert.equal(prefs.get('libExportTranslations'), true, 'its own key first');
});

test('a change of a control stores what 1.3\'s page stored, and shows it at once', async () => {
  for (const [key, { stores }] of Object.entries(CASES)) {
    for (const [value, raw] of stores) {
      const w = world();
      const prefs = createPrefs(w.kv, SETTINGS_PREFS);
      await prefs.load();
      let told = 0;
      prefs.subscribe(() => told++);
      prefs.set(key, value);
      assert.equal(storage.get(`shiori:${key}`), raw, `${key} ← ${JSON.stringify(value)}`);
      assert.equal(prefs.get(key), SETTINGS_PREFS[key].read(JSON.parse(raw), {}), `${key} shows what it stored`);
      assert.ok(told <= 1);
    }
  }
});

test('a change that shows nothing new tells no one; one that does tells once', async () => {
  const w = world();
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  let told = 0;
  prefs.subscribe(() => told++);
  prefs.set('libMergeSeries', true);
  assert.equal(told, 0, 'already shown');
  prefs.set('libMergeSeries', false);
  assert.equal(told, 1);
  assert.equal(storage.get('shiori:libMergeSeries'), 'false');
  prefs.set('libQuickActionsMode', 'nonsense');   // stored as the default, which shows already
  assert.equal(told, 1);
  assert.equal(storage.get('shiori:libQuickActionsMode'), '"hover"');
});

test('while started, a change another tab makes to any key is shown; a key of no control is not read for', async () => {
  const w = world();
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  let told = 0;
  prefs.subscribe(() => told++);
  prefs.start();
  await flush();
  assert.equal(told, 0, 'starting reads again, and nothing changed');
  for (const [key, { shows }] of Object.entries(CASES)) {
    const [raw, shown] = shows[0];
    w.other(key, raw);
    await flush();
    assert.equal(prefs.get(key), shown, `${key}: another tab stored ${raw}`);
  }
  const before = told;
  w.other('readerView', '"study"');
  await flush();
  assert.equal(told, before, 'a key no control shows');
  // The older key of the export's translations, in another tab.
  w.other('libExportTranslations', null);
  w.other('libExportCbzTranslations', 'false');
  await flush();
  assert.equal(prefs.get('libExportTranslations'), false);
});

test('storage cleared in another tab: every control shows its default again', async () => {
  const w = world();
  storage.set('shiori:libMergeSeries', 'false');
  storage.set('shiori:readerSkipOverview', 'true');
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  prefs.start();
  storage.clear();
  for (const watcher of [...w.watchers]) watcher(null);
  await flush();
  assert.equal(prefs.get('libMergeSeries'), true);
  assert.equal(prefs.get('readerSkipOverview'), true);
  prefs.stop();
});

test('stopped, nothing is listened to; started twice, one listener; start() reads what changed meanwhile', async () => {
  const w = world();
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  prefs.start();
  prefs.start();
  assert.equal(w.watchers.size, 1);
  prefs.stop();
  assert.equal(w.watchers.size, 0);
  prefs.stop();
  // Changed while nobody listened.
  storage.set('shiori:readerChapterDivider', 'false');
  assert.equal(prefs.get('readerChapterDivider'), true);
  prefs.start();
  await flush();
  assert.equal(prefs.get('readerChapterDivider'), false);
  prefs.stop();
  assert.equal(w.watchers.size, 0);
});

test('a read that started before a write does not land over it', async () => {
  const w = world();
  const prefs = createPrefs(w.kv, SETTINGS_PREFS);
  await prefs.load();
  const reading = prefs.load();   // reads libMergeSeries unset (shown on)
  prefs.set('libMergeSeries', false);
  await reading;
  assert.equal(prefs.get('libMergeSeries'), false);
  assert.equal(storage.get('shiori:libMergeSeries'), 'false');
});

test('a key no preference has is refused', async () => {
  const prefs = createPrefs(world().kv, SETTINGS_PREFS);
  await prefs.load();
  assert.throws(() => prefs.get('nope'));
  assert.throws(() => prefs.set('nope', 1));
});
