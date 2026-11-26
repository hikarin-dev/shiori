// reader-names.test.mjs — what the reader's page sets on <html> before it draws (app/reader-init.js, a
// classic script in its head) and what the one page's route sets before it draws the reader's frame
// (src/routes/reader/names.ts) are the same: the same names from the same settings, written back the
// same way, for every combination of those settings, and nothing when the storage can't be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { READER_PAGE_NAMES, setReaderNames, takeReaderNames } from '../../src/routes/reader/names.ts';

const script = readFileSync(new URL('../reader-init.js', import.meta.url), 'utf8');

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

function viaPage(values, broken) {
  const html = element(), writes = [];
  vm.runInNewContext(script, { document: { documentElement: html }, localStorage: storage({ ...values }, writes, broken) });
  return result(html, writes);
}
function viaRoute(values, broken) {
  const html = element(), writes = [];
  setReaderNames(html, storage({ ...values }, writes, broken));
  return result(html, writes);
}

test('the route sets on <html> what the reader\'s page sets before it draws, for every combination of the settings read', () => {
  let cases = 0;
  for (const nav of [undefined, 'top', 'side', 'other'])
    for (const mode of [undefined, '"single"'])
      for (const sidePin of [undefined, '0', '1'])
        for (const pin of [undefined, '0', '1'])
          for (const place of [undefined, 'top-center', 'left-end', 'bottom', 'right-start', 'middle-somewhere', '']) {
            const values = Object.fromEntries(Object.entries({ 'shiori-reader-nav': nav, 'shiori:readerMode': mode, 'shiori-reader-side-pin': sidePin,
              'shiori-reader-pin': pin, 'shiori-reader-nav-place': place }).filter(([, v]) => v !== undefined));
            assert.deepEqual(viaRoute(values), viaPage(values), JSON.stringify(values));
            cases++;
          }
  assert.equal(cases, 4 * 2 * 3 * 3 * 7);
  // Unreadable storage: neither sets anything.
  assert.deepEqual(viaRoute({}, true), viaPage({}, true));
  assert.deepEqual(viaPage({}, true), { classes: [], data: {}, writes: [] });
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
