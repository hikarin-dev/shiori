// folder-store.conformance.mjs — the folder store contract (storage/contract.js) checked on one
// adapter (plan §6.1). One suite, run by an entry file per app — folder-store-web.test.mjs for the
// website's adapter (under Node, over real temporary folders: §6.4), desktop/tests/folder-store.test.mjs
// for the desktop's — so both answer every operation alike. Each case gets a temporary folder of its
// own and a store made over it.
//
// The cases, added from S2 (which runs them on today's code through thin temporary adapters, to show
// they find real faults before they judge the fix): identity (a swapped root, a missing library.json);
// reservation races; writeNew never overwriting; publish interrupted after each of its writes, then
// reopened and read by both apps' adapters (the whole previous generation or the whole new one, never
// a mix, never neither); description files whose content doesn't match their name read as corrupt;
// deleteNamed leaving unnamed files, and leaving and reporting a named file replaced by different bytes
// of the same size; sweep leaving names that aren't Shiori's; refusal by purpose and state; on the
// desktop, a junction planted in each app-owned subfolder.
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('../js/storage/contract.js').FolderStore<unknown>} FolderStore */
/** A case: what it checks, the platforms it applies to (both when not said), and the check itself.
 * @typedef {{ name: string, platforms?: ('website' | 'desktop')[], run(ctx: { dir: string, store: FolderStore }): Promise<void> }} Case */
/** @type {Case[]} */
export const CASES = [];

/**
 * Registers the suite for one platform's adapter.
 * @param {'website' | 'desktop'} platform
 * @param {((dir: string) => Promise<FolderStore>) | null} makeStore the adapter over folder `dir`; null
 *   while the platform has none (its cases are then skipped)
 */
export function conformance(platform, makeStore) {
  describe(`folder store conformance (${platform})`, () => {
    for (const c of CASES.filter((c) => !c.platforms || c.platforms.includes(platform))) {
      test(c.name, { skip: !makeStore && 'no adapter yet' }, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-conformance-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        await c.run({ dir, store: await /** @type {NonNullable<typeof makeStore>} */ (makeStore)(dir) });
      });
    }
  });
}
