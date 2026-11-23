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
