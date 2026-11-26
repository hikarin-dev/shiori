// start.js — the one page's first script, run in its head before anything is drawn: a classic script
// served as the file it is (the page's policy allows no inline script; built as dist/start.js, with
// the data the build writes on the START line: build/start.mjs).
//
// It reads the address as the entry (src/entry.ts) will, and does what has to be done before the
// first paint:
//   - the common header's frame, which index.html holds, shows on the routes that have that header
//     (html[data-frame="header"]); never where it says "Not found."; on the reader's, which has a frame
//     of its own and no header, the reader's ground (html[data-frame="reader"]) until the reader draws
//     its frame, as the reader's own page showed it from its first paint;
//   - the shiori-app meta, on the app's own pages, so the page says which it is from its first parse,
//     as 1.3's pages did in their markup (what recognises the app by it may look once, as a page
//     loads); src/frame.tsx keeps that element and changes it with the page;
//   - every module the page will run to draw the address is asked for at once (<link rel=modulepreload>),
//     so they arrive together instead of in waves; and the UI font's faces (app/font-init.js declares
//     them) right after the first frame, so they are there when the app draws its text, which
//     otherwise would ask for them only once drawn, and move when they came (by the font API: preload
//     links for them let Chromium hold the first paint until they arrive);
//   - the bundle's entry is started, first.
(function () {
  const START = null;   // written by the build (build/start.mjs)
  const html = document.documentElement;
  const root = new URL('.', location.href).pathname;
  let segment = location.pathname.slice(root.length);
  // Opened by its own file name: 404.html may have kept the address it was asked for (src/entry.ts
  // puts it back, and takes it away).
  if (segment === START.appPage) {
    let kept = null;
    try { kept = sessionStorage.getItem('shiori-route'); } catch {}
    const asked = kept == null ? null : kept.split(/[?#]/)[0];
    segment = asked != null && Object.hasOwn(START.pages, asked) ? asked : '';
  }
  const route = START.routes[segment];
  if (route && route.header) html.dataset.frame = 'header';
  else if (route && route.meta === 'reader') html.dataset.frame = 'reader';

  const add = (tag, attributes) => {
    const el = document.createElement(tag);
    for (const name in attributes) el.setAttribute(name, attributes[name]);
    document.head.append(el);
  };
  if (route && route.meta) add('meta', { name: 'shiori-app', content: route.meta });
  // The entry first: asked for after the list, it waited behind every module of it (a browser opens a
  // few connections to a host at a time), and nothing runs before it.
  if (START.entry) add('script', { type: 'module', src: root + START.entry });
  for (const path of START.start.concat(route ? route.preload : [])) {
    if (path.endsWith('.css')) add('link', { rel: 'preload', as: 'style', href: root + path });
    else add('link', { rel: 'modulepreload', href: root + path });
  }
  // Once the first frame is out: Chromium holds a first paint while a face is on its way, even one
  // the paint has no text in (measured: 40 ms against 84 ms, and they still come long before the
  // app draws).
  requestAnimationFrame(() => setTimeout(() => {
    for (const face of document.fonts) if (face.family.replace(/["']/g, '') === 'JetBrains Mono') face.load().catch(() => {});
  }));
})();
