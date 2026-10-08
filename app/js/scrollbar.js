import { OverlayScrollbars, ClickScrollPlugin } from '../../vendor/overlayscrollbars/overlayscrollbars.mjs';

// Native scrolling is the default. Only the experimental mode installs overlay controls.
const root = document.documentElement;
const chromium = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);
export const customScrollbarAvailable = chromium;
let uninstall = null, requested = null;

export function applyScrollbarPreference() {
  if (!customScrollbarAvailable) return;
  let enabled = false;
  try { enabled = localStorage.getItem('shiori:customScrollbar') === 'true'; } catch {}
  if (enabled === requested) return;
  requested = enabled;
  uninstall?.();
  uninstall = null;
  root.classList.toggle('custom-scrollbars', enabled);
  if (enabled) uninstall = installCustomScrollbars();
  root.classList.toggle('custom-scrollbars', Boolean(uninstall));
  window.dispatchEvent(new Event('shiori-scrollbar-change'));
}

if (chromium) {
  root.classList.add('chromium-scrollbars');
  applyScrollbarPreference();
  window.addEventListener('storage', (e) => {
    if (e.key === 'shiori:customScrollbar' || e.key === null) applyScrollbarPreference();
  });
}

// A shadow tree measures native controls independently of the slim inner-scrollbar styling.
// Keep the probe outside the body so replacing page content does not remove it.
const pageProbe = document.createElement('div');
pageProbe.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
const pageProbeBox = pageProbe.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
pageProbeBox.style.cssText = 'width:100px;height:100px;overflow:scroll';
const pageProbeContent = pageProbeBox.appendChild(document.createElement('div'));
pageProbeContent.style.cssText = 'width:100%;height:200px';
root.append(pageProbe);

function syncPageScrollbarSpace() {
  pageProbeBox.style.scrollbarWidth = getComputedStyle(root).scrollbarWidth;
  const nativeWidth = pageProbeBox.getBoundingClientRect().width - pageProbeContent.getBoundingClientRect().width;
  const custom = root.classList.contains('custom-scrollbars');
  const occupied = Math.max(0, window.innerWidth - root.clientWidth);
  const width = custom ? 0 : Math.max(occupied, nativeWidth);
  for (const [name, value] of [
    ['--page-scrollbar-width', width],
    ['--page-scrollbar-gap', Math.max(0, width - occupied)],
  ]) {
    const px = `${value}px`;
    if (root.style.getPropertyValue(name) !== px) root.style.setProperty(name, px);
  }
}
// ResizeObserver runs before paint when content makes the page scrollbar appear or disappear.
new ResizeObserver(syncPageScrollbarSpace).observe(root);
window.addEventListener('resize', syncPageScrollbarSpace);
matchMedia('(forced-colors: active)').addEventListener('change', syncPageScrollbarSpace);
window.addEventListener('shiori-scrollbar-change', () => {
  syncPageScrollbarSpace();
  // A preference change and a view change can restore the same root size within one frame.
  requestAnimationFrame(syncPageScrollbarSpace);
});
syncPageScrollbarSpace();

function installCustomScrollbars() {
  const bars = new Map();
  let unit = 1, frame = 0, stopArrow = () => {};
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
  probe.attachShadow({ mode: 'open' }).innerHTML =
    '<div style="width:100px;height:100px;overflow:scroll"><div style="width:100%;height:200px"></div></div>';
  document.body.append(probe);
  function measure() {
    const box = probe.shadowRoot.firstElementChild;
    const gutter = box.getBoundingClientRect().width - box.firstElementChild.getBoundingClientRect().width;
    unit = gutter / 15;
    root.style.setProperty('--scrollbar-unit', `${unit}px`);
    return gutter;
  }
  if (!CSS.supports('selector(::-webkit-scrollbar)') || matchMedia('(forced-colors: active), (pointer: coarse)').matches || !measure()) {
    probe.remove();
    root.style.removeProperty('--scrollbar-unit');
    return;
  }
  OverlayScrollbars.plugin(ClickScrollPlugin);
  const events = new AbortController();
  const { signal } = events;

  function add(el) {
    if (bars.has(el) || el.closest('.os-scrollbar, .os-size-observer, .os-trinsic-observer') || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const page = el === root, style = getComputedStyle(el);
    if (!page && (style.scrollbarWidth === 'none' || !/auto|scroll/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1)) return;
    if (!page && style.display !== 'block' && !(style.display === 'flex' && style.flexDirection === 'column')) return;
    el.classList.add('overlay-scroll-target');
    const target = page ? document.body : el;
    // Keep the existing scroll owner and content layout, including document scrolling and pickers.
    const instance = OverlayScrollbars({ target, elements: { viewport: target }, scrollbars: { slot: el } }, {
      scrollbars: { theme: null, autoHide: 'never', clickScroll: true },
    });
    const { scrollbar: host, track, handle: thumb } = instance.elements().scrollbarVertical;
    host.classList.add('scrollbar-host');
    if (page) host.classList.add('page-scrollbar');
    else if (style.display === 'flex') host.style.marginBottom = `-${parseFloat(style.rowGap) || 0}px`;
    host.setAttribute('aria-hidden', 'true');
    const overlay = document.createElement('div');
    overlay.className = 'scrollbar-overlay';
    overlay.hidden = true;
    overlay.innerHTML = '<span class="scrollbar-arrow up"></span><span class="scrollbar-arrow down"></span>';
    overlay.append(track);
    host.append(overlay);
    el.prepend(host);
    thumb.classList.add('scrollbar-thumb');
    const bar = { el, host, overlay, instance, page, timer: 0 };
    bars.set(el, bar);

    // Appearance only: retain Firefox's 2.5s idle delay and CSS fade, independent of scroll input.
    const reveal = () => {
      if (overlay.classList.contains('held')) return;
      overlay.classList.add('visible');
      clearTimeout(bar.timer);
      bar.timer = setTimeout(() => overlay.classList.remove('visible'), 2500);
    };
    bar.reveal = reveal;
    overlay.addEventListener('pointerenter', reveal);
    overlay.addEventListener('pointerleave', reveal);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      reveal();
      overlay.classList.add('held');
      overlay.classList.toggle('dragging', thumb.contains(event.target));
    });
    host.addEventListener('lostpointercapture', () => {
      overlay.classList.remove('held', 'dragging');
      reveal();
    });
    // OverlayScrollbars supplies dragging, capture, wheel handling and track paging unchanged.
    // It has no arrow buttons; these retain our existing step/repeat behavior.
    for (const arrow of overlay.querySelectorAll('.scrollbar-arrow')) {
      arrow.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        stopArrow();
        const direction = arrow.classList.contains('up') ? -1 : 1;
        let animation = 0, lastTime = 0, x = event.clientX, y = event.clientY;
        const move = (e) => { x = e.clientX; y = e.clientY; };
        const interrupt = () => stopArrow();
        arrow.setPointerCapture(event.pointerId);
        arrow.addEventListener('pointermove', move);
        arrow.addEventListener('lostpointercapture', interrupt);
        document.addEventListener('wheel', interrupt, { capture: true, passive: true });
        el.scrollBy({ top: direction * 40, behavior: 'instant' });
        const repeat = (now) => {
          if (lastTime && document.elementFromPoint(x, y) === arrow) {
            el.scrollBy({ top: direction * Math.min(now - lastTime, 50) * .6, behavior: 'instant' });
          }
          lastTime = now;
          animation = requestAnimationFrame(repeat);
        };
        animation = requestAnimationFrame(repeat);
        stopArrow = () => {
          stopArrow = () => {};
          cancelAnimationFrame(animation);
          arrow.removeEventListener('pointermove', move);
          arrow.removeEventListener('lostpointercapture', interrupt);
          document.removeEventListener('wheel', interrupt, true);
          if (arrow.hasPointerCapture(event.pointerId)) arrow.releasePointerCapture(event.pointerId);
          overlay.classList.remove('held', 'dragging');
          reveal();
        };
      });
    }
    instance.on('scroll', reveal);
    instance.on('updated', () => updateAppearance(bar));
    updateAppearance(bar);
  }

  function updateAppearance(bar) {
    const { el, overlay, page } = bar;
    const style = getComputedStyle(el);
    const height = el.clientHeight;
    const wasHidden = overlay.hidden;
    overlay.hidden = el.scrollHeight <= height + 1 || !el.getClientRects().length || /hidden|clip/.test(style.overflowY);
    if (overlay.hidden) return;
    if (wasHidden) bar.reveal();
    overlay.style.top = page ? '0px' : `${-parseFloat(style.paddingTop)}px`;
    overlay.style.right = page ? '0px' : `${-parseFloat(style.paddingRight)}px`;
    overlay.style.height = `${height}px`;
  }
  function remove(bar) {
    clearTimeout(bar.timer);
    bar.instance.destroy();
    bar.el.classList.remove('overlay-scroll-target');
    bars.delete(bar.el);
  }
  function scan() {
    for (const bar of bars.values()) {
      if (!bar.el.isConnected || !bar.host.isConnected) remove(bar);
    }
    add(root);
    for (const el of document.body.querySelectorAll('*')) add(el);
    for (const bar of bars.values()) updateAppearance(bar);
  }
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; scan(); });
  }
  const mutations = new MutationObserver((records) => {
    if (records.every((r) => r.target.closest?.('.os-scrollbar, .os-size-observer, .os-trinsic-observer') ||
        r.type === 'attributes' && bars.has(r.target))) return;
    schedule();
  });
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open'], characterData: true });
  document.addEventListener('mousemove', (e) => {
    for (let el = e.target; el; el = el.parentElement) bars.get(el)?.reveal();
  }, { capture: true, passive: true, signal });
  const release = () => {
    stopArrow();
    for (const bar of bars.values()) {
      if (!bar.overlay.classList.contains('held')) continue;
      bar.overlay.classList.remove('held', 'dragging');
      bar.reveal();
    }
  };
  document.addEventListener('keydown', () => stopArrow(), { capture: true, signal });
  document.addEventListener('pointerup', release, { capture: true, signal });
  document.addEventListener('pointercancel', release, { capture: true, signal });
  window.addEventListener('blur', release, { signal });
  window.addEventListener('resize', () => { measure(); schedule(); }, { signal });
  document.addEventListener('load', schedule, { capture: true, signal });
  add(root);
  schedule();
  return () => {
    stopArrow();
    events.abort();
    mutations.disconnect();
    cancelAnimationFrame(frame);
    for (const bar of bars.values()) remove(bar);
    probe.remove();
    root.style.removeProperty('--scrollbar-unit');
  };
}
