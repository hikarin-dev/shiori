// gallery-lives.mjs — S34 (review 11): the functions of the libraries' modules that work on a gallery across an await,
// and where each asks whether the gallery it began for is still the id's — what the fitness tests
// (architecture-fitness.test.mjs) hold every such function to. A gallery deleted and made again under its id is another
// gallery with the same key: work that read or wrote the index by id after an await without asking acted on the one
// made again (review 11: a settle, an archive's settle and publication, a move, a check, a publication).
// - The desktop (files.js life, still): every function of its file layer, its check and its linked galleries' module in
//   which a read or write by gallery id follows an await is named in WORK.desktop — 'asks': its code asks (`.still(`,
//   or a check's `current(`);
//   { step: '<file> <function>' }: a step of that function, which asks, and whose code calls it; { free: why }: what it
//   reads or writes by id is no work begun for a gallery before the await.
// - The website (db.js _life, _still, its gallery lock): every function that writes a gallery's pictures under its
//   lock (_writing) names the write in its commit's transaction (`tx._write = w`), which the mount check refuses
//   once the gallery has ended (_logIn) — or is named in WORK.website ({ step } or { free }); a publication asks
//   (`_still(`).
// A function the scan finds and names nowhere fails, as does an entry naming no function.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionsOf } from './stale-view-operations.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const WORK = {
  desktop: {
    'files.js hold': 'asks',
    'files.js _place': 'asks',
    'files.js toFormat': 'asks',
    'files.js _moveIn': 'asks',
    'files.js _moveOwnIn': 'asks',
    'files.js _unpack': 'asks',
    'files.js describe': 'asks',
    'files.js _publish': 'asks',
    'files.js _describeArchiveNow': 'asks',
    'files.js _archiveChanges': 'asks',
    'files.js _settleArchive': 'asks',
    'files.js _compact': 'asks',
    'files.js moveTo': 'asks',
    'files.js _archiveEntries': 'asks',
    'files.js archive': 'asks',
    'files.js cutBack': 'asks',
    'files.js finishMoves': 'asks',
    'files.js _seen': 'asks',
    'files.js _bindUndescribed': 'asks',
    'scan.js scanLibrary': 'asks',
    'scan.js refreshGallery': 'asks',
    'scan.js followUnpacked': 'asks',
    'scan.js folderStands': 'asks',
    'scan.js reread': { step: 'scan.js refreshGallery' },
    'linked.js adoptLinked': 'asks',
    'linked.js linkRoot': 'asks',
    'linked.js addRendered': 'asks',
    'linked.js redrawn': 'asks',
    'linked.js waiting': { free: 'a read: whether a PDF waits to be drawn (it changes nothing)' },
    'files.js _carryOver': { free: 'an earlier build\'s tables carried over: each row read as it is acted on, in one synchronous step' },
    'files.js _deleteOne': { free: 'a deletion: it acts for a gallery that is gone by design, on its own record (read again once its gallery\'s work is over: _underWay), never at a place a gallery\'s row points at now' },
    'files.js ownNames': { free: 'a read: it changes nothing' },
    'files.js _read': { free: 'a read: it changes nothing' },
    'files.js _unstage': { free: 'the id\'s folder in staging, removed only while nothing is staged for the id, asked again as it goes: whichever gallery of the id stages next makes it again' },
    'scan.js finishUnfound': { free: 'deletions of galleries that are gone: what it reads by id is whether the library has one now (a gallery made again under the id is none of them)' },
    'scan.js removeOrphans': { free: 'the library\'s own cache files no record names: by name, no gallery\'s work' },
  },
  website: {
    'db.js _writing': { free: 'the gateway itself (it gives each write its `w`, the gallery it began for): the writes name themselves' },
    'db.js _relocate': { free: 'its commit is _relocateOnce\'s (through _relocateLocked), which names the write' },
    'folder-library.js _writtenBack': { free: 'a removal\'s write-back: a folder of the gallery\'s own reserved in the folder being removed, whose galleries can\'t be deleted meanwhile (the mount check refuses it)' },
  },
};

// What a read or write by gallery id is, per app (desktop: the file layer's own reads of the index and its
// statements keyed by gallery).
const BY_ID = /\b(?:this|files|lib\.files|library\.files)\.(?:_row|_staged|_stagedOwn|_stamp|_retiring|_descriptions|_generation|_recorded|_signature)\s*\(|\b(?:lib|library|this)\.(?:_pageRows|_pageRow|_metaGet|_coverGet|_statGet)\s*\(|gid = \?/;
export const SCAN = {
  desktop: { dir: 'desktop/server', modules: ['files.js', 'scan.js', 'linked.js'], asks: /\.still\s*\(|\bcurrent\s*\(/ },
  website: { dir: 'app/js', modules: ['db.js', 'folder-library.js'], asks: /\b_still\s*\(|\._write\s*=\s*w\b/, writes: /\b(?:_writing|K\.writing)\s*\(/ },
};

// What app `app`'s modules (`read(module)`: its source) break of the rule above: a list of what is wrong, each naming
// the function — empty when every function working on a gallery across an await is accounted for.
export function livesOff(app, { read = (f) => readFileSync(join(repo, SCAN[app].dir, f), 'utf8'), work = WORK[app] } = {}) {
  const scan = SCAN[app];
  const fns = new Map();
  for (const f of scan.modules) for (const [name, body] of functionsOf(read(f))) fns.set(`${f} ${name}`, body);
  const works = (body) => (app === 'desktop' ? (body.search(/\bawait\b/) >= 0 && BY_ID.test(body.slice(body.search(/\bawait\b/)))) : scan.writes.test(body));
  const out = [];
  for (const [key, body] of fns) {
    if (!works(body) || key in work) continue;
    if (app === 'website' && scan.asks.test(body)) continue;   // names its write in its commit (or asks)
    out.push(app === 'desktop' ? `${key}: works on a gallery by id across an await — name it: 'asks', a step of one that does, or free (and why)`
      : `${key}: writes a gallery's pictures under its lock without naming the write in its commit (tx._write = w) — name it a step or free (and why)`);
  }
  for (const [key, how] of Object.entries(work)) {
    if (!fns.has(key)) { out.push(`${key}: no such function (a stale entry)`); continue; }
    if (how === 'asks') { if (!scan.asks.test(fns.get(key))) out.push(`${key}: said to ask, but never does`); }
    else if (how.step) {
      if (work[how.step] !== 'asks' && !(app === 'website' && fns.has(how.step) && scan.asks.test(fns.get(how.step)))) out.push(`${key}: a step of ${how.step}, which doesn't ask`);
      else if (!new RegExp(`\\b${key.split(' ')[1].replace(/\$/g, '\\$')}\\s*\\(`).test(fns.get(how.step) ?? '') && !new RegExp(`\\b${how.step.split(' ')[1]}\\s*\\(`).test(fns.get(key) ?? '')) out.push(`${key}: a step of ${how.step}, but neither calls the other`);
    } else if (!how.free) out.push(`${key}: classified as nothing known`);
  }
  if (app === 'website' && !scan.asks.test(fns.get('db.js _describe') ?? '')) out.push('db.js _describe: a publication that never asks');
  return out;
}
