// folder-owner.test.mjs — which app keeps a library folder: a claim read three ways (none, damaged,
// a claim); only the app holding it writes; a folder no app holds is claimed, one another app holds
// or whose claim can't be checked is taken only when the person says so; the counter never goes
// back, so an app adding a folder back can tell whether another had it meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaim, claimText, access, nextClaim, releasedClaim, unchangedSince, heldElsewhere, knownAfter, CLAIM_TTL_MS } from '../js/storage/folder-owner.js';

const ME = 'aaaaaaaaaaaaaaaa', OTHER = 'bbbbbbbbbbbbbbbb';
const by = { app: 'desktop', host: 'pc' };
const claim = (owner, epoch, at = 1) => readClaim(claimText({ owner, by, at, epoch }));

test('a claim file reads as none, damaged or a claim — never as none when it is there but unreadable (R08)', () => {
  assert.deepEqual(readClaim(null), { state: 'absent' });
  assert.equal(claim(ME, 3).state, 'claim');
  assert.equal(claim(null, 3).owner, null, 'a released claim');
  // A file holding nothing is what a first claim's write cut short leaves (the website makes the file before
  // it writes it): no claim, never "in use by another app" for good (S26a).
  for (const none of ['', ' \n']) assert.deepEqual(readClaim(none), { state: 'absent' }, JSON.stringify(none));
  for (const bad of ['{', '[]', '{"format":"other"}', JSON.stringify({ format: 'shiori-owner', owner: ME, at: 1 }),
    JSON.stringify({ format: 'shiori-owner', owner: ME, at: 1, epoch: -1 }), JSON.stringify({ format: 'shiori-owner', owner: 7, at: 1, epoch: 1 })]) {
    assert.equal(readClaim(bad).state, 'damaged', bad);
  }
  assert.equal(readClaim(new Error('EPERM')).state, 'damaged', 'a read that failed is not "no claim"');
  // One that failed is told from one read whole that is damaged: a moment's failure, kept for no time (C1).
  assert.deepEqual([readClaim(new Error('EIO')).unread, readClaim('{').unread], [true, undefined]);
});

test('the commit gate knows the last claim it read: one naming another app refuses until a later read says otherwise, a read that failed says nothing, and past its time to live it is read again (S29c, C2)', () => {
  const at = 1_800_000_000_000;
  const read = (r, owned = false, when = at, before = null) => knownAfter(before, r, owned, when);
  const other = read(claim(OTHER, 3));
  assert.deepEqual(heldElsewhere(other, at + CLAIM_TTL_MS - 1), { held: true, again: false }, 'inside its time to live: refused, no read');
  // Past it the last answer still stands, to be read again (on `339ddee` a read that old was no knowledge: C2).
  assert.deepEqual(heldElsewhere(other, at + 60_000), { held: true, again: true }, 'past it: still refused, read again');
  // A read that failed says nothing: not kept, the last answer standing whatever it was (C1 stays: none refuses).
  for (const failed of [new Error('EIO'), undefined]) {
    assert.equal(read(readClaim(failed), false, at + 9000, other), other, 'another app\'s still');
    const mine = read(claim(ME, 3), true);
    assert.equal(read(readClaim(failed), false, at + 9000, mine), mine, 'this app\'s still');
    assert.equal(read(readClaim(failed), false, at + 9000), null, 'nothing read yet: still nothing');
  }
  // A later read that says otherwise ends it: this app's claim, one let go, none, a file there that isn't a claim.
  for (const [what, r, owned] of [['this app\'s', claim(ME, 4), true], ['let go', claim(null, 5), false], ['no claim', readClaim(null), false], ['damaged', readClaim('{'), false]]) {
    assert.deepEqual(heldElsewhere(read(r, owned, at + 9000, other), at + 9001), { held: false, again: false }, what);
  }
  // Nothing read yet: nothing refused, and the claim to be read.
  assert.deepEqual(heldElsewhere(null, at), { held: false, again: true });
  assert.deepEqual(heldElsewhere(read(claim(ME, 3), true), at + CLAIM_TTL_MS), { held: false, again: true }, 'this app\'s, past its time to live: read again');
});

test('only the app holding the claim writes; a damaged or unreadable claim is read-only (R08)', () => {
  assert.equal(access(claim(ME, 2), ME, 2), 'mine');
  assert.equal(access(readClaim(null), ME, null), 'free');
  assert.equal(access(claim(OTHER, 3), ME, 2), 'taken');
  assert.equal(access(readClaim('{'), ME, 2), 'unknown');
  assert.equal(access(readClaim(new Error('EACCES')), ME, 2), 'unknown');
  assert.equal(access(claim(null, 2), ME, 2), 'free', 'let go by this app, untouched since');
  assert.equal(access(claim(null, 5), ME, 2), 'taken', 'let go by another app that had it since');
});

test('claiming: a free folder is claimed, a held or damaged one only when the person says so (R08, R21)', () => {
  assert.deepEqual(nextClaim(claim(ME, 4), ME, by), { claim: { owner: ME, by, at: 1, epoch: 4 }, changed: false });
  assert.ok(nextClaim(claim(OTHER, 4), ME, by).refused);
  assert.ok(nextClaim(readClaim('{'), ME, by).refused, 'a damaged claim is not overwritten without asking');
  assert.equal(nextClaim(claim(OTHER, 4), ME, by, { force: true }).claim.owner, ME);
  assert.equal(nextClaim(claim(null, 4), ME, by).changed, true, 'a claim let go, by any app, may be taken');
});

test('the counter never goes back, whatever the folder\'s claim file says (R08)', () => {
  assert.equal(nextClaim(claim(null, 4), ME, by, { held: 9 }).claim.epoch, 10, 'past what this app held');
  assert.equal(nextClaim(claim(OTHER, 12), ME, by, { held: 9, force: true }).claim.epoch, 13, 'past the folder\'s');
  const now = 1_800_000_000_000;
  assert.equal(nextClaim(readClaim('{'), ME, by, { held: 7, force: true, now }).claim.epoch, now, 'a damaged claim\'s count is unknown: past any count');
  assert.equal(nextClaim(readClaim(null), ME, by, { held: 7, now }).claim.epoch, now);
});

test('letting a folder go leaves a released claim only when this app holds it', () => {
  assert.deepEqual(releasedClaim(claim(ME, 6), ME, 50), { owner: null, by, at: 50, epoch: 6 });
  assert.equal(releasedClaim(claim(OTHER, 6), ME), null);
  assert.equal(releasedClaim(readClaim('{'), ME), null, 'a damaged claim stays as it is');
});

test('a folder added back is as this app left it only when no other app claimed it since (R21)', () => {
  assert.equal(unchangedSince(claim(null, 6), ME, 6), true);
  assert.equal(unchangedSince(claim(ME, 6), ME, 6), true);
  assert.equal(unchangedSince(claim(OTHER, 7), ME, 6), false);
  assert.equal(unchangedSince(claim(null, 7), ME, 6), false, 'another app had it and let it go');
  assert.equal(unchangedSince(readClaim('{'), ME, 6), false, 'a damaged claim tells nothing');
  assert.equal(unchangedSince(readClaim(null), ME, null), true, 'set aside before claims existed, never claimed');
  assert.equal(unchangedSince(readClaim(null), ME, 6), false, 'its claim was deleted');
});

test('S33, review 10 A2: a hand-over\'s wait lasts at most its window of this process\'s own running time, whatever the clock says', async () => {
  const { waitLeft, readsFrom, HANDOVER_MARGIN_MS } = await import('../js/storage/folder-owner.js');
  const WINDOW = CLAIM_TTL_MS + HANDOVER_MARGIN_MS, now = 1_800_000_000_000;
  const h = { at: now - 1000, wait: true };
  assert.equal(waitLeft(h, now, 0), readsFrom(h) - now, 'on a right clock: until readsFrom');
  assert.equal(waitLeft(h, now + WINDOW, 0), 0, 'its window passed on the clock: it reads');
  assert.equal(waitLeft(h, now, WINDOW), 0, 'its window passed in this process\'s own time: it reads');
  const back = { at: now + 3_600_000, wait: true };   // the clock set back an hour since the claim (or ahead as a hand-over a kill cut began)
  assert.equal(waitLeft(back, now, 0), WINDOW, 'never longer than the window from the first wait');
  assert.equal(waitLeft(back, now, 2000), WINDOW - 2000);
  assert.equal(waitLeft(back, now, WINDOW), 0, 'then it reads');
  assert.equal(waitLeft({ at: now + 3_600_000, wait: false }, now, 0), 0, 'a claim let go: no wait, whatever the clock');
});
