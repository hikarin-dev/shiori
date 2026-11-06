// folder-model-long.mjs — the model's long randomized session (plan §6.3; S8 and S10): every command set
// of folder-model.test.mjs run for one app again and again, each time a process of its own with a seed
// drawn at random, until the time is up. Run by hand:
//   node app/tests/folder-model-long.mjs <desktop|website> [minutes = 20] [runs per command set = 25]
// Prints each seed as it ends and every failure with its counterexample (fast-check's: replay it with
// SHIORI_MODEL_APP=<app> SHIORI_MODEL_SEED=<seed> SHIORI_MODEL_RUNS=<runs> node --test
// app/tests/folder-model.test.mjs). A test marked todo (a finding a later step fixes) isn't a failure.
// Exits 1 when anything failed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [app, minutes = '20', runs = '25'] = process.argv.slice(2);
if (app !== 'desktop' && app !== 'website') {
  console.error('usage: node app/tests/folder-model-long.mjs <desktop|website> [minutes] [runs]');
  process.exit(2);
}
const file = fileURLToPath(new URL('./folder-model.test.mjs', import.meta.url));
const end = Date.now() + Number(minutes) * 60_000;

// One process: the model test for `app` with `seed`. Resolves its output (the spec reporter's: a test
// failed is `✖ <name>`, a todo one `⚠`).
const once = (seed) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', file], {
    env: { ...process.env, SHIORI_MODEL_APP: app, SHIORI_MODEL_SEED: String(seed), SHIORI_MODEL_RUNS: runs },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

let failed = 0, done = 0;
while (Date.now() < end) {
  const seed = 1 + Math.floor(Math.random() * 2 ** 31);
  const started = Date.now();
  const { code, out } = await once(seed);
  done++;
  // The tests that failed, as they ended (its closing list of failures repeats them, with what each
  // found: the details below).
  const lines = out.split('\n'), cut = lines.findIndex(l => /✖ failing tests:/.test(l));
  const failures = (cut < 0 ? lines : lines.slice(0, cut)).filter(l => /^\s+✖ /.test(l));
  const counterexamples = lines.filter(l => /Counterexample:|\{ seed: \d+, path:/.test(l)).map(l => l.trim());
  console.log(`seed ${seed}: ${failures.length ? `${failures.length} failed` : code ? `exit ${code}` : 'clean'} (${Math.round((Date.now() - started) / 1000)} s)`);
  if (failures.length || code) {
    failed++;
    for (const l of [...failures, ...new Set(counterexamples)]) console.log(`  ${l.trim()}`);
    // Each failure whole: what it found, after which commands.
    for (const l of lines.filter(l => /\[cause\]|never ended|Error:|^\s+\d(\/\d)?: /.test(l))) console.log(`    ${l.trim()}`);
  }
}
console.log(`${app}: ${done} seeds, ${failed} with failures`);
process.exit(failed ? 1 : 0);
