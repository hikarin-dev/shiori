// folder-lifecycle.test.mjs — a library folder's one state ('shown', 'hidden', 'removing') and what
// each allows, the same on both apps: only a shown folder's galleries are in the library; the default
// can't be hidden; new galleries and moves go only to a place shown, held and reachable (R07, A10);
// the write gate refuses a hidden folder, one another app holds, one out of reach, and a removing one
// but for the removal's own write-back (R07, R09, A03); work on a folder is planned per pair of jobs
// (A09); a removal forgets the folder only when everything is saved, or the person chose to
// discard (R06); and a deletion the folder owes ends (review 7 A1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, mounted, canHide, canShow, canSetDefault, canMoveTo, nextDefault, writeAllowed, JOBS, jobPlan, removalOutcome,
  UNFOUND_LOOKS, leavesOpen, unfoundEnd, unfoundMayBeIn, changeRefusal } from '../js/storage/folder-lifecycle.js';
import { published, inFolder, whoseVersion, writerOf, generationOf, tokenOf } from '../js/storage/gallery-manifest.js';

test('S29a: one app changes a folder\'s galleries at a time — the commit gate refuses a change reaching a gallery the folder holds while another app holds it, never the person\'s marks nor one only this app has', () => {
  const at = (o) => changeRefusal({ state: 'shown', change: true, taken: true, held: true, ...o });
  assert.equal(at({}), 'not-owned', 'a change to a gallery published in a folder another app holds');
  assert.equal(at({ change: false }), null, 'no change of its folder: the person\'s marks, a size, a total');
  assert.equal(at({ held: false }), null, 'a gallery only this app has (never published there) keeps working, and waits');
  assert.equal(at({ taken: false }), null, 'a folder this app holds, or one not known to be taken (out of reach: the change waits)');
  assert.equal(at({ work: true }), null, 'the folder\'s own work');
  assert.deepEqual(['hidden', 'removing', null].map(state => changeRefusal({ state })), ['hidden', 'hidden', 'hidden'], 'out of the library: hidden, as before');
  assert.equal(changeRefusal({ state: 'hidden', work: true }), null);
  // What says the folder holds a gallery as published.
  assert.deepEqual([null, 'v2:0:me', 'v2:1:me', 'v2:7:them', 'stamp-of-a-v1-folder'].map(published), [false, false, true, true, true]);
  assert.deepEqual(['v2:3:a1b2', 'v2:0:x', 'v1stamp', null].map(writerOf), ['a1b2', 'x', null, null]);
});

test('S31: a token names one publication, and a gallery\'s place is held against this library\'s view of it — the rule, stated once (gallery-manifest.js whoseVersion), the gate\'s "in the folder" by its place', () => {
  // A publication's own id travels in its token; a manifest written before S31, with none, keeps the token it had.
  const m = { format: 'shiori-gallery', version: 2, galleryId: '1', generation: 2, writer: 'me', files: { pages: {}, covers: {} }, sizes: {}, descriptions: {} };
  assert.equal(tokenOf(m), 'v2:2:me', 'no id: the token of before');
  assert.equal(tokenOf({ ...m, publication: '0a1b2c3d4e5f6071' }), 'v2:2.0a1b2c3d4e5f6071:me');
  assert.notEqual(tokenOf({ ...m, publication: '0a1b2c3d4e5f6071' }), tokenOf({ ...m, publication: '1b2c3d4e5f607182' }), 'the same number and writer, another publication');
  assert.deepEqual(['v2:3.ab12cd34:them', 'v2:3:them'].map(t => [generationOf(t), writerOf(t)]), [[3, 'them'], [3, 'them']]);
  const t = (n, w, id = 'ab12cd34') => `v2:${n}.${id}:${w}`;
  assert.equal(whoseVersion(t(2, 'me'), t(2, 'me'), 'me'), 'ours', 'the very publication this library knows');
  assert.equal(whoseVersion(t(3, 'them'), t(2, 'me'), 'me'), 'theirs', 'another app published since');
  assert.equal(whoseVersion(t(2, 'them', 'ffff0000'), t(2, 'them'), 'me'), 'theirs', 'the same number by the same app, another publication (a folder put back from an older copy)');
  assert.equal(whoseVersion(t(3, 'them'), null, 'me'), 'theirs', 'any manifest where this library has no stamp (R8-1: an index from before stamps)');
  assert.equal(whoseVersion(t(3, 'me'), t(2, 'me'), 'me'), 'ours', 'a later one of this app\'s own (published, its stamp not kept: a kill between)');
  assert.equal(whoseVersion(t(1, 'me'), t(2, 'me'), 'me'), 'theirs', 'an earlier one of this app\'s own: a folder put back from an older copy, not the view here');
  assert.equal(whoseVersion(null, t(2, 'me'), 'me'), 'ours', 'no manifest there');
  assert.equal(whoseVersion('v1stamp-b', 'v1stamp-a', 'me'), 'ours', 'an earlier version\'s descriptions tell no writer: what waits is published over them, as before');
  assert.equal(whoseVersion('v2:4:them', 'v2:4:them', 'me'), 'ours', 'a manifest from before S31, the token as it was kept');
  // The read-only gate's "in the folder": a place there, not a reservation no publication made whole — a stamp or none.
  assert.deepEqual([[true, null], [true, 'v2:1:me'], [true, 'v1stamp'], [true, 'v2:0.ab12cd34:me'], [false, 'v2:3:me'], [false, null]].map(([placed, known]) => inFolder(placed, known)),
    [true, true, true, false, false, false]);
});

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

test('S33, review 10 A1 and B5: a check is never joined to one that is stopping; the reason a change is refused follows the last claim read', () => {
  assert.equal(jobPlan('scan', 'scan', { stopping: true }), 'after', 'a check stopped by a hide: one asked after it starts once it has ended');
  assert.equal(jobPlan('scan', 'scan', { stopping: false }), 'join');
  assert.equal(jobPlan('removal', 'removal', { stopping: true }), 'join', 'a removal as before');
  const at = (o) => changeRefusal({ state: 'shown', change: true, held: true, ...o });
  assert.equal(at({ handover: true }), 'handover', 'still being read after it came back');
  assert.equal(at({ handover: true, taken: true }), 'not-owned', 'the claim last read names another app: said so, as the folder\'s row says it');
  assert.equal(at({ taken: true }), 'not-owned');
});

test('a removal forgets the folder only when everything is saved there, or the person chose to discard (R06)', () => {
  assert.deepEqual(removalOutcome({ required: ['1', '2'], saved: ['1', '2'] }), { forget: true, unsaved: [] });
  assert.deepEqual(removalOutcome({ required: ['1', '2', '3'], saved: ['2'] }), { forget: false, unsaved: ['1', '3'] }, 'kept: back to its state before');
  assert.deepEqual(removalOutcome({ required: ['1', '2'], saved: [], discard: true }), { forget: true, unsaved: ['1', '2'] }, 'discarded: what is lost listed');
  assert.deepEqual(removalOutcome({ required: [], saved: [] }), { forget: true, unsaved: [] }, 'an empty folder (or one out of reach with nothing unsaved)');
  assert.deepEqual(removalOutcome({ required: new Set([1, '2', 2]), saved: new Set(['1', '9']) }), { forget: false, unsaved: ['2'] },
    'ids compared as strings; one saved that wasn\'t required counts for nothing');
});

test('review 7 A1: a deletion waiting for its gallery\'s folder ends: met, it waits to be done there; ruled out, forgotten; else given up after three looks', () => {
  assert.equal(unfoundEnd({ met: true, whole: false, misses: 5 }), 'keep', 'met: deleted where it was met, kept till then');
  assert.equal(unfoundEnd({ met: false, whole: true, misses: 0 }), 'forget', 'a look that could tell whose everything is rules it out');
  assert.equal(unfoundEnd({ met: false, whole: false }), 1, 'one that couldn\'t: counted');
  assert.equal(unfoundEnd({ met: false, whole: false, misses: 1 }), 2);
  assert.equal(UNFOUND_LOOKS, 3);
  assert.equal(unfoundEnd({ met: false, whole: false, misses: 2 }), 'forget', 'the third such look gives it up');
  assert.equal(unfoundEnd({ met: false, whole: false, misses: null }), 1, 'a deletion recorded before the count (none) starts at none');
  // S41 E, S42: every folder it may still be in rules it out first; what is remembered is written only when it changes.
  assert.deepEqual(unfoundEnd({ met: false, whole: true, own: false, at: 'b', ruledOut: [], need: ['a', 'b'] }), { ruledOut: ['b'] }, 'another folder ruled out: remembered');
  assert.equal(unfoundEnd({ met: false, whole: true, own: false, at: 'b', ruledOut: ['b'], need: ['a', 'b'] }), 'keep', 'ruled out again: nothing to write');
  assert.equal(unfoundEnd({ met: false, whole: true, own: true, at: 'a', ruledOut: ['b'], need: ['a', 'b'] }), 'forget', 'the last one: given up');
});

test('S42 B: which folders a deletion not found may still be in is told without a call on any', () => {
  assert.equal(unfoundMayBeIn({ state: 'shown' }), true, 'shown, nothing else known: it may');
  assert.deepEqual(['hidden', 'removing'].map(state => unfoundMayBeIn({ state })), [false, false], 'out of the library');
  assert.equal(unfoundMayBeIn({ state: 'shown', taken: true }), false, 'another app\'s, by the last claim read');
  assert.deepEqual(['granted', 'prompt', 'denied', 'unavailable'].map(permission => unfoundMayBeIn({ state: 'shown', permission })), [true, true, false, false],
    'its permission as the browser says it: waiting to be asked again counts');
  assert.deepEqual(['ok', 'unavailable', 'other-library'].map(reach => unfoundMayBeIn({ state: 'shown', reach })), [true, true, false],
    'its reach as last found: a drive away still counts (the deletion waits for it), another library\'s folder at its path doesn\'t');
  assert.deepEqual(['unreadable', 'corrupt', 'missing-file', 'adopt-failed'].map(reason => leavesOpen({ reason })), [true, false, false, false],
    'only what couldn\'t be read at all may be the deleted gallery\'s: what was read, damaged or not, isn\'t');
});
