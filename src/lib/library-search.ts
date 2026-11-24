// library-search.ts — what the library's search and filter keep and let through, as data: 1.3's
// parseSearch, _matchFilter, _tagNameMatches and _matchEntity (app/js/library.js) stated once, with
// the match applyFilters built from them, the filter's stored form (`shiori:libFilter`) and its steps,
// and the token a card's tag or flag adds to the search (_addSearchToken). Nothing here draws, reads
// the library or keeps anything.
//
// The rules it is handed (so Node tests it as it is, app/tests/library-search.test.mjs):
//   searchTypes     every type a filter searches (search-field.js SEARCH_TYPES)
//   langNameToCode  a language's name → its code (gallery-model.js LANG_NAME_TO_CODE)
//   tagValues       the values a filter's dialog offers per tag type (tag-editor.js TAG_VALUES)

export type SearchRules = {
  searchTypes: ReadonlySet<string>;
  langNameToCode: Readonly<Record<string, string>>;
};

// A filter of the query: a tag type (or a gallery's state: translated, favorite, source) and the value
// it wants; `prefix`, a filter still being typed, which matches what starts with it.
export type Typed = { type: string; value: string; prefix?: true };
export type ParsedSearch = { typed: Typed[]; plain: string[] };

// What a search reads of a gallery (store.js's search projection).
export type SearchEntry = {
  id: string;
  title?: string;
  tags?: { type: string; name: string }[];
  translated?: boolean;
  favorite?: boolean;
  source: string;
  [field: string]: unknown;
};

export function parseSearch(raw: string, rules: SearchRules): ParsedSearch {
  const typed: Typed[] = [];
  const plain: string[] = [];
  const re = /([a-z:]+):"([^"]+)"/gi;
  const aliases: Record<string, string> = { female: 'tag:female', male: 'tag:male' };
  const typeOf = (name: string) => aliases[name.toLowerCase()] ?? name.toLowerCase();
  let match: RegExpExecArray | null;
  let rest = raw;
  while ((match = re.exec(raw)) !== null) {
    typed.push({ type: typeOf(match[1]), value: match[2].toLowerCase() });
    rest = rest.replace(match[0], '');
  }
  // A filter still being typed, without quotes (`artist:an`) or with its quote still open
  // (`tag:"big br`), matches what starts with it; one with no value yet is left out.
  const open = (m: string, pre: string, name: string, value: string) => {
    const type = typeOf(name);
    if (!rules.searchTypes.has(type)) return m;
    if (value.trim()) typed.push({ type, value: value.trim().toLowerCase(), prefix: true });
    return pre;
  };
  rest = rest.replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):"([^"]*)$/i, open)
    .replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):([^\s"]*)(?=\s|$)/gi, open);
  rest.trim().split(/\s+/).filter(Boolean).forEach((word) => plain.push(word.toLowerCase()));
  return { typed, plain };
}

// ── The filter (rating / category) ──
// Per tag type, value → 'include' (show only) or 'exclude' (hide); a value that's absent doesn't
// filter. Stored as it is under `shiori:libFilter` (1.3's form: { rating: {…}, category: {…} }), each
// type's values in the order they were set.
export type FilterState = 'include' | 'exclude';
export type FilterType = 'rating' | 'category';
export type LibFilter = Record<FilterType, Record<string, FilterState>>;
export const FILTER_TYPES: readonly FilterType[] = ['rating', 'category'];

// A stored filter as the page keeps it: only the values the dialog offers, only a known state.
export function readFilter(saved: unknown, tagValues: Readonly<Record<string, readonly string[]>>): LibFilter {
  const out: LibFilter = { rating: {}, category: {} };
  const stored = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  for (const type of FILTER_TYPES) {
    const states = stored[type];
    if (!states || typeof states !== 'object') continue;
    for (const [v, s] of Object.entries(states as Record<string, unknown>)) {
      if (tagValues[type]?.includes(v) && (s === 'include' || s === 'exclude')) out[type][v] = s;
    }
  }
  return out;
}

export const filtering = (filter: LibFilter) => FILTER_TYPES.some((type) => Object.keys(filter[type]).length > 0);

// An option pressed: any → show only → hide → any. A value newly set goes last, one changed keeps its
// place (a Map's order, as 1.3 kept it).
const NEXT: Record<'off' | FilterState, 'off' | FilterState> = { off: 'include', include: 'exclude', exclude: 'off' };
export function stepFilter(filter: LibFilter, type: FilterType, value: string): LibFilter {
  const next = NEXT[filter[type][value] ?? 'off'];
  const states = { ...filter[type] };
  if (next === 'off') delete states[value]; else states[value] = next;
  return { ...filter, [type]: states };
}
export const NO_FILTER: LibFilter = { rating: {}, category: {} };

// Per tag type: with any "show only" values the gallery needs one of them (so a gallery without that
// tag type drops out); it must carry none of the "hide" values.
export function matchFilter(g: SearchEntry, filter: LibFilter): boolean {
  for (const type of FILTER_TYPES) {
    const states = filter[type];
    const values = Object.values(states);
    if (!values.length) continue;
    const names = (g.tags || []).filter((tag) => tag.type === type).map((tag) => String(tag.name).toLowerCase());
    if (names.some((n) => states[n] === 'exclude')) return false;
    if (values.includes('include') && !names.some((n) => states[n] === 'include')) return false;
  }
  return true;
}

// A typed search matches the whole tag name ("big" finds "big", not "big breasts"). A language also
// finds its regional variants, as its flag does: "chinese" finds "chinese (traditional)".
export function tagNameMatches(type: string, name: unknown, value: string, rules: SearchRules): boolean {
  const lower = String(name).toLowerCase();
  if (lower === value) return true;
  const want = type === 'language' && rules.langNameToCode[value];
  const have = want && rules.langNameToCode[lower];
  return !!have && (have === want || have.startsWith(`${want}-`));
}

export function matchEntity(g: SearchEntry, typed: Typed[], plain: string[], rules: SearchRules): boolean {
  for (const { type, value, prefix } of typed) {
    if (type === 'translated' || type === 'favorite') {   // translated:"yes" / favorite:"no"
      const want = prefix ? ({ y: true, n: false } as Record<string, boolean>)[value[0]] : ({ yes: true, no: false } as Record<string, boolean>)[value];
      if (g[type] !== want) return false;
      continue;
    }
    if (type === 'source') {
      const source = g.source.toLowerCase();
      if (prefix ? !source.startsWith(value) : source !== value) return false;
      continue;
    }
    const matches = prefix ? (tag: { name: string }) => String(tag.name).toLowerCase().startsWith(value) : (tag: { name: string }) => tagNameMatches(type, tag.name, value, rules);
    if (!g.tags || !g.tags.some((tag) => tag.type === type && matches(tag))) return false;
  }
  for (const term of plain) {
    if (g.id.includes(term)) continue;
    if (g.title && g.title.toLowerCase().includes(term)) continue;
    if (g.tags && g.tags.some((tag) => tag.name.toLowerCase().includes(term))) continue;
    return false;
  }
  return true;
}

// What store.getPage is handed for a query and a filter (applyFilters'): null when nothing narrows
// the library (the database sorts and pages it alone), else the predicate.
export function libraryMatch(query: string, filter: LibFilter, rules: SearchRules): ((g: SearchEntry) => boolean) | null {
  const { typed, plain } = parseSearch(query, rules);
  if (!typed.length && !plain.length && !filtering(filter)) return null;
  return (g) => matchFilter(g, filter) && matchEntity(g, typed, plain, rules);
}

// ── What a card adds to the search (_addSearchToken) ──
// A tag: `type:"name"` (its name alone where it has no type); a flag: its language.
export const tagToken = (type: string | undefined, name: string) => (type ? `${type}:"${name}"` : name);
export const flagToken = (langName: string) => `language:"${langName}"`;
// Alt on a card's heart, its translate button or its source: galleries in the same state, or from the
// same source.
export const stateToken = (state: 'favorite' | 'translated', on: unknown) => `${state}:"${on ? 'yes' : 'no'}"`;
export const sourceToken = (source: string) => `source:"${source}"`;
