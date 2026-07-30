// csp-hashes.test.mjs — a page that pins an inline script by sha256 must pin the RIGHT bytes.
//
// This shipped broken once: the hash was computed from a CRLF working tree while the host served
// LF, so the browser's hash did not match, the entry script was blocked, and the page hung on its
// loading text forever. `.gitattributes` now checks these files out as LF (matching what any
// static host serves) and this test recomputes every hash from disk so drift fails here instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pages = [
  ...['index.html', '404.html'].filter((f) => existsSync(join(repo, f))),
  ...readdirSync(join(repo, 'app')).filter((f) => f.endsWith('.html')).map((f) => `app/${f}`),
];

// Inline = a <script> with no src attribute.
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const sha256 = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

test('every inline script is covered by its own page CSP hash', () => {
  const problems = [];
  for (const page of pages) {
    const html = readFileSync(join(repo, page), 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/)?.[1];
    const scripts = inlineScripts(html);
    if (!scripts.length) continue;
    if (!csp) { problems.push(`${page}: has an inline script but no CSP`); continue; }
    const declared = [...csp.matchAll(/'(sha256-[^']+)'/g)].map((m) => m[1]);
    for (const body of scripts) {
      const want = sha256(body);
      if (!declared.includes(want)) problems.push(`${page}: inline script hash ${want} is not in the CSP`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no page carries a CRLF line ending, which would change every hash', () => {
  const offenders = pages.filter((p) => readFileSync(join(repo, p)).includes(0x0d));
  assert.deepEqual(offenders, [], 'pages must be stored/served with LF (see .gitattributes)');
});

test('the entry page has no inline script at all', () => {
  // index.html is always served from the deployment root, so its bootstrap is an external file
  // and its CSP is a plain script-src 'self' — no hash to drift in the first place.
  const html = readFileSync(join(repo, 'index.html'), 'utf8');
  assert.deepEqual(inlineScripts(html), []);
  assert.match(html, /<script src="boot-root\.js">/);
});

test('service-worker waits are bounded so a failed install cannot strand a page', () => {
  // Install is fail-fast on critical assets; without a timeout, navigator.serviceWorker.ready
  // simply never settles and the visitor sits on the loading text.
  for (const f of ['boot-root.js', '404.html']) {
    const src = readFileSync(join(repo, f), 'utf8');
    assert.match(src, /serviceWorker\.ready/, `${f} should await the worker`);
    assert.match(src, /Promise\.race/, `${f} must bound that wait`);
  }
});
