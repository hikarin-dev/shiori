// shared.js — the app's own pure modules, which the desktop library runs as they are: series plans,
// the gallery model, titles, page sizes, the export layout, typed errors, the wire format, which app
// keeps a library folder (folder-owner.js), what a library folder holds that Shiori didn't make
// (linked-source.js), which galleries a write touches (hidden-writes.js) and the full backup's format (backup-core.js, which backup.js runs here for the app's window). They
// are read from the app's folder (the repository's app/ in development; the packaged copy when
// SHIORI_UI_DIR names it).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UI_DIR = process.env.SHIORI_UI_DIR
  ? path.resolve(process.env.SHIORI_UI_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');

const load = (name) => import(pathToFileURL(path.join(UI_DIR, 'js', name)).href);

const [plans, model, titles, pageSize, files, errors, wire, backupCore, owner, linked, hiddenWrites] = await Promise.all([
  load('series-plan.js'), load('gallery-model.js'), load('titles.js'), load('page-size.js'),
  load('gallery-files.js'), load('backend-error.js'), load('desktop-wire.js'), load('backup-core.js'), load('folder-owner.js'),
  load('linked-source.js'), load('hidden-writes.js'),
]);

export { plans, model, titles, pageSize, files, wire, backupCore, owner, linked, hiddenWrites };
export const { BackendError } = errors;
