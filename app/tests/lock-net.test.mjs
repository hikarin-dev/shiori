// lock-net.test.mjs — the net of the website's lock order (lock-net.mjs, S37) catches what it is for: a made-up wait for
// a lock the chain holds and a made-up second gallery's lock each fail the test run they happen in, even where the
// code that asked swallows every rejection; the order's own forms pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { offence } from './lock-net.mjs';

test('S37: the order as the net weighs it', () => {
  const g = (id) => `shiori:gallery:${id}`;
  assert.match(offence(g(1), g(1)), /holds itself/);
  assert.match(offence(g(1), g(2)), /second lock of one kind/);
  assert.match(offence('shiori:folder:a', 'shiori:folder:b'), /second lock of one kind/);
  assert.match(offence('shiori:deleting:a', g(1)), /before one held/);
  assert.match(offence(g(1), 'shiori:folder:a'), /before one held/);
  assert.match(offence('shiori:folder:a', 'shiori:folder-job:a'), /before one held/);
  assert.match(offence('shiori:dirs:a', 'shiori:removed:a'), /dirs/);
  assert.match(offence(g(1), 'shiori:somewhere:a'), /doesn't name/);
  for (const [held, asked] of [['shiori:folder-job:a', 'shiori:folder-job:a:scan'], ['shiori:folder-job:a:scan', 'shiori:folder:a'],
    ['shiori:folder:a', g(1)], [g(1), 'shiori:deleting:a'], ['shiori:deleting:a', 'shiori:removed:a'], [g(1), 'shiori:dirs:a'],
    ['shiori:removed:a', g(1)]]) assert.equal(offence(held, asked), null, `${held} → ${asked}`);
});

// `body` run as a test file of its own, the net loaded, product-like code inside one test: its exit and its output.
function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-locknet-'));
  try {
    const file = path.join(dir, 'probe.test.mjs');
    fs.writeFileSync(file, [
      `import test from 'node:test';`,
      `import assert from 'node:assert/strict';`,
      `import { netWatched } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'lock-net.mjs')).href)};`,
      `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
      `const L = navigator.locks;`,
      `test('product code', async (t) => { ${body} });`,
    ].join('\n'));
    const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...env } = process.env;   // a run of its own, not a child of this one
    const out = spawnSync(process.execPath, ['--test', '--test-force-exit', file], { encoding: 'utf8', timeout: 30000, env });
    return { status: out.status, text: `${out.stdout}\n${out.stderr}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// S41: the IndexedDB stand-in starts a waiting transaction from another chain's task; the net follows each transaction's
// own chain. `idb`: the stand-in loaded and a database with one store opened, its opening's tasks let pass.
const idb = `await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'node_modules', 'fake-indexeddb', 'auto', 'index.mjs')).href)});
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('net', 1); q.onupgradeneeded = () => q.result.createObjectStore('s');
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));`;

test('S41: a lock asked from a transaction\'s handler is the chain\'s that made the transaction — not one holding a lock whose task started it', () => {
  // Chain A holds a gallery's lock and makes tx1; chain B, holding nothing, makes tx2 behind it (started as tx1 ends, in
  // A's task) and asks another gallery's lock from tx2's 'complete': B holds nothing — nothing reported.
  const r = run(`${idb}
    let release, made, asked; const held = new Promise((x) => { release = x; }), txMade = new Promise((x) => { made = x; }), done = new Promise((x) => { asked = x; });
    const a = L.request('shiori:gallery:A', async () => { const tx1 = db.transaction('s', 'readwrite'); tx1.objectStore('s').put(1, 'a'); made(); await held; });
    await txMade;
    const tx2 = db.transaction('s', 'readwrite');
    tx2.objectStore('s').put(2, 'b');
    tx2.addEventListener('complete', () => { L.request('shiori:gallery:B', async () => {}).then(asked); });
    await done; release(); await a;`);
  assert.equal(r.status, 0, r.text);
  assert.doesNotMatch(r.text, /lock net/);
});

test('S41: a holder\'s transaction started by a chain that holds nothing — its handler asking a second gallery\'s lock is reported', () => {
  // Chain N, holding nothing, makes txN; chain H holds gallery 1's lock and makes txH behind it (started as txN ends, in
  // N's task), and asks gallery 2's lock from txH's 'complete' while it still holds gallery 1's. If the hook the net rests
  // on is gone (the stand-in's classes changed), this goes unreported and the test fails.
  const r = run(`${idb}
    const txN = db.transaction('s', 'readwrite'); txN.objectStore('s').put(0, 'n');
    let asked; const done = new Promise((x) => { asked = x; });
    await L.request('shiori:gallery:1', async () => {
      const txH = db.transaction('s', 'readwrite'); txH.objectStore('s').put(1, 'h');
      txH.addEventListener('complete', () => { L.request('shiori:gallery:2', async () => {}).catch(() => {}).then(asked); });
      await done;
    }).catch(() => {});
    await sleep(50);`);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /holds shiori:gallery:1, waits for shiori:gallery:2/);
});

test('S37: a made-up wait for its own gallery\'s lock fails the run, though the code swallows it', () => {
  const r = run(`await L.request('shiori:gallery:1', async () => {
    const again = L.request('shiori:gallery:1', () => {}).catch(() => {});
    await Promise.race([again, sleep(100)]);
  }).catch(() => {}); await sleep(50);`);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /lock net \(S37\): a wait for a lock the chain holds itself: holds shiori:gallery:1, waits for shiori:gallery:1/);
  assert.match(r.text, /✖ product code/);
});

test('S37: a made-up second gallery\'s lock waited for under one fails the run, though it is free and the code swallows it', () => {
  const r = run(`await L.request('shiori:gallery:1', async () => {
    await L.request('shiori:gallery:2', () => {}).catch(() => {});
  }).catch(() => {}); await sleep(50);`);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /holds shiori:gallery:1, waits for shiori:gallery:2/);
});

test('S37: a test that collects what the net sees (a regression marked todo) fails as it ends on each violation, though it ran on', () => {
  const r = run(`netWatched(t, assert);
    await L.request('shiori:gallery:1', async () => { await L.request('shiori:gallery:2', () => {}); });
    await L.request('shiori:gallery:2', async () => { await L.request('shiori:gallery:1', () => {}); });`);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /the lock order held/);
  assert.match(r.text, /holds shiori:gallery:1, waits for shiori:gallery:2[\s\S]*holds shiori:gallery:2, waits for shiori:gallery:1/);
});

test('S37: the order\'s own forms pass: down the order, another gallery\'s lock only if free, asked under removed.json\'s and waited for after, a timer\'s work', () => {
  const r = run(`
    await L.request('shiori:folder-job:a', () => L.request('shiori:folder-job:a:scan', () => L.request('shiori:folder:a',
      () => L.request('shiori:gallery:1', async () => {
        await L.request('shiori:gallery:2', { ifAvailable: true }, () => {});
        await L.request('shiori:dirs:a', () => {});
        await L.request('shiori:deleting:a', () => L.request('shiori:removed:a', () => {}));
      }))));
    let overlay;
    await L.request('shiori:removed:a', () => { overlay = L.request('shiori:gallery:3', () => {}); });
    await overlay;
    let later;
    await L.request('shiori:gallery:4', () => { later = new Promise((r) => setTimeout(() => r(L.request('shiori:gallery:4', () => {})), 0)); });
    await later;`);
  assert.equal(r.status, 0, r.text);
  assert.match(r.text, /✔ product code/);
  assert.doesNotMatch(r.text, /lock net/);
});
