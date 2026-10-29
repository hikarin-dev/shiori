// hidden-writes.js — the galleries a library write is about, so that one whose folder is hidden or
// removed (out of the library meanwhile) is never written to, whichever way the write comes: the
// browser library's (api.js) or the desktop app's (server.js). `op` is the library's own name for the
// write; `args` as it is called with.
import { BackendError } from './backend-error.js';

const BY_ID = new Set(['galleryCreate', 'mutateGallery', 'rebuildGalleryEntry', 'deleteGallery', 'pagePut', 'deleteStaleGalleryImages',
  'clearGalleryTranslations', 'coverThumbnailPut', 'coverPut', 'archiveGallery', 'moveGallery']);
const BY_PAGE = new Set(['putTranslatedPage', 'putPageData', 'putTranslatedImage', 'putPageStudy']);   // ({ galleryId, pageNum }, …)

// The library's writes that name galleries.
export const WRITES = new Set([...BY_ID, ...BY_PAGE, 'metaPut', 'transferWrite', 'setPagesOwn', 'seriesCommand']);

export function writeTargets(op, args = []) {
  if (BY_ID.has(op)) return [args[0]];
  if (BY_PAGE.has(op)) return [args[0]?.galleryId];
  if (op === 'metaPut' || op === 'transferWrite') return [args[0]?.galleryId];
  if (op === 'setPagesOwn') return (Array.isArray(args[0]) ? args[0] : []).map(at => at?.galleryId);
  if (op === 'seriesCommand') return args.slice(1).filter(a => typeof a === 'string' || typeof a === 'number');
  return [];
}

// What such a write is refused with.
export function hiddenError(gid) {
  const e = new BackendError('invalid', `gallery ${gid} is in a hidden library folder`);
  e.reason = 'hidden';
  return e;
}
