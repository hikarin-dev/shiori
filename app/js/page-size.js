// page-size.js — how big a gallery's pages are. Each page's pixel size is read from its image
// header (a few KB, never a decode for the usual formats); the gallery's typical page is its
// median page by area, so a cover, a spread or a credits page doesn't move it. Its megapixels
// place the gallery in a tier.

// Upper bounds in megapixels. Each tier holds about 1.5× the pixels of the one below.
export const TIERS = [
  { id: 'T1', name: 'Low', max: 1.4 },
  { id: 'T2', name: 'Medium', max: 2.2 },
  { id: 'T3', name: 'Standard', max: 3 },
  { id: 'T4', name: 'High', max: 5 },
  { id: 'T5', name: 'Very high', max: 8 },
  { id: 'T6', name: 'Print', max: Infinity },
];

export const tierOf = (mp) => (Number.isFinite(mp) && mp > 0 ? TIERS.find(t => mp < t.max) : null);

// A stored median page ({ w, h }) as every surface reads it, or null when there is none yet.
export function describePage(page) {
  if (!(page?.w > 0 && page?.h > 0)) return null;
  const mp = page.w * page.h / 1e6;
  return { w: page.w, h: page.h, mp, tier: tierOf(mp).id };
}

// The page whose area is the median — the lower middle of an even count. A size may carry a
// weight `n` (a chapter standing for its n pages); unweighted sizes count once.
export function medianPage(sizes) {
  const valid = sizes.filter(s => s?.w > 0 && s?.h > 0).sort((a, b) => a.w * a.h - b.w * b.h);
  const weight = (s) => (s.n > 0 ? s.n : 1);
  const half = Math.ceil(valid.reduce((sum, s) => sum + weight(s), 0) / 2);
  let seen = 0;
  for (const s of valid) {
    seen += weight(s);
    if (seen >= half) return { w: s.w, h: s.h };
  }
  return null;
}

// { w, h } from the leading bytes of an image; undefined when the size lies further in than
// what was read, null when the format isn't one of these.
export function headerSize(d) {
  const u16be = (o) => (d[o] << 8) | d[o + 1];
  const u16le = (o) => d[o] | (d[o + 1] << 8);
  const u24le = (o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
  const u32be = (o) => ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
  const is = (o, s) => [...s].every((c, i) => d[o + i] === c.charCodeAt(0));
  if (d.length < 12) return null;
  if (is(0, '\x89PNG')) return d.length >= 24 ? { w: u32be(16), h: u32be(20) } : null;
  if (is(0, 'GIF8')) return { w: u16le(6), h: u16le(8) };
  if (is(0, 'RIFF') && is(8, 'WEBP')) {
    if (d.length < 30) return null;
    if (is(12, 'VP8 ')) return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (is(12, 'VP8L')) return { w: 1 + (((d[22] & 0x3f) << 8) | d[21]), h: 1 + (((d[24] & 0xf) << 10) | (d[23] << 2) | ((d[22] & 0xc0) >> 6)) };
    if (is(12, 'VP8X')) return { w: 1 + u24le(24), h: 1 + u24le(27) };
    return null;
  }
  if (d[0] === 0xff && d[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker (not DHT C4, JPG C8 or DAC CC).
    for (let o = 2; o + 9 < d.length;) {
      if (d[o] !== 0xff) { o++; continue; }
      const m = d[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16be(o + 7), h: u16be(o + 5) };
      o += 2 + u16be(o + 2);
    }
    return undefined;
  }
  if (is(4, 'ftyp')) {
    // AVIF/HEIF: the image-extent properties. A grid image lists its tiles too, so the largest
    // extent is the image itself.
    let best;
    for (let i = 12; i + 16 <= d.length; i++) {
      if (!is(i, 'ispe')) continue;
      const w = u32be(i + 8), h = u32be(i + 12);
      if (!best || w * h > best.w * best.h) best = { w, h };
    }
    return best;
  }
  return null;
}

// A page's pixel size, or null when it can't be read.
export async function imageSize(blob) {
  for (const n of [4096, 65536, 1 << 20]) {
    const bytes = new Uint8Array(await blob.slice(0, n).arrayBuffer());
    const size = headerSize(bytes);
    if (size) return size;
    if (size === null || bytes.length < n) break;
  }
  // An unknown format or an unusual layout: decode it once.
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size;
  } catch { return null; }
}
