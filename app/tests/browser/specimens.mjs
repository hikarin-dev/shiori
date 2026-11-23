// specimens.mjs — what the component tests share: /components opened in Chrome, a specimen found by
// its tags (data-specimen, data-variant, data-state: src/routes/specimens/), and the layout checks
// every component is held to.
import { openPage, until } from './harness.mjs';

export async function componentsPage(t, browser, origin, viewport) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  if (viewport) await page.setViewport(viewport);
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('[data-specimen]'), undefined, { what: 'the components page' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

export const spec = (shape, variant, state = 'rest') => `[data-specimen="${shape}"][data-variant="${variant}"][data-state="${state}"]`;

// Puts a specimen in the middle of the window and gives its centre.
export async function centreOf(page, selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) throw new Error(`no ${selector}`);
  return box;
}

// The box of each element matched, exact.
export const boxes = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
  const r = el.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height];
}), selector);

// Rule 11: nothing that holds text fades or moves by opacity or transform. Every element under
// `root` (selector) that has text of its own: the properties it transitions or animates.
export const textMotion = (page, selector) => page.evaluate((sel) => {
  const bad = [];
  for (const root of document.querySelectorAll(sel)) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      for (const node of [el, ...ancestors(el, root)]) {
        const s = getComputedStyle(node);
        const props = s.transitionProperty.split(',').map((p) => p.trim());
        const durations = s.transitionDuration.split(',').map((d) => parseFloat(d));
        props.forEach((p, i) => { if ((p === 'all' || p === 'opacity' || p === 'transform' || p === 'translate' || p === 'scale') && (durations[i] ?? durations[0]) > 0) bad.push(`${node.localName}.${node.className}: ${p}`); });
        if (s.animationName !== 'none') bad.push(`${node.localName}.${node.className}: animation ${s.animationName}`);
      }
    }
  }
  return [...new Set(bad)];
  function ancestors(el, root) { const out = []; let n = el.parentElement; while (n && n !== root.parentElement) { out.push(n); n = n.parentElement; } return out; }
}, selector);
