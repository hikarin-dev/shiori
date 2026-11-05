// fs-faults.test.mjs — the faults the storage tests inject into the desktop library's file calls
// (fs-faults.mjs) reach the folder store adapter's calls: a fault fails the calls it matches,
// synchronous or promised, as many times as asked, then stops, and never a call made around the
// adapter; and a junction planted leads where it was told.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failNext, reset, junction } from './fs-faults.mjs';
import { disk } from '../server/folder-store.js';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-faults-'));
  t.after(() => { reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('a fault fails the adapter\'s calls it matches, the times asked, synchronous or promised', async (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'a');
  const heard = [];
  failNext((c) => { heard.push(c); return c.op === 'rename' && c.to.endsWith('/b.txt'); }, 'EBUSY', { times: 2 });
  assert.throws(() => disk.renameSync(file, path.join(dir, 'b.txt')), { code: 'EBUSY' });
  fs.renameSync(file, path.join(dir, 'c.txt'));
  fs.renameSync(path.join(dir, 'c.txt'), file);
  assert.ok(fs.existsSync(file), 'a call around the adapter is never failed');
  await assert.rejects(disk.rename(file, path.join(dir, 'b.txt')), { code: 'EBUSY' });
  disk.renameSync(file, path.join(dir, 'b.txt'));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')), 'used up, the call goes through');
  assert.equal(heard[0].path, file.split(path.sep).join('/'));
  const undo = failNext((c) => c.op === 'readFile', 'EACCES');
  undo();
  assert.equal(disk.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'a', 'taken back');
});

test('a junction leads to its folder', (t) => {
  const dir = folder(t);
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'x.png'), 'x');
  junction(path.join(dir, 'outside'), path.join(dir, 'lib', 'translated'));
  assert.ok(fs.lstatSync(path.join(dir, 'lib', 'translated')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'translated', 'x.png'), 'utf8'), 'x');
});
