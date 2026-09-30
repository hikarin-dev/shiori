// architecture-fitness.test.mjs — boundaries that are easy to breach silently and expensive to
// re-establish: schema knowledge confined to the data layer, no source-site or helper naming in
// the public app, and no third-party acquisition URLs in app code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appJs = join(repo, 'app', 'js');
const modules = readdirSync(appJs).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(appJs, f), 'utf8');

// Strip comments so prose about a rule never trips the rule itself.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('only the data layer opens IndexedDB transactions', () => {
  // db.js owns the library schema; platform.js owns the separate durable job database.
  const allowed = new Set(['db.js', 'platform.js']);
  const offenders = modules.filter((f) => !allowed.has(f) && /\.transaction\s*\(/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'raw transactions must live in db.js / platform.js');
});

test('object stores are only reached through the data layer', () => {
  const allowed = new Set(['db.js', 'platform.js']);
  const offenders = modules.filter((f) => !allowed.has(f) && /objectStore\s*\(/.test(code(read(f))));
  assert.deepEqual(offenders, [], 'object-store access belongs to the data layer');
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
