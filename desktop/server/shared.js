// shared.js — the app's own pure modules, which the desktop library runs as they are: series plans,
// the gallery model, titles, page sizes, the export (gallery-export.js), typed errors, the wire format
// and the full backup's format (backup-core.js, which backup.js runs here for the app's window). The
// library folders' rules come from the app's storage module (js/storage/): the gallery format
// (gallery-files.js), which app keeps a library folder (folder-owner.js), a library folder's
// lifecycle — its states, what each allows, its jobs, how a removal ends (folder-lifecycle.js) — what
// a library folder holds (folder-content.js), what it holds that Shiori didn't make
// (linked-source.js), a gallery's manifest — format v2 (gallery-manifest.js) — and the folder store
// contract's typed results (contract.js, which folder-store.js answers by). And the app's addresses
// (pages.js: which file answers each), which the server serves its pages by. They are read from the
// app's folder (the repository's app/ where nothing says otherwise — the tests; the built site's or
// the packaged copy's when SHIORI_UI_DIR names it — the app itself).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UI_DIR = process.env.SHIORI_UI_DIR
  ? path.resolve(process.env.SHIORI_UI_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');

const load = (name) => import(pathToFileURL(path.join(UI_DIR, 'js', name)).href);

const [plans, model, titles, pageSize, galleryExport, errors, wire, backupCore, files, owner, lifecycle, content, linked, contract, manifest, personal, pages] = await Promise.all([
  load('series-plan.js'), load('gallery-model.js'), load('titles.js'), load('page-size.js'), load('gallery-export.js'),
  load('backend-error.js'), load('desktop-wire.js'), load('backup-core.js'), load('storage/gallery-files.js'), load('storage/folder-owner.js'),
  load('storage/folder-lifecycle.js'), load('storage/folder-content.js'), load('storage/linked-source.js'), load('storage/contract.js'),
  load('storage/gallery-manifest.js'), load('storage/personal.js'), load('pages.js'),
]);

export { plans, model, titles, pageSize, galleryExport, files, wire, backupCore, owner, lifecycle, content, linked, contract, manifest, personal, pages };
export const { BackendError } = errors;
