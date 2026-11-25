// hover-audit.mjs — what changes under the pointer, measured. Every element a :hover rule can change
// is found from the page's own stylesheets (the element the rule names as the one under the pointer,
// and everything inside it), the pointer is forced over it (CDP's forced :hover, transitions off),
// and its look is compared with its look at rest: opacity, a brightness filter, the text's colour, the
// ground as it is seen (laid over what is behind it), the frame, an icon's fill and stroke.
//
//   hoverChanges(page) → [{ element, what, from, to, darker, tone }]
//
// `darker`: it ended up dimmer than at rest. Not counted as darker: text or an icon turning dark on a
// ground that lit up (a button that fills), a colour taken for a grey (`tone`: text turning to the
// brand's red is a highlight), and what was not drawn at rest (a control that appears).
// One entry a shape: an element is named by what it is and the state it is in, not by its words.

// ── In the page ─────────────────────────────────────────────────────────────────────────────────
// Every drawn element a :hover rule names as the one under the pointer, kept in window.__hosts.
function findHosts() {
  // A selector list cut at its top-level commas; a complex selector cut at its top-level combinators.
  const cut = (text, at) => {
    const out = []; let depth = 0, cur = '';
    for (const c of text) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (depth === 0 && at.includes(c)) { if (cur.trim()) out.push(cur); if (c !== ',') out.push(c); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  const selectors = new Set();
  const walk = (rules, parent = '') => {
    for (const rule of rules) {
      let scope = parent;
      if (rule.selectorText != null) {
        // (A nested rule's selector comes with "&", or with none: a descendant of its parent's.)
        for (const one of cut(rule.selectorText, ',').map((s) => s.trim())) {
          const full = !parent ? one : one.includes('&') ? one.split('&').join(`:is(${parent})`) : `:is(${parent}) ${one}`;
          if (!full.includes(':hover')) continue;
          const parts = cut(full, ' >+~');
          const at = parts.findIndex((p) => p.includes(':hover'));
          if (at < 0 || /:not\([^)]*:hover/.test(parts[at])) continue;
          selectors.add(parts.slice(0, at + 1).join('').split(':hover').join(':is(*)').replace(/::[\w-]+(\([^)]*\))?/g, ''));
        }
        scope = parent ? rule.selectorText.split('&').join(`:is(${parent})`) : rule.selectorText;
      }
      if (rule.cssRules?.length) walk(rule.cssRules, rule.selectorText != null ? scope : parent);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* another origin's */ } }
  const hosts = new Set();
  for (const sel of selectors) { try { for (const el of document.querySelectorAll(sel)) hosts.add(el); } catch { /* a selector the cut left invalid */ } }
  window.__hosts = [...hosts].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el !== document.documentElement && el !== document.body; });
  return window.__hosts.length;
}

// What window.__hosts[i] and everything in it looks like now, and each one's parent among them.
function look(i) {
  const host = window.__hosts[i];
  const els = [host, ...host.querySelectorAll('*')].slice(0, 600);
  const parse = (s) => {
    let m = /^rgba?\(([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)/.exec(s);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; }
    return [0, 0, 0, 0];
  };
  // The ground seen where an element is: its own laid over what is behind it, down to the page's.
  const shown = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    let out = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    for (const c of layers.reverse()) out = out.map((v, k) => c[k] * c[3] + v * (1 - c[3]));
    return `rgb(${out.map((v) => Math.round(v * 10) / 10).join(', ')})`;
  };
  // A frame as it is seen: its colour over the element's own ground, which lies under it (a clear
  // frame shows that ground, not the page).
  const seenOver = (colour, ground) => {
    const c = parse(colour), under = parse(ground);
    return `rgb(${under.slice(0, 3).map((v, k) => Math.round((c[k] * c[3] + v * (1 - c[3])) * 10) / 10).join(', ')})`;
  };
  return els.map((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return null;
    const border = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none').map((s) => cs[`border${s}Color`]);
    const svg = el instanceof SVGElement;
    return {
      parent: els.indexOf(el.parentElement), visible: cs.visibility, opacity: cs.opacity, filter: cs.filter,
      text: cs.color, ground: cs.backgroundColor, shown: shown(el), frame: [...new Set(border)].join(' '), frameShown: [...new Set(border)].map((b) => seenOver(b, shown(el))).join(' '), fill: svg ? cs.fill : '', stroke: svg ? cs.stroke : '',
    };
  });
}

// A name for the `j`th element of window.__hosts[i]: what it is, the state it is in, and (apart) its words.
function nameOf([i, j]) {
  const host = window.__hosts[i];
  const el = j === 0 ? host : host.querySelectorAll('*')[j - 1];
  const STATES = ['aria-selected', 'aria-current', 'aria-pressed', 'aria-checked', 'aria-expanded', 'data-state', 'data-specimen-state', 'data-slot', 'data-variant', 'disabled', 'data-disabled', 'data-popup-open'];
  const UTILITY = /^-?(flex|grid|relative|absolute|inline|block|contents|min-|max-|w-|h-|p[xytblr]?-|m[xytblr]?-|gap-|items-|justify-|text-|font-|leading-|rounded|border|bg-|shrink|grow|overflow|cursor|transition|duration|ease|whitespace|truncate|select-|outline|shadow|opacity|z-|top-|left-|right-|bottom-|size-|self-|order-|col-|row-|tracking-|uppercase|underline|no-underline|align-|content-|place-|pointer-|appearance|box-|fill-|stroke-|sr-only|hidden|visible|static|fixed|sticky|isolate|inset|translate|rotate|scale|origin|animate|aspect|object|basis|space-|divide|ring|tabular|break|hyphens|list|table|float|clear|line-clamp|decoration|accent-|caret-|scroll|snap|touch|resize|will-change|contain|mix-|backdrop|brightness|blur|contrast|grayscale|saturate|sepia|invert|drop-|hue-|peer|group|lucide)/;
  const one = (e) => {
    // Its own class names: the first three that are not utility classes.
    const cls = String(e.className?.baseVal ?? e.className ?? '').split(/\s+/).filter((c) => c && !/[:[\]/()]/.test(c) && !UTILITY.test(c)).slice(0, 3).join('.');
    const state = STATES.filter((a) => e.hasAttribute?.(a)).map((a) => `${a.replace(/^(aria|data)-/, '')}=${e.getAttribute(a) || 'yes'}`).join(' ');
    const id = e.id && !/\d{4,}|^_r_|^base-ui/.test(e.id) ? `#${e.id}` : '';
    return `${e.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}${state ? ` [${state}]` : ''}`;
  };
  const specimen = el.closest?.('[data-specimen]');
  const where = specimen ? ` «${specimen.getAttribute('data-specimen')}${specimen.getAttribute('data-specimen-state') ? ` / ${specimen.getAttribute('data-specimen-state')}` : ''}»` : '';
  return { name: `${el === host ? one(el) : `${one(host)} ▸ ${one(el)}`}${where}`, words: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) };
}

// ── Here ────────────────────────────────────────────────────────────────────────────────────────
const rgba = (s) => {
  let m = /rgba?\(([^)]+)\)/.exec(s || '');
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
  m = /color\(srgb ([^)]+)\)/.exec(s || '');
  if (!m) return null;
  const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
  return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 };
};
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
// How light a colour looks on the app's dark page (CIE L*, 0 to 100), and how coloured it is.
const PAGE = { r: 13, g: 13, b: 15 };
export const lightness = (s) => {
  const c = rgba(s); if (!c) return null;
  const over = (v, under) => v * c.a + under * (1 - c.a);
  const y = 0.2126 * lin(over(c.r, PAGE.r)) + 0.7152 * lin(over(c.g, PAGE.g)) + 0.0722 * lin(over(c.b, PAGE.b));
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};
const chroma = (s) => { const c = rgba(s); return c ? (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255 * c.a : 0; };
const brightness = (filter) => { const m = /brightness\(([\d.]+)\)/.exec(filter || ''); return m ? parseFloat(m[1]) : 1; };
const drawn = (look) => (rgba(look.text)?.a ?? 1) > 0 || (rgba(look.ground)?.a ?? 0) > 0;
const STEP = 0.8;   // a step of lightness worth telling (two neighbouring surfaces of the app are 2 to 4 apart)

// What changed between an element's two looks. `lit`: its ground, or that of what it sits in, got lighter.
function compare(rest, hover, lit) {
  const out = [];
  if (!rest || !hover || rest.visible !== hover.visible) return out;
  if (hover.opacity !== rest.opacity) out.push({ what: 'opacity', from: rest.opacity, to: hover.opacity, darker: parseFloat(hover.opacity) < parseFloat(rest.opacity) - 0.001 });
  if (hover.filter !== rest.filter) out.push({ what: 'filter', from: rest.filter, to: hover.filter, darker: brightness(hover.filter) < brightness(rest.filter) });
  for (const what of ['text', 'ground', 'frame', 'fill', 'stroke']) {
    if (rest[what] === hover[what]) continue;
    const seen = (l) => (what === 'ground' ? l.shown : what === 'frame' ? l.frameShown : l[what]);
    const a = lightness(seen(rest)), b = lightness(seen(hover));
    const down = a != null && b != null && b < a - STEP && drawn(rest) && !(lit && what !== 'ground' && what !== 'frame');
    // (A frame's colour too is the one seen: a clear frame over a tinted ground has taken that tint.)
    const coloured = what === 'frame' ? chroma(seen(hover)) > chroma(seen(rest)) + 0.08 : chroma(hover[what]) > chroma(rest[what]) + 0.08;
    out.push({ what, from: rest[what], to: hover[what], darker: down && !coloured, tone: down && coloured });
  }
  return out;
}

export async function hoverChanges(page) {
  const style = await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await new Promise((r) => setTimeout(r, 150));
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('DOM.getDocument', { depth: 0 });
  const count = await page.evaluate(findHosts);
  const changes = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    // (The node is asked for in this session: an object's id from the page's own session is not known here.)
    const { result } = await cdp.send('Runtime.evaluate', { expression: `window.__hosts[${i}]` });
    const { nodeId } = await cdp.send('DOM.requestNode', { objectId: result.objectId });
    const rest = await page.evaluate(look, i);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    const hover = await page.evaluate(look, i);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    // Which elements sit on a ground that got lighter: their own, or one round them inside the host.
    const up = rest.map((r, j) => !!r && !!hover[j] && r.ground !== hover[j].ground && (lightness(hover[j].shown) ?? 0) > (lightness(r.shown) ?? 0) + STEP);
    const lit = (j) => { for (let k = j; k >= 0 && rest[k]; k = rest[k].parent) { if (up[k]) return true; if (k === 0) break; } return false; };
    for (let j = 0; j < Math.min(rest.length, hover.length); j++) {
      const diffs = compare(rest[j], hover[j], !!rest[j] && lit(j));
      if (!diffs.length) continue;
      const { name, words } = await page.evaluate(nameOf, [i, j]);
      for (const d of diffs) {
        const key = `${name}|${d.what}|${d.from}|${d.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        changes.push({ element: name, words, ...d });
      }
    }
  }
  await cdp.detach();
  await style.evaluate((el) => el.remove());
  return { hosts: count, changes };
}
