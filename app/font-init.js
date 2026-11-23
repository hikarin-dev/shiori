// Injects the UI font faces before first paint, from the app's own files (app/fonts/) — the
// app makes no third-party requests. Weights match the previous hosted set: 400/600/700.
// URLs are resolved from this file's own address, so they are right whatever base the page has.
(function () {
  try { localStorage.removeItem('shiori-font'); } catch {}   // legacy remote-CSS cache
  const fonts = new URL('fonts/', document.currentScript.src);
  const style = document.createElement('style');
  style.id = 'jb-mono-local';
  style.textContent = [['Regular', 400], ['SemiBold', 600], ['Bold', 700]].map(([file, weight]) =>
    `@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:${weight};font-display:swap;` +
    `src:url('${new URL(`JetBrainsMono-${file}.woff2`, fonts)}') format('woff2');}`
  ).join('\n');
  document.head.appendChild(style);
})();
