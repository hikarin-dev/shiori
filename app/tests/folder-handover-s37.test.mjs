// folder-handover-s37.test.mjs — S37 (review 12's side note): a hand-over's read writes nothing in the folder. A linked
// gallery with a change waiting here (made while the drive was away), the other app's publication of its overlay
// made since (it used the folder anyway), and its ZIP changed in place: at the take-back the hand-over's read meets that
// publication with the change waiting, holds the gallery's place (db.js _hold), and the folder's version stands — the
// gallery read again from there (folder-library.js folderStands), which on the website wrote the overlay's
// source.json during the read (its own `run`, made without `handover`), against "a hand-over's read writes nothing"
// (folder-library.js _overlayFor). The check after the read writes it. Both apps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import { zipCreate } from '../js/zip.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { netWatched } from './lock-net.mjs';

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const zipOf = (n) => zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(n) }]);
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => 'ended', (e) => `failed: ${e?.message || e}`), new Promise((r) => setTimeout(() => r(`still waiting after ${ms} ms`), ms))]);
const READS =new Set(['readFile', 'stat', 'readdir', 'access', 'openAsBlob', 'exists', 'lstat', 'realpath', 'opendir']);
// Folder `id`'s hand-over mark as library `lib` has it now.
async function markOf(lib, id) {
  if (lib.app === 'desktop') return lib.raw.folders.handover(id);
  const idb = await lib.raw.openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('folders', 'readonly');
    const q = tx.objectStore('folders').get(id);
    tx.oncomplete = () => resolve(q.result?.handover ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

for (const app of ['website', 'desktop']) {
  test(`S37: ${app}: a hand-over's read meeting the other app's publication of a linked gallery with a change waiting, its ZIP changed in place, writes nothing in the folder — the check after it does`, { skip, todo: app === 'website' ? 'S37' : undefined }, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s37h-'));
    const from = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
    const to = app === 'desktop' ? await webLibrary() : await desktopLibrary(path.join(base, 'desktop'));
    t.after(async () => { faults.reset(); fsa.reset(); await from.close(); await to.close(); fs.rmSync(base, { recursive: true, force: true }); });
    netWatched(t, assert);
    const F = path.join(base, 'F'), zip = path.join(F, 'Pack.zip');
    fs.mkdirSync(F, { recursive: true });
    fs.writeFileSync(zip, zipOf(2));
    const id = await from.add(F);
    await from.setDefault(id);
    await from.scan(id);
    const x = String((await from.galleries())[0]);
    await from.putTranslation(x, 1, png(3));
    await from.flush();
    // A change made here while the drive was away: it waits.
    fs.renameSync(F, `${F}.away`);
    try { await from.setTitle(x, 'Pack here'); await from.flush(); } finally { fs.renameSync(`${F}.away`, F); }
    // The other app uses the folder anyway, retitles the gallery there, and lets the folder go.
    const theirs = await to.add(F, { force: true });
    await to.scan(theirs);
    await to.setTitle(x, 'Pack there');
    await to.flush();
    await to.setDefault(to.home);
    await to.remove(theirs);
    fs.writeFileSync(zip, zipOf(4));   // the ZIP changed in place
    // Every write of the overlay's source.json, and whether the folder's hand-over mark was still there (its read under way).
    const source = `.shiori/linked/${x}/source.json`;
    const writes = [];
    const seen = (rel) => markOf(from, id).then((mark) => { writes.push({ rel, during: !!mark }); });
    if (app === 'website') fsa.hold((call) => (call.op === 'createWritable' && call.path === source ? seen(call.path) : null));
    else faults.holdIn((call) => (!READS.has(call.op) && path.relative(F, call.path).split(path.sep).join('/').startsWith(source) ? seen(call.path) : null));
    assert.equal(await from.raw.folderClaim(id), 'granted', 'taken back');
    assert.equal(await within(from.flush(), 20000), 'ended', 'the hand-over\'s read (its window passed), then its check');
    assert.equal(await within(from.scan(id), 20000), 'ended', 'the next check');
    assert.equal(await within(from.flush(), 20000), 'ended', 'what waits settled');
    assert.deepEqual(writes.filter(w => w.during), [], 'nothing written during the hand-over\'s read');
    assert.equal(await from.titleOf(x), 'Pack there', 'the folder\'s version stands');
    assert.ok(same(await from.read(x, 2), png(4)), 'the ZIP read as it is now');
    // (The website's check after the read writes the source.json anew; the desktop's re-read writes it only where it
    // reads differently — here it doesn't: the overlay's text stands as the other app wrote it.)
    if (app === 'website') assert.ok(writes.length >= 1, 'the overlay\'s source.json written by the check after it');
  });
}
