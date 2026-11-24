// library-query.test.mjs — the views' read path (src/lib/library-query.ts, T4): reads of one gallery
// that overlap and land out of order leave the newest showing (the fault store.js has, plans §2.7);
// the change feed reads a shown gallery again at its first word, and words that follow within 500 ms
// in one more read at that window's close (a download's every page a handful of reads), '*' every
// gallery, a gallery no view shows not at all; nothing is read again by itself; the follower stopped
// hears nothing more; and an edit the page makes shows at once, held over reads that come before the
// library has it, and is put back when the library refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryObserver } from '@tanstack/react-query';
import { SETTLE_MS, editGallery, followChanges, galleryKey, makeQueryClient, readAgain, readGallery } from '../../src/lib/library-query.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

// A reader whose reads are answered by hand: reads[i].answer(value), in any order.
function handReader() {
  const reads = [];
  const read = (id) => new Promise((resolve) => reads.push({ id, answer: resolve }));
  return { reads, read };
}

// Timers run by hand: advance(ms).
function handTimers() {
  let now = 0, seq = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => { due.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimeout: (h) => { due.delete(h); },
    advance(ms) {
      now += ms;
      for (const [h, { at, fn }] of [...due].sort((a, b) => a[1].at - b[1].at)) if (at <= now) { due.delete(h); fn(); }
    },
    get pending() { return due.size; },
  };
}

// A feed as api.events.watch is: cb(gid, beacon); returns its unsubscribe.
function handFeed() {
  const listeners = new Set();
  return {
    watch: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    say: (gid) => { for (const cb of [...listeners]) cb(gid, null); },
    get listening() { return listeners.size; },
  };
}

const show = (client, id, read) => {
  const observer = new QueryObserver(client, { queryKey: galleryKey(id), queryFn: () => read(id) });
  const seen = [];
  const off = observer.subscribe((result) => seen.push(result.data));
  return { observer, seen, off, data: () => observer.getCurrentResult().data };
};

test('three overlapping reads of one gallery that land oldest last leave the newest showing', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const view = show(client, 'g1', read);
  await tick();
  // Read again twice while the first is still under way (the gallery changed, and again).
  await readAgain(client, 'g1');
  await tick();
  await readAgain(client, 'g1');
  await tick();
  assert.equal(reads.length, 3, 'each change made a read');
  // They land newest first, oldest last.
  reads[2].answer({ id: 'g1', title: 'third' });
  await tick();
  reads[1].answer({ id: 'g1', title: 'second' });
  await tick();
  reads[0].answer({ id: 'g1', title: 'first' });
  await tick();
  assert.equal(view.data()?.title, 'third');
  assert.deepEqual(view.seen.filter(Boolean).map((g) => g.title), ['third'], 'no older read ever showed');
  view.off();
  client.clear();
});

test('the same through the change feed: changes 500 ms apart while reads are slow', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const view = show(client, 'g1', read);
  await tick();
  for (let i = 0; i < 2; i++) {
    feed.say('g1');
    timers.advance(SETTLE_MS);
    await tick();
  }
  assert.equal(reads.length, 3);
  reads[2].answer({ title: 'newest' });
  reads[0].answer({ title: 'oldest' });
  reads[1].answer({ title: 'middle' });
  await tick();
  assert.equal(view.data()?.title, 'newest');
  view.off();
  stop();
  client.clear();
});

test('a change is read at its first word; words within the next 500 ms end in one more read at its close', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const view = show(client, 'g1', read);
  await tick();
  reads[0].answer({ n: 0 });
  await tick();
  feed.say('g1');
  await tick();
  assert.equal(reads.length, 2, 'read at once');
  reads[1].answer({ n: 1 });
  await tick();
  // A download's every page: words 100 ms apart.
  for (let i = 0; i < 4; i++) { timers.advance(100); feed.say('g1'); }
  await tick();
  assert.equal(reads.length, 2, 'not again inside the window');
  timers.advance(SETTLE_MS - 400 - 1);
  await tick();
  assert.equal(reads.length, 2, 'not before the window closes');
  timers.advance(1);
  await tick();
  assert.equal(reads.length, 3, 'once at its close, for every word inside it');
  reads[2].answer({ n: 2 });
  await tick();
  // Quiet since: the next window closes with nothing to read, and the next word is read at once.
  timers.advance(SETTLE_MS);
  await tick();
  assert.equal(reads.length, 3);
  feed.say('g1');
  await tick();
  assert.equal(reads.length, 4, 'a word after a quiet window is read at once');
  view.off();
  stop();
  client.clear();
});

test('200 words about one gallery in a second read it a handful of times', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const view = show(client, 'g1', read);
  await tick();
  reads[0].answer({});
  for (let i = 0; i < 200; i++) {
    feed.say('g1');
    timers.advance(5);
    await tick();
    for (const r of reads) r.answer({ i });
  }
  timers.advance(SETTLE_MS);
  await tick();
  timers.advance(SETTLE_MS);
  await tick();
  const made = reads.length - 1;
  assert.ok(made >= 2 && made <= 4, `${made} reads`);
  view.off();
  stop();
  client.clear();
});

test("'*' reads every gallery shown again; a gallery no view shows is not read; another gallery's word reads only it", async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const a = show(client, 'a', read), b = show(client, 'b', read);
  const gone = show(client, 'gone', read);
  await tick();
  for (const r of reads) r.answer({ id: r.id });
  await tick();
  gone.off();   // no longer shown
  reads.length = 0;
  feed.say('a');
  await tick();
  assert.deepEqual(reads.map((r) => r.id), ['a']);
  for (const r of reads) r.answer({ id: r.id });
  await tick();
  reads.length = 0;
  timers.advance(SETTLE_MS);
  feed.say('*');
  await tick();
  assert.deepEqual(reads.map((r) => r.id).sort(), ['a', 'b'], 'every gallery shown, not the one no view shows');
  a.off(); b.off();
  stop();
  client.clear();
});

test('nothing is read again by itself: not on focus, not on reconnecting, not with time', async () => {
  const client = makeQueryClient();
  const defaults = client.getDefaultOptions().queries;
  assert.equal(defaults.networkMode, 'always', 'a local read never waits on the network');
  assert.equal(defaults.refetchOnWindowFocus, false);
  assert.equal(defaults.refetchOnReconnect, false);
  assert.equal(defaults.retry, false, 'no retry hiding an error');
  assert.equal(defaults.staleTime, Infinity, 'never stale by age');
  const { reads, read } = handReader();
  const view = show(client, 'g1', read);
  await tick();
  reads[0].answer({});
  await tick();
  // A second view of the same gallery takes what is read.
  const again = show(client, 'g1', read);
  await tick();
  assert.equal(reads.length, 1);
  view.off(); again.off();
  client.clear();
});

test('stopped, the follower hears nothing more, and its window\'s read is dropped', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const view = show(client, 'g1', read);
  await tick();
  reads[0].answer({});
  await tick();
  feed.say('g1');
  feed.say('g1');
  await tick();
  assert.equal(reads.length, 2);
  assert.equal(timers.pending, 1, 'its window open, a word in it');
  stop();
  assert.equal(feed.listening, 0, 'unsubscribed from the feed');
  assert.equal(timers.pending, 0, 'its timer cleared');
  timers.advance(SETTLE_MS);
  feed.say('g1');
  await tick();
  assert.equal(reads.length, 2);
  view.off();
  client.clear();
});

// The library as a hand-held record: a read answers when the test says, with what is stored then.
function handLibrary(g) {
  let stored = { ...g };
  const reads = [];
  return {
    read: (id) => readGallery(id, () => new Promise((resolve) => reads.push(() => resolve({ ...stored })))),
    reads,
    commit(patch) { stored = { ...stored, ...patch }; },
    async answerAll() { while (reads.length) { reads.shift()(); await tick(); } },
  };
}

test('an edit the page makes shows at once, holds over reads made before the library has it, and is put back when refused', async () => {
  const client = makeQueryClient();
  const lib = handLibrary({ id: 'g1', favorite: false, title: 'one' });
  const view = new QueryObserver(client, { queryKey: galleryKey('g1'), queryFn: () => lib.read('g1') });
  const seen = [];
  const off = view.subscribe((r) => seen.push(r.data?.favorite));
  await tick();
  await lib.answerAll();
  assert.equal(view.getCurrentResult().data.favorite, false);
  // A read under way when the edit is made (a download's page): it lands after, with the old value.
  await readAgain(client, 'g1');
  await tick();
  let land;
  const done = editGallery(client, 'g1', { favorite: true }, () => new Promise((resolve) => { land = resolve; }));
  assert.equal(view.getCurrentResult().data.favorite, true, 'shown at once, before the library answers');
  await lib.answerAll();
  assert.equal(view.getCurrentResult().data.favorite, true, 'held over a read made before the library had it');
  lib.commit({ favorite: true });
  land(true);
  await done;
  await tick();
  await lib.answerAll();
  assert.equal(view.getCurrentResult().data.favorite, true);
  assert.deepEqual(seen.filter((v, i) => v !== undefined && v !== seen[i - 1]), [false, true], 'never shown false again once pressed');

  // Refused (it throws): put back as the library has it.
  await editGallery(client, 'g1', { title: 'two' }, () => Promise.reject(new Error('no'))).catch(() => {});
  await tick();
  await lib.answerAll();
  assert.equal(view.getCurrentResult().data.title, 'one', 'put back');
  // A refusal said, not thrown (false): put back too.
  const said = editGallery(client, 'g1', { title: 'three' }, () => Promise.resolve(false));
  assert.equal(view.getCurrentResult().data.title, 'three');
  await said;
  await tick();
  await lib.answerAll();
  assert.equal(view.getCurrentResult().data.title, 'one');
  off();
  client.clear();
});
