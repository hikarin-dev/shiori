// architecture-fitness.test.mjs — the desktop library reaches its library folders only through the
// folder store adapter (server/folder-store.js, plan §3.1): every node fs call on a library folder is
// made there, where it is counted and can be failed on purpose, and where the rules for every byte
// touched go. The library's own data folder (its index, thumbnails, write meter) is outside the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
const read = (f) => readFileSync(join(server, f), 'utf8');
// Strip comments so prose about a rule never trips the rule itself.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const FS = /\bfrom\s*['"]node:fs(?:\/promises)?['"]|\b(?:import|require)\s*\(\s*['"]node:fs(?:\/promises)?['"]\s*\)/;

test('only the folder store adapter and the modules of the app\'s own files import node:fs', () => {
  // backup.js writes the backups the person saves, wherever they choose; writes.js keeps the write
  // meter in the data folder; server.js serves the window its own files; library.js keeps its index
  // and thumbnails in the data folder (the test below holds it to that).
  const own = new Set(['folder-store.js', 'backup.js', 'writes.js', 'server.js', 'library.js']);
  const offenders = readdirSync(server).filter((f) => f.endsWith('.js') && !own.has(f) && FS.test(code(read(f))));
  assert.deepEqual(offenders, [], 'go through folder-store.js `disk`');
});

test('library.js calls node:fs only for its data folder', () => {
  // Each fs call sits in a method that works on the data folder alone; anything that may be in a
  // library folder (staging, a gallery's files, a file read for a backup) goes through `disk`.
  const dataFolder = new Set(['open', '_meterDb', '_writeCache', '_readCache', '_cacheFiles', '_clearCache']);
  const offenders = [];
  let method = null;
  for (const line of code(read('library.js')).split('\n')) {
    const m = /^ {2}(?:async |static )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
    if (m) method = m[1];
    if (/\b(?:fs|fsp)\.\w+/.test(line) && !dataFolder.has(method)) offenders.push(`${method}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], 'these may touch a library folder: go through folder-store.js `disk`');
});

test('no code outside the folder store adapter turns a failed read of a library folder into "nothing there"', () => {
  // Review 6: where a folder is read to tell what the library records, an answer of "not found" is
  // 'missing' only as the shared rule takes it (folder-store.js notFound, and the reads made under it:
  // textIn, entriesIn, statIn, textsIn, galleryIn, manifestIn, loadGallery), and any other failure is a
  // failure (S22). So outside folder-store.js no code tells "not found" by an error's code, and no read
  // through `disk` turns its failure into a value meaning "none" (null, [], false, ifMissing, existsSync,
  // a look answering false) — but these, each for its reason. A read is one through `disk` (a look with
  // `throwIfNoEntry: false` answers "none" for "not found" too), or through the reads made under the rule
  // and the archive readers: a failure of those, caught into "none", is the same "not there" (review 7). A
  // line matched is the whole line, comments stripped; an entry no line matches any more is stale and fails
  // too.
  const READ = /\b(?:disk\.(?:readFile|readFileSync|readdir|stat|statSync|access|openAsBlob)|statIn|statNow|textIn|textNow|entriesIn|textsIn|filesIn|holdsFile|picturesIn|loadGallery|ownedIn|classifyAt|readDirectory|directoryEnd|readEntry|zipFingerprint|titleAt|titlesIn|sourceIn|this\._(?:read|readSource|sourceIn|directory|inFormat|foreignIn|archiveEntries))\s*\(/;
  const NONE = /\.catch\(\s*(?:ifMissing\(|\(\)\s*=>\s*(?:null|undefined|false|true|''|\[[^\]]*\]|new Map\(\)|\(\{\}\))\s*\))|,\s*\(\)\s*=>\s*(?:false|true)\s*\)|\bthrowIfNoEntry:\s*false\b/;
  const CODE = /'(?:ENOENT|ENOTDIR)'/;
  const EXISTS = /\bdisk\.existsSync\s*\(/;
  const DATA = 'this computer\'s data folder (the notes beside each library\'s index), not a library folder';
  const START = 'the first folder\'s library.json at the start, before a library is open (S15, S20): the notes decide what one not there means, and one found there meanwhile is the folder\'s (writeId)';
  const FREE = 'a name looked for free before a move or a gallery\'s first folder: the move looks again (moveSync), the folder is made exclusively';
  const NOTHING = 'a failed listing or look deletes nothing, and changes nothing recorded';
  const IDENTITY = 'a library folder\'s identity (principle 1), the shared rule\'s own look: one not there refuses (other-library, unavailable)';
  const CARRY = 'an earlier build\'s tables carried over at the start (D13): a leftover or retired file a look can\'t find now has nothing retired — it stays, never deleted (principle 4); `unplaced` only this branch\'s builds before S4 made, never released';
  const SHOWN = 'a picture read to show, or for a backup (which lists each it couldn\'t read: backup-core `missing`): null shows nothing and changes nothing recorded — a gallery is marked missing only as the shared rule takes it (_seen: gone)';
  const CHECKED = 'what the library check finds readable (integritySnapshot, read by library-check.js and a move\'s check after it): one that can\'t be read now is an error it reports (I5), never a check that passes, and nothing recorded changes';
  const ARCHIVING = 'archiving begins only with every picture looked at: one that can\'t be now leaves the gallery a folder, looked at again after a while — nothing written or deleted';
  const UNKNOWN = 'a fingerprint unknown (null) when the archive can\'t be read now: it concludes no change (matchSources), and a removal note made with it holds whatever the place holds (linked-source.js isRemoved)';
  /** @type {[string, string, string][]} file, a part of the line, why */
  const allowed = [
    ['files.js', 'try { return disk.readFileSync(idFile(libraryDir), \'utf8\'); } catch (e) { if (e.code === \'ENOENT\') return null;', START],
    ['files.js', 'const st = await disk.stat(dir, { bigint: true }).catch((e) => { if (e?.code === \'ENOENT\') return null;', START],
    ['files.js', 'const ids = await disk.readdir(librariesDir)', DATA],
    ['files.js', 'const note = await disk.readFile(path.join(librariesDir, id, FIRST_NOTE)', DATA],
    ['files.js', 'else if (disk.existsSync(index) && !earlierIndex(index))', DATA],
    ['files.js', 'if (await disk.readFile(file, \'utf8\').catch(() => null) !== text) {', DATA],
    ['files.js', 'if (e?.code !== \'ENOENT\' && e?.code !== \'ENOTDIR\' && e?.reason !== \'outside\') return \'unavailable\';', IDENTITY],
    ['files.js', 'try { st = disk.statSync(dir, { throwIfNoEntry: false }); } catch {}', IDENTITY],
    ['files.js', 'const statOf = (abs) => { const st = disk.statSync(abs, { throwIfNoEntry: false }); return st?.isFile() ? st : null; };', CARRY],
    ['files.js', 'const st = disk.statSync(abs, { throwIfNoEntry: false });\n        const named = [];', CARRY],
    ['files.js', 'while (disk.existsSync(path.join(dir, ...name.split(\'/\')))) name = rel.replace(', FREE],
    ['files.js', 'fresh && dir != null && disk.existsSync(path.join(dir, ...n.split(\'/\')))', FREE],
    ['files.js', 'if (!disk.existsSync(at(s.rel))) return s.rel;', FREE],
    ['files.js', 'while (disk.existsSync(at(name))) name = s.rel.replace(', FREE],
    ['files.js', '|| disk.existsSync(this._abs(rel));', FREE],
    ['files.js', '(await classifyAt(abs, await disk.readdir(abs, { withFileTypes: true })).catch(() => null))?.kind === \'gallery\'',
      'an upgrade\'s retired rows: a folder that can\'t be told for a gallery\'s has nothing retired from it, and stays'],
    ['files.js', 'if (!disk.existsSync(this._abs(row.path))) return false;', 'a publication waits while the gallery\'s folder isn\'t there: tried again'],
    ['files.js', 'else if (done === true) done = await holdsFile(abs).then((held) => held || this._delete(abs), () => false);',
      'a deletion whose folder can\'t be listed now isn\'t done: it stays recorded, tried again (review 5 F2)'],
    ['files.js', 'const st = disk.statSync(file, { throwIfNoEntry: false });\n    return !!st && format.unchanged(',
      'an archive a look can\'t find as Shiori last wrote it is never written over whole (F6): it is added to instead, or its compaction given up'],
    ['files.js', 'const bytes = await this._readSource(row, orig.entry).catch(() => null);', SHOWN],
    ['files.js', 'const bytes = await this._read(row, orig.entry).catch(() => null);', SHOWN],
    ['files.js', 'const placed = () => (row ? this._read(row, rel).catch(() => null) : null);', SHOWN],
    ['files.js', ': row.format === \'folder\' ? await filesIn(at).catch(() => [])', CHECKED],
    ['files.js', ': [...(await this._directory(at).catch(() => new Map())).keys()];', CHECKED],
    ['files.js', 'if (src?.kind === \'dir\') return disk.access(path.join(this._sourceAbs(row), orig.entry)).then(() => true, () => false);', CHECKED],
    ['files.js', 'return !!(await this._directory(this._sourceAbs(row)).catch(() => null))?.has(orig.entry);', CHECKED],
    ['files.js', 'if (row.format === \'folder\') return disk.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);', CHECKED],
    ['files.js', 'return !!(await this._directory(this._abs(row.path)).catch(() => null))?.has(orig.entry);', CHECKED],
    ['files.js', 'this._sourceIn(row, orig.entry).catch(() => null) : null;',
      'a linked page\'s file for a read that needn\'t load it: null (its path leads out of its folder) has it read the other way, refused there too — nothing recorded changes'],
    ['files.js', 'const dir = abs && await this._directory(abs).catch(() => null);\n    return dir ?',
      'whether an archive is in the gallery format, can\'t be told now — its library folder out of reach among it (S30) — (principle 6, S21): a settle waits for the gallery\'s next change (§8, review 6 O2), no unpack begins, a picture of its own is staged'],
    ['files.js', '(await disk.readdir(dir).catch(() => null))?.length === 0;', `${NOTHING}: a folder that can't be listed isn't taken for empty`],
    ['files.js', 'const foreign = new Set(await this._foreignIn(file, dir).catch(() => [...dir.keys()]));',
      'an archive whose own manifest can\'t be read now keeps every entry as the person\'s: nothing is dropped from it (principle 4)'],
    ['files.js', 'const stat = disk.statSync(path.join(dir, ...name.split(\'/\')), { throwIfNoEntry: false });', ARCHIVING],
    ['files.js', 'const made = await this._archiveEntries(id, dir, archiveFormat).catch(() => null);', ARCHIVING],
    ['files.js', 'const held = await holdsFile(abs).catch(() => null);',
      'a retirement whose folder can\'t be listed now keeps its rows, tried again at the next sweep (it ends once the folder can be listed, or with the folder\'s removal)'],
    ['folders.js', 'const there = !b.files || disk.existsSync(lib.files._abs(b.files.path));', 'galleries an unreleased build set aside (§8, review 4 O5)'],
    ['folders.js', 'if (!(await disk.stat(abs).then(st => st.isDirectory(), () => false)))', 'a folder to add that can\'t be looked at is refused'],
    ['folders.js', 'const isDir = (dir) => { try { return disk.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true; } catch { return false; } };',
      'a claim is written only in a folder there now (_writeClaim): one a look can\'t find is refused (\'unavailable\'), nothing written'],
    ['library.js', 'if (!disk.existsSync(root)) throw new BackendError(\'unavailable\'', 'a staged write refused while its library folder isn\'t there'],
    ['library.js', 'if (e.code !== \'ENOENT\') throw e;', 'a staged write whose folder was cleared meanwhile: the folder made again (a write, not a read)'],
    ['library.js', 'disk.access(this._staged(o.file)).then(() => true, () => false)', CHECKED],
    ['library.js', 'for (const name of await disk.readdir(dir).catch(() => [])) await disk.rm(', NOTHING],
    ['linked.js', 'const dir = directory || await readDirectory(abs).catch(() => null);',
      'an archive whose directory can\'t be read now has no title read: none joins or is read again from it (adoptLinked: null), a note takes no fingerprint'],
    ['linked.js', 'fingerprint: await zipFingerprint(abs).catch(() => null),\n      size:', UNKNOWN],
    ['linked.js', 'return (await titleAt(library, root, source).catch(() => null))?.fingerprint ?? null;',
      'a source\'s fingerprint, unknown (null) when it can\'t be read now: a note made with it holds whatever the place holds (isRemoved), and one recorded before is kept (folders.js _publishRemoved)'],
    ['linked.js', 'fingerprint: await sourceIn(library, root, rel).then(zipFingerprint).catch(() => null) }];', UNKNOWN],
    ['linked.js', 'const dir = await readDirectory(abs).catch(() => null);\n    const fingerprint',
      'an archive whose directory can\'t be read now is noted as removed whole, as itself: no check adopts anything from it'],
    ['linked.js', 'const fingerprint = await zipFingerprint(abs).catch(() => null);\n    for (const z', UNKNOWN],
    ['linked.js', 'fingerprint: await sourceIn(library, root, rel).then(zipFingerprint).catch(() => null) });', UNKNOWN],
    ['linked.js', 'const fingerprint = await sourceIn(library, root, rel).then(zipFingerprint).catch(() => null);\n  return (folder) => L.chapterRemoved(', UNKNOWN],
    ['linked.js', 'const fingerprint = await zipFingerprint(abs).catch(() => null);\n      const size', UNKNOWN],
    ['linked.js', 'const size = (await statIn(abs).catch(() => null))?.size ?? null;', 'an archive\'s size unknown (null) when it can\'t be read now: its source.json keeps the size it had'],
    ['linked.js', 'const at = await titleAt(library, root, over.source).catch(() => null);',
      'a drawing weighed against the PDF as it is: one that can\'t be read now is not the version drawn, and nothing is written'],
    ['remove.js', 'if (disk.existsSync(file)) await disk.rm(', NOTHING],
    ['scan.js', 'const stat = await disk.stat(file).catch(() => null);', `${NOTHING}: a leftover that can't be looked at isn't old`],
    ['scan.js', '(await disk.readdir(library.rootDir(id)).catch(() => []))', 'a count for the progress shown'],
    ['scan.js', 'for (const item of listed ?? await disk.readdir(dir, { withFileTypes: true }).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const gid of await disk.readdir(dir).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const name of await disk.readdir(path.join(dir, gid)).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const name of await disk.readdir(path.join(dir, ...sub.split(\'/\'))).catch(() => [])) {', `${NOTHING} (leftovers)`],
  ];
  const used = new Set();
  const offenders = [];
  for (const f of readdirSync(server).filter((f) => f.endsWith('.js') && f !== 'folder-store.js')) {
    const lines = code(read(f)).split('\n');
    for (const [i, line] of lines.entries()) {
      if (!((READ.test(line) && NONE.test(line)) || CODE.test(line) || EXISTS.test(line))) continue;
      const near = `${line}\n${lines[i + 1] ?? ''}`;   // an entry may name the line after too, where lines are alike
      const at = allowed.findIndex(([file, part]) => file === f && near.includes(part));
      if (at < 0) offenders.push(`${f}: ${line.trim()}`); else used.add(at);
    }
  }
  assert.deepEqual(offenders, [], 'read through folder-store.js textIn / entriesIn / statIn (or say why here)');
  assert.deepEqual(allowed.filter((_, i) => !used.has(i)).map(([f, part]) => `${f}: ${part}`), [], 'stale entries');
});
