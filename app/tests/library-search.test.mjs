// library-search.test.mjs — what the library's search and filter let through (src/lib/library-search.ts),
// held against 1.3's own code: parseSearch, _matchFilter, _tagNameMatches, _matchEntity, the match
// applyFilters builds from them and the filter's _loadFilter and steps, copied verbatim below from
// app/js/library.js (as released: plans' tree-1.3 is the same) as the oracle. Over a table of queries
// and filters against a set of galleries that reaches every branch (quoted, unquoted and half-typed
// filters, the aliases, a language and its regional variants, translated, favorite, source, plain words
// against the id, the title and the tags, the filter's show-only and hide), the two say the same:
// what a query parses to, and which galleries each lets through, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} removeEventListener() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document ??= { documentElement: { lang: 'en' }, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
const { LANG_NAME_TO_CODE } = await import('../js/gallery-model.js');
const { SEARCH_TYPES } = await import('../js/search-field.js');
const { TAG_VALUES } = await import('../js/tag-editor.js');
const lib = await import('../../src/lib/library-search.ts');

const RULES = { searchTypes: SEARCH_TYPES, langNameToCode: LANG_NAME_TO_CODE };

// ── 1.3's code, verbatim (app/js/library.js at a197355, lines 294–305 and 1452–1562) ──────────────
// What it reads from around it: the filter, set per case.
const _filter = { rating: new Map(), category: new Map() };
function _loadFilter(saved) {
  for (const [type, states] of Object.entries(_filter)) {
    states.clear();
    for (const [v, s] of Object.entries(saved?.[type] || {})) {
      if (TAG_VALUES[type].includes(v) && (s === 'include' || s === 'exclude')) states.set(v, s);
    }
  }
}

function parseSearch(raw) {
  const typed = [];
  const plain = [];
  const re = /([a-z:]+):"([^"]+)"/gi;
  const aliases = { female: 'tag:female', male: 'tag:male' };
  const typeOf = (name) => aliases[name.toLowerCase()] ?? name.toLowerCase();
  let match;
  let rest = raw;
  while ((match = re.exec(raw)) !== null) {
    typed.push({ type: typeOf(match[1]), value: match[2].toLowerCase() });
    rest = rest.replace(match[0], '');
  }
  // A filter still being typed — without quotes (`artist:an`) or with its quote still open
  // (`tag:"big br`) — matches what starts with it; one with no value yet is left out.
  const open = (m, pre, name, value) => {
    const type = typeOf(name);
    if (!SEARCH_TYPES.has(type)) return m;
    if (value.trim()) typed.push({ type, value: value.trim().toLowerCase(), prefix: true });
    return pre;
  };
  rest = rest.replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):"([^"]*)$/i, open)
    .replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):([^\s"]*)(?=\s|$)/gi, open);
  rest.trim().split(/\s+/).filter(Boolean).forEach(t => plain.push(t.toLowerCase()));
  return { typed, plain };
}

// (applyFilters' match, lines 1483–1488, its `raw` handed in.)
function applyFiltersMatch(raw) {
  const { typed, plain } = parseSearch(raw);
  const filtering = Object.values(_filter).some(set => set.size);
  const match = (typed.length || plain.length || filtering)
    ? (g) => _matchFilter(g) && _matchEntity(g, typed, plain) : null;
  return match;
}

// Filter predicate, per tag type: with any "show only" values the gallery needs one of them (so a
// gallery without that tag type drops out); it must carry none of the "hide" values.
function _matchFilter(g) {
  for (const [type, states] of Object.entries(_filter)) {
    if (!states.size) continue;
    const names = (g.tags || []).filter(t => t.type === type).map(t => String(t.name).toLowerCase());
    if (names.some(n => states.get(n) === 'exclude')) return false;
    if ([...states.values()].includes('include') && !names.some(n => states.get(n) === 'include')) return false;
  }
  return true;
}

// A typed search matches the whole tag name ("big" finds "big", not "big breasts"). A language
// also finds its regional variants, as its flag does: "chinese" finds "chinese (traditional)".
function _tagNameMatches(type, name, value) {
  const lower = String(name).toLowerCase();
  if (lower === value) return true;
  const want = type === 'language' && LANG_NAME_TO_CODE[value];
  const have = want && LANG_NAME_TO_CODE[lower];
  return !!have && (have === want || have.startsWith(`${want}-`));
}

// Search predicate; the store evaluates it against each gallery's metadata.
function _matchEntity(g, typed, plain) {
  for (const { type, value, prefix } of typed) {
    if (type === 'translated' || type === 'favorite') {   // translated:"yes" / favorite:"no"
      if (g[type] !== (prefix ? { y: true, n: false }[value[0]] : { yes: true, no: false }[value])) return false;
      continue;
    }
    if (type === 'source') {
      const source = g.source.toLowerCase();
      if (prefix ? !source.startsWith(value) : source !== value) return false;
      continue;
    }
    const matches = prefix ? (t) => String(t.name).toLowerCase().startsWith(value) : (t) => _tagNameMatches(type, t.name, value);
    if (!g.tags || !g.tags.some(t => t.type === type && matches(t))) return false;
  }
  for (const term of plain) {
    if (g.id.includes(term)) continue;
    if (g.title && g.title.toLowerCase().includes(term)) continue;
    if (g.tags && g.tags.some(t => t.name.toLowerCase().includes(term))) continue;
    return false;
  }
  return true;
}

// The filter dialog's step and save (lines 2010, 2042–2044 and 306–308: a press, then what is stored).
const _FILTER_NEXT = { off: 'include', include: 'exclude', exclude: 'off' };
function press(type, value) {
  const states = _filter[type];
  const next = _FILTER_NEXT[states.get(value) || 'off'];
  if (next === 'off') states.delete(value); else states.set(value, next);
}
const saved = () => Object.fromEntries(Object.entries(_filter).map(([type, m]) => [type, Object.fromEntries(m)]));

// (_addSearchToken's tokens, lines 2112 and 2147, and the Alt presses' at 562, 711 and 791.)
const tagTokenOld = (type, name) => (type ? `${type}:"${name}"` : name);
const flagTokenOld = (langName) => `language:"${langName}"`;
const favoriteTokenOld = (g) => `favorite:"${g.favorite ? 'yes' : 'no'}"`;
const translatedTokenOld = (g) => `translated:"${g.translated ? 'yes' : 'no'}"`;
const sourceTokenOld = (g) => `source:"${g.source}"`;

// ── The galleries (store.js's search projection: id, title, tags, translated, source, favorite) ──
const tag = (type, name) => ({ type, name });
const GALLERIES = [
  { id: '1790000000001', title: 'The Big Adventure 冒険', tags: [tag('artist', 'Ann Smith'), tag('tag', 'big'), tag('tag:female', 'glasses'), tag('language', 'english'), tag('rating', 'safe'), tag('category', 'manga')], translated: false, source: 'a.example', favorite: true },
  { id: '1790000000002', title: 'Big Breasts and More', tags: [tag('tag', 'big breasts'), tag('tag:male', 'glasses'), tag('language', 'chinese (traditional)'), tag('rating', 'explicit'), tag('category', 'doujinshi')], translated: true, source: 'B.Example', favorite: false },
  { id: '1790000000003', title: '', tags: [tag('language', 'chinese'), tag('rating', 'suggestive'), tag('category', 'manga'), tag('category', 'misc')], translated: true, source: '', favorite: false },
  { id: '1790000000004', title: 'portuguese stories', tags: [tag('language', 'portuguese (brazil)'), tag('parody', 'original'), tag('character', 'annie')], translated: false, source: 'a.example', favorite: true },
  { id: '1790000000105', title: 'No tags at all', translated: false, source: 'c.example', favorite: false },
  { id: '1790000000106', title: 'Re:Zero fan book', tags: [tag('group', 'circle one'), tag('rating', 'questionable'), tag('category', 'artist cg'), tag('language', 'japanese')], translated: false, source: 'local', favorite: false },
  { id: '17900000001', title: 'Short id: 179', tags: [tag('tag', 'Mixed Case'), tag('rating', 'safe'), tag('language', 'korean')], translated: true, source: 'a.example', favorite: true },
];

// ── The table ──
const QUERIES = [
  '',
  // plain words: the id, the title, the tags; several at once; case
  '179', '00003', 'big', 'BIG adventure', 'breasts', 'circle', 'mixed', 'nothing-is-called-this', '冒険', '  big   smith  ',
  // quoted filters: each type, the aliases, case of the key and the value
  'artist:"Ann Smith"', 'ARTIST:"ann smith"', 'artist:"ann"', 'tag:"big"', 'tag:"big breasts"', 'female:"glasses"', 'male:"glasses"',
  'tag:female:"glasses"', 'tag:male:"glasses"', 'Female:"GLASSES"', 'group:"circle one"', 'parody:"original"', 'character:"annie"',
  'category:"manga"', 'category:"misc"', 'rating:"safe"', 'rating:"explicit"',
  // a language and its regional variants
  'language:"chinese"', 'language:"chinese (traditional)"', 'language:"portuguese"', 'language:"english"', 'language:"klingon"', 'language:"japanese"',
  // translated, favorite: yes, no, anything else
  'translated:"yes"', 'translated:"no"', 'translated:"maybe"', 'favorite:"yes"', 'favorite:"no"',
  // source
  'source:"a.example"', 'source:"b.example"', 'source:"local"', 'source:"a"',
  // half-typed filters: unquoted, an open quote, no value yet, an unknown key (a word)
  'artist:an', 'artist:AN ', 'tag:"big br', 'tag:"big', 'tag:', 'tag:"', 'female:gla', 'male:gl', 'tag:female:gl', 'language:chi', 'language:"port',
  'translated:y', 'translated:n', 'translated:x', 'favorite:yes', 'favorite:no', 'source:a.ex', 'source:B', 're:zero', 'unknown:"x"', 'unknown:x', 'category:man',
  // filters and words together, several filters
  'big artist:"ann smith"', 'artist:"ann smith" tag:"big" glasses', 'language:"chinese" translated:"yes"', 'rating:"safe" category:"manga" adventure',
  'tag:"big" tag:"big breasts"', 'category:"manga" ta', 'artist:"x" artist:"y', 'smith tag:"big br',
];

const FILTERS = [
  {},
  { rating: { safe: 'include' } },
  { rating: { safe: 'exclude' } },
  { rating: { safe: 'include', explicit: 'include' } },
  { rating: { safe: 'include', suggestive: 'exclude' } },
  { category: { manga: 'include' }, rating: { safe: 'exclude' } },
  { category: { misc: 'exclude' } },
  { category: { manga: 'include', misc: 'exclude' } },
  // what a stored filter may hold that is no option: an unknown value, an unknown state, an unknown type
  { rating: { 'not a rating': 'include', safe: 'maybe' }, other: { x: 'include' } },
  null,
];

const sameParse = (q) => {
  const a = parseSearch(q), b = lib.parseSearch(q, RULES);
  assert.deepEqual(b, a, `parseSearch(${JSON.stringify(q)})`);
};
const through = (match) => (match ? GALLERIES.filter((g) => match(g)).map((g) => g.id) : 'everything');

test('a query parses as 1.3 parsed it', () => {
  for (const q of QUERIES) sameParse(q);
});

test('each query under each filter lets through what 1.3 let through', () => {
  let cases = 0;
  for (const saved of FILTERS) {
    _loadFilter(saved);
    const filter = lib.readFilter(saved, TAG_VALUES);
    assert.deepEqual(filter, Object.fromEntries(Object.entries(_filter).map(([type, m]) => [type, Object.fromEntries(m)])), `the filter read from ${JSON.stringify(saved)}`);
    for (const q of QUERIES) {
      const old = applyFiltersMatch(q);
      const now = lib.libraryMatch(q, filter, RULES);
      assert.equal(now === null, old === null, `${JSON.stringify(q)} under ${JSON.stringify(saved)}: narrows the library or not`);
      assert.deepEqual(through(now), through(old), `${JSON.stringify(q)} under ${JSON.stringify(saved)}`);
      cases++;
    }
  }
  assert.equal(cases, QUERIES.length * FILTERS.length);
});

test('the predicates alone, gallery by gallery, as 1.3\'s', () => {
  for (const saved of FILTERS) {
    _loadFilter(saved);
    const filter = lib.readFilter(saved, TAG_VALUES);
    for (const g of GALLERIES) assert.equal(lib.matchFilter(g, filter), _matchFilter(g), `matchFilter ${g.id} ${JSON.stringify(saved)}`);
  }
  for (const q of QUERIES) {
    const { typed, plain } = parseSearch(q);
    for (const g of GALLERIES) assert.equal(lib.matchEntity(g, typed, plain, RULES), _matchEntity(g, typed, plain), `matchEntity ${g.id} ${JSON.stringify(q)}`);
  }
  for (const [type, name, value] of [['language', 'chinese (traditional)', 'chinese'], ['language', 'chinese', 'chinese (traditional)'], ['language', 'portuguese (brazil)', 'portuguese'],
    ['language', 'English', 'english'], ['tag', 'chinese (traditional)', 'chinese'], ['language', 'klingon', 'chinese'], ['language', 'chinese', 'klingon'], ['tag', 'Big', 'big']]) {
    assert.equal(lib.tagNameMatches(type, name, value, RULES), _tagNameMatches(type, name, value), `tagNameMatches ${type} ${name} ${value}`);
  }
});

test('the filter\'s options step and are stored as 1.3 stepped and stored them', () => {
  // Presses in a row (type, value), the stored form read after each.
  const PRESSES = [['rating', 'safe'], ['rating', 'explicit'], ['category', 'manga'], ['rating', 'safe'], ['rating', 'safe'], ['category', 'misc'], ['rating', 'explicit'],
    ['rating', 'safe'], ['category', 'manga'], ['category', 'manga'], ['rating', 'explicit'], ['category', 'misc'], ['category', 'misc']];
  _loadFilter(null);
  let filter = lib.readFilter(null, TAG_VALUES);
  for (const [type, value] of PRESSES) {
    press(type, value);
    filter = lib.stepFilter(filter, type, value);
    // The same keys in the same order: JSON as stored.
    assert.equal(JSON.stringify(filter), JSON.stringify(saved()), `after ${type}:${value}`);
    assert.equal(lib.filtering(filter), Object.values(_filter).some((set) => set.size));
  }
});

test('the tokens a card\'s tag, flag, heart, translate button and source add to the search are 1.3\'s', () => {
  for (const [type, name] of [['artist', 'Ann Smith'], ['tag:female', 'glasses'], ['category', 'artist cg'], [undefined, 'plain'], ['', 'empty type']]) {
    assert.equal(lib.tagToken(type, name), tagTokenOld(type, name));
  }
  for (const name of ['japanese', 'chinese', 'portuguese']) assert.equal(lib.flagToken(name), flagTokenOld(name));
  for (const g of GALLERIES) {
    assert.equal(lib.stateToken('favorite', g.favorite), favoriteTokenOld(g));
    assert.equal(lib.stateToken('translated', g.translated), translatedTokenOld(g));
    assert.equal(lib.sourceToken(g.source), sourceTokenOld(g));
  }
});

test('the table reaches every branch of 1.3\'s code', () => {
  // Each branch, and a query or filter of the table that takes it (checked by running the oracle).
  const reached = new Set();
  const note = (what) => reached.add(what);
  for (const q of QUERIES) {
    const { typed, plain } = parseSearch(q);
    if (typed.some((f) => !f.prefix)) note('quoted');
    if (typed.some((f) => f.prefix)) note('half-typed');
    if (/:"[^"]*$/.test(q) && typed.some((f) => f.prefix)) note('open quote');
    if (/(^|\s)[a-z]+:"?(\s|$)/i.test(q) && !typed.length) note('no value yet');
    if (/unknown:x|re:zero/.test(q) && plain.length) note('unknown key stays a word');
    if (typed.some((f) => f.type.startsWith('tag:'))) note('alias');
    if (typed.some((f) => f.type === 'language' && !f.prefix)) note('language');
    if (typed.some((f) => f.type === 'translated')) note('translated');
    if (typed.some((f) => f.type === 'favorite')) note('favorite');
    if (typed.some((f) => f.type === 'source' && f.prefix)) note('source prefix');
    if (typed.some((f) => f.type === 'source' && !f.prefix)) note('source whole');
    if (plain.length) note('plain');
    for (const g of GALLERIES) {
      for (const term of plain) {
        if (g.id.includes(term)) note('word in id');
        else if (g.title && g.title.toLowerCase().includes(term)) note('word in title');
        else if (g.tags && g.tags.some((t) => t.name.toLowerCase().includes(term))) note('word in tags');
      }
      for (const { type, value } of typed) {
        if (type === 'language' && GALLERIES.some((x) => x.tags?.some((t) => t.type === 'language' && String(t.name).toLowerCase() !== value && _tagNameMatches(type, t.name, value)))) note('regional variant');
      }
      if (!g.tags) note('no tags');
    }
  }
  _loadFilter({ rating: { safe: 'include' } }); if (GALLERIES.some((g) => !_matchFilter(g))) note('show only drops');
  _loadFilter({ rating: { safe: 'exclude' } }); if (GALLERIES.some((g) => !_matchFilter(g))) note('hide drops');
  _loadFilter({ rating: { safe: 'include', suggestive: 'exclude' } }); if (GALLERIES.some((g) => _matchFilter(g))) note('show only and hide');
  const want = ['quoted', 'half-typed', 'open quote', 'no value yet', 'unknown key stays a word', 'alias', 'language', 'regional variant', 'translated', 'favorite',
    'source prefix', 'source whole', 'plain', 'word in id', 'word in title', 'word in tags', 'no tags', 'show only drops', 'hide drops', 'show only and hide'];
  assert.deepEqual(want.filter((w) => !reached.has(w)), []);
});
