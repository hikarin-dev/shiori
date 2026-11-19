// stale-view-operations.mjs — the operations of the stale-view table (folder-stale-view.test.mjs, S31) as the code
// that does each on each app, and what the fitness tests (architecture-fitness.test.mjs here, and the desktop's in
// desktop/tests) hold every function of the library's modules to that writes into, moves, unpacks, archives into or
// deletes at a gallery's place. Review 8: an operation that did so from a view older than the folder's — the other
// app had published the gallery there since — wrote over it, or deleted what it named. Every such operation holds
// the place first, through its library's one gateway (desktop files.js hold; website db.js _hold), and has a row in
// the table, run on both apps from each form of older view. So each function a direct write at a place is found in
// (WRITES below) is, in PLACE_WRITERS:
// - 'holds': it holds the place through the gateway (its own code calls it), and is the code of an operation
//   (OPERATIONS) — unless `{ holds: why }` says why no older view can reach it;
// - { step: '<file> <function>' }: only a step of that function (which holds, or is a step of one that does), whose
//   own code calls it;
// - { after: '<file> <function>' }: it writes into the place that holding function hands it;
// - { free: why }: it touches no gallery's version another app may have published, and why.
// A function a write is found in and named nowhere here fails, as does an entry naming no function there.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Each operation of the table: the functions that do it, per app it applies to.
export const OPERATIONS = {
  'a title': { desktop: ['files.js describe', 'files.js _publish', 'files.js _describeArchiveNow'], website: ['db.js _describe'] },
  'a translation': { desktop: ['files.js home', 'files.js _place', 'files.js _settleArchive', 'files.js _unpack'], website: ['db.js _place', 'db.js _home', 'db.js _relocateOnce'] },
  'a page added': { desktop: ['files.js _place', 'files.js _moveIn', 'files.js _settleArchive', 'files.js _unpack'], website: ['db.js _place', 'db.js _home', 'db.js _relocateOnce'] },
  'a change waiting from the drive\'s absence, published at the take-back': { desktop: ['files.js place', 'files.js describe', 'files.js _publish', 'files.js _letGo'], website: ['db.js settleFolders', 'db.js _describe', 'db.js _relocateOnce'] },
  'the person\'s deletion': { desktop: ['files.js _deleteOne', 'files.js _removeOwn'], website: ['db.js _deleteOne', 'db.js _deleteOverlay'] },
  'a deletion owed from before': { desktop: ['files.js _deleteOne', 'folders.js _publishRemoved', 'files.js _removeOwn'], website: ['db.js _deleteOne', 'db.js _publishRemoved', 'db.js _deleteOverlay'] },
  'a move to another folder': { desktop: ['files.js moveTo'], website: ['db.js _relocateOnce'] },
  'a move into this library\'s own place': { desktop: ['files.js moveTo'], website: ['db.js _relocateOnce'] },
  'a removal moving its galleries': { desktop: ['folders.js _remove', 'files.js moveTo'], website: ['folder-library.js _setAside', 'db.js _relocateOnce'] },
  'a removal\'s write-back': { desktop: ['folders.js _writeBack', 'files.js describe', 'files.js _publish'], website: ['folder-library.js _writtenBack', 'db.js _describe'] },
  'archiving': { desktop: ['files.js archive', 'files.js _retire'] },
  'a regroup': { desktop: ['files.js _place', 'files.js _regroup'] },
  'a start with work left over': { desktop: ['files.js start', 'files.js place', 'files.js _letGo'], website: ['db.js settleFolders', 'db.js _describe'] },
  'a PDF\'s first drawing': { desktop: ['linked.js addRendered'], website: ['folder-library.js addRendered'] },
};

const OWN = 'the library\'s own staging or cache, which no folder\'s publication names';
const MADE = 'only what a write of this library made moments ago under a name no file had (or a place its reservation made), when that write didn\'t commit';
const MARKER = 'an overlay\'s source.json — the link\'s marker, which no publication names — written with what it says as read now';
export const PLACE_WRITERS = {
  desktop: {
    'files.js writeId': { free: 'the library\'s id file, in its own folder' },
    'files.js firstLibrary': { free: 'the library\'s own folder, made' },
    'files.js noteFirst': { free: 'a note in the app\'s own libraries folder' },
    'files.js moveSync': { free: 'the move itself (a primitive): each caller is named here' },
    'files.js movedInto': { free: 'a staged file\'s move (a primitive): each caller is named here' },
    'files.js _carryOver': { free: 'an unfinished file of the released version renamed beside it under a name no file has: nothing published (the publication naming it holds the place)' },
    'files.js _bindUndescribed': { free: 'only a folder holding no description (folder-store.js undescribedAt): no publication there to weigh — bound as a reservation binds a new one' },
    'files.js cutBack': { free: 'only the bytes past an archive\'s described end that this library\'s own addition, cut short, left (another app\'s addition moves that end)' },
    'files.js _reserveAt': { free: 'a new place: reserveIn makes it exclusively' },
    'files.js _deleteOne': 'holds',
    'files.js _removeOwn': 'holds',
    'files.js _remove': { free: 'the deletion of a folder or archive by its path (a primitive): each caller is named here' },
    'files.js _delete': { free: 'the deletion itself (a primitive): each caller is named here' },
    'files.js _tidy': { free: 'a series\' folder left holding only its series.json and the system\'s files: no gallery\'s place' },
    'files.js _discard': { step: 'files.js _deleteOne' },
    'files.js home': 'holds',
    'files.js _place': 'holds',
    'files.js toFormat': { holds: 'run only by the check that has just read the gallery, in the desktop\'s oldest format, whole (scan.js): no older view to meet — held all the same' },
    'files.js _moveIn': { step: 'files.js _place' },
    'files.js _moveOwnIn': { step: 'files.js _place' },
    'files.js _regroup': { step: 'files.js _place' },
    'files.js _unpack': { step: 'files.js _place' },
    'files.js _unstage': { free: OWN },
    'files.js _publish': 'holds',
    'files.js _describeArchiveNow': 'holds',
    'files.js _settleArchive': { step: 'files.js _place' },
    'files.js _compact': { step: 'files.js _settleArchive' },
    'files.js _describeSeries': { free: 'a series\' series.json, which no gallery\'s publication names (each member\'s place is held by what moves it: _regroup, moveTo)' },
    'files.js moveTo': 'holds',
    'files.js archive': 'holds',
    'files.js _retire': { step: 'files.js archive' },
    'files.js _letGo': 'holds',
    'scan.js unpackSeries': { free: 'a new place under a free name (files.js _freePath): a series export\'s entries copied out as they are' },
    'scan.js scanLibrary': { free: 'a series export — an archive that is no gallery\'s place (its chapters are unpacked out of it) — deleted once each chapter joined' },
    'scan.js sweepLeftovers': { free: 'the temporary files of writes cut short (.shiori-tmp, -old, -new), which no publication names' },
    'scan.js removeOrphans': { free: OWN },
    'linked.js writeIn': { free: MARKER },
    'linked.js addRendered': 'holds',
    'linked.js redrawn': { free: OWN },
    'folders.js _writeClaim': { free: 'the folder\'s claim (owner.json): no gallery\'s place' },
    'folders.js _publishRemoved': 'holds',
    'folders.js _writeRemoved': { step: 'folders.js _publishRemoved' },
    'library.js constructor': { free: 'the deletion itself (library.remove, a primitive) defined: each caller is named here' },
    'library.js open': { free: OWN },
    'library.js _tx': { free: `${OWN}: what a transaction made, or let go` },
    'library.js _mkdir': { free: OWN },
    'library.js _writeOwn': { after: 'files.js home' },
    'library.js _externalize': { free: MADE },
    'library.js _writeStaged': { free: OWN },
    'library.js _clearStaging': { free: OWN },
    'library.js _derive': { free: MADE },
    'library.js coverThumbnailPut': { free: MADE },
    'library.js _transferPage': { after: 'files.js home' },
    'library.js _transferDiscard': { free: MADE },
    'library.js clearAll': { free: OWN },
  },
  website: {
    'db.js _writeClaim': { free: 'the folder\'s claim (owner.json): no gallery\'s place' },
    'db.js _reserveDir': { free: 'a new place: reserveDir makes it exclusively' },
    'db.js _place': 'holds',
    'db.js _writing': { free: MADE },
    'db.js _discard': { free: MADE },
    'db.js _deleteOne': 'holds',
    'db.js _deleteDir': { step: 'db.js _deleteOne' },
    'db.js _publishRemoved': 'holds',
    'db.js _deleteOverlay': 'holds',
    'db.js _describe': 'holds',
    'db.js _relocateOnce': 'holds',
    'db.js _relocateLocked': { free: MADE },
    'db.js _unpackLocked': { free: MADE },
    'db.js _publishUnpacked': { step: 'db.js _relocateOnce' },
    'db.js clearAll': { free: 'the person\'s clearing of the library: their own deletion of every gallery, made now, which takes each whatever its place holds (S29a\'s rule 3)' },
    'folder-library.js folderAdd': { free: 'the library\'s id file in the folder (library.json): no gallery\'s place' },
    'folder-library.js addRendered': 'holds',
    'folder-library.js pdfFailed': { free: MARKER },
    // (Hidden from the rule until S32 by a `/*` inside a line comment above it: review 9 A2.)
    'folder-library.js _overlayFor': { free: MARKER },
  },
};

// What is a direct write at a place, per app: a call of the file system's writes, moves and deletions, of the
// adapter's write primitives, or of the library's own deletion helpers; and the gateway.
export const SCAN = {
  desktop: {
    dir: 'desktop/server', modules: ['files.js', 'scan.js', 'linked.js', 'folders.js', 'library.js'],
    writes: /\bdisk\.(?:rename|renameSync|rm|rmSync|rmdir|rmdirSync|cp|copyFile|copyFileSync|writeFile|writeFileSync|truncateSync|mkdir|mkdirSync)\s*\(|\b(?:moveSync|movedInto|replaceFile|appendZip|writeZip|publishIn|deleteGalleryIn|deleteNamedIn|writeNewIn|bindIn|reserveIn|ownDirIn)\s*\(|\blibrary\.remove\s*\(|\bthis\.remove\s*\(/,
    helpers: { 'files.js': /\bthis\.(?:_delete|_remove|_discard)\s*\(/, 'scan.js': /\bfiles\.(?:_delete|_remove|_discard)\s*\(/ },
    gateway: /\b(?:this|files|library\.files|lib\.files)\.hold\s*\(/,
  },
  website: {
    dir: 'app/js', modules: ['db.js', 'folder-library.js'],
    writes: /\bfolderFiles\.(?:writeFile|removeFile|removeDir|writeNew|publishIn|deleteNamedIn|deleteGalleryIn|reserveDir)\s*\(|\.dir\.(?:publish|writeNew|deleteNamed)\s*\(|\.root\.reserve\s*\(/,
    helpers: { 'db.js': /\b(?:_deleteDir|_discard)\s*\(/ },
    gateway: /\b(?:_hold|K\.hold)\s*\(/,
  },
};

// Comments taken out of `src` as JavaScript reads it, so prose never counts as code (line count kept): a `/*` or
// `//` inside a string, a template or a regular expression opens nothing, and a `/*` inside a line comment neither
// (review 9 A2: one there hid 210 lines of folder-library.js). Throws where the source ends inside a comment, a
// string or a template: a range the rule can't read is a failure, never a blind spot.
export function code(src) {
  let out = '', i = 0, prev = '';   // `prev`: the last character of code, telling a regular expression from a division
  const n = src.length, braces = [];   // in a template's ${…}: the brace depth it opened at
  let depth = 0;
  const regexMayStart = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await|throw|delete)\s*$/.test(out);
  const fail = (what) => { throw new Error(`${what} not closed (line ${src.slice(0, i).split('\n').length})`); };
  const template = () => {   // from just after a backtick (or a ${…}'s closing brace) to its end, or a ${
    for (;;) {
      if (i >= n) fail('a template');
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; prev = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; braces.push(depth); depth++; prev = '{'; return; }
      out += c; i++;
    }
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('a comment');
      out += src.slice(i, end + 2).replace(/[^\n]/g, '');
      i = end + 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      const start = i++;
      while (i < n && src[i] !== c) { if (src[i] === '\n') fail('a string'); i += src[i] === '\\' ? 2 : 1; }
      if (i >= n) fail('a string');
      out += src.slice(start, ++i);
      prev = c;
      continue;
    }
    if (c === '`') { out += c; i++; template(); continue; }
    if (c === '/' && regexMayStart()) {
      const start = i++;
      let inClass = false;
      for (; i < n; i++) {
        const x = src[i];
        if (x === '\n') fail('a regular expression');
        if (x === '\\') { i++; continue; }
        if (inClass) { if (x === ']') inClass = false; } else if (x === '[') inClass = true; else if (x === '/') break;
      }
      if (i >= n) fail('a regular expression');
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      out += src.slice(start, i);
      prev = '/';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (braces.length && depth === braces[braces.length - 1]) { braces.pop(); out += c; i++; template(); continue; }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
// What a function's first line looks like (a top-level function, a `const name =`, a class's method two spaces in).
const DECLARED = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:export\s+)?const\s+([\w$]+)\s*=|^ {2}(?:async |static )?(?!(?:if|for|while|switch|catch|return)\b)([A-Za-z_$][\w$]*)\s*\(.*\)\s*\{\s*$/;
// Each function of `src` and its code. Throws where a declaration the source shows is hidden once its comments are
// out (a range the rule didn't read: review 9 A2).
export function functionsOf(src) {
  const out = new Map();
  let at = null;
  const lines = code(src).split('\n');
  const shown = src.split('\n').filter(l => DECLARED.test(l)).length, read = lines.filter(l => DECLARED.test(l)).length;
  if (read < shown) throw new Error(`${shown - read} of ${shown} declarations aren't read as code: a range of the file is hidden`);
  for (const line of lines) {
    const m = DECLARED.exec(line);
    if (m) { at = m[1] ?? m[2] ?? m[3]; if (!out.has(at)) out.set(at, []); }
    if (at) out.get(at).push(line);
  }
  return new Map([...out].map(([name, lines]) => [name, lines.join('\n')]));
}

// What app `app`'s modules (`read(module)`: its source; the files as they are by default) break of the rule above:
// a list of what is wrong, each naming the function — empty when every function writing at a place is accounted for.
export function placeWritersOff(app, { read = (f) => readFileSync(join(repo, SCAN[app].dir, f), 'utf8'), writers = PLACE_WRITERS[app], operations = OPERATIONS } = {}) {
  const scan = SCAN[app];
  const fns = new Map();
  for (const f of scan.modules) for (const [name, body] of functionsOf(read(f))) fns.set(`${f} ${name}`, body);
  const writes = (key) => { const [f] = key.split(' '); const body = fns.get(key) ?? ''; return scan.writes.test(body) || !!scan.helpers[f]?.test(body); };
  const called = (key, by) => new RegExp(`\\b${key.split(' ')[1].replace(/\$/g, '\\$')}\\s*\\(`).test(fns.get(by) ?? '');
  const rowed = new Set(Object.values(operations).flatMap(o => o[app] ?? []));
  const holds = (key) => writers[key] === 'holds' || !!writers[key]?.holds;
  const out = [];
  for (const key of fns.keys()) if (writes(key) && !(key in writers)) out.push(`${key}: writes at a place — name it: 'holds' (and an operation of the table), a step of one, or free (and why)`);
  for (const [key, how] of Object.entries(writers)) {
    if (!fns.has(key)) { out.push(`${key}: no such function (a stale entry)`); continue; }
    if (holds(key)) {
      if (!scan.gateway.test(fns.get(key))) out.push(`${key}: said to hold its place, but never calls the gateway`);
      if (how === 'holds' && !rowed.has(key)) out.push(`${key}: holds, but is no operation's code in the stale-view table`);
    } else if (how.step) {
      if (!(how.step in writers) || writers[how.step].free || writers[how.step].after) out.push(`${key}: a step of ${how.step}, which neither holds nor is a step of one that does`);
      else if (!called(key, how.step)) out.push(`${key}: a step of ${how.step}, which doesn't call it`);
    } else if (how.after) {
      if (!holds(how.after)) out.push(`${key}: writes after ${how.after}, which doesn't hold`);
    } else if (!how.free) out.push(`${key}: classified as nothing known`);
  }
  for (const fn of new Set(Object.values(operations).flatMap(o => o[app] ?? []))) if (!fns.has(fn)) out.push(`${fn}: an operation's code, but no such function`);
  return out;
}
