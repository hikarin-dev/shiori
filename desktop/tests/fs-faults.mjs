// fs-faults.mjs — faults injected into the desktop library's file calls in its library folders, and the
// junctions planted in them, for the storage tests (plan §6.4). Those calls are the folder store
// adapter's (server/folder-store.js `disk`, the one door to the folders), so a fault reaches them and
// nothing else: not the index, the cache, or a test's own setup.
//
// - failNext(when, code, { times }): the next `times` calls `when(call)` matches throw (or reject, for
//   a promised call) an error with `code` ('EBUSY', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'…). `call` is
//   { op, path, to? }: `op` the fs method's name without Sync ('rename', 'rm', 'readFile'…), `path` its
//   first argument as an absolute path ('/'-separated), `to` the second for rename, copyFile and cp.
//   Returns a function that takes the fault back (taken back by itself once used up).
// - reset(): every fault taken back.
// - junction(target, at): a junction at `at` leading to folder `target` (no admin rights needed;
//   a directory symbolic link off Windows).
import fs from 'node:fs';
import path from 'node:path';

export { failNext, resetFaults as reset } from '../server/folder-store.js';

/** @param {string} target @param {string} at */
export function junction(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.resolve(target), at, process.platform === 'win32' ? 'junction' : 'dir');
}
