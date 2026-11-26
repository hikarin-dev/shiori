// csp-hashes.test.mjs — a page that pins an inline script by sha256 must pin the RIGHT bytes.
//
// This shipped broken once: the hash was computed from a CRLF working tree while the host served
// LF, so the browser's hash did not match, the entry script was blocked, and the page hung on its
// loading text forever. `.gitattributes` now checks these files out as LF (matching what any
// static host serves) and this test recomputes every hash from disk so drift fails here instead.
//
// The one page (index.html) has no inline script at all, and gets its policy when it is built: the
// built page is read here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtSite } from '../../build/built.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pages = [
  ...['index.html', '404.html'].filter((f) => existsSync(join(repo, f))),
  ...readdirSync(join(repo, 'app')).filter((f) => f.endsWith('.html')).map((f) => `app/${f}`),
];
// The built one page (throws, saying so, when there is no build or a source changed since).
const builtPage = () => readFileSync(join(builtSite(), 'index.html'), 'utf8');

// Inline = a <script> with no src attribute.
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const sha256 = (s) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');
const policyOf = (html) => html.match(/http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/)?.[1];

test('every inline script is covered by its own page CSP hash', () => {
  const problems = [];
  for (const [page, html] of [...pages.map((p) => [p, readFileSync(join(repo, p), 'utf8')]), ['dist/index.html', builtPage()]]) {
    const csp = policyOf(html);
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
  if (readFileSync(join(builtSite(), 'index.html')).includes(0x0d)) offenders.push('dist/index.html');
  assert.deepEqual(offenders, [], 'pages must be stored/served with LF (see .gitattributes)');
});

test('the entry page has no inline script at all', () => {
  // index.html is the one page: its scripts are files — its first, start.js, which starts the
  // bundle — so its CSP is a plain script-src 'self', no hash to drift in the first place. Neither
  // the page as written nor the page as built may gain one.
  assert.deepEqual(inlineScripts(readFileSync(join(repo, 'index.html'), 'utf8')), []);
  assert.deepEqual(inlineScripts(builtPage()), []);
  assert.match(builtPage(), /<script src="start\.js"\s*><\/script>/, 'the built page starts with start.js');
  assert.match(readFileSync(join(builtSite(), 'start.js'), 'utf8'), /"entry":"assets\/[^"]+\.js"/, 'which starts the bundle');
});

// 1.3's pages' policy (the reader's page, the last with a file of its own, until 2026-11-26), less the hash
// of that page's one inline script.
const PAGES_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob: http: https: ws://127.0.0.1:*; object-src 'none'; base-uri 'self'";

test('the built one page carries the policy of the app\'s other pages', () => {
  // The same policy as 1.3's pages had, less a page's hash (the build writes it: the dev server's page
  // needs inline scripts, so the page as written has none).
  const policy = policyOf(builtPage());
  assert.equal(policy, PAGES_POLICY);
  assert.match(policy, /(?:^|; )script-src 'self'(?:;|$)/, 'scripts from the site only');
  // It must come before the first script it is to hold.
  assert.ok(builtPage().indexOf('Content-Security-Policy') < builtPage().indexOf('<script'), 'the policy precedes every script');
});

test('service-worker waits are bounded so a failed install cannot strand a page', () => {
  // Install is fail-fast on critical assets; without a timeout, navigator.serviceWorker.ready
  // simply never settles and the visitor sits on a blank page. (404.html is the one page that waits
  // for it: the one page's entry waits on no worker, sw-install-budget.test.mjs.)
  for (const f of ['404.html']) {
    const src = readFileSync(join(repo, f), 'utf8');
    assert.match(src, /serviceWorker\.ready/, `${f} should await the worker`);
    assert.match(src, /Promise\.race/, `${f} must bound that wait`);
  }
});
