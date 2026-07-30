// locale-parity.test.mjs — English is the canonical key set (see locales.js); t() silently
// falls back to English for any missing key, so a gap is invisible without this check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES } from '../js/locales.js';

test('every locale defines exactly the English key set', () => {
  const enKeys = Object.keys(LOCALES.en);
  const enSet = new Set(enKeys);
  for (const [code, table] of Object.entries(LOCALES)) {
    if (code === 'en') continue;
    const keys = new Set(Object.keys(table));
    const missing = enKeys.filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !enSet.has(k));
    assert.deepEqual(missing, [], `${code}: missing ${missing.length} keys`);
    assert.deepEqual(extra, [], `${code}: unknown keys not present in en`);
  }
});
