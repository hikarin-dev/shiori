// job-view.test.mjs — what a job's bar and words say (src/lib/job-view.ts), every branch, as a task row
// (1.3's app/js/tasks.js view) and as a library card (1.3's app/js/library.js applyJob) say it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobView, isRunning } from '../../src/lib/job-view.ts';

// Words by their key, with what they were given: 'prog.error', 'lf.task_found{n:3}'.
const t = (key, vars) => (vars ? `${key}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(',')}}` : key);
const f = { t, count: (n) => `#${n}`, bytes: (n) => `${n}B` };
const task = (job) => jobView(job, f, 'task');
const card = (job) => jobView(job, f, 'card');
const v = (pct, label, done = false) => ({ pct, done, label });

test('running or not', () => {
  for (const status of ['done', 'error', 'cancelled']) assert.equal(isRunning({ status }), false);
  for (const status of ['started', 'progress', 'downloading', 'extracting', 'queued']) assert.equal(isRunning({ status }), true);
});

test('a library folder\'s check (a task only)', () => {
  assert.deepEqual(task({ kind: 'folder', status: 'progress', done: 1, total: 4, label: 'Checking', found: 2 }), v(25, 'Checking · #1 / #4 · lf.task_found{n:#2}'));
  assert.deepEqual(task({ kind: 'folder', status: 'progress', labelKey: 'lf.k', found: 2, foundKey: 'lf.set_aside' }), v(null, 'lf.k · lf.set_aside{n:#2}'), 'no figure yet, its own word for what it found');
  assert.deepEqual(task({ kind: 'folder', status: 'progress', found: 2, foundKey: '' }), v(null, ''), 'a found count it does not say');
  assert.deepEqual(task({ kind: 'folder', status: 'done', found: 5, updated: 2, problems: 0, left: 1 }), v(100, 'lf.task_done{n:#5} · lf.task_updated{n:#2} · lf.task_left{n:#1}', true));
  assert.deepEqual(task({ kind: 'folder', status: 'done', doneKey: 'lf.other_done' }), v(100, 'lf.other_done{n:#0}', true));
  assert.deepEqual(task({ kind: 'folder', status: 'cancelled', problems: 3 }), v(0, 'prog.cancelled · lf.task_problems{n:#3}'));
  assert.deepEqual(task({ kind: 'folder', status: 'error', errorKey: 'lf.gone' }), v(0, 'prog.error: lf.gone'));
  assert.deepEqual(task({ kind: 'folder', status: 'error' }), v(0, 'prog.error: unknown'));
  assert.equal(card({ kind: 'folder', status: 'progress' }), null, 'a card draws no folder check');
});

test('error, cancelled', () => {
  assert.deepEqual(task({ kind: 'download', status: 'error', error: 'No answer' }), v(0, 'prog.error: No answer'));
  assert.deepEqual(task({ kind: 'download', status: 'error', errorKey: 'err.k', error: 'raw' }), v(0, 'prog.error: err.k'));
  assert.deepEqual(card({ kind: 'download', status: 'error', error: 'No answer' }), v(undefined, 'prog.error: No answer'), 'a card\'s bar stays where it was');
  assert.deepEqual(card({ kind: 'download', status: 'error' }), v(undefined, 'prog.error: unknown'));
  for (const view of [task, card]) assert.deepEqual(view({ kind: 'translate', status: 'cancelled' }), v(0, 'prog.cancelled'));
});

test('a download\'s bytes: no size yet, with pages, without', () => {
  for (const view of [task, card]) {
    assert.deepEqual(view({ kind: 'download', status: 'downloading', downloaded: 100 }), v(null, '↓ 100B'));
    assert.deepEqual(view({ kind: 'download', status: 'downloading', downloaded: 50, total: 100, pages: 10 }), v(43, '~#5 / #10 · 50B'));
    assert.deepEqual(view({ kind: 'download', status: 'downloading', downloaded: 300, total: 100, pages: 10 }), v(85, '~#10 / #10 · 300B'), 'never past 85% nor past its pages');
    assert.deepEqual(view({ kind: 'download', status: 'downloading', downloaded: 50, total: 100 }), v(43, '↓ 50B'));
    assert.deepEqual(view({ kind: 'download', status: 'extracting' }), v(85, 'prog.extracting'));
  }
});

test('started', () => {
  for (const view of [task, card]) {
    assert.deepEqual(view({ kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' }), v(0, 'prog.contacting_helper'));
    assert.deepEqual(view({ kind: 'download', status: 'started', label: 'Raw' }), v(0, 'Raw'));
    assert.deepEqual(view({ kind: 'sync', status: 'started' }), v(0, 'prog.syncing'));
    assert.deepEqual(view({ kind: 'upload', status: 'started', total: 3 }), v(0, '0 / #3'));
    assert.deepEqual(view({ kind: 'upload', status: 'started' }), v(0, 'prog.starting'));
    assert.deepEqual(view({ kind: 'upload', status: 'started', labelKey: 'k', labelArgs: { n: 2 } }), v(0, 'k{n:2}'));
  }
});

test('a task row: progress and done, by kind', () => {
  assert.deepEqual(task({ kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' }), v(40, 'prog.translating'));
  assert.deepEqual(task({ kind: 'translate', status: 'progress', done: 1, total: 4 }), v(25, 'prog.translating #1 / #4'));
  assert.deepEqual(task({ kind: 'translate', status: 'progress' }), v(0, 'prog.translating '));
  assert.deepEqual(task({ kind: 'translate', status: 'done', done: 3, total: 3, stale: 1, failed: 2, costNote: 'x' }), v(100, 'prog.translated #3/#3 · prog.stale_pages{n:#1}', true));
  assert.deepEqual(task({ kind: 'translate', status: 'done' }), v(100, 'prog.translated #0/#0', true));
  assert.deepEqual(task({ kind: 'download', status: 'progress', done: 1, total: 4 }), v(89, '#1 / #4'));
  assert.deepEqual(task({ kind: 'download', status: 'progress' }), v(85, 'prog.starting'));
  assert.deepEqual(task({ kind: 'download', status: 'done', done: 4, total: 4, skipped: 1 }), v(100, 'prog.done — #4/#4 (prog.already_cached{n:#1})', true));
  assert.deepEqual(task({ kind: 'upload', status: 'progress', done: 1, total: 3, labelKey: 'prog.importing' }), v(33, 'prog.importing · #1 / #3'));
  assert.deepEqual(task({ kind: 'upload', status: 'progress', done: 1, total: 3, skipped: 2 }), v(33, '#1 / #3 (prog.already_cached{n:#2})'));
  assert.deepEqual(task({ kind: 'upload', status: 'progress', labelKey: 'prog.importing' }), v(0, 'prog.importing'));
  assert.deepEqual(task({ kind: 'sync', status: 'progress', done: 1, total: 2 }), v(50, 'prog.syncing · #1 / #2'));
  assert.deepEqual(task({ kind: 'sync', status: 'progress' }), v(0, 'prog.syncing'));
  assert.deepEqual(task({ kind: 'sync', status: 'done' }), v(100, 'prog.synced', true));
  assert.deepEqual(task({ kind: 'other', status: 'queued', done: 1, total: 2 }), v(50, '#1 / #2'), 'a status it does not know is progress');
});

test('a library card: progress and done, by kind', () => {
  assert.deepEqual(card({ kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' }), v(40, 'prog.translating'));
  assert.deepEqual(card({ kind: 'translate', status: 'progress', done: 1, total: 4 }), v(25, 'prog.translating #1 / #4'));
  assert.deepEqual(card({ kind: 'translate', status: 'progress' }), v(0, 'prog.translating #0 / #0'));
  assert.deepEqual(card({ kind: 'translate', status: 'done', done: 3, total: 3, failed: 2, stale: 1, costNote: '$0.01' }),
    v(100, 'prog.translated #3/#3 (#2 failed) · prog.stale_pages{n:#1} · $0.01', true));
  assert.deepEqual(card({ kind: 'translate', status: 'done', done: 3, total: 3, pct: 100 }), v(100, 'prog.translated #3/#3', true));
  assert.deepEqual(card({ kind: 'download', status: 'progress', done: 1, total: 4 }), v(89, '#1 / #4'));
  assert.deepEqual(card({ kind: 'download', status: 'progress' }), v(85, '#0 / #0'));
  assert.deepEqual(card({ kind: 'download', status: 'progress', done: 1, total: 4, labelKey: 'k', skipped: 1 }), v(89, 'k · #1/#4 (prog.already_cached{n:#1})'));
  assert.deepEqual(card({ kind: 'download', status: 'done', done: 4, total: 4 }), v(100, 'prog.done — #4/#4', true));
  assert.deepEqual(card({ kind: 'upload', status: 'progress', done: 1, total: 3 }), v(33, '#1 / #3'));
  assert.deepEqual(card({ kind: 'upload', status: 'progress' }), v(0, '#0 / #0'));
  assert.deepEqual(card({ kind: 'sync', status: 'progress', done: 1, total: 2 }), v(50, 'prog.syncing · #1/#2'));
  assert.deepEqual(card({ kind: 'sync', status: 'done', done: 2, total: 2 }), v(100, 'prog.synced', true));
  assert.equal(card({ kind: 'download', status: 'queued' }), null, 'a status a card does not know: nothing drawn');
});
