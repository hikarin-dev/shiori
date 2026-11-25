// records.mjs — what 1.3's pages gave, kept as the record the new pages are held to. Until 1.3's
// Settings page went (2026-11-24), and its library page (2026-11-25), the tests drove each table of
// actions on both pages and compared the two; what 1.3's page gave is kept here, measured on the day
// its page went (three runs, the same), one file a table: records/<test file>.<table>.json. A test
// compares what the page gives with its record; a deliberate change of behaviour edits the record in
// the same commit.
//
// What may differ between two runs of the same page is taken out of both alike before they are
// compared (normalised): the addresses of the servers a test starts (on ports of their own each run).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'records');

// The record of `table` of the test file `test` (its file name); of one row of it where the table is
// kept by rows (`key`: a case's name).
export function record(test, table, key) {
  const kept = JSON.parse(readFileSync(join(DIR, `${test}.${table}.json`), 'utf8'));
  if (key === undefined) return kept;
  if (!Object.hasOwn(kept, key)) throw new Error(`${test}.${table}: no row "${key}"`);
  return kept[key];
}

// `value` with each of `origins` (name → origin, an address that changes from run to run) written as
// <name>, wherever it stands in a string.
export function normalised(value, origins = {}) {
  let text = JSON.stringify(value);
  for (const [name, origin] of Object.entries(origins)) if (origin) text = text.split(origin).join(`<${name}>`);
  return JSON.parse(text);
}
