// safe-mode.ts — Safe Mode's stand-in words on a library card, as 1.3's page made them (app/js/library.js
// "Safe Mode": GIBBERISH_POOL, randomGibberish, _scrambleTag, _scrambleTitle, _scrambleId): the title
// word by word, each tag, the id's digits; the language flags and "+" keep theirs. The card shows them
// in place of its real words (CardView's `safe`) and keeps the real ones as its originals; its id is no
// link meanwhile (the card leaves the address out of the page while `safe` is there). The covers' blur
// is the stylesheet's (the grid's `safe` mode); a dialog about a card shows no cover while it blurs that
// card's (the page's).
//
// Made once a gallery: a scrambler keeps each gallery's stand-ins while Safe Mode stays on, so a card
// drawn again for the same gallery says the same words, and its view is made once (1.3 scrambled anew at
// each paint, which nobody can tell apart). Turned off, they are let go: on again, new ones.
// Pure: the random numbers are handed in (app/tests/safe-mode.test.mjs holds it to 1.3's lines).
import type { CardView } from './card-view.ts';

// Where the choice is kept, as 1.3 kept it: '1' on, '0' off.
export const SAFE_MODE_KEY = 'shiori-safe-mode';

export const GIBBERISH_POOL: readonly string[] = [
  'xelorp', 'blathnar', 'quixum', 'frobzle', 'wumble', 'cranlop', 'dribnak',
  'snorvel', 'durple', 'grixon', 'zibble', 'wonkle', 'frumple', 'drabix',
  'squibble', 'grompf', 'twarble', 'blintz', 'clongle', 'frixum', 'snargle',
  'wobzle', 'plinkle', 'glorble', 'snortle', 'grumple', 'blixon', 'trixon',
  'yarvok', 'splumf', 'crelbix', 'quznak', 'throble', 'wibzor', 'drangle',
  'snorbel', 'glumfix', 'twonkle', 'brixum', 'florkel', 'plorbix', 'snurgal',
  'wramble', 'draxon', 'kribzle', 'glorpan', 'snuffwix', 'blavrok', 'quorple',
];

type Random = () => number;

// A word of the pool for `original`: one within two letters of its length where the pool has one.
export function gibberish(original: string, random: Random = Math.random): string {
  const close = GIBBERISH_POOL.filter((w) => Math.abs(w.length - original.length) <= 2);
  const pool = close.length > 0 ? close : GIBBERISH_POOL;
  return pool[Math.floor(random() * pool.length)];
}
// A title, word by word.
export const scrambleTitle = (title: string, random: Random = Math.random) => title.split(/\s+/).map((w) => gibberish(w, random)).join(' ');
// An id: its digits.
export const scrambleId = (id: string, random: Random = Math.random) => id.replace(/\d/g, () => String(Math.floor(random() * 10)));

// The words a card shows while Safe Mode is on (CardView's `safe`).
export type SafeWords = NonNullable<CardView['safe']>;

export type Scrambler = { view(v: CardView): CardView; clear(): void };

export function createScrambler(random: Random = Math.random): Scrambler {
  const kept = new Map<string, string>();
  const word = (key: string, make: () => string) => {
    let out = kept.get(key);
    if (out === undefined) { out = make(); kept.set(key, out); }
    return out;
  };
  return {
    // The view as Safe Mode shows it: every other part the view's own.
    view(v) {
      const at = (part: string, original: string) => `${v.id}\u0000${part}\u0000${original}`;
      const safe: SafeWords = {
        title: v.title ? word(at('title', v.title), () => scrambleTitle(v.title, random)) : '',
        idText: word(at('id', v.idText), () => scrambleId(v.idText, random)),
        tags: v.tags.map((chip) => (chip.kind === 'tag' ? word(at('tag', chip.name), () => gibberish(chip.name, random)) : null)),
      };
      return { ...v, safe };
    },
    clear() { kept.clear(); },
  };
}
