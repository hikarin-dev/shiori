// page-image.js — a page's translated image. It is stored as an image, or — when the translation
// server found the page's study data stands in for it — as that data alone
// (`record.translatedLayers`): the clean background with each balloon's text layer drawn over it
// (which rebuilds the render exactly), or with its translation typeset over it as text, so the
// page is never stored twice. Anything that needs the page as one image asks here.

const _layered = (rec) => !!rec?.translatedLayers && rec.studyBg != null
  && Array.isArray(rec.bubbles) && rec.bubbles.length > 0;

// Whether the page has a translation to show (its image, or the study data that is it).
export const hasTranslation = (rec) => rec?.translated != null || _layered(rec);

// What the translate view shows for a page, given the display chosen in Settings → Reader
// ('image' | 'text'): `source` is the image under it ('translated' | 'bg' | 'original') and
// `overlay` what goes on top (null | 'images' — the balloons' text layers | 'text' — DOM text).
// A display the page can't provide falls back to the one it can. `page` holds whether it has a
// translated image, its study background and its balloons.
export function translationView({ translated, bg, bubbles }, display) {
  const text = bg != null && Array.isArray(bubbles) && bubbles.length > 0;
  if (display === 'text' && text) return { source: 'bg', overlay: 'text' };
  if (translated) return { source: 'translated', overlay: null };
  if (text && bubbles.some(b => b?.text)) return { source: 'bg', overlay: 'images' };
  if (text) return { source: 'bg', overlay: 'text' };
  return { source: 'original', overlay: null };
}

// The page's translated image — a stored Blob or data URL, or its study data composed into one
// (WebP, like the server's pages) — or null when it has none. A few recent compositions are kept.
const CACHE_MAX = 12;
const _cache = new Map();   // url → { key, blob }

export async function translatedImage(rec) {
  if (rec?.translated != null) return rec.translated;
  if (!_layered(rec)) return null;
  const key = `${rec.pipeline?.job}|${rec.studyBg.size ?? rec.studyBg.length}|${rec.bubbles.map(b => b?.tr).join('\0')}`;
  const hit = _cache.get(rec.url);
  if (hit?.key === key) return hit.blob;
  let blob = null;
  try { blob = await _compose(rec.studyBg, rec.bubbles); } catch {}
  if (!blob) return null;
  _cache.delete(rec.url);
  _cache.set(rec.url, { key, blob });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  return blob;
}

// Text layers are fully opaque or fully clear, so drawing them over the background reproduces the
// page the server rendered. A page without them is its translations typeset over the background.
async function _compose(bg, bubbles) {
  const decode = async (src) => createImageBitmap(src instanceof Blob ? src : await (await fetch(src)).blob(),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const layers = bubbles.map(b => b?.text).filter(Boolean);
  const font = layers.length ? null : _loadFont();
  const base = await decode(bg);
  const canvas = new OffscreenCanvas(base.width, base.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);
  base.close();
  for (const layer of layers) {
    const bitmap = await decode(layer);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  if (!layers.length) {
    await font;
    for (const b of bubbles) _typeset(ctx, b, canvas.width, canvas.height);
  }
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.95 });
}

// A balloon's outline from its renderer hints: the stroke colour and width — `px` in page pixels
// or `em` of the font size (older records) — or null for none. The width is the outward ring;
// strokes are centred, so it is doubled and the fill painted over the inner half.
export function textOutline(st) {
  if (st.borderDisabled || !Array.isArray(st.fg)) return null;
  const black = st.fg.length === 3 && st.fg.every(c => c >= 0 && c <= 32);
  const whiteHalo = black && st.paintPolicy !== 'manga2eng';
  const color = whiteHalo && !st.strokeColorExplicit ? [255, 255, 255] : st.bg;
  if (!Array.isArray(color)) return null;
  // Match the renderer's black-text halo, including records made before this policy.
  const width = whiteHalo ? Math.max(1.5, Number.isFinite(st.strokeWidth) ? st.strokeWidth : 0) : st.strokeWidth;
  if (Number.isFinite(width)) return width > 0 ? { px: 2 * width, color } : null;
  // Older native records use equal fill/background colors to represent no outline.
  if (st.fg.every((c, i) => c === color[i])) return null;
  return { em: 0.16, color };
}

// The reader's balloon face, loaded here too: a page composed away from the reader (served back
// to a site, say) has no stylesheet declaring it.
const FONT = 'CC Victory Speech';
let _font = null;
function _loadFont() {
  const fonts = globalThis.document?.fonts ?? globalThis.fonts;
  if (!fonts || typeof FontFace !== 'function') return null;
  return _font ??= new FontFace(FONT, `local("${FONT}"), url("${new URL('../fonts/ccvictoryspeech.ttf', import.meta.url)}")`)
    .load().then(face => { fonts.add(face); }).catch(() => {});
}

// One balloon's translation as the reader shows it as text (.study-text): the renderer's size,
// colours and outline, the block centred in the rect the renderer drew at, each line centred (or
// aligned as the renderer did). The lines are the renderer's own, fitted to that rect with its
// font, so they are kept as drawn rather than re-wrapped on this font's slightly different widths.
function _typeset(ctx, b, W, H) {
  const r = b?.tbox || b?.rbox || b?.region || b?.box;
  if (!b?.tr || !r) return;
  const st = b.style || {};
  const fs = st.fontSize || Math.max(12, Math.round(W * 0.022));
  const lh = (st.lineH || (st.caps ? 1.0 : 1.15)) * fs;
  ctx.font = `400 ${fs}px "${FONT}", "Comic Sans MS", sans-serif`;
  const lines = (st.caps ? b.tr.toUpperCase() : b.tr).split(/\r?\n/);
  const m = ctx.measureText(lines.join(''));
  const asc = m.fontBoundingBoxAscent ?? 0.8 * fs, desc = m.fontBoundingBoxDescent ?? 0.2 * fs;
  const blockW = Math.min(r.w * W, Math.max(...lines.map(l => ctx.measureText(l).width)));
  const cx = (r.x + r.w / 2) * W;
  const align = st.align === 'left' || st.align === 'right' ? st.align : 'center';
  const x = align === 'left' ? cx - blockW / 2 : align === 'right' ? cx + blockW / 2 : cx;
  // CSS centres each line's glyph box (ascent + descent) in its line height.
  const first = (r.y + r.h / 2) * H - lines.length * lh / 2 + (lh - asc - desc) / 2 + asc;
  const outline = textOutline(st);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = Array.isArray(st.fg) ? `rgb(${st.fg.join(',')})` : '#111';
  if (outline) {
    ctx.lineWidth = outline.px ?? outline.em * fs;
    ctx.strokeStyle = `rgb(${outline.color.join(',')})`;
  }
  lines.forEach((line, i) => {
    if (outline) ctx.strokeText(line, x, first + i * lh);
    ctx.fillText(line, x, first + i * lh);
  });
}
