// cover-fit.ts — how a card's cover sits in its portrait box (src/components/gallery-card.tsx).
//
// 1.3's paintCardGlow, moved as it is: a landscape cover's bars are filled with an ambient glow built
// as ambient-light video players build theirs, copies of the cover stacked behind it, each a step
// taller than the last so its edge colours reach outward, then blurred. Tuned to the maximum spread
// (400%, in 12% edge steps) and a 100% blur (a radius of 25% of the cover's height). The copies grow
// only vertically (the bars are above and below), so each colour runs straight out of the edge it
// touches. Shown as an image, not the canvas it is drawn on: a canvas gets a compositor layer of its
// own, and a card growing over one would be drawn on another, its text thinned.
const GLOW_SPREAD = 4, GLOW_EDGE = 0.12, GLOW_BLUR = 0.25;
// The glow overhangs the cover's box by half its size on every side (the stylesheet, same fraction).
const GLOW_BLEED = 0.5;
export type Glow = { src: string; blur: string };
export function paintGlow(img: HTMLImageElement): Glow | null {
  const aspect = img.naturalWidth / img.naturalHeight;
  // Small is enough: the result is blurred and scaled up. One downscaled copy is drawn repeatedly.
  const src = document.createElement('canvas');
  src.width = 48; src.height = Math.max(1, Math.round(48 / aspect));
  const sctx = src.getContext('2d');
  if (!sctx) return null;
  sctx.drawImage(img, 0, 0, src.width, src.height);
  const W = 96, H = W * Math.SQRT2;                       // the cover's box (1:√2) in canvas px
  const padX = W * GLOW_BLEED, padY = H * GLOW_BLEED;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W + 2 * padX);
  canvas.height = Math.round(H + 2 * padY);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const coverW = W, coverH = W / aspect;                  // object-fit: contain, width-bound
  const cx = canvas.width / 2, cy = canvas.height / 2;
  // Tallest first, each shorter copy covering the middle of the one behind it; the step is scaled by
  // the aspect ratio, as the spread would be for a glow around all four sides. Each copy's outer
  // columns are stretched sideways across the overhang so the blur finds colour at the card's sides.
  const x0 = cx - coverW / 2, x1 = cx + coverW / 2;
  for (let level = Math.round(GLOW_SPREAD / GLOW_EDGE); level >= 0; level--) {
    const h = coverH * (1 + GLOW_EDGE * aspect * level), y0 = cy - h / 2;
    ctx.drawImage(src, 0, 0, 1, src.height, 0, y0, x0, h);
    ctx.drawImage(src, src.width - 1, 0, 1, src.height, x1, y0, canvas.width - x1, h);
    ctx.drawImage(src, x0, y0, coverW, h);
  }
  // The radius in the cover's width units (cqw), so it holds at any card size.
  return { src: canvas.toDataURL(), blur: `blur(${(GLOW_BLUR * 100 / aspect).toFixed(2)}cqw)` };
}
