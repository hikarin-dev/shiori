// runner.js — the page the desktop app keeps open out of sight (desktop/main.js) for the imports its
// windows start. Handed over here (submit-job.js handImport), an import runs to the end whatever the
// window does meanwhile — goes to an overview or the reader, reloads, closes to the tray — as a
// browser's service worker keeps a browser's going. One at a time, in the order given; each reports
// through platform.jobs as any import does, so every page shows it.
import * as platform from './platform.js';
import { importBytes } from './import-files.js';
import { startImport } from './jobs-runner.js';
import { RUNNER_CHANNEL } from './submit-job.js';

const queue = [];
let current = null;

const channel = new BroadcastChannel(RUNNER_CHANNEL);
channel.onmessage = ({ data }) => {
  if (data?.type !== 'import' || !data.group?.files?.length) return;
  queue.push(data);
  channel.postMessage({ type: 'taken', id: data.id });
  if (!current) run();
};

// A stop (STOP_IMPORT, see jobs-runner.js) drops a waiting import, and ends the one being read here
// once its file is read; from then on jobs-runner.js stops it like any other import.
platform.jobs.subscribe((e) => {
  if (e?.type !== 'STOP_IMPORT') return;
  const gid = String(e.galleryId);
  for (let i = queue.length - 1; i >= 0; i--) if (String(queue[i].galleryId) === gid) queue.splice(i, 1);
  if (current && String(current.galleryId) === gid) current.stopped = true;
});

async function run() {
  while ((current = queue.shift())) {
    const job = current;
    const { galleryId: gid, group, skipExisting } = job;
    let buffer;
    try {
      buffer = await importBytes(group, ({ done, total }) => job.stopped || platform.jobs.publish({
        gid, kind: 'upload', status: 'progress', done, total, labelKey: 'prog.rendering', labelArgs: { done, total },
      }));
    } catch (e) {
      if (!job.stopped) platform.jobs.publish({ gid, kind: 'upload', status: 'error', error: String(e?.message || e) });
      continue;
    }
    if (job.stopped) { platform.jobs.publish({ gid, kind: 'upload', status: 'cancelled' }); continue; }
    await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting });
  }
}

// What runs here, for the desktop app's question before it quits: { count, titles }, as
// desktop-shell.js answers for its window.
export function activeJobs() {
  const jobs = [current, ...queue].filter(Boolean);
  return { count: jobs.length, titles: jobs.map((j) => j.group.name.replace(/\.[^.]+$/, '')) };
}

// Stop: the imports waiting are dropped; the one running stops with the app.
export function cancelJobs() { queue.length = 0; }

globalThis.shioriDesktop?.shell?.('runnerReady').catch(() => {});
