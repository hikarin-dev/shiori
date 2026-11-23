// main.tsx — the one page's script. The entry decides first (entry.ts); only when this page is the
// one to draw does the app start: what every page starts with (boot-core.js: the services, the
// worker, the library's upkeep), then the app itself.
import { enter } from './entry';

if (await enter()) {
  await import('@lib/boot-core.js');
  const { mount } = await import('./app');
  mount(document.getElementById('root')!);
}
