// reader-tokens.test.mjs — the reader's stylesheet and scripts and the one page share one document once
// the reader is drawn inside it, so they share custom properties: the reader reads the one page's
// token names (src/styles/tokens.css) and defines none of the one page's names, and its own page
// gives those names 1.3's values through one alias block (app/reader-aliases.css), loaded there alone.
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

// The reader's sheets: what its page links, less the old pages' sheets (base.css, notice.css) and the
// alias block, which its page alone loads.
const OLD_PAGE = ['base.css', 'reader-aliases.css', 'notice.css'];
const linked = [...read('app/reader.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
const SHEETS = linked.filter((href) => !OLD_PAGE.includes(href)).map((href) => `app/${href}`);
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

const aliases = noComments(read('app/reader-aliases.css'));
const ALIASED = new Map([...aliases.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const tokens = noComments(read('src/styles/tokens.css'));
const TOKEN_VALUE = new Map([...tokens.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const base = noComments(read('app/base.css'));
const BASE = new Set([...base.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test('the reader\'s sheets are its page\'s links less the old pages\' sheets, and its scripts are found', () => {
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

test('every one-page name the reader reads is one of its tokens, given on the reader\'s own page by the alias block', () => {
  const read = [...READ].filter((n) => ONE_PAGE.has(n) && !SHARED.has(n));
  assert.ok(read.length >= 10, 'the reader reads the one page\'s tokens');
  for (const name of read) {
    assert.ok(TOKEN_VALUE.has(name), `${name} is a token of src/styles/tokens.css`);
    assert.ok(ALIASED.has(name) || BASE.has(name), `${name} has a value on the reader's own page (reader-aliases.css, or base.css under the same name)`);
  }
  // Every other name it reads is its own: one it defines (in its sheet, or from its scripts). A name
  // only base.css defines would have no value inside the one page.
  for (const name of READ) if (!ONE_PAGE.has(name) && !SHARED.has(name)) assert.ok(DEFINED.has(name), `${name} is read and never defined by the reader`);
});

test('the alias block: each one-page token as base.css\'s token for it, the reader\'s ground as the one page has it', () => {
  for (const [name, value] of ALIASED) {
    if (name === '--bg') { assert.equal(value, 'var(--reader-background)', 'base.css\'s and notice.css\'s rules take the reader\'s ground'); continue; }
    assert.ok(TOKEN_VALUE.has(name), `${name} is a token of the one page`);
    const of = value.match(/^var\((--[\w-]+)\)$/);
    if (of) assert.ok(BASE.has(of[1]), `${name}: ${of[1]} is base.css's`);
    else assert.equal(value, TOKEN_VALUE.get(name), `${name} has the one page's value`);
  }
  // Loaded by the reader's page alone, after base.css, before the reader's sheets.
  assert.deepEqual(linked.slice(0, 3), ['base.css', 'reader-aliases.css', 'app/reader.css'.slice(4)]);
  for (const f of filesUnder('src').filter((x) => ['.ts', '.tsx', '.css', '.html'].includes(extname(x)))) assert.doesNotMatch(read(f), /reader-aliases/, f);
  assert.doesNotMatch(read('index.html'), /reader-aliases|base\.css|notice\.css/);
});
