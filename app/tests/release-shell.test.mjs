// release-shell.test.mjs — deployment integrity. The site that is served is the built one (dist/:
// the one page with its bundle, and the app's other files copied as they are), so "deployable"
// means: every runtime root file is in it, every file the worker precaches is in it, every app/js
// module is in that precache list (or it silently breaks offline only) and is the file it is in the
// sources, and every page resolves its static assets — including a direct app/<page>.html load with
// no worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtSite } from '../../build/built.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
// The built site (throws, saying so, when there is none or a source changed since: npm run build).
const built = (rel) => join(builtSite(), rel);
// Every file under a folder of the repo, as its path from the repo ('app/js/storage/contract.js').
const filesUnder = (dir, root = repo) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile()).map((f) => join(f.parentPath, f.name).slice(root.length + 1).replace(/\\/g, '/'));
// Every app/js module, its subfolders' too.
const appModules = () => filesUnder('app/js').filter((f) => f.endsWith('.js'));

// The files the worker precaches: the list the build wrote into the built site, which sw.js imports.
const shellFiles = async () => (await import(pathToFileURL(built('shell-files.js')).href)).SHELL;

test('the runtime root files are present', () => {
  for (const required of ['index.html', '404.html', 'sw.js', 'shell-files.js', 'CHANGELOG.md']) {
    assert.ok(existsSync(built(required)), `${required} is missing from the built site`);
  }
});

test('every precached SHELL file exists', async () => {
  const missing = (await shellFiles()).filter((f) => !existsSync(built(f)));
  assert.deepEqual(missing, [], 'SHELL lists files that are not in the built site');
});

test('every app/js module is precached in SHELL', async () => {
  const shell = new Set(await shellFiles());
  const missing = appModules().filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], 'app/js modules not listed in the SHELL cache');
});

test('SHELL is the whole built site, less what a worker must not keep', async () => {
  // The worker and its list are what the browser checks for a newer version: taken from the
  // worker's own cache they would never change. 404.html is a host's answer for an address it
  // doesn't have, never the worker's. A source map is nothing a page runs.
  const shell = await shellFiles();
  for (const f of ['sw.js', 'shell-files.js', '404.html']) assert.ok(!shell.includes(f), `${f} must not be in the list`);
  assert.deepEqual(shell.filter((f) => f.endsWith('.map')), []);
  const site = filesUnder('', builtSite()).filter((f) => !['sw.js', 'shell-files.js', '404.html'].includes(f) && !f.endsWith('.map'));
  assert.deepEqual(shell.toSorted(), site.toSorted(), 'every other file of the built site is listed, and nothing that isn\'t there');
  assert.equal(new Set(shell).size, shell.length, 'no file twice');
  // What the one page loads is among it: the page, and each file of its bundle.
  assert.ok(shell.includes('index.html'));
  assert.deepEqual(filesUnder('assets', builtSite()).filter((f) => !shell.includes(f)), []);
});

test('the built site carries every app/js and vendor file as the file it is', () => {
  // The bundle imports these by address and carries no copy; the worker, the desktop app and the
  // pages that have a file of their own load them from the same addresses.
  const changed = [...filesUnder('app/js'), ...filesUnder('vendor')]
    .filter((f) => !existsSync(built(f)) || !readFileSync(join(repo, f)).equals(readFileSync(built(f))));
  assert.deepEqual(changed, [], 'missing from the built site, or not the same bytes');
  // A bundle chunk sits in assets/, one folder under the site's root: what it imports from above
  // is one of those files.
  const assets = filesUnder('assets', builtSite()).filter((f) => f.endsWith('.js'));
  assert.ok(assets.length, 'the built site has a bundle');
  for (const chunk of assets) {
    for (const [, spec] of readFileSync(built(chunk), 'utf8').matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`](\.\.\/[^"'`]+)["'`]/g)) {
      assert.match(spec, /^\.\.\/(app\/js|vendor)\//, `${chunk} imports ${spec}`);
      assert.ok(existsSync(built(spec.slice(3))), `${chunk} imports ${spec}, which the built site doesn't have`);
    }
  }
});

test('the app\'s start-up is a served file, never part of the bundle: it finds the worker from its own address', () => {
  // boot-core.js takes the app's folder to be the one above its own (to retire a worker a previous
  // layout registered there) and registers sw.js two folders up. Both hold only while it is the
  // file app/js/boot-core.js: carried in a chunk under assets/, the folder above is the site's root,
  // and every page load would unregister the live worker.
  const core = read('app/js/boot-core.js');
  assert.match(core, /const _appDir = new URL\('\.\.', import\.meta\.url\)\.pathname;/);
  assert.match(core, /serviceWorker\.register\(new URL\(worker, import\.meta\.url\)/);
  assert.match(core, /'\.\.\/\.\.\/sw\.js'/);
  // The one page starts with it, by its address in app/js.
  assert.match(read('src/main.tsx'), /import\('@lib\/boot-core\.js'\)/);
  const chunks = filesUnder('assets', builtSite()).filter((f) => f.endsWith('.js')).map((f) => readFileSync(built(f), 'utf8'));
  assert.ok(chunks.some((text) => /import\(["'`]\.\.\/app\/js\/boot-core\.js["'`]\)/.test(text)), 'the bundle imports boot-core.js by address');
  for (const text of chunks) {
    assert.doesNotMatch(text, /serviceWorker\.register\(|__shioriWarmShell|getRegistrations\(\)/, 'no chunk carries the start-up\'s own code');
  }
});

test('the UI font is served locally — no hosted-font URLs anywhere in the app', () => {
  const offenders = [];
  const hosted = /fonts\.googleapis|fonts\.gstatic/;
  const scan = (rel) => { if (hosted.test(read(rel))) offenders.push(rel); };
  scan('sw.js'); scan('index.html'); scan('404.html'); scan('app/font-init.js');
  for (const f of appModules()) scan(f);
  for (const f of readdirSync(join(repo, 'app')).filter((f) => f.endsWith('.html') || f.endsWith('.css'))) scan(`app/${f}`);
  for (const f of filesUnder('src')) scan(f);
  for (const f of ['index.html', ...filesUnder('assets', builtSite())]) {
    if (hosted.test(readFileSync(built(f), 'utf8'))) offenders.push(`dist/${f}`);
  }
  assert.deepEqual(offenders, []);
});

test('the bundle carries no font file: the UI font comes from app/fonts/, at the address it always had', () => {
  const fonts = filesUnder('assets', builtSite()).filter((f) => /\.(woff2?|ttf|otf|eot)$/.test(f));
  assert.deepEqual(fonts, []);
  assert.match(readFileSync(built('index.html'), 'utf8'), /<script src="app\/font-init\.js"/, 'the one page declares the faces as every page does');
});

// Clean-URL segments the service worker / 404.html serve — not files.
const CLEAN = new Set(['', 'library', 'reader', 'settings', 'overview']);

test('app pages resolve their assets when loaded directly (no service worker)', () => {
  for (const page of ['library', 'reader', 'settings', 'overview', 'tasks']) {
    const html = readFileSync(built(`app/${page}.html`), 'utf8');
    assert.match(html, /document\.querySelector\('base'\)\.href = '\.\/'/,
      `${page}.html lacks the runtime base corrector for direct file loads`);
    for (const [, url] of html.replace(/<base [^>]*>/g, '').matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|\/\/|data:|#|mailto:)/.test(url)) continue;
      const bare = url.replace(/[?#].*$/, '');
      // <base> points at the app folder in both serve modes; ../ climbs to the site root.
      const rel = bare.startsWith('../') ? bare.slice(3) : `app/${bare}`;
      if (CLEAN.has(rel.replace(/\/$/, ''))) continue;
      assert.ok(existsSync(built(rel)), `${page}.html references ${url} → ${rel}, which is missing`);
    }
  }
});

test('the one page resolves its assets from the site\'s root, at every address it answers', () => {
  // It has no <base>: every address of the app is one segment under the root, so a relative
  // reference resolves from the root wherever the page is shown.
  const html = readFileSync(built('index.html'), 'utf8');
  assert.doesNotMatch(html, /<base\b/);
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.some((u) => /^\.\/assets\/.+\.js$/.test(u)), 'it loads its bundle');
  for (const url of urls) {
    assert.doesNotMatch(url, /^(?:[a-z]+:|\/)/i, `${url} must be relative, for a site under a folder`);
    assert.ok(existsSync(built(url.replace(/^\.\//, ''))), `index.html references ${url}, which is missing`);
  }
});
