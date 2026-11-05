// fs-faults.mjs — faults injected into the desktop library's file system calls, and the junctions
// planted in its folders, for the storage tests (plan §6.4). The desktop's modules call node:fs and
// node:fs/promises through their module objects (`fs.renameSync(…)`, `fsp.rm(…)`), so a method
// replaced on those objects is the one they call; until the folder store adapter (S3) is the one place
// they go through, the faults are put there.
//
// - failNext(when, code, { times }): the next `times` calls `when(call)` matches throw (or reject, for
//   a promise call) an error with `code` ('EBUSY', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'…). `call` is
//   { op, path, to? }: `op` the method's name without Sync ('rename', 'rm', 'unlink', 'readFile'…),
//   `path` its first argument as an absolute path ('/'-separated), `to` the second for rename, copyFile
//   and cp. Resolves a function that takes the fault back (taken back by itself once used up).
// - reset(): every fault taken back.
// - junction(target, at): a junction at `at` leading to folder `target` (no admin rights needed;
//   a directory symbolic link off Windows).
import fs from 'node:fs';
import path from 'node:path';

// The calls a fault may be put on: every one the desktop library makes on its folders.
const OPS = ['rm', 'rmdir', 'unlink', 'rename', 'readFile', 'writeFile', 'open', 'stat', 'lstat', 'readdir', 'mkdir', 'copyFile', 'cp',
  'realpath', 'access', 'truncate', 'opendir', 'utimes'];
const TWO_PATHS = new Set(['rename', 'copyFile', 'cp']);

/** @type {{ when: (call: { op: string, path: string, to?: string }) => boolean, code: string, times: number }[]} */
let faults = [];
const norm = (p) => (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p) ? path.resolve(String(p)).split(path.sep).join('/') : String(p));

function faultFor(op, args) {
  if (!faults.length) return null;
  const call = { op, path: norm(args[0]), ...(TWO_PATHS.has(op) ? { to: norm(args[1]) } : {}) };
  const fault = faults.find(f => f.when(call));
  if (!fault) return null;
  if (--fault.times <= 0) faults = faults.filter(f => f !== fault);
  return Object.assign(new Error(`${fault.code}: injected, ${op} '${call.path}'`), { code: fault.code, syscall: op, path: call.path });
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const op of OPS) {
    for (const [host, name, promised] of [[fs.promises, op, true], [fs, `${op}Sync`, false], [fs, op, 'callback']]) {
      const real = host[name];
      if (typeof real !== 'function') continue;
      host[name] = function (...args) {
        const e = faultFor(op, args);
        if (!e) return real.apply(this, args);
        if (promised === true) return Promise.reject(e);
        if (promised === 'callback') { const cb = args.findLast(a => typeof a === 'function'); if (cb) { process.nextTick(cb, e); return; } }
        throw e;
      };
    }
  }
}

/** @param {(call: { op: string, path: string, to?: string }) => boolean} when @param {string} code
 * @param {{ times?: number }} [options] */
export function failNext(when, code = 'EIO', { times = 1 } = {}) {
  install();
  const fault = { when, code, times };
  faults.push(fault);
  return () => { faults = faults.filter(f => f !== fault); };
}
export function reset() { faults = []; }

/** @param {string} target @param {string} at */
export function junction(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.resolve(target), at, process.platform === 'win32' ? 'junction' : 'dir');
}
