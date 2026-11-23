// shell.mjs — what the service worker keeps of a built site, and the one id that names it.
//
// The rule: a build whose files differ in any way is a new worker with its own complete cache, and
// it installs whole before it takes over. So the id is a hash over every file the worker keeps —
// each as its path and a hash of its bytes — and the same id ends the cache's name (sw.js) and the
// built worker's own file. The second is what makes a browser replace the worker: it does so when
// the worker's file changed, and not reliably when only a module it imports did — Chrome starts the
// new worker and gives it up ("Failed to update a ServiceWorker") when that worker asks for two of
// its unchanged imports at once, as this one does (seen in Chrome 158).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Every file of the built site but the worker and its list themselves, which a browser never takes
// from a worker's cache; 404.html, a host's answer and never the worker's; and source maps.
const NOT_KEPT = new Set(['sw.js', 'shell-files.js', '404.html']);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// The files of the site in `dir` the worker keeps (sorted, as paths from the site's root), and
// their id.
export function shellFiles(dir) {
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !NOT_KEPT.has(file) && !file.endsWith('.map'))
    .sort();
  const id = sha256(JSON.stringify(files.map((file) => [file, sha256(fs.readFileSync(path.join(dir, file)))]))).slice(0, 12);
  return { files, id };
}

// shell-files.js, the module sw.js imports.
export const shellModule = ({ files, id }) => [
  '// Written by the build (build/shell.mjs): the files of the built site the service worker keeps,',
  '// and their id — a hash over every one of them, so any change to any file is another id.',
  'export const SHELL = [',
  ...files.map((file) => `  ${JSON.stringify(file)},`),
  '];',
  `export const SHELL_ID = ${JSON.stringify(id)};`,
  '',
].join('\n');

// The line that ends the built sw.js.
export const shellStamp = (id) => `\n// The files this worker was built with (shell-files.js): ${id}\n`;

// Finishes a built site in `dir`: writes its shell-files.js and ends its sw.js with the id.
// `worker` is sw.js as it is written (the stamp is put on that, so a site is finished the same
// whether or not it was finished before).
export function writeShell(dir, worker) {
  const shell = shellFiles(dir);
  fs.writeFileSync(path.join(dir, 'shell-files.js'), shellModule(shell));
  fs.writeFileSync(path.join(dir, 'sw.js'), worker + shellStamp(shell.id));
  return shell;
}
