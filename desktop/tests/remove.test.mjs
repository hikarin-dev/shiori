// remove.test.mjs — the desktop app's outright delete (server/remove.js): a gallery's folder, with
// everything in it, and an archive are gone afterwards; one already gone is no error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeOutright } from '../server/remove.js';

test('a folder with everything in it, and an archive, are deleted outright', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-remove-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'A Gallery');
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'metadata.json'), '{}');
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(folder, 'images', `000${n}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, n]));
  const archive = path.join(dir, 'Another.zip');
  fs.writeFileSync(archive, 'PK');

  await removeOutright(folder);
  await removeOutright(archive);
  assert.deepEqual(fs.readdirSync(dir), []);
  await removeOutright(path.join(dir, 'never there'));
});
