// contract-setup.mjs — runs the app's library tests against the desktop library. Loaded before a
// test file (node --import), it opens a desktop library in a temporary folder, serves it on a free
// port and points the app's api.js at it, as the desktop app's window does; the test file then runs
// unchanged.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Library } from '../server/library.js';
import { startServer } from '../server/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-desktop-'));
// Galleries are settled into their folders as soon as their pages change (SHIORI_PLACE_DELAY, in ms,
// to wait instead), so the tests read pages from the folders, and from staging while they are moved,
// not only from staging.
const placeDelay = process.env.SHIORI_PLACE_DELAY ? Number(process.env.SHIORI_PLACE_DELAY) : 0;
const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay }).open();
const token = crypto.randomBytes(16).toString('hex');
const server = await startServer({ library, token });
globalThis.shioriDesktop = { url: server.url, token };
globalThis.__desktopLibrary = library;
// Removed when the process ends (run with --test-force-exit, which ends it once the file's tests
// have: the open server would otherwise keep it alive).
process.on('exit', () => {
  library.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
