// folder-model.test.mjs — model-based fault-injection tests (plan §6.3): fast-check command sequences
// run against a library and a model of what it should hold (its galleries, pages and slot contents, in
// plain objects), with the invariants checked after every command:
// 1. no file Shiori didn't make was changed or deleted (a snapshot of the other files compared);
// 2. every committed edit reads back after a restart, and after forget plus re-add;
// 3. no page serves another gallery's bytes, and no derived picture sits on a page whose source changed;
// 4. every refusal or problem is reported, none swallowed.
// npm test runs the fixed seeds below; a long randomized session runs at the end of S8 and before the
// external review.
//
// The commands, added from S2: add, hide, show or remove a folder; set the default; write a page or a
// translation; move; delete; rename or replace a source outside the app; swap a root for another
// library; plant a junction (desktop); fail the next N I/O calls; restart (reopen the library); hand
// the folder to the other app.
import test from 'node:test';
import fc from 'fast-check';

/** @typedef {{ model: object, real: object }} Setup */
export const SEEDS = [1, 2, 3];
const NUM_RUNS = 20;
/** @type {fc.Arbitrary<fc.AsyncCommand<object, object>>[]} */
const COMMANDS = [];
/** @type {((setup: Setup) => Promise<void>)[]} */
const INVARIANTS = [];

/** @returns {Promise<Setup>} */
async function setup() { return { model: {}, real: {} }; }
/** @param {Setup} s */
async function checkAll(s) { for (const invariant of INVARIANTS) await invariant(s); }

for (const seed of SEEDS) {
  test(`model run, seed ${seed}`, async () => {
    if (!COMMANDS.length) { await checkAll(await setup()); return; }   // the empty sequence, until there are commands
    await fc.assert(fc.asyncProperty(fc.commands(COMMANDS), async (cmds) => {
      const s = await setup();
      await fc.asyncModelRun(() => s, cmds);
      await checkAll(s);
    }), { seed, numRuns: NUM_RUNS });
  });
}
