// shell.mjs — the service worker of a built site: what it keeps of the site, each file's hash, the one
// id that names them all, and the worker itself, built as one file.
//
// The rule: a build whose files differ in any way is a new worker with its own complete cache, and it
// installs whole before it takes over, or not at all. So:
//   - the list carries each file the worker keeps with a hash of its bytes, and one id over them all
//     (each as its path and its hash), which ends the cache's name (sw.js);
//   - the worker is one file, with what it imports and the list inside it: any change to any file the
//     worker keeps or runs changes the worker's own file, which is what makes a browser replace it, and
//     there is no import of it for a host to serve older than the worker (a host's edges keep a file
//     for minutes after a deploy; a worker built from a new sw.js and an old import stayed that way
//     until the next release; and Chrome gives up a new worker that asks for two of its unchanged
//     imports at once, seen in Chrome 158);
//   - its install fetches each file past the browser's cache and checks its bytes against the list,
//     failing whole on a mismatch (the worker before it stays in charge, and the browser tries again).
// The modules the worker shares with the pages are copies in the worker's own global: they always
// were (a worker never shared a module instance with a page), now inside its file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rolldown } from 'rolldown';

// Every file of the built site but the worker and its list themselves, which a browser never takes
// from a worker's cache; 404.html, a host's answer and never the worker's; and source maps.
const NOT_KEPT = new Set(['sw.js', 'shell-files.js', '404.html']);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// The files of the site in `dir` the worker keeps (sorted, as paths from the site's root), their id,
// and the hash of every file the worker may keep: those, and `leftOut`, the files of the bundle that
// only a route the worker doesn't install draws with (start.mjs, notInstalled), fetched when first
// asked for and kept from then on.
export function shellFiles(dir, leftOut = []) {
  const left = new Set(leftOut);
  const all = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !NOT_KEPT.has(file) && !file.endsWith('.map'))
    .sort();
  const hashes = Object.fromEntries(all.map((file) => [file, sha256(fs.readFileSync(path.join(dir, file)))]));
  const files = all.filter((file) => !left.has(file));
  const id = sha256(JSON.stringify(files.map((file) => [file, hashes[file]]))).slice(0, 12);
  return { files, id, hashes };
}

// shell-files.js: the list, as the worker is built with it (and as the tests read it in the built site).
export const shellModule = ({ files, id, hashes }) => [
  '// Written by the build (build/shell.mjs): the files of the built site the service worker keeps, their',
  '// id (a hash over every one of them, so any change to any file is another id), and the hash of the',
  '// bytes of every file the worker may keep (those, and what is fetched when first shown).',
  'export const SHELL = [',
  ...files.map((file) => `  ${JSON.stringify(file)},`),
  '];',
  `export const SHELL_ID = ${JSON.stringify(id)};`,
  'export const HASHES = {',
  ...Object.entries(hashes).map(([file, hash]) => `  ${JSON.stringify(file)}: ${JSON.stringify(hash)},`),
  '};',
  '',
].join('\n');

// A module of the worker that finds a file from its own address (import.meta.url) keeps finding it
// there: inside the worker's one file, its address is said from the worker's (the site's root).
function ownAddresses(dir, entry) {
  return {
    name: 'shiori:worker-own-addresses',
    transform(code, id) {
      const file = path.resolve(id.split('?')[0]);
      if (file === entry || !code.includes('import.meta')) return null;
      const rel = path.relative(dir, file).split(path.sep).join('/');
      const out = code.replace(/\bimport\.meta\.url\b/g, `new URL(${JSON.stringify(rel)}, self.location.href).href`);
      if (/\bimport\.meta\b/.test(out)) throw new Error(`${rel}: the worker's one file can't carry its import.meta`);
      return { code: out, map: null };
    },
  };
}

// Finishes the built site in `dir`, whose sw.js is the worker's source as copied there (its imports
// resolved against the built site, so it is built with the very copies the site serves): writes its
// shell-files.js, then the worker as one file in place of its source. Resolves the list.
export async function writeWorker(dir, leftOut = []) {
  const shell = shellFiles(dir, leftOut);
  fs.writeFileSync(path.join(dir, 'shell-files.js'), shellModule(shell));
  const entry = path.resolve(dir, 'sw.js');
  // (Its modules said from the site's root where each begins: `// app/js/platform.js`, the same bytes
  // wherever the build runs.)
  const bundle = await rolldown({ input: entry, cwd: path.resolve(dir), plugins: [ownAddresses(path.resolve(dir), entry)],
    onLog: (level, log) => { if (level === 'warn') throw new Error(`the worker's build: ${log.message}`); } });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    if (output.length !== 1 || output[0].type !== 'chunk') throw new Error(`the worker's build made ${output.length} files, not one`);
    fs.writeFileSync(entry, output[0].code);
  } finally { await bundle.close(); }
  return shell;
}
