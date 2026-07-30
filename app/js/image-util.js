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
