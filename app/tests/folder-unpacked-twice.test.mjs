// folder-unpacked-twice.test.mjs — S35: both apps unpacking one archive in the same moment, a limit (plan §8, "Two apps
// unpacking one archive at once"). The desktop, opened again after it stopped in an archived gallery's unpack, takes
// the unpack up at its start; the website, told "Use anyway" in that moment, changes the gallery and unpacks the same
// archive. Its look for an unpack beside the archive (folder-library.js followUnpacked) comes before the desktop's
// folder takes its place, its folder's choosing after (the sweeps met this order in most replays of the kill at call 40
// of "an unpack cut short, met by the other app using the folder anyway": the desktop started again before the other
// app met the folder, until S35 made that scenario meet it first). What the person has then, held here in that order:
// the desktop's unpack at Alpha with its change, the website's at "Alpha (2)" with its own — each app showing its own,
// the desktop's check listing the other as a copy ('duplicate') at every check, nothing lost — until the copy is
// deleted by hand, after which nothing is listed. (The other order, the website's folder chosen first: the desktop's
// folder can't take its place there, and it follows the website's unpack — one gallery, as the sweeps' passing replays.)
// And the narrowest order (S36; S35's trace, its fifth passing replay): the website's choosing looked at Alpha and
// found it free, the desktop's folder took the name, then the website made "its" folder there — File System Access hands
// back the one there — and wrote its unpack into the desktop's. A reservation keeps a folder it made only while that
// lists empty as made, so this order too leaves the two copies, never one folder written by both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';

const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const writer = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'gallery.json'), 'utf8')).writer;

for (const order of ['its folder chosen after the desktop\'s took the name', 'the desktop\'s folder taking the name between its look and its making']) test(`two apps unpacking one archive in the same moment leave a copy beside it, each app's change in its own, listed until deleted (a limit; the website's ${order})`, { skip }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-twice-'));
  const A = path.join(base, 'A');
  const D = await desktopLibrary(path.join(base, 'desktop'));
  let W = null;
  t.after(async () => { faults.reset(); fsa.reset(); await W?.close(); await D.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const a = await D.add(A);
  await D.setDefault(a);
  const gid = await D.newGallery('Alpha');
  for (const n of [1, 2, 3]) await D.putPage(gid, n, png(n));
  await D.putTranslation(gid, 1, png(5));
  await D.flush();
  await D.raw.archiveGallery(gid);
  await D.flush();
  // The desktop's unpack (its change: a translation of page 2) held at its last call before its folder takes its place,
  // and its deletion of the archive once it has; the website's unpack (its change: page 3's) held as it chooses its
  // folder, past its look beside the archive and its read of it — at its look at the name, or (the narrowest order) once
  // it has looked (a name answering "not found" is looked at twice, as the shared rule takes it) as it makes the folder.
  const unpacking = gate(), placed = gate(), choosing = gate(), chosen = gate(), deleting = gate(), webDone = gate();
  const at = order.startsWith('its folder chosen') ? 1 : 3;
  let webArmed = false, looked = false, read = false, calls = 0;
  faults.holdIn((call) => {
    if (/\/A\/Alpha\.[0-9a-f]+\.shiori-tmp\/image_records\.json\.shiori-tmp$/.test(call.path) && call.op === 'rename') { unpacking.open(); return placed.at; }
    if (call.op === 'rm' && call.path.endsWith('/A/Alpha.zip')) { deleting.open(); return webDone.at; }
    return null;
  });
  await D.putTranslation(gid, 2, png(4));
  const flushed = D.flush();   // an archived gallery's change settles at its flush: the unpack
  await unpacking.at;
  W = await webLibrary();   // (handed out again, the website's library takes back every hold: the website's is put after)
  fsa.hold((call) => {
    if (!webArmed) return null;
    if (call.op === 'getDirectoryHandle' && call.path === 'Alpha' && !read) { looked = true; return null; }
    if (call.op === 'getFile' && call.path === 'Alpha.zip' && looked) { read = true; return null; }
    if (call.op === 'getDirectoryHandle' && call.path === 'Alpha' && read && ++calls === at) { webArmed = false; choosing.open(); return chosen.at; }
    return null;
  });
  const w = await W.add(A, { force: true });   // "Use anyway"
  await W.scan(w);
  webArmed = true;
  const translated = W.putTranslation(gid, 3, png(9)).finally(webDone.open);
  await choosing.at;
  placed.open();   // the desktop's folder takes its place
  for (let i = 0; i < 100 && !fs.existsSync(path.join(A, 'Alpha', '.shiori', 'gallery.json')); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  chosen.open();
  await translated;
  await flushed;
  await W.flush();
  assert.equal(path.basename(/** @type {string} */ (await W.dirOf(gid))), 'Alpha (2)', 'the website has its unpack beside the desktop\'s');
  assert.ok(same(await W.read(gid, 3, 'translated'), png(9)), 'with its change');
  await W.setDefault(W.home);
  await W.remove(w);   // it lets the folder go
  await W.close();
  W = null;
  await D.raw.folderClaim(a);   // "Take back"
  const found = await D.scan(a);
  await D.flush();
  const alpha = path.join(A, 'Alpha'), copy = path.join(A, 'Alpha (2)');
  assert.equal(path.resolve(/** @type {string} */ (await D.dirOf(gid))), path.resolve(alpha), 'the desktop has its own unpack');
  assert.ok(same(await D.read(gid, 2, 'translated'), png(4)), 'with its change');
  assert.ok(same(await D.read(gid, 1, 'translated'), png(5)), 'and what the gallery had');
  assert.notEqual(writer(alpha), writer(copy), 'each copy published by its own app');
  assert.equal(fs.existsSync(path.join(A, 'Alpha.zip')), false, 'the archive gone');
  assert.deepEqual(found.problems.filter(p => p.reason === 'duplicate').map(p => p.path), ['Alpha (2)'], 'the website\'s copy reported as a copy');
  for (const stage of ['another check', 'a start']) {
    if (stage === 'a start') await /** @type {() => Promise<void>} */ (D.restart)();
    await D.scan(a);
    assert.deepEqual((await D.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), ['duplicate Alpha (2)'], `${stage}: still listed`);
  }
  fs.rmSync(copy, { recursive: true, force: true });   // the person deletes the copy
  await D.scan(a);
  assert.deepEqual((await D.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), [], 'the copy deleted: nothing listed');
  assert.ok(same(await D.read(gid, 2, 'translated'), png(4)), 'the gallery as it was');
});
