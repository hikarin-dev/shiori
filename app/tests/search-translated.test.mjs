// search-translated.test.mjs — a search predicate sees each gallery's translation state as a plain
// yes/no, with a partly translated gallery counting as translated.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { galleries } = await import('../js/api.js');
const store = await import('../js/store.js');

const metas = new Map([
  ['1', { translated: true }],
  ['2', { translated: 'partial' }],
  ['3', { translated: false }],
  ['4', {}],
]);
galleries.idsSorted = async () => [...metas.keys()];
galleries.metaMap = async () => metas;
galleries.byIds = async (ids) => ids.map(id => ({ id }));

test('partly translated galleries match as translated; the rest as untranslated', async () => {
  const seen = new Map();
  await store.getPage({ match: (g) => { seen.set(g.id, g.translated); return true; } });
  assert.deepEqual(Object.fromEntries(seen), { 1: true, 2: true, 3: false, 4: false });
});
