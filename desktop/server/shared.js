// shared.js — the app's own pure modules, which the desktop library runs as they are: series plans,
// the gallery model, titles, page sizes, the export layout, typed errors and the wire format. They
// are read from the app's folder (the repository's app/ in development; the packaged copy when
// SHIORI_UI_DIR names it).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UI_DIR = process.env.SHIORI_UI_DIR
  ? path.resolve(process.env.SHIORI_UI_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');

const load = (name) => import(pathToFileURL(path.join(UI_DIR, 'js', name)).href);

const [plans, model, titles, pageSize, files, errors, wire] = await Promise.all([
  load('series-plan.js'), load('gallery-model.js'), load('titles.js'), load('page-size.js'),
  load('gallery-files.js'), load('backend-error.js'), load('desktop-wire.js'),
]);

export { plans, model, titles, pageSize, files, wire };
export const { BackendError } = errors;
