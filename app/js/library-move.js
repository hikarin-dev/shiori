// library-move.js — moving galleries from this browser's library into the desktop app's: the whole
// library when a site starts using the desktop app, or what was saved while it continued without
// it. One gallery at a time in the full-backup record format, each checked once it lands (every
// page it had is there); what has moved is noted as it goes, so a move cut short carries on where
// it stopped. The browser keeps its copies until the person deletes them.
import * as api from './api.js';
import { checkInvariants } from './library-check.js';

const JOURNAL_KEY = 'shiori:moveJournal';
const JOURNAL_EVERY = 20;   // galleries between notes of progress (a gallery moved twice is moved alike)

function readJournal(token) {
  try {
    const j = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
    return j?.token === token && Array.isArray(j.done) ? new Set(j.done) : new Set();
  } catch { return new Set(); }
}
function writeJournal(token, done) {
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify({ token, done: [...done] })); } catch {}
}
function clearJournal() { try { localStorage.removeItem(JOURNAL_KEY); } catch {} }

// The galleries this browser holds (placeholders with nothing in them aside), those added at or
// after `since` when given.
export async function browserGalleries({ since = null } = {}) {
  const list = await api.browserLibraryForMove().list();
  return list.filter(g => (!g.isStub || g.count > 0) && (since == null || g.addedAt >= since)).map(g => g.gid);
}

// Move `ids` into the desktop library `config` names ({ url, token }). `onProgress(done, total)`
// follows it; it stops between galleries once `signal` aborts. Resolves { moved, failed, errors }:
// how many moved, those that couldn't ({ gid, error }), and what the desktop library's check found
// wrong afterwards (only when everything moved).
export async function moveToDesktop(config, ids, { onProgress = () => {}, signal = null } = {}) {
  const source = api.browserLibraryForMove();
  const target = api.desktopLibraryForMove(config);
  const done = readJournal(config.token);
  const failed = [];
  let moved = 0, since = 0;
  try {
    for (let i = 0; i < ids.length; i++) {
      if (signal?.aborted) break;
      const gid = String(ids[i]);
      if (!done.has(gid)) {
        try {
          const bundle = await source.read(gid);
          // A page stored without a page number (long ago) can't be addressed in either library.
          bundle.pages = bundle.pages.filter(p => /\/\d+\.(webp|jpg|jpeg|png|gif|avif)$/i.test(String(p.url)));
          await target.write({ galleryId: gid, ...bundle }, { silent: true });
          const there = new Set((await target.pages(gid)).map(p => p.url));
          const lost = bundle.pages.filter(p => /\/\d+\.\w+$/.test(String(p.url)) && !there.has(p.url));
          if (lost.length) throw new Error(`${lost.length} page(s) missing once moved`);
          done.add(gid);
          moved++;
          if (++since >= JOURNAL_EVERY) { writeJournal(config.token, done); since = 0; }
        } catch (e) {
          failed.push({ gid, error: String(e?.message || e) });
        }
      }
      onProgress(i + 1, ids.length);
    }
    const finished = !signal?.aborted && !failed.length;
    if (finished) clearJournal(); else writeJournal(config.token, done);
    const errors = finished
      ? checkInvariants(await target.integritySnapshot()).violations.filter(v => v.severity === 'error')
      : [];
    return { moved, failed, errors };
  } finally {
    target.close();
  }
}

// Delete this browser's library (once it has moved).
export const clearBrowserLibrary = () => api.browserLibraryForMove().clear();
