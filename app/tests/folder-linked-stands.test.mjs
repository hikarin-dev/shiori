// folder-linked-stands.test.mjs — S36, found beyond its four items: the website's work on a linked gallery under the
// gallery's lock (its publication, a picture of its own stored) that meets another app's generation of its overlay
// stands by the folder's version (db.js _hold, _stands; folder-library.js folderStands), reading the gallery again from
// there — and where its source changed in place since that generation was written, the re-read writes the overlay's
// source.json again (folder-library.js _writeSource), which takes the gallery's lock (S35): the work then waited for the
// lock it holds itself, for good — its gallery took no write again until the page was loaded again. The re-read made
// under the lock its caller holds writes there as that caller's (`held`). Website alone (the desktop's overlay writer is
// a write into the gallery's own under way: no lock).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webLibrary } from './library-drivers.mjs';
import { zipCreate } from '../js/zip.js';

const skip = !!globalThis.__desktopLibrary && 'the website\'s alone';
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const within = (p, ms) => Promise.race([p.then(() => 'ended', (e) => `failed: ${e?.message || e}`), new Promise((r) => setTimeout(() => r(`still waiting after ${ms} ms`), ms))]);

for (const work of ['its publication', 'a translation of it stored']) {
  test(`website: ${work}, meeting another app's generation of its overlay after its ZIP changed in place, ends — never waiting for its own lock`, { skip }, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-stands-'));
    const L = await webLibrary();
    t.after(async () => { await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
    const A = path.join(base, 'A'), zip = path.join(A, 'Pack.zip');
    fs.mkdirSync(A, { recursive: true });
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
    const a = await L.add(A);
    await L.setDefault(a);
    await L.scan(a);
    const gid = String((await L.galleries())[0]);
    await L.putTranslation(gid, 1, png(3));
    await L.flush();
    // The ZIP changed in place, then another app's generation of the overlay there (written over this app's manifest,
    // as a publication of the other app's lands) — its source.json the one from before the change.
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(4) }]));
    const file = path.join(A, '.shiori', 'linked', gid, 'gallery.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
    const done = work === 'its publication' ? (async () => { await L.setTitle(gid, 'Retitled here'); await L.raw.settleFolders(); })()
      : L.putTranslation(gid, 2, png(5));
    assert.equal(await within(done, 10000), 'ended', `${work}: ended`);
    // The gallery takes a write again, and reads as the folder now has it.
    assert.equal(await within(L.putTranslation(gid, 1, png(6)), 10000), 'ended', 'a later write of it ends');
    assert.ok(same(await L.read(gid, 2), png(4)), 'its page 2 as the ZIP has it now');
  });
}
