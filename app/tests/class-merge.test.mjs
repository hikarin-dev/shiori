// class-merge.test.mjs — the new UI's cn() (src/lib/utils.ts) knows the theme's own names, so merging
// class lists keeps a type size beside a colour and settles two radii: its lists are tokens.css's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn, TOKENS } from '../../src/lib/utils.ts';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles', 'tokens.css'), 'utf8');
const names = (prefix) => [...css.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+(?:\\\\\\.[0-9]+)?):(?!\\s*initial)`, 'gm'))].map((m) => m[1].replace('\\', ''));

test('cn() is told every type size, radius, shadow, easing, layer and duration of tokens.css', () => {
  const sort = (list) => [...list].sort();
  assert.deepEqual(sort(TOKENS.text), sort(names('text')));
  assert.deepEqual(sort(TOKENS.radius), sort(names('radius')));
  assert.deepEqual(sort(TOKENS.shadow), sort(names('shadow')));
  assert.deepEqual(sort(TOKENS.ease), sort(names('ease')));
  assert.deepEqual(sort(TOKENS.z), sort(names('z-index')));
  assert.deepEqual(sort(TOKENS.duration), sort(names('transition-duration')));
});

test('cn() keeps a size beside a colour and settles conflicts within one token family', () => {
  assert.equal(cn('text-13 text-primary'), 'text-13 text-primary');
  assert.equal(cn('text-10.5 text-11'), 'text-11');
  assert.equal(cn('rounded-6 rounded-8'), 'rounded-8');
  assert.equal(cn('shadow-dialog shadow-popover'), 'shadow-popover');
  assert.equal(cn('duration-fast duration-base'), 'duration-base');
  assert.equal(cn('z-header z-dialog'), 'z-dialog');
  assert.equal(cn('ease-standard ease-out'), 'ease-out');
});

// cn()'s tables are compiled ahead from its config (build/cn-tables.mjs), so a page does not compile them
// as it starts: the kept file is what the config compiles to, and cn() merges as one made from the config
// at run time does, over every class name the sources hold, alone and in pairs.
test('cn()\'s kept tables are the ones its config compiles to, and merge as the config does', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { cnTables, TABLES } = await import('../../build/cn-tables.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cn-tables-'));
  try {
    assert.equal(await cnTables(join(dir, 'cn-tables.ts')), readFileSync(TABLES, 'utf8'), 'src/lib/cn-tables.ts is out of date: node build/cn-tables.mjs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const { createCn } = await import('cn/config');
  const { default: config } = await import('../../src/lib/cn-config.ts');
  const { extractTokens } = await import('cn/build');
  const fromConfig = createCn(config);
  const tokens = new Set();
  const { readdirSync } = await import('node:fs');
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  for (const f of readdirSync(src, { recursive: true })) if (/\.(tsx?|css)$/.test(f)) extractTokens(readFileSync(join(src, f), 'utf8'), tokens);
  const list = [...tokens];
  const differ = [];
  const check = (s) => { if (cn(s) !== fromConfig(s) && differ.length < 5) differ.push([s, cn(s), fromConfig(s)]); };
  for (const x of list) check(x);
  // Pairs within a family (the same word before the first dash, variants aside).
  const family = new Map();
  for (const x of list) { const k = x.replace(/^.*:/, '').replace(/^-/, '').split('-')[0]; if (!family.has(k)) family.set(k, []); family.get(k).push(x); }
  for (const group of family.values()) { const some = group.slice(0, 60); for (const x of some) for (const y of some) check(`${x} ${y}`); }
  assert.deepEqual(differ, []);
});
