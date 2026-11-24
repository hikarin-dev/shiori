// library-query.test.mjs — the views' read path (src/lib/library-query.ts, T4): reads of one gallery
// that overlap and land out of order leave the newest showing (the fault store.js has, plans §2.7);
// the change feed reads a shown gallery again only once its changes settle (500 ms after the last),
// '*' every gallery, a gallery no view shows not at all; nothing is read again by itself; and the
// follower stopped hears nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryObserver } from '@tanstack/react-query';
import { SETTLE_MS, followChanges, galleryKey, makeQueryClient, readAgain } from '../../src/lib/library-query.ts';

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

test('a change is read once things settle: 500 ms after the last word of it', async () => {
  const client = makeQueryClient();
  const { reads, read } = handReader();
  const timers = handTimers();
  const feed = handFeed();
  const stop = followChanges(client, feed.watch, { timers });
  const view = show(client, 'g1', read);
  await tick();
  reads[0].answer({ n: 0 });
  await tick();
  // A download's every page: words 100 ms apart.
  for (let i = 0; i < 5; i++) { feed.say('g1'); timers.advance(100); }
  await tick();
  assert.equal(reads.length, 1, 'not while the words keep coming');
  timers.advance(SETTLE_MS - 100 - 1);
  await tick();
  assert.equal(reads.length, 1, 'not before 500 ms after the last');
  timers.advance(1);
  await tick();
  assert.equal(reads.length, 2, 'once, 500 ms after the last');
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
  timers.advance(SETTLE_MS);
  await tick();
  assert.deepEqual(reads.map((r) => r.id), ['a']);
  for (const r of reads) r.answer({ id: r.id });
  await tick();
  reads.length = 0;
  feed.say('*');
  timers.advance(SETTLE_MS);
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

test('stopped, the follower hears nothing more, and its waiting reads are dropped', async () => {
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
  assert.equal(timers.pending, 1);
  stop();
  assert.equal(feed.listening, 0, 'unsubscribed from the feed');
  assert.equal(timers.pending, 0, 'its timer cleared');
  timers.advance(SETTLE_MS);
  await tick();
  assert.equal(reads.length, 1);
  view.off();
  client.clear();
});
