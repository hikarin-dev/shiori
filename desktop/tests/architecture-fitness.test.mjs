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
  // a look answering false) — but these, each for its reason. A line matched is the whole line, comments
  // stripped; an entry no line matches any more is stale and fails too.
  const READ = /\bdisk\.(?:readFile|readFileSync|readdir|stat|statSync|access|openAsBlob)\s*\(/;
  const NONE = /\.catch\(\s*(?:ifMissing\(|\(\)\s*=>\s*(?:null|undefined|false|true|''|\[[^\]]*\]|new Map\(\))\s*\))|,\s*\(\)\s*=>\s*(?:false|true)\s*\)/;
  const CODE = /'(?:ENOENT|ENOTDIR)'/;
  const EXISTS = /\bdisk\.existsSync\s*\(/;
  const DATA = 'this computer\'s data folder (the notes beside each library\'s index), not a library folder';
  const START = 'the first folder\'s library.json at the start, before a library is open (S15, S20): the notes decide what one not there means, and one found there meanwhile is the folder\'s (writeId)';
  const FREE = 'a name looked for free before a move or a gallery\'s first folder: the move looks again (moveSync), the folder is made exclusively';
  const NOTHING = 'a failed listing or look deletes nothing, and changes nothing recorded';
  /** @type {[string, string, string][]} file, a part of the line, why */
  const allowed = [
    ['files.js', 'try { return disk.readFileSync(idFile(libraryDir), \'utf8\'); } catch (e) { if (e.code === \'ENOENT\') return null;', START],
    ['files.js', 'const st = await disk.stat(dir, { bigint: true }).catch((e) => { if (e?.code === \'ENOENT\') return null;', START],
    ['files.js', 'const ids = await disk.readdir(librariesDir)', DATA],
    ['files.js', 'const note = await disk.readFile(path.join(librariesDir, id, FIRST_NOTE)', DATA],
    ['files.js', 'else if (disk.existsSync(index) && !earlierIndex(index))', DATA],
    ['files.js', 'if (await disk.readFile(file, \'utf8\').catch(() => null) !== text) {', DATA],
    ['files.js', 'if (e?.code !== \'ENOENT\' && e?.code !== \'ENOTDIR\' && e?.reason !== \'outside\') return \'unavailable\';',
      'a library folder\'s identity (principle 1), the shared rule\'s own look: one not there refuses (other-library, unavailable)'],
    ['files.js', 'while (disk.existsSync(path.join(dir, ...name.split(\'/\')))) name = rel.replace(', FREE],
    ['files.js', 'while (disk.existsSync(path.join(dir, ...name.split(\'/\')))) name = s.rel.replace(', FREE],
    ['files.js', 'fresh && dir != null && disk.existsSync(path.join(dir, ...n.split(\'/\')))', FREE],
    ['files.js', 'if (!fresh) return dir != null && disk.existsSync(path.join(dir, ...suffixed.split(\'/\')))', FREE],
    ['files.js', '|| disk.existsSync(this._abs(rel));', FREE],
    ['files.js', '(await classifyAt(abs, await disk.readdir(abs, { withFileTypes: true })).catch(() => null))?.kind === \'gallery\'',
      'an upgrade\'s retired rows: a folder that can\'t be told for a gallery\'s has nothing retired from it, and stays'],
    ['files.js', 'if (!disk.existsSync(this._abs(row.path))) return false;', 'a publication waits while the gallery\'s folder isn\'t there: tried again'],
    ['files.js', 'if (src?.kind === \'dir\') return disk.access(path.join(this._sourceAbs(row), orig.entry)).then(() => true, () => false);',
      'which pictures a backup lists (hasOriginal): decides nothing the library records'],
    ['files.js', 'if (row.format === \'folder\') return disk.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);',
      'which pictures a backup lists (hasOriginal): decides nothing the library records'],
    ['files.js', '(await disk.readdir(dir).catch(() => null))?.length === 0;', `${NOTHING}: a folder that can't be listed isn't taken for empty`],
    ['folders.js', 'const there = !b.files || disk.existsSync(lib.files._abs(b.files.path));', 'galleries an unreleased build set aside (§8, review 4 O5)'],
    ['folders.js', 'if (!(await disk.stat(abs).then(st => st.isDirectory(), () => false)))', 'a folder to add that can\'t be looked at is refused'],
    ['library.js', 'if (!disk.existsSync(root)) throw new BackendError(\'unavailable\'', 'a staged write refused while its library folder isn\'t there'],
    ['library.js', 'if (e.code !== \'ENOENT\') throw e;', 'a staged write whose folder was cleared meanwhile: the folder made again (a write, not a read)'],
    ['library.js', 'disk.access(this._staged(o.file)).then(() => true, () => false)', 'which pictures a backup lists (_origExists): decides nothing the library records'],
    ['library.js', 'for (const name of await disk.readdir(dir).catch(() => [])) await disk.rm(', NOTHING],
    ['remove.js', 'if (disk.existsSync(file)) await disk.rm(', NOTHING],
    ['scan.js', 'const stat = await disk.stat(file).catch(() => null);', `${NOTHING}: a leftover that can't be looked at isn't old`],
    ['scan.js', '(await disk.readdir(library.rootDir(id)).catch(() => []))', 'a count for the progress shown'],
    ['scan.js', 'for (const item of await disk.readdir(dir, { withFileTypes: true }).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const gid of await disk.readdir(dir).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const name of await disk.readdir(path.join(dir, gid)).catch(() => [])) {', `${NOTHING} (leftovers)`],
    ['scan.js', 'for (const name of await disk.readdir(path.join(dir, ...sub.split(\'/\'))).catch(() => [])) {', `${NOTHING} (leftovers)`],
  ];
  const used = new Set();
  const offenders = [];
  for (const f of readdirSync(server).filter((f) => f.endsWith('.js') && f !== 'folder-store.js')) {
    for (const line of code(read(f)).split('\n')) {
      if (!((READ.test(line) && NONE.test(line)) || CODE.test(line) || EXISTS.test(line))) continue;
      const at = allowed.findIndex(([file, part]) => file === f && line.includes(part));
      if (at < 0) offenders.push(`${f}: ${line.trim()}`); else used.add(at);
    }
  }
  assert.deepEqual(offenders, [], 'read through folder-store.js textIn / entriesIn / statIn (or say why here)');
  assert.deepEqual(allowed.filter((_, i) => !used.has(i)).map(([f, part]) => `${f}: ${part}`), [], 'stale entries');
});
