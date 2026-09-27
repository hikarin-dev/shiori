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
  createElementNS(ns, tag) {
    return { ns, tag, children: [], attrs: {}, style: {}, setAttribute(name, value) { this.attrs[name] = value; },
      appendChild(child) { this.children.push(child); } };
  },
};
const { _buildStudyText, _buildStudySrc, _buildBubbleShape, _sharedShapes, _positionBubbleIndicator } =
  await import('../js/reader-study.js');
const box = { x: 0, y: 0, w: 0.2, h: 0.3 };
const builders = {
  translation: style => _buildStudyText({ tr: 'Hello world!', box, style }, true, 1000),
  source: style => _buildStudySrc({ src: 'Original text', box, style }, true, { w: 1000 }),
};

for (const [surface, build] of Object.entries(builders)) {
  test(`${surface}: saved black text gets a white halo even with no recorded outline`, () => {
    for (const fg of [[0, 0, 0], [16, 20, 24], [32, 32, 32]]) {
      for (const strokeWidth of [undefined, 0]) {
        const el = build({ fg, bg: [...fg], fontSize: 24, strokeWidth });
        assert.equal(el.style.color, `rgb(${fg.join(',')})`);
        assert.equal(el.style['--outline-w'], 'calc(3px * var(--pgscale, 1))');
        assert.equal(el.style['--outline-c'], 'rgb(255,255,255)');
      }
    }
  });

  test(`${surface}: unoutlined white and colored text stay unchanged`, () => {
    for (const color of [[255, 255, 255], [30, 100, 180], [33, 33, 33]]) {
      const el = build({ fg: color, bg: [...color], fontSize: 24 });
      assert.equal(el.style.color, `rgb(${color.join(',')})`);
      assert.equal(el.style['--outline-w'], undefined);
    }
  });

  test(`${surface}: the explicit disable setting wins over the default halo`, () => {
    const el = build({ fg: [0, 0, 0], bg: [255, 255, 255], fontSize: 24, strokeWidth: 0, borderDisabled: true });
    assert.equal(el.style['--outline-w'], undefined);
  });

  test(`${surface}: measured outlines scale in page pixels`, () => {
    const el = build({ fg: [255, 255, 255], bg: [0, 0, 0], fontSize: 30, strokeWidth: 1.5 });
    assert.equal(el.style['--outline-w'], 'calc(3px * var(--pgscale, 1))');
    assert.equal(el.style['--outline-c'], 'rgb(0,0,0)');
  });

  test(`${surface}: historical colored outlines retain their fallback width`, () => {
    const el = build({ fg: [30, 100, 180], bg: [255, 255, 255], fontSize: 24 });
    assert.equal(el.style['--outline-w'], '0.16em');
    assert.equal(el.style['--outline-c'], 'rgb(255,255,255)');
  });

  test(`${surface}: black text replaces inferred outline colors with white`, () => {
    const el = build({ fg: [0, 0, 0], bg: [30, 100, 180], fontSize: 24, strokeWidth: 3 });
    assert.equal(el.style['--outline-w'], 'calc(6px * var(--pgscale, 1))');
    assert.equal(el.style['--outline-c'], 'rgb(255,255,255)');
  });

  test(`${surface}: an explicitly configured outline color is preserved`, () => {
    const el = build({ fg: [0, 0, 0], bg: [30, 100, 180], fontSize: 24, strokeWidth: 2, strokeColorExplicit: true });
    assert.equal(el.style['--outline-w'], 'calc(4px * var(--pgscale, 1))');
    assert.equal(el.style['--outline-c'], 'rgb(30,100,180)');
  });

  test(`${surface}: hybrid retains manga2eng paint without the Shiori halo minimum`, () => {
    const style = { fg: [0, 0, 0], bg: [30, 100, 180], fontSize: 24, paintPolicy: 'manga2eng' };
    for (const strokeWidth of [1, 2, 4]) {
      const el = build({ ...style, strokeWidth });
      assert.equal(el.style['--outline-w'], `calc(${2 * strokeWidth}px * var(--pgscale, 1))`);
      assert.equal(el.style['--outline-c'], 'rgb(30,100,180)');
    }
    assert.equal(build({ ...style, strokeWidth: 0 }).style['--outline-w'], undefined);
  });
}

test('a renderer shape becomes a page-fraction outline with a halo under the line', () => {
  assert.equal(_buildBubbleShape({ box }), null, 'records without a shape keep their region');
  const svg = _buildBubbleShape({ box, shape: [[0.1, 0.2], [0.5, 0.2], [0.3, 0.6]] });
  assert.equal(svg.attrs.viewBox, '0 0 1 1');
  assert.equal(svg.attrs.preserveAspectRatio, 'none');
  assert.deepEqual(svg.children.map(p => [p.attrs.class, p.attrs.points]),
    [['bubble-shape-halo', '0.1,0.2 0.5,0.2 0.3,0.6'], ['bubble-shape-line', '0.1,0.2 0.5,0.2 0.3,0.6']]);
});

test('the shape keeps spanning the page wherever its region box moves', () => {
  const shape = { style: {} };
  const el = { style: {}, querySelector: () => shape };
  _positionBubbleIndicator(el, { x: 0.25, y: 0.1, w: 0.5, h: 0.2 });
  assert.deepEqual([el.style.left, el.style.top, el.style.width, el.style.height], ['25%', '10%', '50%', '20%']);
  assert.deepEqual([shape.style.left, shape.style.top, shape.style.width, shape.style.height],
    ['-50%', '-50%', '200%', '500%']);
});

test('texts sharing one balloon are the only ones whose shape is shared', () => {
  const balloon = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]];
  const bubbles = [{ shape: balloon }, { shape: balloon.map(p => [...p]) }, { shape: [[0, 0], [0.1, 0], [0, 0.1]] }, {}];
  assert.deepEqual([...(_sharedShapes(bubbles))], bubbles.slice(0, 2));
});

test('text on a bubble with a shape is marked so the shape takes its pointer', () => {
  const shape = [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]];
  const classes = el => el.className.split(' ');
  assert.ok(classes(_buildStudyText({ tr: 'Hi', box, shape }, true, 1000)).includes('on-shape'));
  assert.ok(classes(_buildStudySrc({ src: 'あ', box, shape }, true, { w: 1000 })).includes('on-shape'));
  assert.ok(!classes(_buildStudyText({ tr: 'Hi', box }, true, 1000)).includes('on-shape'));
  assert.ok(!classes(_buildStudySrc({ src: 'あ', box }, true, { w: 1000 })).includes('on-shape'));
});
