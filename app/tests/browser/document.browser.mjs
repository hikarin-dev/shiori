// document.browser.mjs — the one page's document defaults are today's, not Tailwind's: a bare element
// computes as it did on a 1.3 page where app/base.css or the browser decided it (src/styles/
// document.css), the tokens are all there and shown on /components, and a control's keyboard-focus
// ring is the one ring, for the keyboard only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function components(t) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('main button'), undefined, { what: 'the components page' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

const FOREGROUND = 'rgb(244, 244, 245)';

test('a bare element computes as on a 1.3 page: the UI font at 13px, line height normal, the palette\'s text', async (t) => {
  const page = await components(t);
  if (!page) return;
  const seen = await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('section'));
    host.innerHTML = '<div>div</div><p>p</p><h2>h2</h2><a href="#x">a</a><button>button</button><input value="input"><textarea>textarea</textarea>';
    // The browser's own link colour on this theme, to hold a bare link to.
    const link = host.appendChild(document.createElement('span'));
    link.style.color = 'LinkText';
    const out = { linkText: getComputedStyle(link).color };
    for (const el of host.querySelectorAll('div, p, h2, a, button, input, textarea')) {
      const s = getComputedStyle(el);
      out[el.localName] = { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, line: s.lineHeight, color: s.color,
        background: s.backgroundColor, decoration: s.textDecorationLine, ligatures: s.fontVariantLigatures,
        outline: s.outlineStyle, outlineColor: s.outlineColor };
    }
    // (A pseudo-element's colour can't be read back here: the rule that sets it is looked for.)
    const rules = [];
    const walk = (list) => { for (const r of list) { if (r.selectorText === '::placeholder') rules.push(r.style.color); if (r.cssRules) walk(r.cssRules); } };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    out.placeholder = rules;
    const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body);
    out.root = { scheme: root.colorScheme, line: root.lineHeight };
    out.body = { padding: body.paddingRight, gap: root.getPropertyValue('--page-scrollbar-gap').trim(), background: body.backgroundColor,
      minHeight: body.minHeight, ligatures: body.fontVariantLigatures };
    host.remove();
    return out;
  });
  for (const tag of ['div', 'p', 'h2', 'a', 'button', 'input', 'textarea']) {
    assert.match(seen[tag].family, /^"?JetBrains Mono"?, monospace$/, `${tag}: the UI font`);
    assert.equal(seen[tag].line, 'normal', `${tag}: line height normal, not Tailwind's 1.5`);
    assert.notEqual(seen[tag].outlineColor, 'rgba(251, 113, 133, 0.5)', `${tag}: no outline in the ring colour on every element`);
    assert.equal(seen[tag].outline, 'none', `${tag}: no outline at rest`);
  }
  for (const tag of ['div', 'p', 'button', 'input', 'textarea']) {
    assert.equal(seen[tag].size, '13px', `${tag}: 13px`);
    assert.equal(seen[tag].color, FOREGROUND, `${tag}: the palette's text colour`);
  }
  // Today's, where base.css left it to the browser: a heading's size and weight, a link's colour and
  // underline.
  assert.deepEqual([seen.h2.size, seen.h2.weight, seen.h2.color], ['19.5px', '700', FOREGROUND], 'h2: the browser\'s 1.5em, bold');
  assert.deepEqual([seen.a.size, seen.a.color, seen.a.decoration], ['13px', seen.linkText, 'underline'], 'a: the browser\'s link');
  // A control takes the text around it and has no ground of its own (A2).
  for (const tag of ['button', 'input', 'textarea']) assert.equal(seen[tag].background, 'rgba(0, 0, 0, 0)', `${tag}: no ground`);
  for (const tag of ['button', 'input', 'textarea']) assert.equal(seen[tag].ligatures, 'none', `${tag}: no code ligatures`);
  assert.deepEqual(seen.placeholder, ['var(--muted-dim)'], 'the placeholder is --muted-dim');
  assert.deepEqual(seen.root, { scheme: 'dark', line: 'normal' }, 'the root is dark (A1), line height normal');
  assert.equal(seen.body.padding, seen.body.gap || '0px', 'the body keeps the page scrollbar\'s room');
  assert.deepEqual([seen.body.background, seen.body.minHeight, seen.body.ligatures], ['rgb(13, 13, 15)', '900px', 'none']);
  assert.deepEqual(page.problems, []);
});

test('less motion when the system asks for it', async (t) => {
  const page = await components(t);
  if (!page) return;
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const durations = await page.evaluate(() => {
    const el = document.body.appendChild(document.createElement('div'));
    el.style.transition = 'color 2s'; el.style.animation = 'spin 3s infinite';
    const s = getComputedStyle(el);
    const out = [s.transitionDuration, s.animationDuration, s.animationIterationCount];
    el.remove();
    return out;
  });
  assert.deepEqual(durations, ['1e-05s', '1e-05s', '1']);
});

test('a control\'s focus ring is the one ring, and for the keyboard only', async (t) => {
  const page = await components(t);
  if (!page) return;
  const ring = () => page.evaluate(() => {
    const el = document.activeElement, s = getComputedStyle(el);
    return { tag: el.localName, visible: el.matches(':focus-visible'), outline: s.outlineStyle === 'none' ? 'none' : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}` };
  });
  // Two bare controls, first in the page: a click on one, then Tab to the other.
  await page.evaluate(() => {
    for (const [id, tag] of [['next', 'button'], ['probe', 'button']]) {
      const b = document.body.insertBefore(document.createElement(tag), document.body.firstChild);
      b.id = id; b.textContent = id;
      Object.assign(b.style, { position: 'fixed', left: id === 'probe' ? '10px' : '100px', top: '10px', width: '80px', height: '30px' });
    }
  });
  await page.click('#probe');
  assert.deepEqual(await ring(), { tag: 'button', visible: false, outline: 'none' }, 'a click shows no ring');
  await page.keyboard.press('Tab');   // on to the next control: by the keyboard
  const tabbed = await ring();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'next');
  assert.equal(tabbed.visible, true);
  assert.equal(tabbed.outline, 'solid 2px rgb(238, 238, 238) -1px', 'the keyboard ring: a 2px light band over the edge');
});

test('every token of tokens.css exists on the page, and /components shows each by its name', async (t) => {
  const page = await components(t);
  if (!page) return;
  const css = readFileSync(join(repo, 'src', 'styles', 'tokens.css'), 'utf8');
  // Declared names (not the namespace resets): `--name:` at a line's start.
  const declared = [...css.matchAll(/^\s*(--[a-z0-9-]+(?:\\\.[0-9]+)?):(?!\s*initial)/gm)].map((m) => m[1].replace('\\', ''))
    .filter((name) => !name.startsWith('--color-') && !name.startsWith('--page-scrollbar-') && !name.startsWith('--font-') && !name.startsWith('--leading-'));
  assert.ok(declared.length > 80, `the tokens are read from tokens.css (${declared.length})`);
  const missing = await page.evaluate((names) => {
    const root = getComputedStyle(document.documentElement);
    const shown = new Set([...document.querySelectorAll('[data-token]')].map((el) => el.dataset.token));
    return names.filter((name) => !root.getPropertyValue(name).trim() || !shown.has(name));
  }, declared);
  assert.deepEqual(missing, [], 'tokens missing from the page or from /components');
  // The two names that mean something else than in base.css.
  const colours = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ['--primary', '--accent', '--muted', '--muted-foreground'].map((name) => root.getPropertyValue(name).trim());
  });
  assert.deepEqual(colours, ['#ed2754', '#1c1c21', '#1c1c21', '#a1a1aa'], 'base.css --accent is --primary; its --muted is --muted-foreground');
});
