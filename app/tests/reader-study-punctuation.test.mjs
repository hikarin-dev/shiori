import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
globalThis.document = {
  addEventListener() {},
  createElement(tag) {
    return { tag, children: [], style: { setProperty(name, value) { this[name] = value; } },
      classList: { add() {} }, appendChild(child) { this.children.push(child); } };
  },
  createTextNode(text) { return { textContent: text }; },
};
const { _buildStudySrc, _buildStudyText } = await import('../js/reader-study.js');
const box = { x: 0, y: 0, w: 0.2, h: 0.3 };
const textOf = el => el.textContent ?? el.children.map(textOf).join('');
const findClass = (el, name) => [
  ...(el.className === name ? [el] : []),
  ...(el.children || []).flatMap(child => findClass(child, name)),
];
const source = (src, { style, ...extra } = {}, opts) => _buildStudySrc(
  { src, box, style: { dir: 'v', srcFontSize: 32, ...style }, ...extra }, true, { w: 1000 }, opts);

for (const [renderer, style] of Object.entries({
  shiori: { paintPolicy: 'shiori' },
  hybrid: { paintPolicy: 'manga2eng' },
  manga2eng: { caps: true },
})) {
  test(`${renderer}: source ellipses and emphasis use compact vertical typography`, () => {
    const src = '思えない．．．考えられない！！！';
    const bubble = { src, box, style: { ...style, dir: 'v' } };
    const el = _buildStudySrc(bubble, true, { w: 1000 });
    assert.equal(textOf(el), '思えない•••考えられない!!!');
    assert.deepEqual(findClass(el, 'study-combined').map(textOf), ['!!!']);
    assert.equal(bubble.src, src, 'display formatting must not rewrite saved OCR');
  });
}

test('arbitrary dot runs use one consistent dot with no two- or three-dot grouping', () => {
  for (const dot of ['.', '．', '・', '･', '·']) {
    for (let count = 2; count <= 25; count++) {
      const el = source(`前${dot.repeat(count)}後`);
      assert.equal(textOf(el), `前${'•'.repeat(count)}後`);
      const runs = findClass(el, 'study-ellipsis');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].children.length, count);
      assert.ok(runs[0].children.every(cell => textOf(cell) === '•'));
    }
  }
});

test('native and mixed ellipsis forms keep the exact number of dots', () => {
  for (const [input, count] of [
    ['‥', 2], ['…', 3], ['⋯', 3], ['⋮', 3], ['︙', 3], ['……', 6],
    ['…‥', 5], ['…・', 4], ['‥…．', 6], ['.．・', 3], ['…‥⋯⋮︙', 14],
  ]) {
    const el = source(`前${input}後`);
    assert.equal(textOf(el), `前${'•'.repeat(count)}後`);
    assert.equal(findClass(el, 'study-ellipsis').length, 1);
  }
});

test('OCR colons adjoining an ellipsis continue the same round dot run', () => {
  for (const [input, count] of [
    ['．．．：', 5], ['…：', 5], ['…:', 5], ['：…', 5], [':…', 5],
    ['…：…', 8], ['…：：', 7], ['‥：', 4], ['・：', 3],
  ]) {
    const el = source(`前${input}後`);
    assert.equal(textOf(el), `前${'•'.repeat(count)}後`);
    assert.equal(findClass(el, 'study-ellipsis').length, 1);
  }
  const el = source('すり替えた．．．：？', {
    furi: [[['すり', ''], ['替', 'か'], ['えた', ''], ['．．．', ''], ['：', ''], ['？', '']]],
  }, { furi: true, lang: 'ja' });
  assert.equal(textOf(el), 'すり替かえた•••••?');
  assert.deepEqual(findClass(el, 'study-ellipsis').map(textOf), ['•••••']);
});

test('emphasis uses narrow upright glyphs, including mixed and precombined punctuation', () => {
  for (const [marks, expected] of [
    ['!', '!'], ['?', '?'], ['!!', '!!'], ['!!!', '!!!'], ['!?', '!?'], ['?!', '?!'],
    ['??', '??'], ['???', '???'], ['！！', '!!'], ['！！！', '!!!'], ['！？', '!?'],
    ['‼', '!!'], ['⁇', '??'], ['⁈', '?!'], ['⁉', '!?'],
  ]) {
    const el = source(`前${marks}後`);
    assert.equal(textOf(el), `前${expected}後`);
    assert.deepEqual(findClass(el, 'study-combined').map(textOf), [expected]);
    assert.equal(findClass(el, 'study-combined')[0].style.textCombineUpright, 'all',
      'the group must stay upright even while an older reader stylesheet is cached');
  }
});

test('punctuation split into plain furigana segments still forms one run', () => {
  const el = source('思えない．．．！！！\n考える！！', {
    furi: [
      [['思', 'おも'], ['えない', ''], ['．', ''], ['．．', ''], ['！', ''], ['！！', '']],
      [['考', 'かんが'], ['える！！', '']],
    ],
  }, { furi: true, lang: 'ja' });
  const lines = findClass(el, 'study-src-line');
  assert.equal(lines.length, 2);
  assert.deepEqual(findClass(el, 'study-combined').map(textOf), ['!!!', '!!']);
  assert.equal(textOf(lines[0]), '思おもえない•••!!!');
  assert.equal(textOf(lines[1]), '考かんがえる!!');
});

test('single dots, decimals, separators and native punctuation retain their text', () => {
  const src = '3.14・名前．文。「あー」〜 12:30 １２：３０ 注意：次 :: ：：';
  assert.equal(textOf(source(src)), src);
  assert.equal(findClass(source(src), 'study-combined').length, 0);
});

test('punctuation does not combine across an OCR line break', () => {
  const el = source('前！\n！後');
  assert.deepEqual(findClass(el, 'study-combined').map(textOf), ['!', '!']);
  assert.deepEqual(findClass(source('前・・\n・・・後'), 'study-ellipsis').map(textOf), ['••', '•••']);
});

test('horizontal source text and translations keep their existing typography', () => {
  const src = 'Wait．．．！！！';
  const el = source(src, { style: { dir: 'h' } });
  assert.equal(textOf(el), src);
  assert.equal(findClass(el, 'study-combined').length, 0);
  assert.equal(textOf(_buildStudyText({ tr: src, box }, true, 1000)), src);
});

test('Latin words stay sideways while isolated letters, numbers and symbols stay upright', () => {
  const el = source('あAえHelloう12%♡！！');
  assert.equal(textOf(el), 'あAえHelloう12%♡!!');
  assert.deepEqual(findClass(el, 'study-upright').map(textOf), ['A', '12%♡']);
});
