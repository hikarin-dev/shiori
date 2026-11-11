// search-translated.test.mjs — a search predicate sees each gallery's translation state as a plain
// yes/no, with a partly translated gallery counting as translated; and its favorite as the person's
// mark says (storage/personal.js), never its metadata.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { galleries, personal } = await import('../js/api.js');
const store = await import('../js/store.js');

const metas = new Map([
  ['1', { translated: true }],
  ['2', { translated: 'partial' }],
  ['3', { translated: false }],
  ['4', { favorite: true }],   // an earlier version's field: not what search reads
]);
personal.all = async () => new Map([['2', { favorite: true }]]);
galleries.idsSorted = async () => [...metas.keys()];
galleries.searchIndex = async () => metas;
galleries.byIds = async (ids) => ids.map(id => ({ id }));

test('partly translated galleries match as translated; the rest as untranslated', async () => {
  const seen = new Map();
  await store.getPage({ match: (g) => { seen.set(g.id, g.translated); return true; } });
  assert.deepEqual(Object.fromEntries(seen), { 1: true, 2: true, 3: false, 4: false });
});

test('a gallery is a favorite as the person\x27s marks say, not as its metadata does', async () => {
  const seen = new Map();
  await store.getPage({ match: (g) => { seen.set(g.id, g.favorite); return true; } });
  assert.deepEqual(Object.fromEntries(seen), { 1: false, 2: true, 3: false, 4: false });
});
