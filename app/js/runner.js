// runner.js — the page the desktop app keeps open out of sight (desktop/main.js) for the work its
// windows start. Handed over here (submit-job.js handImport, handImportBatch), an import runs to the
// end whatever the window does meanwhile — goes to an overview or the reader, reloads, closes to the
// tray — as a browser's service worker keeps a browser's going. What it runs, and how what waits
// shows, is import-queue.js's. A translation a page of the library hands the app (server.js runJob,
// from the desktop app's own window or a site's tab) runs here too, and is polled from here.
import * as platform from './platform.js';
import { RUNNER_CHANNEL, submitJob } from './submit-job.js';
import { runPoll } from './jobs-runner.js';
import { enqueue, activeJobs, cancelJobs } from './import-queue.js';

const channel = new BroadcastChannel(RUNNER_CHANNEL);
channel.onmessage = ({ data }) => {
  if (!(data?.type === 'import' && data.group?.files?.length) && !(data?.type === 'batch' && data.batch?.groups?.length)) return;
  channel.postMessage({ type: 'taken', id: data.id });
  enqueue(data);
};

// ── Translations ──
// `translate`: start one (payload as jobs-runner.js runTranslate takes it) — refused while the
// gallery is translating already when it names pages; `poll`: make sure what is in flight is
// collected. Resolves { ok, busy }.
const POLL_EVERY_MS = 3000;
const _translating = async (gid) => !!(await platform.translateResume.get(gid))
  || (await platform.jobsPending.all()).some((e) => e.key === `${gid}:translate`);
export async function runJob(kind, payload) {
  if (kind === 'translate') {
    const gid = String(payload.galleryId);
    if (payload.pages && await _translating(gid)) return { ok: false, busy: true };
    await submitJob('translate', payload);   // this page has no service worker: it runs here
  } else if (kind !== 'poll') return { ok: false };
  _pollWhileTranslating();
  return { ok: true };
}
export async function stopJob(kind, payload) {
  if (kind !== 'translate') return { ok: false };
  const { services } = await import('./services.js');
  return services.handle({ type: 'CANCEL_TRANSLATE', galleryId: String(payload.galleryId) });
}
// Poll while anything is in flight, every few seconds; then rest until asked again.
let _polling = null;
function _pollWhileTranslating() {
  _polling ||= (async () => {
    try {
      for (;;) {
        const inFlight = (await platform.translateResume.all()).length
          || (await platform.jobsPending.all()).some((e) => e.kind === 'translate');
        if (!inFlight) return;
        await runPoll().catch(() => {});
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
      }
    } finally { _polling = null; }
  })();
}

// For the desktop app's question before it quits, as desktop-shell.js answers for its window.
export { activeJobs, cancelJobs };

globalThis.shioriDesktop?.shell?.('runnerReady').catch(() => {});
