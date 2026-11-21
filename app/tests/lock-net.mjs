// lock-net.mjs — the website's lock order, held at run time in every test that runs its library (S37). Imported by
// library-drivers.mjs (every test, table, model and sweep point that drives the website's library) and preloaded by
// `npm test` (package.json: every other test of app/js), it follows each Web Lock request (`navigator.locks.request`)
// along the async chain that asks (AsyncLocalStorage; a lock is held by the chain while its callback hasn't settled),
// and a request that waits (not `ifAvailable`) from a chain that already holds
//   (a) that very lock — a wait for itself, which never ends;
//   (b) another lock of the same kind — two galleries' (or folders') locks in no order;
//   (c) a lock the stated order puts after the one asked — or one the order doesn't name —
// fails the run: the test the chain belongs to fails (an error thrown from the chain's own context: node:test lays it
// on that test, whatever the product code that asked swallows — `_describe(id).catch(() => {})`), and a violation
// whose throw hasn't been delivered as the process exits sets its exit code. Each is written at once to stderr, naming
// both locks and the asking stack. The one form the order allows (db.js `_galleryLocked`: a gallery's lock asked where
// `shiori:removed:<folder>` is held, waited for only once that is let go — `_publishRemoved`'s overlays) passes.
// A timer's callback is no part of the chain that set it (work begun there is waited for by no one holding a lock): it
// runs outside any held lock. The order is ORDER below, which the fitness rule 'S37' ties to the comment in db.js.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';

/** The website's locks in the order they are taken (db.js `_galleryLocked`): each waited for only while those before it,
 * never one after it, are held. A folder's task holds its kind's lock just after its own (folder-scan.js). */
export const ORDER = ['shiori:folder-job:', 'shiori:folder:', 'shiori:gallery:', 'shiori:deleting:', 'shiori:removed:'];
/** Taken within any of them; nothing is waited for while it is held. */
export const WITHIN = 'shiori:dirs:';
/** The one lock asked where a later one is held, and waited for only once that is let go: [held, asked]. */
export const ASKED_THERE = ['shiori:removed:', 'shiori:gallery:'];

/** Every violation seen in this process: { kind, held, asked, stack }. */
export const violations = [];
const watchers = new Set();
/** The violations seen from now until `stop()`, collected for the caller to fail on rather than thrown: for a test whose
 * product code is known to break the order until a step fixes it (a regression marked todo), which a throw would cut
 * short, and whose other chain's violation would then land after the test ended. The test fails on what it collected
 * as it ends (`netWatched`, below): nothing passes unseen.
 * @returns {{ seen: typeof violations, stop: () => void }} */
export function watch() {
  const w = { seen: [], stop: () => watchers.delete(w) };
  watchers.add(w);
  return w;
}
/** Test `t`'s run watched (watch), failing as it ends on every violation seen meanwhile. */
export function netWatched(t, assert) {
  const w = watch();
  t.after(() => { w.stop(); assert.deepEqual(w.seen.map(v => `${v.kind}: holds ${v.held}, waits for ${v.asked}`), [], 'the lock order held'); });
  return w;
}

const kindOf = (name) => {
  const s = String(name);
  if (s.startsWith('shiori:folder-job:')) return s.slice('shiori:folder-job:'.length).includes(':') ? 'shiori:folder-job:<kind>' : 'shiori:folder-job:';
  return [...ORDER, WITHIN].find(k => s.startsWith(k)) ?? null;
};
// A kind's place in the order (a folder task's kind's lock just after the task's own); null for one the order doesn't name.
const rankOf = (kind) => (kind === 'shiori:folder-job:<kind>' ? 0.5 : kind === WITHIN ? Infinity : ORDER.indexOf(kind) < 0 ? null : ORDER.indexOf(kind));

/** Why a request for lock `asked` that waits, made by a chain holding `held` (lock names), breaks the order — or null. */
export function offence(held, asked) {
  if (held === asked) return 'a wait for a lock the chain holds itself';
  const h = kindOf(held), a = kindOf(asked);
  if (h == null || a == null) return 'a lock the order doesn\'t name';
  if (h === ASKED_THERE[0] && a === ASKED_THERE[1]) return null;
  if (h === WITHIN) return `a lock waited for while ${WITHIN}<folder> is held`;
  if (h === a) return 'a second lock of one kind waited for while the first is held';
  if (rankOf(h) > rankOf(a)) return 'a lock the order puts before one held';
  return null;
}

const stackNow = () => String(new Error().stack).split('\n').slice(3).map(l => l.trim())
  .filter(l => /[\\/]app[\\/](js|tests)[\\/]|[\\/]desktop[\\/]/.test(l) && !l.includes('lock-net.mjs')).slice(0, 14).join('\n    ');

const als = new AsyncLocalStorage();
const undelivered = new Set();
const fail = (kind, held, asked) => {
  const v = { kind, held, asked, stack: stackNow() };
  violations.push(v);
  const err = new Error(`lock net (S37): ${kind}: holds ${held}, waits for ${asked}\n    ${v.stack}`);
  try { fs.writeSync(2, `\n${err.message}\n`); } catch {}
  if (watchers.size) { for (const w of watchers) w.seen.push(v); return; }
  undelivered.add(err);
  setImmediate(() => { undelivered.delete(err); throw err; });
};
/** Lock requests made through `request` (a LockManager's, or a stand-in's: the sweeps' shadow of the page's locks)
 * followed by the net. */
export function netted(request) {
  return function (name, a, b) {
    const cb = typeof a === 'function' ? a : b;
    const opts = typeof a === 'function' ? undefined : a;
    const chain = (als.getStore() || []).filter(h => h.live);
    if (!opts?.ifAvailable && String(name).startsWith('shiori:')) {
      for (const h of chain) {
        const why = offence(h.name, String(name));
        if (why) fail(why, h.name, String(name));
      }
    }
    const entry = { name: String(name), live: true };
    const wrapped = (lock) => als.run([...chain, entry], async () => { try { return await cb(lock); } finally { entry.live = false; } });
    return opts === undefined ? request.call(this, name, wrapped) : request.call(this, name, opts, wrapped);
  };
}

/** `fn` run as no part of the chain that calls it: a test's own work started from inside a held call (the sweeps'
 * 'made again': the person deleting and making a gallery again while the step's call is held) — never the product's. */
export const detached = (fn) => als.exit(fn);

const locks = globalThis.navigator?.locks;
if (!globalThis.__shioriLockNet && typeof locks?.request === 'function') {
  globalThis.__shioriLockNet = { violations, als };
  const proto = Object.getPrototypeOf(locks);
  proto.request = netted(proto.request);
  // A timer's callback runs outside the locks of the chain that set it.
  for (const set of ['setTimeout', 'setInterval']) {
    const original = globalThis[set];
    globalThis[set] = function (fn, ...rest) { return typeof fn === 'function' ? original((...args) => als.exit(() => fn(...args)), ...rest) : original(fn, ...rest); };
  }
  process.on('exit', () => {
    if (!undelivered.size) return;
    try { fs.writeSync(2, `\nlock net (S37): ${undelivered.size} violation(s) not reported to a test before the exit\n`); } catch {}
    process.exitCode = 1;
  });
}
