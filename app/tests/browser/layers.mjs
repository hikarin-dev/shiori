// layers.mjs — what the compositor has on layers of their own while something animates (rule 29).
//
// Text on a layer of its own is smoothed another way than text in the page's layer, so an animation
// that lifts the page's words onto layers changes their look for its time, which is seen. The cause
// met: an animated transform (rotate, scale, translate) is the compositor's, and while it runs the
// browser cannot tell what it will come to cover, so every positioned thing painted after it gets a
// layer (reason "Overlap"). Read from the browser's own layer tree (the protocol's LayerTree), with
// animations slowed fifty times so that "mid-way" is a moment that can be met.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function layerWatch(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.enable');
  await cdp.send('Animation.enable');
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
  await cdp.send('LayerTree.enable');
  const reasons = async (l) => (await cdp.send('LayerTree.compositingReasons', { layerId: l.layerId }).catch(() => ({}))).compositingReasonIds ?? [];

  // The layers that draw, as they are now: each its element (name, id, slot or first class) and the
  // browser's reasons for it. The browser tells of the tree only when it changes, so it is made to: a
  // pixel in the window's corner is put on a layer and taken away, and the tree told after is read.
  async function read() {
    await page.evaluate(() => new Promise((done) => {
      const dot = document.createElement('div');
      dot.id = 'layerWatchDot';
      dot.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;will-change:transform;pointer-events:none';
      document.documentElement.append(dot);
      requestAnimationFrame(() => requestAnimationFrame(() => { dot.remove(); requestAnimationFrame(() => requestAnimationFrame(done)); }));
    }));
    for (let i = 0; ; i++) {
      await sleep(60);
      const rows = [];
      let stale = false;
      for (const l of layers) {
        if (!l.drawsContent) continue;
        const why = await reasons(l);
        let who = '';
        if (l.backendNodeId) {
          const d = await cdp.send('DOM.describeNode', { backendNodeId: l.backendNodeId }).catch(() => null);
          const a = d?.node?.attributes ?? [], at = (n) => { const j = a.indexOf(n); return j < 0 ? '' : a[j + 1]; };
          if (at('id') === 'layerWatchDot' || (!d && why.includes('WillChangeTransform'))) { stale = true; break; }
          if (!d) continue;
          const id = at('id');
          who = `${d.node.nodeName.toLowerCase()}${id && !/^base-ui|^_r_|^:r/.test(id) ? `#${id}` : ''}${at('data-slot') ? `[${at('data-slot')}]` : at('class') ? `.${at('class').split(/\s+/)[0]}` : ''}`;
        }
        rows.push({ who, why });
      }
      if (!stale || i > 30) return rows;
    }
  }
  const line = (r) => `${r.who} [${r.why.join(', ')}]`;

  return {
    read,
    // What `act` starts, met mid-way: the layers there for an animation (the compositor running one),
    // and the layers gained over the ones at rest. Then the animation is let run out.
    async during(act, { settle = 600 } = {}) {
      const rest = (await read()).map(line);
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.02 });
      try {
        await act();
        await sleep(1500);   // some 30 ms into it
        const mid = await read();
        const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.transitionProperty ?? a.animationName ?? ''));
        const left = [...rest];
        const gained = mid.map(line).filter((l) => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; });
        return { animated: mid.filter((r) => r.why.some((w) => /^Active\w*Animation$/.test(w))).map(line), gained, running: [...new Set(running)].sort() };
      } finally {
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
        await sleep(settle);
      }
    },
    close: () => cdp.detach().catch(() => {}),
  };
}

// Every element of the page that eases a transform (transform, rotate, scale, translate) by a
// transition: each such motion is the compositor's while it runs. `but`: a selector whose elements,
// and what is in them, are left out.
export const easedTransforms = (page, but = null) => page.evaluate((but) => {
  const out = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (but && el.closest(but)) continue;
    const s = getComputedStyle(el);
    const props = s.transitionProperty.split(',').map((p) => p.trim()), times = s.transitionDuration.split(',').map((d) => parseFloat(d));
    props.forEach((p, i) => {
      if (!['all', 'transform', 'rotate', 'scale', 'translate'].includes(p) || !(times[i % times.length] > 0)) return;
      out.add(`${el.localName}${el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : ''}: ${p}`);
    });
  }
  return [...out].sort();
}, but);
