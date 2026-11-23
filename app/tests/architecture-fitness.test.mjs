// architecture-fitness.test.mjs — boundaries that are easy to breach silently and expensive to
// re-establish: schema knowledge confined to the data layer, the storage module standing on its
// own, a library folder's files reached only through its folder store adapter, no source-site or
// helper naming in the public app, and no third-party acquisition URLs in app code. (The desktop's
// own adapter rule: desktop/tests/architecture-fitness.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeWritersOff, functionsOf, code as asCode } from './stale-view-operations.mjs';
import { livesOff } from './gallery-lives.mjs';
import { ORDER, WITHIN, ASKED_THERE } from './lock-net.mjs';
import { builtSite } from '../../build/built.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appJs = join(repo, 'app', 'js');
// Every module of the app, as its path in app/js ('db.js', 'storage/folder-owner.js').
const modules = readdirSync(appJs, { recursive: true }).map((f) => f.replace(/\\/g, '/')).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(appJs, f), 'utf8');
// The UI drawn by the one page: its sources (src/**), and the bundle built from them with the
// libraries it uses (dist/assets/* — asking for it throws, saying so, when there is no build or a
// source changed since). Each as [name, text]. What holds for the app's modules holds there too.
const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
  .map((f) => join(f.parentPath, f.name));
const named = (files) => files.map((f) => [f.slice(repo.length + 1).replace(/\\/g, '/'), readFileSync(f, 'utf8')]);
const uiSources = () => named(filesIn(join(repo, 'src')));
const uiBundle = () => named(filesIn(join(builtSite(), 'assets')));

// Strip comments so prose about a rule never trips the rule itself.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// The modules a module's code imports (static, re-exported or dynamic), as written.
const importsOf = (src) => [...code(src).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);

test('only the data layer opens IndexedDB transactions', () => {
  // db.js owns the library schema; platform.js owns the separate durable job database.
  const allowed = new Set(['db.js', 'platform.js']);
  const offenders = modules.filter((f) => !allowed.has(f) && /\.transaction\s*\(/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'raw transactions must live in db.js / platform.js');
});

test('the app reaches its library only through the library interface', () => {
  // api.js is the interface and picks the backend; migrations.js runs the browser library's own
  // one-time repairs of what it stores. Everything else goes through api.js, so either backend
  // (db.js, or desktop-backend.js for the desktop app's library) can stand behind it.
  const allowed = new Set(['db.js', 'api.js', 'migrations.js']);
  const imports = /from\s*['"]\.\/db\.js['"]|import\(\s*['"]\.\/db\.js['"]\s*\)/;
  const offenders = modules.filter((f) => !allowed.has(f) && imports.test(code(read(f))));
  assert.deepEqual(offenders, [], 'import api.js, not db.js');
  const desktop = /from\s*['"]\.\/desktop-backend\.js['"]|import\(\s*['"]\.\/desktop-backend\.js['"]\s*\)/;
  assert.deepEqual(modules.filter((f) => f !== 'api.js' && desktop.test(code(read(f)))), [], 'import api.js, not desktop-backend.js');
});

test('object stores are only reached through the data layer', () => {
  // folder-library.js is db.js's folder layer: it reaches the stores only in the transactions db.js
  // opens for it (its kernel), never opening one itself (the test above).
  const allowed = new Set(['db.js', 'folder-library.js', 'platform.js']);
  const offenders = modules.filter((f) => !allowed.has(f) && /objectStore\s*\(/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'object-store access belongs to the data layer');
});

test('the storage module imports nothing app-specific', () => {
  // app/js/storage/ is the library folders' format, rules and folder store contract, shared by both
  // apps and extractable as a package: it imports its own modules, and of the app's only these
  // dependency-free rules (the gallery id gate, the title choice) — no UI, strings, translation,
  // platform or extension code, no packages and no node: modules (the adapters do the I/O).
  const shared = new Set(['../sanitize.js', '../titles.js']);
  const storage = modules.filter((f) => f.startsWith('storage/'));
  assert.ok(storage.length >= 6, `found ${storage.join(', ')}`);
  const offenders = storage.flatMap((f) => importsOf(read(f))
    .filter((spec) => !(spec.startsWith('./') && !spec.includes('/../')) && !shared.has(spec))
    .map((spec) => `${f} imports ${spec}`));
  assert.deepEqual(offenders, [], 'storage/ imports only storage/ and the listed dependency-free rules');
  for (const spec of shared) assert.deepEqual(importsOf(read(spec.slice(3))), [], `${spec.slice(3)} must stay dependency-free`);
});

test('only the folder store adapter touches the files of a library folder', () => {
  // Every byte the browser library reads or writes in a folder the person picked goes through
  // storage/folder-store-web.js (plan §3.1): no other module calls a file or folder handle's methods.
  // These reach the browser's own storage (OPFS: an import's staging copy) and nothing else; picking a
  // folder (showDirectoryPicker) hands its handle to the library, touching nothing in it.
  const adapter = 'storage/folder-store-web.js';
  const opfs = new Set(['jobs-runner.js', 'migrations.js', 'settings.js']);
  const handleCall = /\.(?:getDirectoryHandle|getFileHandle|removeEntry|createWritable|createSyncAccessHandle|queryPermission|requestPermission|isSameEntry|getFile)\s*\(|for\s+await\s*\([^)]*\bof\b[^)]*\.(?:entries|keys|values)\(\)/;
  const offenders = modules.filter((f) => f !== adapter && !opfs.has(f) && handleCall.test(code(read(f))));
  assert.deepEqual(offenders, [], 'go through storage/folder-store-web.js');
  for (const f of opfs) assert.match(code(read(f)), /navigator\.storage\.getDirectory\(\)/, `${f} reaches OPFS`);
  assert.ok(handleCall.test(code(read(adapter))), 'the adapter is where they are');
});

test('no code outside the folder store adapter turns a failed read of a library folder into "nothing there"', () => {
  // Review 6: where a folder is read to tell what the library records, an answer of "not found" is
  // 'missing' only as the shared rule takes it (storage/folder-store-web.js _notFound, and the reads made
  // under it: readText, readFile, list, picturesIn, galleryIn, manifestIn, loadGallery), and any other
  // failure is a failure (S22). So outside the adapter no code tells "not found" by an error's name, and no
  // read through it turns its failure into a value meaning "none" (null, [], false, a look answering
  // false) — but these, each for its reason. A read is one through the adapter, or through the archive
  // readers over it: a failure of those, caught into "none", is the same "not there" (review 7). The
  // desktop's rule: desktop/tests/architecture-fitness.test.mjs. A line matched is the whole line, comments
  // stripped; an entry no line matches any more is stale.
  const adapter = 'storage/folder-store-web.js';
  const READ = /\b(?:folderFiles\.\w+|K\.archiveOf|_archiveOf|_archiveNames|_readEntry|_classifyZip|_zipTitlesOf)\s*\(/;
  const NONE = /\.catch\(\s*\(\)\s*=>\s*(?:null|undefined|false|true|''|\[[^\]]*\]|new Map\(\)|\(\{\}\))\s*\)|,\s*\(\)\s*=>\s*(?:false|true)\s*\)/;
  const NAME = /'NotFoundError'/;
  /** @type {[string, string, string][]} module, a part of the line, why */
  const allowed = [
    ['db.js', 'const file = await folderFiles.readFile(folder, root, dir).catch(() => undefined);\n  if (file === undefined) return null;',
      'undefined: can\'t be told now (S21), tried again'],
    ['db.js', 'const file = await folderFiles.readFile(folder, root, dir).catch(() => undefined);\n  if (file === undefined) return false;',
      'undefined: can\'t be told now, the deletion tried again'],
    ['db.js', 'const OUT_OF_REACH = [\'NotFoundError\'', 'a write that fails while the folder is out of reach: the picture kept in this browser (a write)'],
    ['db.js', 'const done = await folderFiles.deleteGalleryIn(m.folder, m.root, m.path, m.gid, named).catch(() => false);',
      'a reservation undone: false is "not done", recorded for deletion (_owe: review 6 F9 b), never "nothing there"'],
    ['db.js', 'await folderFiles.readFile(ref.folder, root, _joinPath(ref.dir, ref.$path), ref.type || undefined).catch(() => null);',
      'a page read to show (the line before reads one in an archive): null shows nothing, and changes nothing recorded'],
    ['db.js', 'const names = await _archiveNames(folder, root, dir).catch(() => null);\n  if (!names) return null;',
      'whose an archive is, can\'t be told now (null) when its descriptions can\'t be read: nothing is deleted for the gallery (S21)'],
    ['db.js', 'const names = await _archiveNames(ref.folder, root, ref.dir).catch(() => null);',
      'an archive whose descriptions can\'t be read now serves nothing as the gallery\'s (fail closed), and changes nothing recorded'],
    ['folder-library.js', 'const there = !root || !rec.stat?.dir || (await folderFiles.list(folder, root, rec.stat.dir).catch(() => [])).length > 0;',
      'galleries an unreleased build set aside (§8, review 4 O5)'],
    ['folder-library.js', 'if (stat.packed) return folderFiles.readFile(stat.folder, root, stat.dir).then(Boolean, () => true);',
      'a look that fails is taken for "there": nothing is concluded from it'],
    ['folder-library.js', 'fingerprint: (await K.archiveOf(id, root, dir).catch(() => null))?.fingerprint ?? null',
      'a removal note\'s fingerprint, unknown (null) when the archive can\'t be read now: the note then holds whatever the archive holds, as the desktop\'s (linked.js titlesIn)'],
    ['folder-library.js', 'if (source.kind === \'zip\') return (await K.archiveOf(id, root, source.path).catch(() => null))?.fingerprint ?? null;',
      'a removal note\'s fingerprint (fingerprintNow), unknown (null) when the archive can\'t be read now: the note then holds whatever the archive holds, and db.js _publishRemoved keeps one recorded before'],
    ['folder-library.js', 'const file = await folderFiles.readFile(folder, root, source.path).catch(() => null);',
      'a drawing weighed against the PDF as it is: one that can\'t be read now is not the version drawn, and nothing is written'],
  ];
  const used = new Set();
  const offenders = [];
  for (const f of modules.filter((f) => f !== adapter)) {
    const lines = code(read(f)).split('\n');
    for (const [i, line] of lines.entries()) {
      if (!((READ.test(line) && NONE.test(line)) || NAME.test(line))) continue;
      const near = `${line}\n${lines[i + 1] ?? ''}`;   // an entry may name the line after too
      const at = allowed.findIndex(([file, part]) => file === f && near.includes(part));
      if (at < 0) offenders.push(`${f}: ${line.trim()}`); else used.add(at);
    }
  }
  assert.deepEqual(offenders, [], `read through ${adapter} (or say why here)`);
  assert.deepEqual(allowed.filter((_, i) => !used.has(i)).map(([f, part]) => `${f}: ${part}`), [], 'stale entries');
});

// The top-level function (or `const name =`) each line of `src`'s code is in: [line, its function's name].
function linesByFunction(src) {
  let at = null;
  return code(src).split('\n').map((line) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:export\s+)?const\s+([\w$]+)\s*=/.exec(line);
    if (m) at = m[1] ?? m[2];
    return [line, at];
  });
}

test('S31: whose version a gallery\'s place holds is weighed in one place — the adapter\'s placeIn, reached through the library\'s gateway alone', () => {
  // Review 8: S29a's rule (the folder's version stands) sat in the callers that publish and settle, keyed on a stamp
  // that could be missing or name two publications, and an unpack and a move out never asked. The rule is one
  // function of the shared core (storage/gallery-manifest.js whoseVersion), weighed in one place of the adapter
  // (storage/folder-store-web.js placeIn: a gallery's place held, as it is now), which the library reaches through
  // one gateway (db.js _hold) every operation writing into, moving, unpacking or deleting at a gallery's place
  // passes first (folder-stale-view.test.mjs runs each). So whoseVersion is called in placeIn alone, placeIn by the
  // adapter's own contract (_root: Root.gallery with a view, reserve) and _hold alone, and none of the per-path
  // checks of before is left. A check's catch-up compares a place's token with the stamp for equality alone (rule 1:
  // equal tokens are the same publication, anything else is read again) — it weighs nothing of whose it is, and with
  // something waiting it holds the place (_hold). The desktop's rule: desktop/tests/architecture-fitness.test.mjs.
  const calls = (re) => modules.flatMap((f) => linesByFunction(read(f)).filter(([line]) => re.test(line)).map(([, fn]) => `${f} ${fn}`));
  assert.deepEqual([...new Set(calls(/\bwhoseVersion\s*\(/))], ['storage/folder-store-web.js placeIn'], 'the rule weighed in the adapter\'s placeIn alone');
  assert.deepEqual([...new Set(calls(/(?<!function\s+)\bplaceIn\s*\(/))].sort(), ['db.js _hold', 'storage/folder-store-web.js _root'], 'a place held through the library\'s gateway, and the adapter\'s contract, alone');
  assert.deepEqual(calls(/\b(?:othersSince|_othersThere|_othersIn|_dropOrOver|dropWaiting)\b|\b_others\s*\(/), [], 'no per-path check of another app\'s generation left');
  assert.deepEqual(calls(/\bwriterOf\s*\(/).filter(c => !c.startsWith('storage/gallery-manifest.js')), [], 'whose a token is told by the rule alone');
});

test('S31: every function writing into, moving, unpacking or deleting at a gallery\'s place holds it first, and is an operation of the stale-view table — or a step of one, or touches no version another app may have published, and why', () => {
  // stale-view-operations.mjs lists each (PLACE_WRITERS) and the table's operations' code (OPERATIONS);
  // folder-stale-view.test.mjs runs each operation on both apps from every form of older view. The desktop's
  // own: desktop/tests/architecture-fitness.test.mjs.
  assert.deepEqual(placeWritersOff('website'), [], 'name each in stale-view-operations.mjs');
  // A function made up to write at a place, and one that stops holding first, each fail it.
  const madeUp = (f) => read(f) + (f === 'db.js' ? '\nasync function _madeUp(found) {\n  await found.dir.publish({ manifest: {}, descriptions: {} });\n}\n' : '');
  assert.deepEqual(placeWritersOff('website', { read: madeUp }), ['db.js _madeUp: writes at a place — name it: \'holds\' (and an operation of the table), a step of one, or free (and why)']);
  const unheld = (f) => read(f).replace('const held = await _hold(d.gid, {', 'const held = await ({');
  assert.deepEqual(placeWritersOff('website', { read: unheld }), ['db.js _deleteOne: said to hold its place, but never calls the gateway']);
});

test('S32: whether a library folder is this library\'s is answered in one place — the adapter\'s claim answer, the hand-over in it', () => {
  // A folder that comes (back) to an app is read before it is that app's (storage/folder-owner.js). The rule — the claim
  // read (access: 'mine', 'handover', …) and the folder's mark turned into a hand-over (handoverIn) — is asked in the
  // website library's one answer alone (db.js _holds, _markOf), which every gate asks (_access: the write gate, the
  // folder store, the lists); the commit gate reads the mark in its own transaction (_logIn). Only an add and a take-back
  // decide that a claim begins a hand-over (handoverOf). No other place decides "this folder is ours".
  const where = (re, src = read) => [...new Set(modules.filter(f => !f.startsWith('storage/'))
    .flatMap(f => [...functionsOf(src(f))].filter(([, body]) => re.test(body)).map(([fn]) => `${f} ${fn}`)))].sort();
  assert.deepEqual(where(/(?<![\w.$])access\s*\(\s*(?:read|back)\b/), ['db.js _holds'], 'the claim rule asked in the one answer alone');
  assert.deepEqual(where(/\bhandoverIn\s*\(/), ['db.js _markOf'], 'the mark read into a hand-over there alone');
  assert.deepEqual(where(/\bhandoverOf\s*\(/), ['folder-library.js _takeBack', 'folder-library.js folderAdd'], 'a hand-over begun by an add and a take-back alone');
  // One decided anywhere else fails it.
  const madeUp = (f) => read(f) + (f === 'folder-library.js' ? '\nasync function _madeUp(read, me) {\n  return access(read, me, null) === \'mine\';\n}\n' : '');
  assert.deepEqual(where(/(?<![\w.$])access\s*\(\s*(?:read|back)\b/, madeUp), ['db.js _holds', 'folder-library.js _madeUp']);
});

test('S32, review 9 A2: the rule that every place-writing function holds reads code as code — a range of a module it can\'t read fails it', () => {
  // A `/*` inside a line comment hid 210 lines of folder-library.js from it (_overlayFor's write among them).
  assert.equal(asCode('a(); // see .shiori/linked/*/x\nb(); /* c */ d();').split('\n').length, 2);
  assert.match(asCode('a(); // see .shiori/linked/*/x\nb();'), /b\(\);/, 'a `/*` in a line comment opens nothing');
  assert.match(asCode('s = "/*"; t = `//${x}`; r = /\\/\\*/g; u();'), /u\(\);/, 'nor in a string, a template or a regular expression');
  assert.throws(() => asCode('a(); /* never closed\nb();'), /not closed/, 'a comment never closed is a failure');
  assert.throws(() => functionsOf('/* x */ const y = 1;\n/*\nfunction hidden() {}\n'), /not closed/);
  // The blind range of review 9 A2: a made-up deletion in it is found now.
  const blind = (f) => (f === 'folder-library.js' ? read(f).replace(/(\nasync function _relink\(run, title, gid\) \{\n(?:.*\n)*?  try \{)/,
    '$1\n    await folderFiles.removeDir(run.id, run.root, title.path);') : read(f));
  assert.deepEqual(placeWritersOff('website', { read: blind }), ['folder-library.js _relink: writes at a place — name it: \'holds\' (and an operation of the table), a step of one, or free (and why)']);
});

test('S33, review 10 A4: the rule places every function — a write in a getter, a one-line method, a signature over two lines, a class field, a top-level let is found, never counted to the function above', () => {
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const named = (key) => [`${key}: writes at a place — name it: 'holds' (and an operation of the table), a step of one, or free (and why)`];
  // Each made-up write placed right after a function the table names free (files.js cutBack), as review 10's probe did.
  for (const [what, member] of [['a getter', '  get sneaky() { return disk.rmSync(this.x, { recursive: true }); }'],
    ['a one-line method', '  sneaky(rel) { return disk.rm(this._abs(rel), { recursive: true, force: true }); }'],
    ['a signature over two lines', '  async sneaky(gid,\n    rel) { await disk.rm(this._abs(rel), { recursive: true }); }'],
    ['a class field', '  sneaky = async (a) => { await disk.rm(a, { recursive: true }); };']]) {
    const read = (f) => (f === 'files.js' ? desktop(f).replace(/\n {2}close\(\) \{/, `\n${member}\n  close() {`) : desktop(f));
    assert.deepEqual(placeWritersOff('desktop', { read }), named('files.js sneaky'), what);
  }
  const letFn = (f) => (f === 'db.js' ? read(f).replace(/\nasync function _deleteDir\(/, '\nlet sneaky = async (id, root) => { await folderFiles.removeFile(id, root, "x"); };\nasync function _deleteDir(') : read(f));
  assert.deepEqual(placeWritersOff('website', { read: letFn }), named('db.js sneaky'), 'a top-level let');
  // A class member of a shape it can't place fails the rule.
  assert.throws(() => functionsOf('class A {\n  [computed]() { return 1; }\n}\n'), /can't place/);
});

test('S34, review 11: every function working on a gallery across an await asks whether the gallery it began for is still the id\'s — or is a step of one that does, or works on no gallery begun before, and why', () => {
  // gallery-lives.mjs lists each (WORK); the sweeps' 'made again' (folder-sweep.test.mjs) runs every operation at every
  // file call with the gallery deleted and made again meanwhile.
  assert.deepEqual(livesOff('desktop'), [], 'name each in gallery-lives.mjs');
  assert.deepEqual(livesOff('website'), [], 'name each in gallery-lives.mjs');
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  // A function made up to read by id after an await, and one that stops asking, each fail it — on both apps.
  const madeUp = (f) => desktop(f).replace(/\n {2}close\(\) \{/, '\n  async sneaky(gid) { await disk.stat(this._abs(this._row(gid).path)); return this._stagedOwn(gid); }\n  close() {');
  assert.deepEqual(livesOff('desktop', { read: madeUp }), ['files.js sneaky: works on a gallery by id across an await — name it: \'asks\', a step of one that does, or free (and why)']);
  const silent = (f) => desktop(f).replace(/\n {2}async _unpack\([\s\S]*?\n {2}\}\n/, (m) => m.replace(/this\.still\(life\)/g, 'true'));
  assert.deepEqual(livesOff('desktop', { read: silent }), ['files.js _unpack: said to ask, but never does']);
  const unnamed = (f) => (f === 'db.js' ? read(f).replace(/(export async function coverPut\([\s\S]*?\n\}\n)/, (m) => m.replace('      tx._write = w;\n', '')) : read(f));
  assert.deepEqual(livesOff('website', { read: unnamed }), ['db.js coverPut: writes a gallery\'s pictures under its lock without naming the write in its commit (tx._write = w) — name it a step or free (and why)']);
});

test('S35: a linked gallery\'s overlay is its gallery\'s own — its source.json written by one writer that asks there, deleted once what was under way for the gallery is over', () => {
  // A check's write of the overlay under way as its gallery was deleted landed after the deletion had deleted the file
  // (the website: the deletion then left the overlay; the desktop: the write made its folder again). The website writes
  // every overlay's source.json in folder-library.js _writeSource, under the gallery's lock, asking there, and deletes
  // the overlay under that lock (db.js _deleteOverlay); the desktop writes every one in linked.js overlayFor, a write
  // into the gallery's own under way (files.js ownWrite) that asks its life, and deletes it once that is over
  // (files.js _removeOwn, _underWay) — as a deleted gallery's folder is (S34).
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  assert.deepEqual([...site].filter(([, body]) => /\bSOURCE_FILE\b/.test(body) && /\bwriteFile\s*\(/.test(body)).map(([name]) => name), ['_writeSource']);
  // (Under the lock its caller holds where it is the gallery's own work's re-read: `held`, S36.)
  assert.match(site.get('_writeSource') ?? '', /\bended\s*\(\s*\)[\s\S]*\bwriteFile\s*\([\s\S]*\bK\.galleryWork\s*\(\s*gid\s*,\s*held\s*,\s*write\s*\)/);
  assert.match(site.get('_deleteOverlay') ?? '', /\b_galleryWork\s*\(\s*gid\s*,\s*held\b/);
  const linked = new Map([...functionsOf(desktop('linked.js'))].map(([name, body]) => [name, asCode(body)]));
  assert.deepEqual([...linked].filter(([name, body]) => name !== 'writeIn' && /\bwriteIn\s*\(/.test(body)).map(([name]) => name), ['overlayFor']);
  assert.match(linked.get('overlayFor') ?? '', /\bownWrite\s*\([\s\S]*\.still\s*\(\s*life\s*\)[\s\S]*\bwriteIn\s*\(/);
  assert.match(asCode(functionsOf(desktop('files.js')).get('_removeOwn') ?? ''), /\bawait this\._underWay\s*\(\s*gid\s*\)[\s\S]*\bthis\._remove\s*\(/);
});

// The website's asks whether a gallery is still the one work began for (db.js _still, K.still), as `src`'s code has them:
// each { at, args: how many arguments it passes }.
function stillAsks(src) {
  const text = code(src), out = [];
  for (const m of text.matchAll(/\b(?:_still|K\.still)\s*\(/g)) {
    let depth = 0, args = 1, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch) && --depth === 0) break;
      else if (ch === ',' && depth === 1) args++;
    }
    if (/^\s*\)/.test(text.slice(m.index + m[0].length))) args = 0;
    const end = text.indexOf('\n', m.index);
    out.push({ at: text.slice(text.lastIndexOf('\n', m.index) + 1, end < 0 ? undefined : end).trim(), args });
  }
  return out;
}
test('S36: the website decides whether a gallery is still the one work began for as its stat record is read where the decision holds — so a deletion in any of its pages ends it', () => {
  // A gallery's life in a page (db.js _life) told a deletion made in another page (a tab, the service worker) by
  // nothing: a write of its pictures under way there committed into a gallery made again under the id meanwhile
  // (app/tests/pages-made-again.test.mjs). The stat record carries a mark made with the gallery (`born`, db.js _born);
  // every ask passes the record as the transaction or the lock it holds in reads it, and compares the mark.
  const site = new Map([...functionsOf(read('db.js')), ...functionsOf(read('folder-library.js'))].map(([name, body]) => [name, asCode(body)]));
  const asks = [...stillAsks(read('db.js')), ...stillAsks(read('folder-library.js'))];
  assert.ok(asks.length >= 8, 'the asks are found');
  assert.deepEqual(asks.filter(a => a.args !== 2).map(a => a.at), [], 'every ask passes the life and the stat record as read where it holds');
  const db = code(read('db.js'));
  assert.match(db, /const _still = \(life, stat\) => [^\n]*_bornOf\(stat\) === life\.born/, 'an ask compares the mark');
  assert.match(site.get('_life') ?? '', /\bgalleryGet\s*\(/, 'a life takes the mark its stat record has');
  assert.match(site.get('_logIn') ?? '', /stat\.onsuccess[\s\S]*_still\s*\(\s*tx\._write\.life\s*,\s*stat\.result\s*\)/, 'a write is asked in its commit');
  // Every stat record made where none was is made with a mark, and the mark never leaves this browser.
  for (const fn of ['dbPut', 'rebuildGalleryEntry', 'transferWrite', 'galleryPut', '_mutateIn', '_storeAdopted', '_restoreDormant']) {
    assert.match(site.get(fn) ?? '', /\b(?:_born|K\.born)\s*\(/, `${fn} makes a stat record with its mark`);
  }
  assert.match(db, /const _forTransfer = [^\n]*\{ born, \.\.\.rest \}/, 'a stat record travels without its mark');
  for (const fn of ['transferRead', 'transferWrite']) assert.match(site.get(fn) ?? '', /\b_forTransfer\s*\(/, `${fn}: the bundle's stat record without the mark`);
  // A made-up ask that passes no record fails the rule.
  const madeUp = stillAsks(read('folder-library.js').replace(/(\nasync function folderStands\(.*\) \{\n)/, '$1  if (!K.still(life)) return false;\n'));
  assert.deepEqual(madeUp.filter(a => a.args !== 2).map(a => a.at), ['if (!K.still(life)) return false;']);
});

test('S36: the website\'s locks are taken in one order, stated where they are named — a deleted gallery\'s folder is deleted under its gallery\'s lock, taken before the folder\'s deletion lock', () => {
  // A deletion waited for its gallery's lock only while the id had no gallery, and then inside the folder's deletion
  // lock, which a gallery made again under the id, being moved, holds its gallery's lock waiting for: with a gallery made
  // again the deleted one's folder was deleted while its publication still wrote there (app/tests/folder-made-again.test.mjs).
  const order = read('db.js').match(/\/\/ The website's locks [\s\S]*?\nconst _galleryLocked = /)?.[0] ?? '';
  const named = new Set(modules.flatMap(f => [...code(read(f)).matchAll(/`(shiori:[a-z-]+:)\$\{/g)].map(m => m[1])));
  assert.ok(named.size >= 6, 'the locks are found');
  assert.deepEqual([...named].filter(n => !order.includes(n)), [], 'every lock is in the order');
  const site = new Map([...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const orderOff = (fns) => {
    const out = [];
    if (!/\bconst run = \(\) => folderFiles\.withLock\(`shiori:deleting:[\s\S]*\b_galleryWork\s*\(\s*d\.gid\s*,\s*held\s*,\s*run\s*\)/.test(fns.get('_deletion') ?? '')) out.push('_deletion: the gallery\'s lock first, then the folder\'s deletion lock');
    if (/\b_galleryLocked\s*\(|\bwithLock\s*\(/.test(fns.get('_deleteOne') ?? '')) out.push('_deleteOne: no lock waited for within the folder\'s deletion lock');
    if (!/withLock\(`shiori:removed:[\s\S]*going\.push\([\s\S]*_deleteOverlay\([\s\S]*\}\)\.catch\([\s\S]*await Promise\.all\(going/.test(fns.get('_publishRemoved') ?? '')) out.push('_publishRemoved: its overlays\' deletions waited for once its lock is let go');
    return out;
  };
  assert.deepEqual(orderOff(site), []);
  // The gallery's lock waited for inside the folder's deletion lock again fails the rule.
  const inside = new Map(site);
  inside.set('_deleteOne', `${site.get('_deleteOne')}\nawait _galleryLocked(d.gid, () => {});`);
  assert.deepEqual(orderOff(inside), ['_deleteOne: no lock waited for within the folder\'s deletion lock']);
});

test('S37: a gallery\'s lock is never waited for while one is held — every holder says which gallery\'s lock it holds, down to every place that asks for one', () => {
  // S35 put a lock on a path that runs under that lock; S36 passed a boolean `held` down one branch, and the series
  // command's weighing reached the same lock through another (review 12 F1), or another gallery's (F2). Now: `held` is a
  // gallery's id, and _galleryWork takes a gallery's lock by the rule the comment at _galleryLocked states.
  const db = read('db.js'), lib = read('folder-library.js');
  const site = new Map([...functionsOf(db), ...functionsOf(lib)].map(([name, body]) => [name, asCode(body)]));
  const order = db.match(/\/\/ The website's locks [\s\S]*?\nconst _galleryLocked = /)?.[0]?.replace(/\s*\/\/\s*/g, ' ') ?? '';
  assert.match(order, /A gallery's lock is never waited for while a gallery's lock is held/, 'the rule, stated with the order');
  // _galleryWork's three forms: its own inline, none waited for, another's only if free (else busy: 'unreadable').
  assert.match(site.get('_galleryWork') ?? '', /held != null && String\(held\) === String\(gid\)\) return Promise\.resolve\(\)\.then\(fn\)[\s\S]*if \(held == null\) return _galleryLocked\(gid, fn\)[\s\S]*ifFree: true[\s\S]*busy: true/);
  // No boolean form left, nor a lock asked for a gallery but through _galleryWork (or by its holder, _writing/_describe).
  const both = asCode(db) + asCode(lib);
  assert.deepEqual([...both.matchAll(/\bheld\s*(?:=|:)\s*(?:true|false)\b|\blocked\s*(?:=|:)\s*(?:true|false)\b|\bK\.locked\b/g)].map(m => m[0]), [], 'no boolean held');
  const asking = [...site].filter(([name, body]) => /\b_galleryLocked\s*\(/.test(body)).map(([name]) => name).sort();
  assert.deepEqual(asking, ['_describe', '_galleryWork', '_writing'], 'a gallery\'s lock waited for only by its holders and _galleryWork');
  // Every call down the chains from a holder to a place that asks passes `held`.
  const offPath = (fns) => {
    const out = [];
    const must = [['_weighGroup', /\b_hold\s*\(\s*m\s*,\s*\{\s*held:\s*String\(gid\)\s*\}/], ['_hold', /\b_stands\s*\(\s*id\s*,\s*held\b/],
      ['_stands', /\bfolderStands\s*\(\s*String\(gid\)\s*,\s*\{\s*held\b/], ['folderStands', /\b_adoptLinked\s*\([^)]*\bheld\b/], ['folderStands', /\bfolderStands\s*\(\s*m\s*,\s*\{\s*held\b/],
      ['_adoptLinked', /\b_overlayFor\s*\([^)]*\bheld\s*\)/], ['_overlayFor', /\b_writeSource\s*\([^)]*\bheld\s*\)/], ['_followTo', /\bK\.follow\s*\([^;]*\{\s*leave,\s*held\s*\}[\s\S]*\bK\.hold\s*\(\s*found\.id\s*,\s*\{\s*held\b/],
      ['_deletion', /\b_galleryWork\s*\(\s*d\.gid\s*,\s*held\b/], ['_follow', /\b_galleryWork\s*\(\s*gid\s*,\s*held\b/], ['_deleteOverlay', /\b_galleryWork\s*\(\s*gid\s*,\s*held\b/]];
    for (const [fn, shape] of must) if (!shape.test(fns.get(fn) ?? '')) out.push(`${fn}: passes held`);
    return out;
  };
  assert.deepEqual(offPath(site), []);
  // A made-up call that drops `held` on a path under a gallery's lock (folderStands' others loop, review 12's F1) fails it.
  const dropped = new Map(site);
  dropped.set('folderStands', (site.get('folderStands') ?? '').replace(/folderStands\(m, \{ held\b[^}]*\}\)/, 'folderStands(m)'));
  assert.deepEqual(offPath(dropped), ['folderStands: passes held']);
});

test('S38: a gallery left to stand is never held for good — what a drop rests on is one rule, and one with no version to stand by is settled, on both apps', () => {
  // S37's flag held a gallery for good where its place held no manifest (an earlier version's folder, an overlay never
  // described): every hold of it answered 'unreadable' (review 13 F1). Now gallery-manifest.js dropBasis says what a
  // drop rests on, beside each app's drop (website _droppedFor; desktop reread and adoptLinked), and the stand reached
  // from a flagged gallery's hold settles one that has none. (S39: what it rests on is what the asking look saw — `seen`
  // — not this library's stamp: the S39 rule below.)
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  assert.match(read('storage/gallery-manifest.js'), /export const dropBasis = \(now, seen\) =>/);
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const scan = new Map([...functionsOf(desktop('scan.js'))].map(([name, body]) => [name, asCode(body)]));
  const linked = new Map([...functionsOf(desktop('linked.js'))].map(([name, body]) => [name, asCode(body)]));
  const files = new Map([...functionsOf(desktop('files.js'))].map(([name, body]) => [name, asCode(body)]));
  const off = (s) => {
    const out = [];
    if (!/\bdropBasis\s*\(\s*read\.token\s*,\s*seen\s*\)\s*===\s*'none'[\s\S]*reason: 'unversioned'/.test(s.site.get('_droppedFor') ?? '')) out.push('website _droppedFor: dropBasis');
    if (!/\b_adoptLinked\s*\([^;]*\bseen\b[\s\S]*\b_adopt\s*\([^;]*\bseen\b[\s\S]*reason === 'unversioned'\) \{ await _settle\(/.test(s.site.get('folderStands') ?? '')) out.push('website folderStands: seen, and settled');
    if (!/\bleft = !deletion && first\.kind === 'ok' && await _groupDropped\(id\)[\s\S]*_stands\(id, held, handover, look\)/.test(s.site.get('_hold') ?? '')) out.push('website _hold: a gallery left to stand stands');
    if (!/format\.dropBasis\s*\(\s*g\.read\.token\s*,\s*seen\s*\)/.test(s.scan.get('reread') ?? '') || /startsWith\('v2:'\)/.test(s.scan.get('reread') ?? '')) out.push('desktop reread: dropBasis');
    if (!/format\.dropBasis\s*\(\s*read\.token\s*,\s*seen\s*\)/.test(s.linked.get('adoptLinked') ?? '')) out.push('desktop adoptLinked: dropBasis');
    if (!/reason === 'unversioned'\) \{ files\.settleLeft\(id\)/.test(s.scan.get('folderStands') ?? '')) out.push('desktop folderStands: settled');
    if (!/at\.kind === 'ok' && !deletion && this\._dropped\(id\)/.test(s.files.get('hold') ?? '')) out.push('desktop hold: a gallery left to stand stands');
    return out;
  };
  assert.deepEqual(off({ site, scan, linked, files }), []);
  // A made-up stand that forgets what its look saw fails it.
  const forgot = new Map(site);
  forgot.set('folderStands', (site.get('folderStands') ?? '').replace(/group: others, seen, began \}\);/, 'group: others, began });'));
  assert.deepEqual(off({ site: forgot, scan, linked, files }), ['website folderStands: seen, and settled']);
});

test('S39: a gallery left to stand is never worse off than one that isn\'t — what the place shows decides, a tidy fails no stand, one stand at a time', () => {
  // Review 14: a drop's 'unreadable' rested on this library's stamp (S38), so a gallery whose manifest was lost for good
  // was held for good though one not left to stand is published over; a linked gallery left to stand with nothing to read
  // was held for good; the tidy after a stand could fail it; the website's tidy put fields it had read earlier back; and
  // the desktop could stand one gallery twice at once. The shapes that hold each, on both apps.
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const scan = new Map([...functionsOf(desktop('scan.js'))].map(([name, body]) => [name, asCode(body)]));
  const linked = new Map([...functionsOf(desktop('linked.js'))].map(([name, body]) => [name, asCode(body)]));
  const files = new Map([...functionsOf(desktop('files.js'))].map(([name, body]) => [name, asCode(body)]));
  const lib = new Map([...functionsOf(desktop('library.js'))].map(([name, body]) => [name, asCode(body)]));
  const off = (s) => {
    const out = [];
    // 1. What the look saw, never the stamp: no stamp read where a drop is weighed.
    for (const [where, body] of [['website _droppedFor', s.site.get('_droppedFor')], ['website folderStands', s.site.get('folderStands')], ['desktop reread', s.scan.get('reread')], ['desktop adoptLinked', s.linked.get('adoptLinked')]]) {
      if (/dropBasis\s*\([^)]*(_stamp|stamp\b|known)/.test(body ?? '')) out.push(`${where}: the stamp weighed`);
    }
    if (!/_stands\(id, look\)/.test(s.files.get('hold') ?? '')) out.push('desktop hold: what it saw');
    // 2. A linked gallery with nothing to read, asked for its drop alone, settled.
    if (!/!at && settles && [\s\S]*throw bare\(\)[\s\S]*if \(!pages\.length\) \{ if \(settles\) throw bare\(\)/.test(s.site.get('_adoptLinked') ?? '')) out.push('website _adoptLinked: nothing to read, settled');
    if (!/!at && settles\(\)\) throw bare\(\)[\s\S]*pdfReady[^;]*\{ if \(settles\(\)\) throw bare\(\)[\s\S]*if \(!pages\.length\) \{ if \(settles\(\)\) throw bare\(\)/.test(s.linked.get('adoptLinked') ?? '')) out.push('desktop adoptLinked: nothing to read, settled');
    // 3. The tidy fails nothing: refused galleries passed over, publication scheduled first; the check tidies the rest.
    if (!/\.catch\(\(\) => new Set\(\)\)/.test(s.site.get('_tidyAround') ?? '')) out.push('website _tidyAround: never rejects');
    if (!/K\.describeSoon\(gid\);\s*await _tidyAround\(/.test(s.site.get('_settle') ?? '')) out.push('website _settle: published whatever the tidy meets');
    if (!/try \{\s*this\._tx\([\s\S]*\} catch \{ continue; \}/.test(s.lib.get('_tidyLinks') ?? '')) out.push('desktop _tidyLinks: a refusal passed over');
    if (!/this\.scheduleDescribe\(id\);\s*this\.library\._tidyLinks\(/.test(s.files.get('settleLeft') ?? '')) out.push('desktop settleLeft: published whatever the tidy meets');
    // (S40: the folder's tidy, one function each app, picks those whose links another contradicts.)
    if (!/await _tidyFolder\(run\.id, \{ kept, also:/.test(s.site.get('_checkOnce') ?? '')) out.push('website _checkOnce: its folder\'s tidy');
    if (!/library\._tidyFolder\(\[\.\.\.checked\], \{ also:/.test(s.scan.get('scanLibrary') ?? '')) out.push('desktop scanLibrary: its folders\' tidy');
    // 4. The website's tidy takes out of the record as its writing transaction reads it, and puts nothing for one gone.
    const tidy = s.site.get('_tidySeriesLinks') ?? '';
    if (!/metas\.get\(gid\)[\s\S]*stats\.get\(gid\)[\s\S]*if \(!cur\.result \|\| !K\.still\(life, stat\.result\)\) return;[\s\S]*const next = linksTidied\(cur\.result, judged\)/.test(tidy) || /linksTidied\(meta\b|\{ \.\.\.meta \}/.test(tidy)) out.push('website _tidySeriesLinks: the record as its transaction reads it');
    // 5. One stand of a desktop gallery at a time, never waiting for itself.
    if (!/return this\._standOnce\(id,/.test(s.files.get('_stands') ?? '')) out.push('desktop _stands: one at a time');
    if (!/if \(standing\) return contract\.unreadable/.test(s.files.get('hold') ?? '')) out.push('desktop hold: a stand never waits for itself');
    if (!/_letGo\(id, undefined, null, life, true\)/.test(s.scan.get('folderStands') ?? '') || /await folderStands\(library, m\)/.test(s.scan.get('folderStands') ?? '')) out.push('desktop folderStands: its own holds and its others');
    return out;
  };
  assert.deepEqual(off({ site, scan, linked, files, lib }), []);
  // A made-up tidy that writes back the record it read before its transaction fails it.
  const stale = new Map(site);
  stale.set('_tidySeriesLinks', (site.get('_tidySeriesLinks') ?? '').replace('linksTidied(cur.result, judged)', 'linksTidied(meta, judged)'));
  assert.deepEqual(off({ site: stale, scan, linked, files, lib }), ['website _tidySeriesLinks: the record as its transaction reads it']);
});

test('S41: each rule of the step where it has its one place, on both apps', () => {
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const scan = new Map([...functionsOf(desktop('scan.js'))].map(([name, body]) => [name, asCode(body)]));
  const files = new Map([...functionsOf(desktop('files.js'))].map(([name, body]) => [name, asCode(body)]));
  const off = [];
  // D: nothing tried or told by the check itself — an owed deletion left to its folder.
  if (/deletionTried|deletionThere/.test(`${site.get('_deletionMet')}${scan.get('deletionMet')}`)) off.push('D: a check tries another folder\'s deletion');
  // E: given up only once every folder that can be checked ruled it out — one rule, folder-lifecycle.js.
  if (!/need\.every\(/.test(read('storage/folder-lifecycle.js'))) off.push('E: unfoundEnd weighs every folder');
  // (S42 B: which folders those are is told without a call on any — both apps asking folder-lifecycle.js unfoundMayBeIn,
  // never the write gate, which reads each folder's library.json: _checkable / activeRoots were that.)
  if (!/_unfoundMayBeIn\(\)/.test(site.get('_endUnfound') ?? '') || !/unfoundMayBeIn\(\)/.test(files.get('endUnfound') ?? '')
    || /_checkable\(|_usable\(|_rootOf\(|_access\(/.test(site.get('_endUnfound') ?? '') || /activeRoots\(|writable\(|probe\(/.test(files.get('endUnfound') ?? '')) off.push('E: both apps tell which folders may hold it, with no call on them');
  // C: a removed source's overlay never offered as a title's own.
  if (!/isRemoved\(removed, o\.source\)/.test(read('storage/linked-source.js'))) off.push('C: matchSources leaves a removed source\'s overlay');
  // F: the contract says the token on 'ok', both adapters.
  if (!/kind: 'ok', token: at\.place\.token/.test(read('storage/folder-store-web.js')) || !/kind: 'ok', token: at\.place\.token/.test(desktop('folder-store.js'))) off.push('F: gallery() answers its token');
  // G: the stand's transaction checks the stamp it began with.
  if (!/began !== undefined && \(stat\.result\?\.stamp \?\? null\) !== began/.test(site.get('_storeAdopted') ?? '') || !/began !== undefined && files\._stamp\(gid\) !== began/.test(scan.get('reread') ?? '')) off.push('G: the stamp a stand began with');
  // (S42 E: and the desktop's linked gallery's stand, linked.js adoptLinked, in its transaction.)
  if (!/_tx\([\s\S]*replace && began !== undefined && files\._stamp\(gid\) !== began/.test(asCode(new Map([...functionsOf(desktop('linked.js'))]).get('adoptLinked') ?? ''))) off.push('G: the stamp a linked stand began with (desktop adoptLinked)');
  // A: the window opens after the weigher's own hold.
  if (/_weighedGroups\.set/.test(site.get('_weighGroup') ?? '') || /_weighed\.set/.test(files.get('_weighGroup') ?? '')) off.push('A: the weighing alone opens the window');
  assert.deepEqual(off, []);
});

test('S42: each rule of the step where it has its one place, on both apps', () => {
  // Review 17 of S41: a settle that weighed no group acted for a command made since (and the window it opened was
  // carried forward from member to member); a check waited on every other folder's drive; a folder's removal gave its
  // not-found deletions up; a publication dropped as it landed left the folder and the library apart for good.
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const scan = new Map([...functionsOf(desktop('scan.js'))].map(([name, body]) => [name, asCode(body)]));
  const files = new Map([...functionsOf(desktop('files.js'))].map(([name, body]) => [name, asCode(body)]));
  const off = [];
  // A: every caller of the weighing acts only while its group is the one weighed, and the window opens only for a real weighing.
  if (!/_weighedStill\(gid, weighed\)[\s\S]*found\.dir\.publish/.test(site.get('_describe') ?? '')) off.push('A: website _describe acts only for what it weighed');
  for (const fn of ['_place', '_publish', '_describeArchiveNow']) if (!/_weighedStill\(gid, weighed\)/.test(files.get(fn) ?? '')) off.push(`A: desktop ${fn} acts only for what it weighed`);
  if (!/weighed\.how !== 'weighed'/.test(site.get('_groupWeighed') ?? '') || !/weighed\.how === 'weighed'/.test(files.get('_groupWeighed') ?? '')) off.push('A: only a real weighing opens the window');
  // B: a check looks through no other folder's staging (the unfound end: 'S41' E above).
  if (/activeRoots\(\)/.test(scan.get('removeOrphans') ?? '') || !/library\.files\.resume\(\{ roots: checked \}\)/.test(scan.get('scanLibrary') ?? '')
    || /stagingDirs\(\)/.test(files.get('_unstage') ?? '')) off.push('B: a check or a publication looks through another folder\'s staging');
  // C: no removal gives a deletion up, and forgetting a folder keeps its deletions not found.
  if (/removal/.test(`${site.get('_endUnfound')}${files.get('endUnfound')}`)) off.push('C: an unfound end says removal');
  if (!/if \(!d\.unfound\) store\.delete/.test(read('db.js')) || !/for \(const d of this\.deletingIn\(root\)\)/.test(files.get('forgetDeletionsIn') ?? '')) off.push('C: forgetting a folder keeps its deletions not found');
  // D: a publication dropped as it landed leaves the gallery waiting.
  if (!/else if \(rev != null && !mark\.result\) \{ _markIn\(tx, gid, rev\); dropped = true; \}/.test(site.get('_described') ?? '')
    || !/dropped = waited && !this\._row\(id\)\?\.pending;\s*if \(dropped\) lib\._s\('UPDATE files SET pending = 1/.test(files.get('describe') ?? '')) off.push('D: a publication dropped as it landed is published again');
  // E: a linked source read and damaged is 'corrupt' on the desktop's check too.
  if (!/contract\.readDamaged\(e\) \? 'corrupt'/.test(desktop('linked.js'))) off.push('E: the desktop reports a damaged linked archive corrupt');
  assert.deepEqual(off, []);
});

test('S40: totals written only when changed, deletions read as the place is met, the drop guarded in its transaction, seen as the look saw it — both apps', () => {
  // Review 15 and the coordinator after S39: an idle check wrote a revision per series (the website put its totals
  // unconditionally); a check adopted a place naming a gallery whose deletion was still owed (it read only `unfound`
  // deletions, once, as it began); a stand overtaken by another dropped a change made since; a manifest seen by the
  // first look and gone at the re-read settled a gallery left to stand. Each rule held where it has its one place.
  const desktop = (f) => readFileSync(join(repo, 'desktop', 'server', f), 'utf8');
  const site = new Map([...functionsOf(read('folder-library.js')), ...functionsOf(read('db.js'))].map(([name, body]) => [name, asCode(body)]));
  const scan = new Map([...functionsOf(desktop('scan.js'))].map(([name, body]) => [name, asCode(body)]));
  const linked = new Map([...functionsOf(desktop('linked.js'))].map(([name, body]) => [name, asCode(body)]));
  const files = new Map([...functionsOf(desktop('files.js'))].map(([name, body]) => [name, asCode(body)]));
  const off = (s) => {
    const out = [];
    if (!/if \(_sameRecord\(next, owner\)\) \{ done\(false\); return; \}\s*gals\.put\(next\)/.test(s.site.get('_aggregateIn') ?? '')) out.push('website _aggregateIn: totals written only when changed');
    if (!/await _deletionMet\(run, found\.id\)/.test(s.site.get('_joinOwn') ?? '') || /run\.deleted/.test(s.site.get('_checkOnce') ?? '')) out.push('website _joinOwn: deletions read as the place is met');
    if (!/await deletionMet\(library, id, handover\)/.test(s.scan.get('scanLibrary') ?? '') || /d\.unfound \|\| handover/.test(s.scan.get('scanLibrary') ?? '')) out.push('desktop scanLibrary: deletions read as the place is met');
    if (!/K\.groupDroppedIn\(tx, gid, \(left\) => \{\s*if \(stamp && stat\.result\?\.stamp === stamp && !left\)/.test(s.site.get('_storeAdopted') ?? '')) out.push('website _storeAdopted: the drop guarded in its transaction');
    if (!/_ownTx\([\s\S]*if \(drop && g\.read\.token && files\._stamp\(gid\) === g\.read\.token && !files\._dropped\(gid\)\)/.test(s.scan.get('reread') ?? '')) out.push('desktop reread: the drop guarded in its transaction');
    if (!/_tx\([\s\S]*if \(replace && drop && read\.token && files\._stamp\(gid\) === read\.token && !files\._dropped\(gid\)\)/.test(s.linked.get('adoptLinked') ?? '')) out.push('desktop adoptLinked: the drop guarded in its transaction');
    if (!/seen: first\.kind === 'theirs' \|\| first\.place\?\.token != null/.test(s.site.get('_hold') ?? '')) out.push('website _hold: seen as the look saw it');
    if (!/seen: at\.kind === 'theirs' \|\| !!at\.place\?\.token/.test(s.files.get('hold') ?? '')) out.push('desktop hold: seen as the look saw it');
    return out;
  };
  assert.deepEqual(off({ site, scan, linked, files }), []);
  // A made-up hold that takes 'theirs' alone for what it saw fails it.
  const theirsOnly = new Map(site);
  theirsOnly.set('_hold', (site.get('_hold') ?? '').replace(" || first.place?.token != null", ''));
  assert.deepEqual(off({ site: theirsOnly, scan, linked, files }), ['website _hold: seen as the look saw it']);
});

test('S37: the net that holds the website\'s lock order at run time weighs the order the comment states', () => {
  // The tests' net (app/tests/lock-net.mjs) fails a run on a lock waited for against the order; its list is the order
  // as stated once, at db.js _galleryLocked — the locks named there in the order they come, the one taken within any last.
  const order = read('db.js').match(/\/\/ The website's locks [\s\S]*?\nconst _galleryLocked = /)?.[0] ?? '';
  const stated = (text) => [...new Set([...text.matchAll(/\b(shiori:[a-z-]+:)</g)].map(m => m[1]))];
  assert.deepEqual(stated(order), [...ORDER, WITHIN]);
  assert.match(order, new RegExp(`${WITHIN}<folder>[^\\n]*\\n?[^\\n]*within`), 'the lock taken within any, said so');
  assert.ok(order.includes(ASKED_THERE[0]) && /asked for there and waited for once that one is let go/.test(order.replace(/\s*\/\/\s*/g, ' ')),
    'the one lock asked where a later one is held, said so');
  // A comment putting two of them the other way round fails it.
  assert.notDeepEqual(stated(order.replace('shiori:deleting:<folder>', 'shiori:@').replace('shiori:removed:<folder>', 'shiori:deleting:<folder>').replace('shiori:@', 'shiori:removed:<folder>')), [...ORDER, WITHIN]);
});

test('S33, review 10 B7: a change refused for now is worded through backend-error.js refusalKey alone — a translation\'s start and a PDF\'s drawing task say it by its key', () => {
  // A translation's start kept the key only for 'lf.taken_msg' (so "still being scanned" was sent as a raw message), and
  // the PDF drawing task sent no key at all.
  assert.deepEqual(modules.filter(f => f !== 'backend-error.js' && !f.startsWith('locales') && /'lf\.taken_msg'/.test(code(read(f)))), [],
    'no module tells one refusal by a key of its own');
  for (const [f, fn] of [['jobs-runner.js', 'runTranslate'], ['library-folders.js', 'drawWaitingPdfs']]) {
    assert.match(functionsOf(read(f)).get(fn), /\brefusalKey\s*\(\s*e\s*\)[\s\S]*\berrorKey\b/, `${f} ${fn}: its error carries the refusal's key`);
  }
});

test('the app never names a source site or the companion helper', () => {
  // The app is site-agnostic and must carry no evidence of the companion relationship in
  // user-facing copy. Bridge message names (EXT_*) are the sanctioned contract and stay.
  const banned = /\b(?:nhentai|hitomi|exhentai|e-hentai|mangafire)\b/i;
  const offenders = [];
  for (const f of modules) if (banned.test(read(f))) offenders.push(`app/js/${f}`);
  for (const f of readdirSync(join(repo, 'app')).filter((x) => /\.(html|css)$/.test(x))) {
    if (banned.test(readFileSync(join(repo, 'app', f), 'utf8'))) offenders.push(`app/${f}`);
  }
  for (const [f, text] of [...uiSources(), ...uiBundle()]) if (banned.test(text)) offenders.push(f);
  assert.deepEqual(offenders, [], 'source-site names must exist only in the private companion');
});

test('the app never opens the browser\'s own confirm / alert / prompt boxes', () => {
  // notice.js has the app's styled replacements (confirmDialog / alertDialog / promptDialog).
  const native = /(^|[^.\w])(?:window\.)?(?:confirm|alert|prompt)\s*\(/m;
  const offenders = modules.filter((f) => native.test(code(read(f))));
  for (const [f, text] of uiSources()) if (native.test(code(text))) offenders.push(f);
  // The bundle is read as it is: it has no comments, and its lines are too long to strip any from.
  for (const [f, text] of uiBundle()) if (native.test(text)) offenders.push(f);
  assert.deepEqual(offenders, [], 'use notice.js dialogs instead of window.confirm/alert/prompt');
});

test('no third-party acquisition URLs are constructed in the app', () => {
  const offenders = [];
  const outside = (src) => [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)]
    .map((m) => m[0])
    // The user-configured translation server default is local and explicitly user-owned.
    .filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u))
    // Namespace/spec URLs are not network acquisition (SVG xmlns and friends).
    .filter((u) => !/w3\.org|schema\.org/.test(u))
    // This project's own release downloads are its own artifacts, not a content source.
    .filter((u) => !/^https:\/\/github\.com\/hikarin-dev\/shiori\//.test(u));
  for (const f of modules) {
    const hits = outside(code(read(f)));
    if (hits.length) offenders.push(`app/js/${f}: ${hits.join(', ')}`);
  }
  for (const [f, text] of uiSources()) {
    const hits = outside(code(text));
    if (hits.length) offenders.push(`${f}: ${hits.join(', ')}`);
  }
  // The bundle also holds the libraries the UI is built on, whose messages name their own
  // documentation: text for a developer's console, nothing the app requests. Each such host is
  // named here, so an address that is neither one of these nor allowed above fails.
  const libraryDocs = /^https:\/\/(?:react\.dev|reactrouter\.com|base-ui\.com|tailwindcss\.com)(?:\/|$)/;
  for (const [f, text] of uiBundle()) {
    const hits = [...new Set(outside(text).filter((u) => !libraryDocs.test(u)))];
    if (hits.length) offenders.push(`${f}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'the app must not know where external content comes from');
});
