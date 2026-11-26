// import-batch-view.js — what a batch of imports (import-batch.js) tells a person, whoever draws it:
// how it stands (running, waiting, done, stopped, or lost: its page is gone), what its panel says
// (titles and bytes in, the pace and the time left, the title under way, the titles found imported
// already and those that failed, and when nothing has moved for a while), and its titles as a list,
// filtered and shown a step at a time. Also how a page asks the page running a batch for its titles.
// The import tracker draws from it (import-tracker.js, and the new UI's ImportTracker).

import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { BATCH_CHANNEL, localTitles } from './import-batch.js';

export const QUIET_MS = 2 * 60 * 1000;     // nothing moving this long is said
const LOST_MS = 20 * 1000;          // a batch silent this long has lost its runner (it says so every 5 s)
export const PAINT_EVERY_MS = 5000;        // time left, quiet and lost are read again this often
export const TITLES_EVERY_MS = 2000;       // an open list asks for its titles again this often
export const ROWS_STEP = 200;              // titles shown at a time
export const FILTERS = ['all', 'waiting', 'importing', 'done', 'skipped', 'failed', 'stopped'];

// Asking for a batch's titles: from this page when it runs the batch, else from the page that does,
// on BATCH_CHANNEL (null when none answers). Returns { titlesOf(id), close() }.
export function titlesSource() {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(BATCH_CHANNEL) : null;
  const waiting = new Map();    // batch id → resolve of a titles request
  if (channel) channel.onmessage = ({ data }) => {
    if (data?.type === 'titles') { waiting.get(data.batch)?.(data.titles); waiting.delete(data.batch); }
  };
  const titlesOf = (id) => {
    const here = localTitles(id);
    if (here || !channel) return Promise.resolve(here);
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      channel.postMessage({ type: 'titles?', batch: id });
      setTimeout(() => { if (waiting.get(id) === resolve) { waiting.delete(id); resolve(null); } }, 1500);
    });
  };
  return { titlesOf, close: () => channel?.close() };
}

// How the batch `id` stands, by its last news `job`: running, waiting, done, stopped, or lost.
const lost = (job, id) => job && job.status === 'progress' && !localTitles(id) && Date.now() - (job.at || 0) > LOST_MS;
export const batchState = (job, id) => (!job ? 'running' : job.status === 'done' ? 'done' : job.status === 'cancelled' ? 'stopped' : lost(job, id) ? 'lost'
  : job.waiting ? 'waiting' : 'running');
export const isLive = (state) => ['running', 'waiting'].includes(state);
// A batch not begun, or whose page is gone, has no titles to tell.
export const hasTitles = (state) => !(state === 'lost' || state === 'waiting');

// What the panel says of `job` standing as `s` (batchState): its name, its size, the bar's width, the
// tally, the title under way (and whether nothing has moved for a while), and its issues.
export function batchView(job, s) {
  const cur = job.current;
  const curShare = cur?.total ? Math.min(1, cur.done / cur.total) : 0;
  const bytesIn = (job.bytesDone || 0) + (cur ? (cur.bytes || 0) * curShare : 0);
  const tally = s === 'done' ? t('imp.done', { n: formatCount(job.imported) })
    : s === 'stopped' ? t('imp.stopped', { done: formatCount(job.done), total: formatCount(job.total) })
    : s === 'lost' ? t('imp.lost', { done: formatCount(job.done), total: formatCount(job.total) })
    : s === 'waiting' ? t('imp.waiting')
    : [t('imp.tally', { done: formatCount(job.done), total: formatCount(job.total), bytes: formatBytes(bytesIn), size: formatBytes(job.bytes) }),
      ..._pace(job, bytesIn)].join(' · ');
  const quiet = s === 'running' && cur && Date.now() - (job.movedAt || job.at || 0) > QUIET_MS;
  return {
    name: job.name || '',
    total: t('imp.ask_total', { n: formatCount(job.total), size: formatBytes(job.bytes) }),
    width: `${Math.round(((job.done + curShare) / Math.max(1, job.total)) * 1000) / 10}%`,
    tally,
    quiet: !!quiet,
    now: s !== 'running' || !cur ? ''
      : quiet ? t('imp.quiet', { n: formatCount(Math.floor((Date.now() - job.movedAt) / 60000)), done: formatCount(cur.done), total: formatCount(cur.total), name: cur.name })
      : cur.total ? t('imp.now', { name: cur.name, done: formatCount(cur.done), total: formatCount(cur.total) }) : t('imp.now_start', { name: cur.name }),
    issues: [job.skipped ? t('imp.skipped', { n: formatCount(job.skipped) }) : '',
      job.failed ? t('imp.failed', { n: formatCount(job.failed) }) : ''].filter(Boolean).join(' · '),
    failed: job.failed > 0,
  };
}

// The titles list (`titles`: each { name, status, error }, or null when none could be had) under the
// filter `filter`, `shown` at most: how many each filter holds, the titles shown, and whether more
// match.
export function titlesView(titles, filter, shown) {
  const counts = Object.fromEntries(FILTERS.map((f) => [f, 0]));
  for (const ti of titles || []) { counts.all++; counts[ti.status] = (counts[ti.status] || 0) + 1; }
  const matching = (titles || []).filter((ti) => filter === 'all' || ti.status === filter);
  return { counts, rows: matching.slice(0, shown), more: matching.length > shown };
}

// The pace so far and the time left, once there is enough to tell.
function _pace(job, bytesIn) {
  const s = (Date.now() - (job.startedAt || Date.now())) / 1000;
  if (s < 10 || bytesIn <= 0) return [];
  const rate = bytesIn / s;
  const left = Math.max(0, job.bytes - bytesIn) / rate;
  const m = Math.round(left / 60);
  return [t('imp.rate', { rate: formatBytes(rate) }),
    left < 60 ? t('imp.eta_s') : m < 60 ? t('imp.eta_m', { m: formatCount(m) }) : t('imp.eta_h', { h: formatCount(Math.floor(m / 60)), m: formatCount(m % 60) })];
}
