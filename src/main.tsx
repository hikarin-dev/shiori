// main.tsx — the one page's script. The entry decides first (entry.ts); the app is loaded only
// when this page is the one to draw.
import { enter } from './entry';

if (await enter()) {
  const { mount } = await import('./app');
  mount(document.getElementById('root')!);
}
