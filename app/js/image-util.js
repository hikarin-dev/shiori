// image-util.js — the one downscale-and-encode implementation every surface parameterizes.
// Decode at 2× target so the first canvas step is a clean 2× reduction, then halve until at
// target — each step is bilinear over a 2× range, which avoids the aliasing single-pass
// resampling produces on large→small ratios. Format/quality are explicit per caller and must
// not drift: each call site keeps its historical parameters (standing rule: these are derived
// thumbnails/upload copies only — stored originals are never re-encoded).
export async function resizeToWidth(blob, targetW, { format = 'image/jpeg', quality = 0.9 } = {}) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: targetW * 2, resizeQuality: 'high' });
  let w = bitmap.width, h = bitmap.height;
  let canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  while (w > targetW) {
    w = Math.max(targetW, Math.ceil(w / 2));
    h = Math.ceil(h / 2);
    const step = new OffscreenCanvas(w, h);
    step.getContext('2d').drawImage(canvas, 0, 0, w, h);
    canvas = step;
  }
  return canvas.convertToBlob({ type: format, quality });
}

// Image records may hold a Blob (current format) or a legacy base64 data-URL (imported from an
// old backup). These helpers normalize either to the shape a caller needs, in both the service
// worker and pages (no FileReader — it is unavailable in a service worker).
export async function imageToBlob(src) {
  if (!src) return null;
  if (src instanceof Blob) return src;
  try { return await (await fetch(src)).blob(); } catch { return null; }
}
export async function imageToDataUrl(src) {
  if (!src) return null;
  if (typeof src === 'string') return src;
  const buf = new Uint8Array(await src.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return `data:${src.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// A cover at most `maxW` wide, for callers that persist derived thumbnails. Falls back to the full
// cover when it is already small enough or on any decode error. Cover thumbnails keep their
// historical WebP q0.82 parameters.
export async function resizeCoverBlob(src, maxW) {
  const inBlob = await imageToBlob(src);
  if (!inBlob || !maxW) return inBlob;
  try {
    const bitmap = await createImageBitmap(inBlob);
    const alreadySmall = bitmap.width <= maxW;
    bitmap.close();
    if (alreadySmall) return inBlob;
    return await resizeToWidth(inBlob, maxW, { format: 'image/webp', quality: 0.82 });
  } catch { return inBlob; }
}

// The same as a data URL, for callers that don't keep the thumbnail.
export async function resizeCover(src, maxW) {
  return imageToDataUrl(await resizeCoverBlob(src, maxW));
}
