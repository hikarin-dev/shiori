// folder-lifecycle.test.mjs — a library folder's one state ('shown', 'hidden', 'removing') and what
// each allows, the same on both apps: only a shown folder's galleries are in the library; the default
// can't be hidden; new galleries and moves go only to a place shown, held and reachable (R07, A10);
// the write gate refuses a hidden folder, one another app holds, one out of reach, and a removing one
// but for the removal's own write-back (R07, R09, A03); work on a folder is planned per pair of jobs
// (A09); and a removal forgets the folder only when everything is saved, or the person chose to
// discard (R06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, mounted, canHide, canShow, canSetDefault, canMoveTo, nextDefault, writeAllowed, JOBS, jobPlan, removalOutcome }
  from '../js/storage/folder-lifecycle.js';

const place = (over = {}) => ({ state: 'shown', isDefault: false, owned: true, reachable: true, ...over });

test('only a shown place\'s galleries are in the library', () => {
  assert.deepEqual(STATES.map(mounted), [true, false, false]);
  assert.equal(mounted(undefined), false);
});

test('hide a shown place that isn\'t the default; show a hidden one', () => {
  assert.equal(canHide(place()), true);
  assert.equal(canHide(place({ isDefault: true })), false, 'new galleries need somewhere shown to go');
  assert.equal(canHide(place({ state: 'hidden' })), false);
  assert.equal(canHide(place({ state: 'removing' })), false);
  assert.deepEqual(STATES.map(state => canShow(place({ state }))), [false, true, false]);
});

test('new galleries and moves go only to a place shown, held by this library and reachable (R07, A10)', () => {
  for (const can of [canSetDefault, canMoveTo]) {
    assert.equal(can(place()), true);
    assert.equal(can(place({ state: 'hidden' })), false);
    assert.equal(can(place({ state: 'removing' })), false);
    assert.equal(can(place({ owned: false })), false, 'a folder another app took over');
    assert.equal(can(place({ reachable: false })), false, 'a drive away, or a browser folder still needing permission');
  }
});

test('the default\'s successor: the home place while it can take galleries, else the first other that can', () => {
  const home = { id: 'browser', state: 'shown', owned: true, reachable: true };
  const a = { id: 'a', state: 'shown', owned: true, reachable: true };
  const b = { id: 'b', state: 'shown', owned: true, reachable: true };
  assert.equal(nextDefault([home, a, b], 'a'), 'browser');
  assert.equal(nextDefault([{ ...home, state: 'hidden' }, a, b], 'a'), 'b');
  assert.equal(nextDefault([{ ...home, state: 'hidden' }, a, { ...b, owned: false }], 'a'), null, 'none can: the removal is refused');
  assert.equal(nextDefault([{ ...home, state: 'hidden' }, { ...a, state: 'removing' }, { ...b, reachable: false }], 'x'), null);
});

test('the write gate: reachable, held, and the state allows it — a removing folder only to its write-back (R07, R09)', () => {
  const rows = [];
  for (const state of STATES) for (const owned of [true, false]) for (const reachable of [true, false]) for (const work of [null, 'removal', 'claim']) {
    rows.push(`${state} ${owned ? 'owned' : 'not-owned'} ${reachable ? 'reachable' : 'away'} ${work || '-'} → ${writeAllowed({ state, owned, reachable, work })}`);
  }
  const allowed = rows.filter(r => r.endsWith('true'));
  assert.deepEqual(allowed, [
    'shown owned reachable - → true', 'shown owned reachable removal → true', 'shown owned reachable claim → true',
    'shown not-owned reachable claim → true',
    'hidden owned reachable claim → true', 'hidden not-owned reachable claim → true',
    'removing owned reachable removal → true', 'removing owned reachable claim → true', 'removing not-owned reachable claim → true',
  ], 'nothing else writes: not to a hidden folder, nor one another app holds, nor one out of reach');
  assert.equal(writeAllowed({ state: 'shown', owned: true, reachable: true }), true, 'work defaults to anything else');
});

test('every pair of jobs on one folder has a plan (A09)', () => {
  assert.deepEqual(JOBS, ['scan', 'removal']);
  const plans = {};
  for (const running of [null, ...JOBS]) for (const requested of JOBS) plans[`${running} + ${requested}`] = jobPlan(running, requested);
  assert.deepEqual(plans, {
    'null + scan': 'start', 'null + removal': 'start',
    'scan + scan': 'join', 'scan + removal': 'after',
    'removal + scan': 'refuse', 'removal + removal': 'join',
  });
  assert.equal(jobPlan(undefined, 'scan'), 'start');
  assert.throws(() => jobPlan(null, 'rescan'), TypeError);
  assert.throws(() => jobPlan('pdf', 'scan'), TypeError);
});

test('a removal forgets the folder only when everything is saved there, or the person chose to discard (R06)', () => {
  assert.deepEqual(removalOutcome({ required: ['1', '2'], saved: ['1', '2'] }), { forget: true, unsaved: [] });
  assert.deepEqual(removalOutcome({ required: ['1', '2', '3'], saved: ['2'] }), { forget: false, unsaved: ['1', '3'] }, 'kept: back to its state before');
  assert.deepEqual(removalOutcome({ required: ['1', '2'], saved: [], discard: true }), { forget: true, unsaved: ['1', '2'] }, 'discarded: what is lost listed');
  assert.deepEqual(removalOutcome({ required: [], saved: [] }), { forget: true, unsaved: [] }, 'an empty folder (or one out of reach with nothing unsaved)');
  assert.deepEqual(removalOutcome({ required: new Set([1, '2', 2]), saved: new Set(['1', '9']) }), { forget: false, unsaved: ['2'] },
    'ids compared as strings; one saved that wasn\'t required counts for nothing');
});
