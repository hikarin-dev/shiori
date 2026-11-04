// folder-handover.test.mjs — one library folder used by both apps in turn (plan §6.2): what one app
// wrote, the other reads whole, in both directions. Both libraries work on the same temporary folder
// in one test: the desktop's as it is, the website's under Node over real folders (§6.4, from S2).
//
// The cases, added from S2: a gallery written by one app, then each slot replaced (the same format, a
// format change, a suffixed name) with old files left behind, read by the other with every slot's
// bytes matching; native archives (archived by the desktop, read and unpacked by the website); linked
// overlays with their provenance; a series spread over two folders; claims moving between the apps.
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{ name: string, run(ctx: { dir: string }): Promise<void> }} Handover */
/** @type {Record<string, Handover[]>} */
const HANDOVERS = { 'website to desktop': [], 'desktop to website': [] };

for (const [direction, cases] of Object.entries(HANDOVERS)) {
  describe(`hand-over, ${direction}`, () => {
    for (const h of cases) {
      test(h.name, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-handover-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        await h.run({ dir });
      });
    }
  });
}
