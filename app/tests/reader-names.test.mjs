// reader-names.test.mjs — what the route sets on <html> before it draws the reader's frame
// (src/routes/reader/names.ts) is what 1.3's reader page set before it drew (app/reader-init.js, a classic
// script in its head): the same names from the same settings, written back the same way, for every
// combination of those settings, and nothing when the storage can't be read. 1.3's answers are the record
// (records/reader-names.test.mjs.names.json, measured on 2026-11-26 from that script, three runs the
// same): a deliberate change of what the reader opens with edits it in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { READER_PAGE_NAMES, setReaderNames, takeReaderNames } from '../../src/routes/reader/names.ts';
import { record } from './browser/records.mjs';

const element = () => {
  const classes = new Set();
  return {
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
    dataset: {},
    getAttribute: (name) => (name === 'class' ? [...classes].join(' ') : null),
    removeAttribute() {},
    classes,
  };
};
const storage = (values, writes, broken) => ({
  getItem(key) { if (broken) throw new Error('no storage'); return Object.hasOwn(values, key) ? values[key] : null; },
  setItem(key, value) { if (broken) throw new Error('no storage'); writes.push([key, String(value)]); values[key] = String(value); },
});
const result = (html, writes) => ({ classes: [...html.classes].sort(), data: { ...html.dataset }, writes });

function viaRoute(values, broken) {
  const html = element(), writes = [];
  setReaderNames(html, storage({ ...values }, writes, broken));
  return result(html, writes);
}

test('the route sets on <html> what the reader\'s page set before it drew, for every combination of the settings read', () => {
  const kept = record('reader-names.test.mjs', 'names');
  // The five settings, each unset or set to each value it may hold (and others it may not).
  const combinations = [];
  for (const nav of [undefined, 'top', 'side', 'other'])
    for (const mode of [undefined, '"single"'])
      for (const sidePin of [undefined, '0', '1'])
        for (const pin of [undefined, '0', '1'])
          for (const place of [undefined, 'top-center', 'left-end', 'bottom', 'right-start', 'middle-somewhere', '']) {
            combinations.push(Object.fromEntries(Object.entries({ 'shiori-reader-nav': nav, 'shiori:readerMode': mode, 'shiori-reader-side-pin': sidePin,
              'shiori-reader-pin': pin, 'shiori-reader-nav-place': place }).filter(([, v]) => v !== undefined)));
          }
  assert.equal(combinations.length, 4 * 2 * 3 * 3 * 7);
  assert.deepEqual(kept.combinations.map((row) => row.settings), combinations, 'the record holds every combination');
  for (const { settings, ...was } of kept.combinations) assert.deepEqual(viaRoute(settings), was, JSON.stringify(settings));
  // Unreadable storage: nothing set.
  assert.deepEqual(viaRoute({}, true), kept.unreadable);
  assert.deepEqual(kept.unreadable, { classes: [], data: {}, writes: [] });
});

test('what the route set is taken away again, and only that', () => {
  const html = element();
  html.classList.add('dark');
  html.dataset.frame = 'header';
  setReaderNames(html, storage({ 'shiori-reader-nav': 'side', 'shiori-reader-side-pin': '0', 'shiori-reader-nav-place': 'left-end' }, []));
  assert.deepEqual(result(html, []).classes, ['dark', 'reader-controls-hidden', 'reader-side-nav']);
  takeReaderNames(html);
  assert.deepEqual(result(html, []), { classes: ['dark'], data: { frame: 'header' }, writes: [] });
  assert.deepEqual(READER_PAGE_NAMES, { classes: ['reader-side-nav', 'reader-controls-hidden'], data: ['snPos', 'snAlign'] });
});
