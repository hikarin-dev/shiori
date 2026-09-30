// reader-study.js — study mode's own data and rendering primitives, owned here rather than
// mixed into the reader's page-loading state.
//
// This module holds the per-page study records and their object-URL lifecycle, and builds the
// DOM for a bubble's source/translation text (fonts, furigana ruby, outline, geometry,
// selection containment). It knows nothing about page mounting, zoom, spreads or navigation —
// the reader keeps that orchestration and calls in.
//
// Preferences (Settings -> Reader) live here too, pushed in by the reader when they load or
// change, so every builder reads one copy instead of threading four arguments everywhere.

import { listGalleryStudyRecords } from './db.js';
import { textOutline } from './page-image.js';

// page url -> { bg:Blob|null, bubbles:[{box,region,tr,src,rbox?,style?,furi?,shape?,text?:Blob}], page:{w,h}|null }
const _pageStudy     = new Map();
// page url -> { bgUrl, textUrls:[] } object URLs, revoked on teardown
const _pageLayerUrls = new Map();

let studyDisplay  = 'hardcoded_images'; // translation display: 'hardcoded_images' | 'text'
let studyOriginal = 'image';            // original display: 'image' (untouched page) | 'text'
let studySrcFont  = 'yasashisa';        // original text face: 'yasashisa' | 'kiwi'
let furiganaOn    = false;              // applies only to Japanese-tagged galleries

export function setStudyPrefs(prefs = {}) {
  if (prefs.display  !== undefined) studyDisplay  = prefs.display;
  if (prefs.original !== undefined) studyOriginal = prefs.original;
  if (prefs.srcFont  !== undefined) studySrcFont  = prefs.srcFont;
  if (prefs.furigana !== undefined) furiganaOn    = !!prefs.furigana;
}
export const studyPrefs = () => ({ display: studyDisplay, original: studyOriginal, srcFont: studySrcFont, furigana: furiganaOn });

// Every study record for a page, or null when that page has none.
export const studyFor = (pageUrl) => _pageStudy.get(pageUrl) || null;
export const hasAnyStudy = () => _pageStudy.size > 0;

// Load every chapter's stored study layers. One cursor pass per chapter; bg/text layers stay
// Blobs, turned into object URLs lazily when a bubble is first revealed.
export async function loadStudyRecords(chapterIds) {
  for (const id of chapterIds) {
    for (const rec of await listGalleryStudyRecords(id)) {
      _pageStudy.set(rec.url, { bg: rec.bg, bubbles: rec.bubbles, page: rec.page, job: rec.job, translated: rec.translated });
    }
  }
  return _pageStudy.size > 0;
}

// Drop what is held for these pages (translated again: loadStudyRecords reads them back).
export function forgetStudy(pageUrls) {
  for (const url of pageUrls) {
    _pageStudy.delete(url);
    _releaseLayerUrls(url);
  }
}

export function _ensureWrap(imgEl) {
  const parent = imgEl.parentElement;
  if (parent && parent.classList.contains('page-wrap')) return parent;
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  const ratio = imgEl.style.getPropertyValue('--page-ratio');
  if (ratio) wrap.style.setProperty('--page-ratio', ratio);
  imgEl.replaceWith(wrap);
  wrap.appendChild(imgEl);
  return wrap;
}

// Drop every bubble layer and free the page layers' object URLs — except those of the pages in
// `keep` (page urls), which the caller is about to show again: their images stay decoded under the
// same URLs, so the rebuilt layers paint complete instead of loading all over again.
export function _removeBubbleLayers(keep) {
  document.querySelectorAll('.bubble-layer').forEach(l => { if (l._ro) l._ro.disconnect(); l.remove(); });
  for (const pageUrl of [..._pageLayerUrls.keys()]) {
    if (!keep?.has(pageUrl)) _releaseLayerUrls(pageUrl);
  }
  document.body.classList.remove('study-bubbles-active');
}

function _releaseLayerUrls(pageUrl) {
  const u = _pageLayerUrls.get(pageUrl);
  if (!u) return;
  try {
    if (u.bgUrl) URL.revokeObjectURL(u.bgUrl);
    (u.textUrls || []).forEach(t => t && URL.revokeObjectURL(t));
  } catch {}
  _pageLayerUrls.delete(pageUrl);
}

// `pageUrl` is resolved by the caller — which page a wrap holds is the reader's knowledge.
export function _removeWrapBubbleLayer(wrap, pageUrl) {
  const layer = wrap && wrap.querySelector(':scope > .bubble-layer');
  if (layer) { if (layer._ro) layer._ro.disconnect(); layer.remove(); }
  if (pageUrl) _releaseLayerUrls(pageUrl);
}

// Object URLs for a page's study layers: one shared bg + one per bubble text, created once.
export function _layerUrls(pageUrl) {
  let u = _pageLayerUrls.get(pageUrl);
  if (u) return u;
  const study = _pageStudy.get(pageUrl);
  if (!study) return null;
  u = {
    bgUrl:    study.bg ? URL.createObjectURL(study.bg) : '',
    textUrls: study.bubbles.map(b => (b.text ? URL.createObjectURL(b.text) : '')),
  };
  _pageLayerUrls.set(pageUrl, u);
  return u;
}

// CSS clip-path inset that exposes only region r of a full-page (100%) layer image.
export function _clipInset(r) {
  const top = r.y * 100, left = r.x * 100;
  const right = (1 - (r.x + r.w)) * 100, bottom = (1 - (r.y + r.h)) * 100;
  return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

// The outline scales with the page; paint-order lets the fill cover the stroke's inner half.
function _applyTextOutline(el, st) {
  const outline = textOutline(st);
  if (!outline) return;
  el.style.setProperty('--outline-w', outline.px != null ? `calc(${outline.px}px * var(--pgscale, 1))` : `${outline.em}em`);
  el.style.setProperty('--outline-c', `rgb(${outline.color.join(',')})`);
}

// A DOM-text block for one bubble's translation, positioned at the rect the renderer actually
// drew its glyph canvas at (tbox; older records fall back to the layout box) and scaled with
// the page via the layer's --pgscale. Style comes from the stored renderer hints; anything
// missing falls back to a deterministic reader style (never inferred from the image).
export function _buildStudyText(b, hasBg, pageW) {
  if (!b.tr) return null;
  const r = b.tbox || b.rbox || b.region || b.box;
  const el = document.createElement('div');
  el.className = 'study-text' + (hasBg ? '' : ' boxed') + (_hasShape(b) ? ' on-shape' : '');
  el.style.left   = (r.x * 100) + '%';
  el.style.top    = (r.y * 100) + '%';
  el.style.width  = (r.w * 100) + '%';
  el.style.height = (r.h * 100) + '%';
  const st = b.style || {};
  el.style.setProperty('--fs', (st.fontSize || Math.max(12, Math.round((pageW || 1000) * 0.022))) + 'px');
  if (Array.isArray(st.fg)) el.style.color = `rgb(${st.fg.join(',')})`;
  _applyTextOutline(el, st);
  // manga2eng typesets in comic caps with a tight line advance — mirror both, then prefer the
  // exact pitch the renderer drew at when the pipeline recorded it.
  if (st.caps) { el.style.textTransform = 'uppercase'; el.style.lineHeight = '1.0'; }
  if (st.lineH) el.style.lineHeight = String(st.lineH);
  if (st.align === 'left' || st.align === 'right') el.style.textAlign = st.align;
  // Renderer-preserved line breaks live directly in `tr`; pre-wrap keeps them while still
  // allowing a safe additional wrap if browser font metrics need one.
  const body = document.createElement('span');
  body.className = 'study-text-content';
  body.textContent = b.tr;
  el.appendChild(body);
  return el;
}

// The bubble's ORIGINAL text as DOM text, typeset like the source. OCR line breaks live directly
// in `src`; native horizontal/vertical flow lays them out as rows or right-to-left columns.
// Optional <ruby> furigana comes from the pipeline's per-line segments.
export function _buildStudySrc(b, hasBg, pg, srcOpts) {
  const srcText = String(b.src || '').trim();
  if (!srcText) return null;
  const st = b.style || {};
  const vertical = String(st.dir || '').startsWith('v');
  const lines = srcText.split(/\r?\n/);
  const furi = (srcOpts && srcOpts.furi && Array.isArray(b.furi) && b.furi.length === lines.length) ? b.furi : null;

  // In vertical CJK text, leave native scripts and punctuation to Unicode's mixed orientation.
  // Stand isolated letters upright, along with numbers and symbols such as a percent sign;
  // multi-letter horizontal-script words keep their normal sideways run.
  const appendText = (target, text) => {
    if (!vertical) { target.appendChild(document.createTextNode(text)); return; }
    const nativeVertical = /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul}|\p{Script_Extensions=Bopomofo}|\p{Script_Extensions=Mongolian})$/u;
    const letter = /^\p{Letter}$/u;
    const mark = /^\p{Mark}$/u;
    const numberOrSymbol = /^(?:\p{Number}|\p{Symbol}|[%％])$/u;
    let run = '';
    let runType = null;
    let letterCount = 0;
    const flush = () => {
      if (!run) return;
      if (runType === 'upright' || (runType === 'letter' && letterCount === 1)) {
        const upright = document.createElement('span');
        upright.className = 'study-upright';
        upright.textContent = run;
        target.appendChild(upright);
      } else {
        target.appendChild(document.createTextNode(run));
      }
      run = '';
      runType = null;
      letterCount = 0;
    };
    for (const glyph of text.match(/[.．・･·…‥⋯⋮︙:：]+|[!！?？‼⁇⁈⁉]+|./gsu) || []) {
      if (/^[.．・･·…‥⋯⋮︙:：]+$/u.test(glyph) && /[.．・･·…‥⋯⋮︙]/u.test(glyph)
          && (glyph.length > 1 || /[…‥⋯⋮︙]/u.test(glyph))) {
        flush();
        // Draw every dot alike: font ellipsis glyphs can mix round and square dots,
        // and two-/three-dot glyphs give arbitrary-length runs uneven spacing.
        // OCR can read two adjoining dots as a colon; ordinary colons stay outside this branch.
        const count = glyph.replace(/[…⋯⋮︙]/gu, '...').replace(/[‥:：]/gu, '..').length;
        const ellipsis = document.createElement('span');
        ellipsis.className = 'study-ellipsis';
        Object.assign(ellipsis.style, {
          display: 'inline-flex', flexDirection: 'column', writingMode: 'horizontal-tb', verticalAlign: 'baseline',
        });
        for (let i = 0; i < count; i++) {
          const cell = document.createElement('span');
          Object.assign(cell.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '1em', height: 'calc(1em / 3)', flex: 'none',
          });
          const dot = document.createElement('span');
          Object.assign(dot.style, { fontFamily: 'Arial, sans-serif', fontSize: '0.5em', lineHeight: '1' });
          dot.textContent = '•';
          cell.appendChild(dot);
          ellipsis.appendChild(cell);
        }
        target.appendChild(ellipsis);
        continue;
      }
      // Emphasis such as !!, !!! and !? shares one upright character cell.
      if (/^[!！?？‼⁇⁈⁉]+$/u.test(glyph)) {
        flush();
        const combined = document.createElement('span');
        combined.className = 'study-combined';
        combined.style.textCombineUpright = 'all';
        // Use narrow punctuation before fitting the group, so full-width marks do not
        // get squeezed into hairlines (and compatibility pairs use supported glyphs).
        combined.textContent = glyph.normalize('NFKC');
        target.appendChild(combined);
        continue;
      }
      let type = 'plain';
      if (mark.test(glyph) && runType) type = runType;
      else if (!nativeVertical.test(glyph) && letter.test(glyph)) type = 'letter';
      else if (numberOrSymbol.test(glyph)) type = 'upright';
      if (runType !== null && type !== runType) flush();
      runType = type;
      run += glyph;
      if (type === 'letter' && letter.test(glyph)) letterCount++;
    }
    flush();
  };

  // Fill one line's content (plain text or ruby-annotated segments) into `target`.
  const lineContent = (target, i) => {
    const segs = furi && Array.isArray(furi[i]) ? furi[i] : null;
    if (!segs) { appendText(target, lines[i]); return; }
    let plain = '';
    for (const seg of segs) {
      if (!seg || !seg[0]) continue;
      if (seg[1]) {
        if (plain) { appendText(target, plain); plain = ''; }
        const ruby = document.createElement('ruby');
        appendText(ruby, seg[0]);
        const rt = document.createElement('rt');
        rt.textContent = seg[1];
        ruby.appendChild(rt);
        target.appendChild(ruby);
      } else {
        // A punctuation run can span several unannotated segments.
        plain += seg[0];
      }
    }
    if (plain) appendText(target, plain);
  };

  const r = b.box || b.region;
  const el = document.createElement('div');
  el.className = 'study-text src' + (hasBg ? '' : ' boxed') + (studySrcFont === 'kiwi' ? ' font-kiwi' : '') +
    (_hasShape(b) ? ' on-shape' : '');
  if (furi) el.classList.add('with-ruby');
  el.style.left   = (r.x * 100) + '%';
  el.style.top    = (r.y * 100) + '%';
  el.style.width  = (r.w * 100) + '%';
  el.style.height = (r.h * 100) + '%';
  if (Array.isArray(st.fg)) el.style.color = `rgb(${st.fg.join(',')})`;
  _applyTextOutline(el, st);
  // Language drives the appropriate Han glyph forms when source metadata identifies it.
  if (srcOpts && srcOpts.lang) el.lang = srcOpts.lang;
  if (vertical) el.classList.add('vert');
  el.style.setProperty('--fs', (st.srcFontSize || st.fontSize || Math.max(12, Math.round(((pg && pg.w) || 1000) * 0.022))) + 'px');
  const body = document.createElement('span');
  body.className = 'study-src-body study-text-content';
  lines.forEach((ln, i) => {
    const line = document.createElement('span');
    line.className = 'study-src-line';
    lineContent(line, i);
    body.appendChild(line);
    if (i < lines.length - 1) body.appendChild(document.createElement('br'));
  });
  el.appendChild(body);
  return el;
}

// Original-as-text display (Settings → Reader): a bubble opens ALREADY revealed — the
// inpainted bg with the ORIGINAL text on top as DOM text — and clicking cycles it between the
// original and the translation (DOM text or the typeset PNG, per the translation display
// setting). DOM text stays selectable; a plain click with no selection cycles it. Escape returns
// every bubble to its original text.
export function _studySourceRect(b) {
  return b.box || b.region;
}

export function _studyTranslationRect(b) {
  return b.tbox || b.rbox || b.region || b.box;
}

export function _positionBubbleIndicator(box, r) {
  if (!box || !r) return;
  box.style.left   = (r.x * 100) + '%';
  box.style.top    = (r.y * 100) + '%';
  box.style.width  = (r.w * 100) + '%';
  box.style.height = (r.h * 100) + '%';
  // A shape is drawn in page fractions: undo the box's offset and size so it spans the page.
  const shape = box.querySelector(':scope > .bubble-shape');
  if (!shape) return;
  shape.style.left   = (-r.x / r.w * 100) + '%';
  shape.style.top    = (-r.y / r.h * 100) + '%';
  shape.style.width  = (100 / r.w) + '%';
  shape.style.height = (100 / r.h) + '%';
}

// The area the renderer laid a bubble's text into (`shape`, a page-fraction polygon) as a
// page-sized SVG for the bubble's box: a dashed outline over a light halo, drawn at a fixed screen
// width. Nesting it in the box keeps hover, clicks and feedback tags the box's own. The bubble's
// DOM text is marked `on-shape` so it leaves hover and clicks to the shape beneath it.
const _hasShape = b => Array.isArray(b.shape) && b.shape.length >= 3;
export function _buildBubbleShape(b) {
  if (!_hasShape(b)) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'bubble-shape');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  const points = b.shape.map(p => p.join(',')).join(' ');
  for (const part of ['halo', 'line']) {
    const polygon = document.createElementNS(ns, 'polygon');
    polygon.setAttribute('class', 'bubble-shape-' + part);
    polygon.setAttribute('points', points);
    svg.appendChild(polygon);
  }
  return svg;
}

// Texts a renderer gave the very same area (a balloon it didn't divide between them) share one
// outline, so each keeps its own region as the click target. Returns those bubbles.
export function _sharedShapes(bubbles) {
  const byShape = new Map();
  for (const b of bubbles) {
    if (!Array.isArray(b.shape)) continue;
    const key = JSON.stringify(b.shape);
    byShape.set(key, [...(byShape.get(key) || []), b]);
  }
  return new Set([...byShape.values()].filter(group => group.length > 1).flat());
}

export function _wireSelectableText(el, onPlainClick) {
  if (!el || !el.classList.contains('study-text')) return false;
  const content = el.querySelector('.study-text-content');
  if (!content) return false;
  content.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.ctrlKey) return;
    if (!String(window.getSelection() || '')) onPlainClick();
  });
  return true;
}

// Contain a text selection to the single study bubble it began in — like a textbox, so a Ctrl-drag
// inside one bubble's text never bleeds into another bubble or the page. Chrome has no CSS
// `user-select: contain`, so the moment a drag starts inside a bubble we make every OTHER bubble
// unselectable for the duration (study-sel-lock on the body + study-sel-host on that bubble): the
// native selection then physically can't extend past it. The selectionchange handler backstops any
// residual overrun by pinning the moving end back to the bubble's edge. Keyed purely on the bubble's
// text wrapper, so only study-text selections are affected.
let _clampingStudySelection = false;
let _studySelHost = null;
function _studyTextHost(node) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  return el ? el.closest('.study-text-content') : null;
}
function _lockSelectionToHost(host) {
  if (_studySelHost === host) return;
  if (_studySelHost) _studySelHost.classList.remove('study-sel-host');
  _studySelHost = host;
  host.classList.add('study-sel-host');
  document.body.classList.add('study-sel-lock');
}
function _unlockSelectionHost() {
  if (_studySelHost) _studySelHost.classList.remove('study-sel-host');
  _studySelHost = null;
  document.body.classList.remove('study-sel-lock');
}
// A drag beginning inside a bubble locks the selection to it before the pointer can move (so the
// confinement is in place before the browser extends the range). Releasing the pointer frees it.
document.addEventListener('pointerdown', (e) => {
  if (!document.body.classList.contains('study-text-selecting')) return;
  const host = _studyTextHost(e.target);
  if (host) _lockSelectionToHost(host); else _unlockSelectionHost();
});
document.addEventListener('pointerup', _unlockSelectionHost);
document.addEventListener('pointercancel', _unlockSelectionHost);
document.addEventListener('selectionchange', () => {
  if (_clampingStudySelection) return;
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const host = _studyTextHost(sel.anchorNode);
  if (!host || host.contains(sel.focusNode)) return;   // not a bubble selection, or still inside it
  const after = !!(host.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING);
  const r = document.createRange();
  r.selectNodeContents(host);
  _clampingStudySelection = true;
  try { sel.extend(after ? r.endContainer : r.startContainer, after ? r.endOffset : r.startOffset); } catch {}
  _clampingStudySelection = false;
});

export function _setStudyTextSelectable(selectable) {
  document.body.classList.toggle('study-text-selecting', !!selectable);
  if (!selectable) _unlockSelectionHost();
}


export function _sourceTextLang(meta) {
  if (!meta) return '';
  const values = [];
  for (const tags of [meta.tags, meta.seriesTags]) {
    if (Array.isArray(tags)) {
      for (const tg of tags) if (tg && tg.type === 'language') values.push(String(tg.name || ''));
    }
  }
  values.push(String(meta.sourceMetadata?.language || ''));
  const language = values.join(' ');
  if (/(^|\W)(japanese|ja|jpn)(\W|$)/i.test(language)) return 'ja';
  if (/chinese\s*\(traditional\)|traditional\s+chinese|zh[-_](tw|hant)/i.test(language)) return 'zh-Hant';
  if (/chinese\s*\(simplified\)|simplified\s+chinese|zh[-_](cn|hans)/i.test(language)) return 'zh-Hans';
  if (/(^|\W)(chinese|zh|zho)(\W|$)/i.test(language)) return 'zh';
  return '';
}

// Source metadata doesn't always carry a language tag. Kana in the OCR'd text — or a ruby
// reading, which is kana by definition — is unambiguous evidence of Japanese, so fall back to
// what the page itself says.
export function _sniffSourceLang(bubbles) {
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  for (const b of bubbles) if (b.furi || kana.test(b.src || '')) return 'ja';
  return '';
}

// Keep a layer's DOM text sized in page pixels × --pgscale (wrap width ÷ page width), so it
// tracks zoom/resize exactly like the image layers do.
export function _syncLayerScale(layer, wrap, pageW) {
  if (!pageW) return;
  const sync = () => layer.style.setProperty('--pgscale', String((wrap.clientWidth / pageW) || 1));
  sync();
  layer._ro = new ResizeObserver(sync);
  layer._ro.observe(wrap);
}

// Translate-as-text: the page image is ALREADY the inpainted bg, so the overlay is only the
// translations as DOM text — no per-bubble backgrounds, no reveal targets, and no page-flip zones
// (the reader's own click zones stay in charge). A page that kept no bg is showing its untouched
// original, so it gets no text rather than translations stacked over the source.
