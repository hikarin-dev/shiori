// served-copy.test.mjs — the built site's served modules (app/js) are their sources less their comments
// (build/served-copy.mjs): the same program, statement for statement, every line where it was and its
// code at the same column, the source's date; and the copy is what the build writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { builtSite } from '../../build/built.mjs';
import { withoutComments } from '../../build/served-copy.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const modules = readdirSync(join(repo, 'app', 'js'), { recursive: true }).map((f) => f.replace(/\\/g, '/')).filter((f) => f.endsWith('.js'));

// A program as the parser gives it, without where each piece is.
const shape = (name, code) => JSON.stringify(parseSync(name, code).program, (key, value) => (key === 'start' || key === 'end' || key === 'range' ? undefined : value));

test('every served module is copied as its source less its comments: the same program, its lines where they were', () => {
  let saved = 0;
  for (const f of modules) {
    const source = readFileSync(join(repo, 'app', 'js', f), 'utf8');
    const built = readFileSync(join(builtSite(), 'app', 'js', f), 'utf8');
    assert.equal(built, withoutComments(f, source), `${f}: what the build writes`);
    assert.equal(shape(f, built), shape(f, source), `${f}: the same program`);
    assert.equal(parseSync(f, built).comments.length, 0, `${f}: no comment left`);
    const a = source.split('\n'), b = built.split('\n');
    assert.equal(b.length, a.length, `${f}: as many lines`);
    // Every character of code at the line and column the source has it.
    for (let i = 0; i < b.length; i++) {
      for (let j = 0; j < b[i].length; j++) if (b[i][j] !== ' ' && b[i][j] !== '\t' && b[i][j] !== '\r' && a[i][j] !== b[i][j]) assert.fail(`${f}:${i + 1}:${j + 1}: its code where the source has it`);
    }
    assert.ok(Math.abs(statSync(join(builtSite(), 'app', 'js', f)).mtimeMs - statSync(join(repo, 'app', 'js', f)).mtimeMs) < 1, `${f}: the source's date`);
    saved += source.length - built.length;
  }
  assert.ok(saved > 0);
});
