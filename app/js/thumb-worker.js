// thumb-worker.js — makes small copies of pages off the page's main thread. A canvas encode on the
// main thread is scheduled into the page's idle time, and a busy or hidden page gets none: each
// thumbnail then waits up to a second for its turn. Here the same resize-and-encode runs at once.
// Nothing is kept: each request is one blob in, one small blob out.

import { resizeToWidth } from './image-util.js';

self.onmessage = async ({ data: { id, blob, width, format, quality } }) => {
  try {
    self.postMessage({ id, blob: await resizeToWidth(blob, width, { format, quality }) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
