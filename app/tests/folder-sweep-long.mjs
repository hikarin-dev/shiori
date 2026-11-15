// folder-sweep-long.mjs — the whole fault sweep (folder-sweep.test.mjs: every fault point of every
// scenario, for every kind of fault, on both apps), a process per app, kind and shard, some at once.
// Run by hand:
//   node app/tests/folder-sweep-long.mjs [desktop|website|both = both] [processes at once = 12]
// The website's page is loaded again at least once per fault point, and a process has a few hundred
// loads in it (library-drivers.mjs), so its kinds run in more shards. Prints each process as it ends
// with what it found (a test marked todo — a later step's finding — isn't a failure), then each app's
// and kind's fault points and time. Exits 1 when anything failed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [which = 'both', atOnce = '12'] = process.argv.slice(2);
const BLIPS = ['drive blip 1', 'drive blip 2', 'drive blip 3', 'drive blip 5'];
const KINDS = {
  desktop: ['kill', 'EIO', 'EPERM', 'ENOENT', 'EXDEV', 'drive away', ...BLIPS],
  website: ['page death', 'NoModificationAllowedError', 'NotFoundError', 'NotAllowedError', 'drive away', ...BLIPS],
};
const SHARDS = { desktop: 5, website: 24 };
const file = fileURLToPath(new URL('./folder-sweep.test.mjs', import.meta.url));
const jobs = [];
for (const app of /** @type {('desktop' | 'website')[]} */ (['desktop', 'website'])) {
  if (which !== 'both' && which !== app) continue;
  for (const kind of KINDS[app]) for (let i = 0; i < SHARDS[app]; i++) jobs.push({ app, kind, shard: `${i}/${SHARDS[app]}` });
}

// One process: its output (the spec reporter's: a failed test `✖ <name>`, a todo one `⚠ <name> # <step>`).
const run = ({ app, kind, shard }) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', file], {
    env: { ...process.env, SHIORI_SWEEP_EVERY: '1', SHIORI_SWEEP_APP: app, SHIORI_SWEEP_KIND: kind, SHIORI_SWEEP_SHARD: shard },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

const started = Date.now();
const totals = new Map();   // "app kind" → { points, ms }
let failed = 0;
const queue = [...jobs];
await Promise.all(Array.from({ length: Math.min(Number(atOnce), jobs.length) }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const t0 = Date.now();
    const { code, out } = await run(job);
    const ms = Date.now() - t0;
    const lines = out.split('\n'), cut = lines.findIndex(l => /✖ failing tests:/.test(l));
    const failures = (cut < 0 ? lines : lines.slice(0, cut)).filter(l => /^\s+✖ /.test(l));
    const todos = (cut < 0 ? lines : lines.slice(0, cut)).filter(l => /^\s+⚠ /.test(l));   // a later step's finding
    const points = lines.map(l => l.match(/ℹ (\d+) of \d+ fault points/)).filter(Boolean).reduce((n, m) => n + Number(m[1]), 0);
    const key = `${job.app} ${job.kind}`;
    const t = totals.get(key) ?? { points: 0, ms: 0 };
    totals.set(key, { points: t.points + points, ms: Math.max(t.ms, ms) });
    console.log(`${key} ${job.shard}: ${points} points, ${Math.round(ms / 1000)} s, ${failures.length ? `${failures.length} failed` : code ? `exit ${code}` : 'clean'}${todos.length ? ` (${todos.length} todo)` : ''}`);
    if (failures.length || code) {
      failed++;
      for (const l of failures) console.log(`  ${l.trim()}`);
      for (const l of new Set((cut < 0 ? [] : lines.slice(cut)).filter(l => /^\s+call \d+\/\d+:|Error:/.test(l)))) console.log(`    ${l.trim().slice(0, 400)}`);
    }
  }
}));
for (const [key, t] of totals) console.log(`${key}: ${t.points} fault points (longest shard ${Math.round(t.ms / 1000)} s)`);
console.log(`all: ${Math.round((Date.now() - started) / 60_000)} min, ${failed} processes with failures`);
process.exit(failed ? 1 : 0);
