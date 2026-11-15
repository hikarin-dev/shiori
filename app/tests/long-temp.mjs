// long-temp.mjs — a temporary folder of its own for each process the long runs start (folder-model-long.mjs,
// folder-sweep-long.mjs), removed once the process ended: what its tests make in the system's temporary
// folder (`shiori-*`) — and the processes they start, a killed desktop among them — goes there, so nothing
// of a long run is left behind, whatever stopped a test before it cleared its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `work(env)` run with `env` naming a fresh temporary folder (TMP, TEMP, TMPDIR: os.tmpdir() in the process
 * given it), which is removed once `work` settled — tried a few times while Windows still holds a file in
 * it for a moment. Resolves what `work` resolved.
 * @template T @param {(env: Record<string, string>) => Promise<T>} work @returns {Promise<T>} */
export async function ownTemp(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-long-'));
  try { return await work({ TMP: dir, TEMP: dir, TMPDIR: dir }); } finally {
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 500 * (i + 1))); }
    }
  }
}
