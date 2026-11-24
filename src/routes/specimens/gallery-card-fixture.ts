// The library the Phase 0 captures were made of (plans/frontend-react-probes/lib/fixture.mjs), as 1.3's
// library page held its galleries (store.js's entities, read from it), for the gallery card's
// specimens: the same words, figures and tags, so a specimen can be laid over a capture. The source of
// the one gallery that has one is a made-up neutral one, its page on this site (the app names no
// address of anyone else's, not even a made-up one). Its covers are made as 1.3 made them: each
// gallery's first page drawn as the fixture draws it (flat colour, its big and small numbers) and made a
// cover by the app's own resizeCover at the width 1.3 asked for (256): the same bytes 1.3 showed, in
// each browser (each encodes its own).
import { resizeCover } from '@lib/image-util.js';
import type { CardGallery } from '@/lib/card-view';

// The source's page of the gallery that has one.
const SOURCE_PAGE = `${location.origin}/g/48213`;

export const GALLERIES = {
  tagged: {"id":"1790000001060","count":4,"numPages":4,"size":22424,"origSize":17108,"aggPages":4,"aggSize":22424,"aggOrig":17108,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"A Card With Many Tags","japanese":"","pretty":""},"tags":[{"type":"category","name":"doujinshi"},{"type":"rating","name":"erotica"},{"type":"artist","name":"studio north"},{"type":"artist","name":"ito"},{"type":"language","name":"english"},{"type":"tag:female","name":"glasses"},{"type":"tag:female","name":"long hair"},{"type":"tag:female","name":"ponytail"},{"type":"tag:male","name":"suit"},{"type":"parody","name":"original"},{"type":"character","name":"the librarian"},{"type":"group","name":"night owls"},{"type":"tag","name":"tag number 1"},{"type":"tag","name":"tag number 2"},{"type":"tag","name":"tag number 3"},{"type":"tag","name":"tag number 4"},{"type":"tag","name":"tag number 5"},{"type":"tag","name":"tag number 6"},{"type":"tag","name":"tag number 7"},{"type":"tag","name":"tag number 8"},{"type":"tag","name":"tag number 9"},{"type":"tag","name":"tag number 10"},{"type":"tag","name":"tag number 11"},{"type":"tag","name":"tag number 12"},{"type":"tag","name":"tag number 13"},{"type":"tag","name":"tag number 14"},{"type":"tag","name":"tag number 15"},{"type":"tag","name":"tag number 16"},{"type":"tag","name":"tag number 17"},{"type":"tag","name":"tag number 18"},{"type":"tag","name":"tag number 19"},{"type":"tag","name":"tag number 20"},{"type":"tag","name":"tag number 21"},{"type":"tag","name":"tag number 22"}],"languages":["en"],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  long: {"id":"1790000001059","count":5,"numPages":5,"size":24144,"origSize":21124,"aggPages":5,"aggSize":24144,"aggOrig":21124,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"The Extraordinarily Long and Winding Chronicle of a Librarian Who Catalogued Every Single Volume in the Kingdom, Twice, and Then Started Over From the Very Beginning","japanese":"王国のすべての本を二度も目録にした司書の、とてつもなく長く曲がりくねった年代記","pretty":""},"tags":[{"type":"category","name":"manga"},{"type":"rating","name":"safe"},{"type":"artist","name":"aoki ren"},{"type":"tag","name":"library"},{"type":"tag","name":"slice of life"},{"type":"tag","name":"comedy"},{"type":"language","name":"japanese"}],"languages":["ja"],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":true,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  landscape: {"id":"1790000001058","count":4,"numPages":4,"size":17244,"origSize":15016,"aggPages":4,"aggSize":17244,"aggOrig":15016,"medianPage":{"w":900,"h":600,"mp":0.54,"tier":"T1"},"aggMedianPage":{"w":900,"h":600,"mp":0.54,"tier":"T1"},"title":{"english":"Panorama Sketchbook","japanese":"","pretty":""},"tags":[{"type":"category","name":"artist cg"},{"type":"rating","name":"safe"},{"type":"artist","name":"mori"},{"type":"tag","name":"landscape"},{"type":"tag","name":"full color"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  series: {"id":"1790000001057","count":6,"numPages":6,"size":29600,"origSize":25452,"aggPages":26,"aggSize":218082,"aggOrig":111572,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Harbor Lights Ch. 1","japanese":"","pretty":""},"tags":[{"type":"category","name":"manga"},{"type":"rating","name":"safe"},{"type":"artist","name":"kanzaki"},{"type":"tag","name":"sea"},{"type":"tag","name":"mystery"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":true,"chapters":[{"id":"1790000001057","title":"Arrival","number":1},{"id":"1790000001041","title":"The Lighthouse Keeper","number":2},{"id":"1790000001042","title":"Low Tide","number":3},{"id":"1790000001043","title":"Interlude","number":3.5},{"id":"1790000001044","title":"A Chapter Whose Title Is Long Enough to Need Its Whole Row and Then Some More Room After That","number":4},{"id":"1790000001045","title":"","number":1,"kind":"volume"},{"id":"1790000001046","title":"","number":2,"kind":"volume"}],"chapterCount":7,"isSeries":true,"seriesTitle":{"english":"Harbor Lights","japanese":"港の灯","pretty":""}},
  translated: {"id":"1790000001056","count":3,"numPages":3,"size":69600,"origSize":12756,"aggPages":3,"aggSize":69600,"aggOrig":12756,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Translated Sample","japanese":"翻訳サンプル","pretty":""},"tags":[{"type":"category","name":"doujinshi"},{"type":"rating","name":"suggestive"},{"type":"artist","name":"hoshino"},{"type":"tag","name":"drama"},{"type":"language","name":"japanese"}],"languages":["ja"],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":true,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  reading: {"id":"1790000001055","count":24,"numPages":24,"size":114684,"origSize":105952,"aggPages":24,"aggSize":114684,"aggOrig":105952,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Twenty-Four Pages","japanese":"","pretty":""},"tags":[{"type":"category","name":"manga"},{"type":"rating","name":"safe"},{"type":"artist","name":"aoki ren"},{"type":"tag","name":"reader fixture"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":true,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  korean: {"id":"1790000001054","count":3,"numPages":3,"size":14747,"origSize":12755,"aggPages":3,"aggSize":14747,"aggOrig":12755,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Rooftop Season","japanese":"","pretty":""},"tags":[{"type":"category","name":"manhwa"},{"type":"rating","name":"suggestive"},{"type":"artist","name":"baek"},{"type":"tag","name":"romance"},{"type":"tag","name":"webtoon"},{"type":"language","name":"korean"}],"languages":["ko"],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  sourced: {"id":"1790000001053","count":3,"numPages":3,"size":14773,"origSize":12736,"aggPages":3,"aggSize":14773,"aggOrig":12736,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Gallery With a Source","japanese":"","pretty":""},"tags":[{"type":"category","name":"western"},{"type":"rating","name":"pornographic"},{"type":"artist","name":"quill"},{"type":"tag","name":"sci-fi"},{"type":"language","name":"english"}],"languages":["en"],"source":"a.example","sourceId":"48213",sourceUrl: SOURCE_PAGE,"isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  pageless: {"id":"1790000001052","count":0,"numPages":18,"size":608,"origSize":0,"aggPages":0,"aggSize":608,"aggOrig":0,"medianPage":null,"aggMedianPage":null,"title":{"english":"No Pages Yet","japanese":"","pretty":""},"tags":[{"type":"category","name":"manga"},{"type":"tag","name":"waiting"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  plain: {"id":"1790000001051","count":3,"numPages":3,"size":14394,"origSize":12913,"aggPages":3,"aggSize":14394,"aggOrig":12913,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Plain","japanese":"","pretty":""},"tags":[{"type":"tag","name":"smoke"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  chinese: {"id":"1790000001050","count":2,"numPages":2,"size":10007,"origSize":8536,"aggPages":2,"aggSize":10007,"aggOrig":8536,"medianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"aggMedianPage":{"w":600,"h":860,"mp":0.516,"tier":"T1"},"title":{"english":"Lantern Street","japanese":"","pretty":""},"tags":[{"type":"category","name":"manhua"},{"type":"rating","name":"safe"},{"type":"tag","name":"historical"},{"type":"language","name":"chinese"}],"languages":["zh"],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
  small: {"id":"1790000001049","count":1,"numPages":1,"size":2378,"origSize":1440,"aggPages":1,"aggSize":2378,"aggOrig":1440,"medianPage":{"w":300,"h":430,"mp":0.129,"tier":"T1"},"aggMedianPage":{"w":300,"h":430,"mp":0.129,"tier":"T1"},"title":{"english":"One Page","japanese":"","pretty":""},"tags":[{"type":"category","name":"image set"},{"type":"rating","name":"safe"}],"languages":[],"source":"","sourceId":null,"sourceUrl":"","isLocalImport":false,"translated":false,"favorite":false,"chapters":null,"chapterCount":0,"isSeries":false,"seriesTitle":null},
} satisfies Record<string, CardGallery>;
export type FixtureName = keyof typeof GALLERIES;

// Each gallery's first page: its hue, its small number (its place in the fixture), its size.
const PICTURES: Partial<Record<FixtureName, { hue: number; g: number; w?: number; h?: number }>> = {
  tagged: { hue: 280, g: 5 },
  long: { hue: 350, g: 1 },
  landscape: { hue: 205, g: 2, w: 900, h: 600 },
  series: { hue: 25, g: 4 },
  translated: { hue: 140, g: 3 },
  reading: { hue: 60, g: 6 },
  korean: { hue: 320, g: 7 },
  sourced: { hue: 175, g: 8 },
  plain: { hue: 100, g: 10 },
  chinese: { hue: 235, g: 11 },
  small: { hue: 45, g: 12, w: 300, h: 430 },
};

// lib/fixture.mjs's picture(), drawn on a canvas: the same rectangles at the same whole pixels, so the
// same pixels as the PNG the capture's server made.
function hsl(h: number, s: number, l: number) {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
}
const SEGMENTS: Record<string, string> = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };

function picture({ w = 600, h = 860, hue, n = 1, g }: { w?: number; h?: number; hue: number; n?: number; g: number }): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const rect = (x: number, y: number, rw: number, rh: number, [r, gg, b]: number[]) => {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(w, Math.round(x + rw)), y1 = Math.min(h, Math.round(y + rh));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.fillStyle = `rgb(${r},${gg},${b})`;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  const digits = (value: number, x: number, y: number, size: number, colour: number[]) => {
    const t = Math.max(2, Math.round(size / 6)), dw = size, dh = size * 2;
    for (const ch of String(value)) {
      const on = SEGMENTS[ch] || '';
      if (on.includes('a')) rect(x, y, dw, t, colour);
      if (on.includes('g')) rect(x, y + dh / 2 - t / 2, dw, t, colour);
      if (on.includes('d')) rect(x, y + dh - t, dw, t, colour);
      if (on.includes('f')) rect(x, y, t, dh / 2, colour);
      if (on.includes('b')) rect(x + dw - t, y, t, dh / 2, colour);
      if (on.includes('e')) rect(x, y + dh / 2, t, dh / 2, colour);
      if (on.includes('c')) rect(x + dw - t, y + dh / 2, t, dh / 2, colour);
      x += dw + Math.round(size / 2);
    }
  };
  rect(0, 0, w, h, hsl(hue, 45, 24));
  const m = Math.round(Math.min(w, h) * 0.05), gap = Math.round(m * 0.6);
  const top = Math.round(h * 0.56);
  rect(m, m, w - 2 * m, top - m, hsl(hue, 50, 52));
  rect(m, top + gap, (w - 2 * m - gap) * 0.45, h - top - gap - m, hsl((hue + 30) % 360, 45, 40));
  rect(m + (w - 2 * m - gap) * 0.45 + gap, top + gap, (w - 2 * m - gap) * 0.55, h - top - gap - m, hsl((hue + 330) % 360, 55, 66));
  const big = Math.round(Math.min(w, h) * 0.14);
  digits(n, m * 2, m * 2, big, [255, 255, 255]);
  digits(g, m * 2, top + gap + m, Math.round(big * 0.4), [20, 20, 24]);
  return canvas.convertToBlob({ type: 'image/png' });
}

// The covers, as data URLs (nothing to let go of), made once a page asks for them.
let made: Promise<Partial<Record<FixtureName, string>>> | null = null;
export function fixtureCovers() {
  made ??= (async () => {
    const out: Partial<Record<FixtureName, string>> = {};
    for (const [name, p] of Object.entries(PICTURES) as [FixtureName, NonNullable<(typeof PICTURES)[FixtureName]>][]) {
      out[name] = (await resizeCover(await picture(p), 256)) as string;
    }
    return out;
  })();
  return made;
}
