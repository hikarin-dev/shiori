// fs-faults.test.mjs — the faults the storage tests inject into the desktop library's file calls
// (fs-faults.mjs) reach it: a fault fails the calls it matches, synchronous, promised or with a
// callback, as many times as asked, then stops; and a junction planted leads where it was told.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { failNext, reset, junction } from './fs-faults.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-faults-'));
  t.after(() => { reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('a fault fails the calls it matches, the times asked, in every form of the call', async (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'a');
  const heard = [];
  failNext((c) => { heard.push(c); return c.op === 'rename' && c.to.endsWith('/b.txt'); }, 'EBUSY', { times: 3 });
  assert.throws(() => fs.renameSync(file, path.join(dir, 'b.txt')), { code: 'EBUSY' });
  await assert.rejects(fsp.rename(file, path.join(dir, 'b.txt')), { code: 'EBUSY' });
  const viaCallback = await new Promise((resolve) => fs.rename(file, path.join(dir, 'b.txt'), resolve));
  assert.equal(viaCallback?.code, 'EBUSY');
  fs.renameSync(file, path.join(dir, 'b.txt'));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')), 'used up, the call goes through');
  assert.equal(heard[0].path, file.split(path.sep).join('/'));
  const undo = failNext((c) => c.op === 'readFile', 'EACCES');
  undo();
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'a', 'taken back');
});

test('a junction leads to its folder', (t) => {
  const dir = folder(t);
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'x.png'), 'x');
  junction(path.join(dir, 'outside'), path.join(dir, 'lib', 'translated'));
  assert.ok(fs.lstatSync(path.join(dir, 'lib', 'translated')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'translated', 'x.png'), 'utf8'), 'x');
});
