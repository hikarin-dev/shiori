// import-log.js — a record of imports in the console ("[import] …" lines, one JSON object each),
// enough to tell afterwards what a batch did and where one failed: each gallery's size, pace and
// outcome, the storage it left behind, and an error with the page it stopped at. A gallery taking
// long says how far it is every half minute; a batch (one drop or pick, import-batch.js) is summed up
// as it ends.

import * as platform from './platform.js';

const HEARTBEAT_MS = 30000;
const _mb = (bytes) => Math.round((bytes || 0) / 1048576 * 10) / 10;

export const logImport = (event, fields) => console.info(`[import] ${event}`, JSON.stringify(fields));

// What the browser says this app stores and may store, and this page's script memory.
async function _state() {
  const out = {};
  try { const { usage, quota } = await navigator.storage.estimate(); Object.assign(out, { usedMB: _mb(usage), quotaMB: _mb(quota) }); } catch {}
  if (globalThis.performance?.memory) out.heapMB = _mb(performance.memory.usedJSHeapSize);
  return out;
}

const _error = (e) => ({
  name: e?.name, message: String(e?.message || e), ...(e?.code ? { code: e.code } : {}),
  ...(e?.stack ? { stack: String(e.stack).split('\n').slice(0, 4).join(' | ') } : {}),
});

// What an import reads: a folder's files (a zip's entries), a zip file, or a zip's bytes.
function _source(source) {
  if (Array.isArray(source)) return { from: 'files', files: source.length, MB: _mb(source.reduce((n, e) => n + (e.size || 0), 0)) };
  if (source instanceof Blob) return { from: 'zip', MB: _mb(source.size) };
  return { from: 'bytes', MB: _mb(source?.byteLength) };
}

// One gallery's import: logged as it starts, every half minute while it runs (progress(p) keeps
// the engine's latest count), and as it ends (end(status, error)).
export function galleryLog(gid, name, source) {
  const started = Date.now();
  const what = { gid, name, ..._source(source) };
  let last = { done: 0, total: 0, skipped: 0 };
  logImport('gallery start', { ...what, in: globalThis.document ? 'page' : 'worker' });
  const timer = setInterval(async () => logImport('gallery working', { gid, name, ...last, s: Math.round((Date.now() - started) / 1000), ...await _state() }), HEARTBEAT_MS);
  return {
    progress(p) { if (p.total != null) last = { done: p.done ?? 0, total: p.total, skipped: p.skipped ?? 0 }; },
    async end(status, error) {
      clearInterval(timer);
      const s = (Date.now() - started) / 1000;
      logImport(`gallery ${status}`, { ...what, ...last, s: Math.round(s * 10) / 10, MBps: s ? Math.round(what.MB / s * 10) / 10 : null,
        ...(error ? { error: _error(error) } : {}), ...await _state() });
    },
  };
}

// A batch of imports (import-batch.js): logged as it starts (`what`: its id, name, titles, files and
// bytes) and summed up as it ends (end(tally): its titles imported, skipped as imported before, failed
// — each failure named — and whether it was stopped), with the app's writes over its run.
export async function batchLog({ bytes, ...what }) {
  const started = Date.now();
  const writesAtStart = await platform.writes.get().catch(() => null);
  logImport('batch start', { ...what, MB: _mb(bytes), ...await _state(), writes: writesAtStart });
  return {
    async end(tally) {
      const s = (Date.now() - started) / 1000;
      logImport('batch end', { ...what, ...tally, s: Math.round(s), MBps: s ? Math.round(_mb(bytes) / s * 10) / 10 : null,
        ...await _state(), writes: await platform.writes.get().catch(() => null), writesAtStart });
    },
  };
}
