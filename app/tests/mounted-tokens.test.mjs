// mounted-tokens.test.mjs — the colour and radius tokens Settings' optional panel promises whatever is
// mounted there (src/styles/tokens.css, its --shiori-* block): every name of the promise is declared,
// in that one block, each an alias of one of the app's own tokens. A name may be added (to the block
// and to PROMISED below), never renamed or removed: what is mounted is drawn by someone else, released
// on its own schedule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles', 'tokens.css'), 'utf8');

const PROMISED = [
  '--shiori-background', '--shiori-surface', '--shiori-surface-subtle', '--shiori-surface-raised',
  '--shiori-border', '--shiori-border-strong',
  '--shiori-text', '--shiori-text-muted', '--shiori-text-dim',
  '--shiori-brand', '--shiori-danger', '--shiori-success', '--shiori-warning', '--shiori-focus',
  '--shiori-radius-control', '--shiori-radius-section',
];

// Every declaration in the file: [name, value, the block it is in].
const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2].replace(/\/\*[\s\S]*?\*\//g, '') }));
const declared = blocks.flatMap((b, i) => [...b.body.matchAll(/(--[a-z0-9-]+(?:\\\.[0-9]+)?)\s*:\s*([^;]+);/g)].map((m) => ({ name: m[1].replace('\\', ''), value: m[2].trim(), block: i, selector: b.selector })));

test('every promised name is declared, in one :root block of its own, and nothing else there', () => {
  const ours = declared.filter((d) => d.name.startsWith('--shiori-'));
  assert.deepEqual(ours.map((d) => d.name).toSorted(), PROMISED.toSorted(), 'the promise: none removed or renamed (a new name joins PROMISED)');
  const homes = new Set(ours.map((d) => d.block));
  assert.equal(homes.size, 1, 'one block');
  const [home] = homes;
  assert.equal(blocks[home].selector, ':root');
  assert.deepEqual(declared.filter((d) => d.block === home).map((d) => d.name).toSorted(), PROMISED.toSorted(), 'the block holds the promise alone');
});

test('each is an alias of one of the app\'s own tokens', () => {
  const own = new Set(declared.filter((d) => !d.name.startsWith('--shiori-')).map((d) => d.name));
  for (const d of declared.filter((x) => x.name.startsWith('--shiori-'))) {
    const m = d.value.match(/^var\((--[a-z0-9-]+)\)$/);
    assert.ok(m, `${d.name}: ${d.value} is var(--a-token)`);
    assert.ok(own.has(m[1]), `${d.name}: ${m[1]} is a token of the app`);
  }
});
