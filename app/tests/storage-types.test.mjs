// storage-types.test.mjs — the storage module's JSDoc types hold (plan D9): tsc checks every module
// of app/js/storage/, and the two dependency-free rules it imports, as JavaScript in strict mode,
// emitting nothing. A type error fails the suite with tsc's own report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const storage = join(repo, 'app', 'js', 'storage');
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
const OPTIONS = ['--allowJs', '--checkJs', '--noEmit', '--strict', '--target', 'es2023', '--module', 'esnext',
  '--moduleResolution', 'bundler', '--lib', 'es2023,dom'];

test('the storage module type-checks', () => {
  const files = readdirSync(storage, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => join(storage, f));
  assert.ok(files.length >= 6, `found ${files.join(', ')}`);
  const run = spawnSync(process.execPath, [tsc, ...OPTIONS, ...files], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, `tsc found type errors:\n${run.stdout}${run.stderr}`);
});
