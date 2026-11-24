// main.tsx — the one page's script, started by start.js. The entry decides first (entry.ts); only when
// this page is the one to draw does the app start: what every page starts with (boot-core.js: the
// services, the worker, the library's upkeep), then the app itself. (start.js has asked for all of it
// at once already.)
//
// The stylesheet is imported here, so the built page links it in its head: the first paint, the
// header's frame with it, waits for it, as every page's first paint waited for its stylesheets.
import './index.css';
import { enter } from './entry';

if (await enter()) {
  // notice.js's host first, so a notice the start-up raises before the app has drawn waits for it.
  await import('./lib/notice-store');
  // The start-up and the app's own code, asked for together: the app's code (React and the routes)
  // is evaluated while the start-up's many modules are still arriving, instead of after them. It
  // draws nothing until both are in.
  const [, { mount }] = await Promise.all([import('@lib/boot-core.js'), import('./app')]);
  // start.js starts this script from the head: the body may still be on its way.
  if (document.readyState === 'loading') await new Promise((ready) => document.addEventListener('DOMContentLoaded', ready, { once: true }));
  mount(document.getElementById('root')!);
}
