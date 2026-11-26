// reader-tokens.test.mjs — the reader's stylesheet and scripts and the one page share one document, the
// reader drawn inside it, so they share custom properties: the reader reads the one page's token names
// (src/styles/tokens.css) and defines none of the one page's names. (Until the reader's switch,
// 2026-11-26, its own page gave those names 1.3's values through an alias block, app/reader-aliases.css,
// held here to base.css's tokens.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const noComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const filesUnder = (dir) => readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })
  .filter((d) => d.isFile()).map((d) => join(d.parentPath ?? d.path, d.name).slice(repo.length + 1).replaceAll('\\', '/'));

// The reader's sheets: what the route table names for it.
const { ROUTES } = await import('../../src/routes.ts');
const SHEETS = [...ROUTES.reader.sheets];
const SCRIPTS = readdirSync(join(repo, 'app', 'js')).filter((f) => /^(reader|page-nav)/.test(f)).map((f) => `app/js/${f}`);

const css = SHEETS.map((f) => noComments(read(f))).join('\n');
const js = SCRIPTS.map((f) => noComments(read(f))).join('\n');
const names = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
// Read: var(--x) in a sheet or a script's string, getPropertyValue('--x'). Defined: --x: in a sheet,
// setProperty('--x') in a script.
const READ = new Set([...names(css, /var\(\s*(--[\w-]+)/g), ...names(js, /var\(\s*(--[\w-]+)/g), ...names(js, /getPropertyValue\(\s*['"`](--[\w-]+)/g)]);
const DEFINED = new Set([...names(css, /(?:^|[;{\s])(--[\w-]+)\s*:/g), ...names(js, /setProperty\(\s*['"`](--[\w-]+)/g),
  ...names(js, /setProperty\(\s*`(--[\w-]+)-\$\{/g)]);
// The reader's measured sizes are written by name in a loop (`--sn-${key}-w`): its own family.
for (const key of ['pill', 'zoom', 'rail']) for (const d of ['w', 'h']) DEFINED.add(`--sn-${key}-${d}`);

// The one page's names: every custom property its stylesheets and components name.
const onePageFiles = filesUnder('src').filter((f) => ['.css', '.ts', '.tsx'].includes(extname(f)));
const ONE_PAGE = new Set(onePageFiles.flatMap((f) => [...noComments(read(f)).matchAll(/(--[a-zA-Z][\w-]*)/g)].map((m) => m[1].replace(/\\$/, ''))));
// Written on <html> by scrollbar.js, a module both use, and read by both for the same thing.
const SHARED = new Set(['--page-scrollbar-gap', '--page-scrollbar-width', '--scrollbar-unit']);

const tokens = noComments(read('src/styles/tokens.css'));
const TOKEN_VALUE = new Map([...tokens.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

test('the reader\'s sheets are the route table\'s, and its scripts are found', () => {
  assert.deepEqual(SHEETS, ['app/reader.css']);
  assert.ok(SCRIPTS.includes('app/js/reader.js') && SCRIPTS.includes('app/js/page-nav.js'));
  assert.ok(READ.has('--primary') && DEFINED.has('--sn-size') && DEFINED.has('--thumb-h'), 'what is read and defined is found');
});

test('neither --accent nor --muted, which mean something else in the one page, is read or defined by the reader', () => {
  for (const name of ['--accent', '--muted']) {
    assert.ok(!READ.has(name), `${name} is read`);
    assert.ok(!DEFINED.has(name), `${name} is defined`);
  }
});

test('the reader defines none of the one page\'s names', () => {
  assert.deepEqual([...DEFINED].filter((n) => ONE_PAGE.has(n) || SHARED.has(n)), []);
});

test('every one-page name the reader reads is one of its tokens', () => {
  const read = [...READ].filter((n) => ONE_PAGE.has(n) && !SHARED.has(n));
  assert.ok(read.length >= 10, 'the reader reads the one page\'s tokens');
  for (const name of read) assert.ok(TOKEN_VALUE.has(name), `${name} is a token of src/styles/tokens.css`);
  // Every other name it reads is its own: one it defines (in its sheet, or from its scripts). A name
  // only base.css defines would have no value inside the one page.
  for (const name of READ) if (!ONE_PAGE.has(name) && !SHARED.has(name)) assert.ok(DEFINED.has(name), `${name} is read and never defined by the reader`);
});
