// safe-mode.test.mjs — Safe Mode's stand-in words for a library card (src/lib/safe-mode.ts), held
// against 1.3's own lines (app/js/library.js "Safe Mode": GIBBERISH_POOL, randomGibberish,
// _scrambleTag, _scrambleTitle, _scrambleId), copied verbatim below as the oracle and fed the same
// random numbers; and the scrambler's own rules: a gallery's words are made once and kept while Safe
// Mode stays on (a view drawn again for the same gallery says the same words), the flags and "+" keep
// theirs, the id is no link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GIBBERISH_POOL as POOL, gibberish, scrambleTitle, scrambleId, createScrambler } from '../../src/lib/safe-mode.ts';

// ── 1.3's lines (library.js, as released), verbatim ──
const GIBBERISH_POOL = [
  'xelorp','blathnar','quixum','frobzle','wumble','cranlop','dribnak',
  'snorvel','durple','grixon','zibble','wonkle','frumple','drabix',
  'squibble','grompf','twarble','blintz','clongle','frixum','snargle',
  'wobzle','plinkle','glorble','snortle','grumple','blixon','trixon',
  'yarvok','splumf','crelbix','quznak','throble','wibzor','drangle',
  'snorbel','glumfix','twonkle','brixum','florkel','plorbix','snurgal',
  'wramble','draxon','kribzle','glorpan','snuffwix','blavrok','quorple',
];

function randomGibberish(original) {
  const len = original.length;
  const close = GIBBERISH_POOL.filter(w => Math.abs(w.length - len) <= 2);
  const pool  = close.length > 0 ? close : GIBBERISH_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}
function _scrambleTag(tag) {
  tag.textContent = randomGibberish(tag.dataset.original);
}
function _scrambleTitle(el) {
  el.textContent = el.dataset.original.split(/\s+/).map(w => randomGibberish(w)).join(' ');
}
function _scrambleId(el) {
  el.textContent = el.dataset.original.replace(/\d/g, () => Math.floor(Math.random() * 10));
  if (el.hasAttribute('href')) { el.dataset.safeHref = el.getAttribute('href'); el.removeAttribute('href'); }
}
// ── end of 1.3's lines ──

// A seeded sequence of numbers in [0, 1), the same for the oracle and for the module.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
// 1.3's function run on an element of its own, Math.random being `random`.
function oracle(fn, original, random, href) {
  const real = Math.random;
  Math.random = random;
  try {
    const attrs = new Map(href ? [['href', href]] : []);
    const el = { textContent: original, dataset: { original }, hasAttribute: (k) => attrs.has(k), getAttribute: (k) => attrs.get(k), removeAttribute: (k) => attrs.delete(k) };
    fn(el);
    return { text: el.textContent, href: attrs.get('href') ?? null, parked: el.dataset.safeHref ?? null };
  } finally { Math.random = real; }
}

const WORDS = ['', 'a', 'ab', 'abc', 'Gallery', 'title', 'supercalifragilistic', 'verylongwordthatnopoolwordisnear', '「日本語」', 'x y', 'two  spaces', ' leading', 'trailing '];

test('the pool is 1.3\'s', () => {
  assert.deepEqual([...POOL], GIBBERISH_POOL);
});

test('a tag\'s, a title\'s and an id\'s stand-ins are 1.3\'s for the same random numbers', () => {
  for (const [i, word] of WORDS.entries()) {
    assert.equal(gibberish(word, seeded(i + 1)), oracle(_scrambleTag, word, seeded(i + 1)).text, `tag ${JSON.stringify(word)}`);
    assert.equal(scrambleTitle(word, seeded(i + 7)), oracle(_scrambleTitle, word, seeded(i + 7)).text, `title ${JSON.stringify(word)}`);
  }
  for (const [i, id] of ['1790000000001', '901', 'abc-12', '', 'no digits'].entries()) {
    assert.equal(scrambleId(id, seeded(i + 3)), oracle(_scrambleId, id, seeded(i + 3)).text, `id ${JSON.stringify(id)}`);
  }
  // A word is one of the pool's within two letters of its length where there is one; any of them
  // otherwise.
  for (let n = 0; n < 40; n++) {
    const word = 'w'.repeat(n);
    for (let k = 0; k < 20; k++) {
      const out = gibberish(word, seeded(n * 100 + k));
      assert.ok(POOL.includes(out));
      if (POOL.some((w) => Math.abs(w.length - n) <= 2)) assert.ok(Math.abs(out.length - n) <= 2, `${out} for ${n} letters`);
    }
  }
});

// A view as cardView makes it (the parts Safe Mode reads).
const view = (id, title, tags, { idText = id, idHref = `https://a.example/g/${id}` } = {}) => ({
  id, title, idText, idHref,
  tags: [{ kind: 'flag', code: 'ja', name: 'japanese', tip: 'Japanese', flag: 'JP' },
    ...tags.map(([type, name]) => ({ kind: 'tag', type, name, text: `${name}${type === 'tag:female' ? ' ♀' : ''}` })),
    { kind: 'add', tip: 'Add a tag' }],
  other: { kept: true },
});

test('the scrambler: every word of a card stood in for, the flags and "+" left, the rest the view\'s', () => {
  const s = createScrambler(seeded(42));
  const v = view('901', 'A gallery with a long title', [['category', 'manga'], ['tag', 'alpha'], ['tag:female', 'beta']]);
  const out = s.view(v);
  assert.equal(out.id, v.id);
  assert.equal(out.title, v.title, 'the real title stays the view\'s (the card keeps it as its original)');
  assert.equal(out.other, v.other);
  assert.equal(out.tags, v.tags, 'the same chips');
  assert.equal(out.idHref, v.idHref, 'the link stays the view\'s (the card leaves it out while `safe` is there)');
  const words = out.safe.title.split(' ');
  assert.equal(words.length, v.title.split(/\s+/).length);
  assert.ok(words.every((w) => POOL.includes(w)));
  assert.deepEqual(out.safe.tags.map((w) => w === null ? null : POOL.includes(w)), [null, true, true, true, null]);
  assert.match(out.safe.idText, /^\d{3}$/);
  // No title: none.
  assert.equal(s.view(view('902', '', [])).safe.title, '');
});

test('the scrambler keeps a gallery\'s stand-ins while Safe Mode stays on, and makes new ones after it was off', () => {
  const s = createScrambler(seeded(7));
  const v = view('901', 'One two three', [['tag', 'alpha'], ['tag', 'beta']]);
  const first = s.view(v);
  // The same gallery drawn again (its view made again, or another of its fields changed): the same words.
  const again = s.view({ ...view('901', 'One two three', [['tag', 'alpha'], ['tag', 'beta']]), favorite: true });
  assert.deepEqual(again.safe, first.safe);
  // A part that changed gets new words; the others stay.
  const retitled = s.view(view('901', 'Another title', [['tag', 'alpha'], ['tag', 'beta']]));
  assert.deepEqual(retitled.safe.tags, first.safe.tags);
  assert.equal(retitled.safe.idText, first.safe.idText);
  // Another gallery's words are its own.
  const other = s.view(view('902', 'One two three', [['tag', 'alpha']]));
  assert.ok(other.safe);
  // Turned off and on again: made anew (1.3 scrambled each time it was turned on).
  s.clear();
  let differs = false;
  for (let i = 0; i < 5 && !differs; i++) { differs = JSON.stringify(s.view(v).safe) !== JSON.stringify(first.safe); s.clear(); }
  assert.ok(differs);
});
