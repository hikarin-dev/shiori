// desktop-shell.js — what the desktop app asks of the window it shows, before it quits: the jobs
// running there, and stopping them. Loaded only by the desktop app (it imports this module into
// its window's page).
import * as platform from './platform.js';
import * as api from './api.js';
import { services } from './services.js';
import { pickTitle } from './titles.js';
import { getLang } from './i18n.js';

const _gidOf = (entry) => String(entry?.payload?.galleryId ?? String(entry?.key || '').split(':')[0]);

// The galleries an import or a translation is under way for: { count, titles } (a translation the
// translation server is still working on counts, as does a job waiting to be resumed here).
export async function activeJobs() {
  const [pending, translating] = await Promise.all([platform.jobsPending.all(), platform.translateResume.all()]);
  const gids = [...new Set([...pending.map(_gidOf), ...translating.map(r => String(r.gid))])].filter(Boolean);
  const galleries = await api.galleries.byIds(gids).catch(() => []);
  const titles = gids.map((gid, i) => pickTitle({ title: galleries[i]?.title }, getLang()) || `#${gid}`);
  return { count: gids.length, titles };
}

// Stop every job: a translation is cancelled where it runs, on the translation server too; an
// import stops with the window and isn't picked up again next time.
export async function cancelJobs() {
  for (const rec of await platform.translateResume.all()) {
    await services.handle({ type: 'CANCEL_TRANSLATE', galleryId: rec.gid }).catch(() => {});
  }
  for (const entry of await platform.jobsPending.all()) {
    if (entry.kind === 'translate') await services.handle({ type: 'CANCEL_TRANSLATE', galleryId: _gidOf(entry) }).catch(() => {});
    await platform.jobsPending.remove(entry.key);
    platform.jobs.publish({ gid: _gidOf(entry), kind: entry.kind, status: 'cancelled' });
  }
}
