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
