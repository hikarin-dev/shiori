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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appJs = join(repo, 'app', 'js');
// Every module of the app, as its path in app/js ('db.js', 'storage/folder-owner.js').
const modules = readdirSync(appJs, { recursive: true }).map((f) => f.replace(/\\/g, '/')).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(appJs, f), 'utf8');

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

test('the app never names a source site or the companion helper', () => {
  // The app is site-agnostic and must carry no evidence of the companion relationship in
  // user-facing copy. Bridge message names (EXT_*) are the sanctioned contract and stay.
  const banned = /\b(?:nhentai|hitomi|exhentai|e-hentai|mangafire)\b/i;
  const offenders = [];
  for (const f of modules) if (banned.test(read(f))) offenders.push(`app/js/${f}`);
  for (const f of readdirSync(join(repo, 'app')).filter((x) => /\.(html|css)$/.test(x))) {
    if (banned.test(readFileSync(join(repo, 'app', f), 'utf8'))) offenders.push(`app/${f}`);
  }
  assert.deepEqual(offenders, [], 'source-site names must exist only in the private companion');
});

test('the app never opens the browser\'s own confirm / alert / prompt boxes', () => {
  // notice.js has the app's styled replacements (confirmDialog / alertDialog / promptDialog).
  const native = /(^|[^.\w])(?:window\.)?(?:confirm|alert|prompt)\s*\(/m;
  const offenders = modules.filter((f) => native.test(code(read(f))));
  assert.deepEqual(offenders, [], 'use notice.js dialogs instead of window.confirm/alert/prompt');
});

test('no third-party acquisition URLs are constructed in the app', () => {
  const offenders = [];
  for (const f of modules) {
    const src = code(read(f));
    const hits = [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)]
      .map((m) => m[0])
      // The user-configured translation server default is local and explicitly user-owned.
      .filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u))
      // Namespace/spec URLs are not network acquisition (SVG xmlns and friends).
      .filter((u) => !/w3\.org|schema\.org/.test(u))
      // This project's own release downloads are its own artifacts, not a content source.
      .filter((u) => !/^https:\/\/github\.com\/hikarin-dev\/shiori\//.test(u));
    if (hits.length) offenders.push(`app/js/${f}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'the app must not know where external content comes from');
});
