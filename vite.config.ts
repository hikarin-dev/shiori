import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ROOT, servedModules, contentSecurityPolicy, firstPaint, siteFiles, devPages, routeDependencies } from './build/plugins.ts';

// What every page runs as it starts is one chunk ('start'). Left to itself the bundler splits it by
// which of the lazily loaded parts also use each piece, so a page's start fetched more files the more
// lazy parts the app had (6c's added six: the last of them came about 7 ms later on a hard load of the
// library), though every one of them loads at the start anyway. What the entry imports before it knows
// the page is to be drawn (the address's check, which may hand another page's address on) is a chunk
// of its own ('entry'), so a page handed on fetches none of the rest; what the entry imports itself
// stays a chunk of its own each, so the entry runs them in its order (the notice store first, then the
// start-up modules and the app together). Worked out once a build, from the module graph.
const ENTRY = path.join(ROOT, 'src', 'main.tsx').split(path.sep).join('/');
type Info = { importedIds: readonly string[]; dynamicallyImportedIds: readonly string[] } | null;
let parts: { early: Set<string>; start: Set<string> } | null = null;
function startChunk(id: string, info: (id: string) => Info) {
  if (!parts) {
    // (The bundler writes a module's id with the drive's letter as it found it.)
    const entry = [ENTRY, ENTRY.replace(/^[a-z]:/, (d) => d.toUpperCase())].find((m) => info(m));
    const own = entry ? info(entry)!.importedIds : [], lazy = entry ? info(entry)!.dynamicallyImportedIds : [];
    const reach = (from: readonly string[]) => {
      const seen = new Set<string>(), queue = [...from];
      while (queue.length) {
        const next = queue.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(info(next)?.importedIds ?? []));
      }
      return seen;
    };
    const early = reach(own);
    parts = { early, start: new Set([...reach(lazy.flatMap((m) => info(m)?.importedIds ?? []))].filter((m) => !early.has(m) && !lazy.includes(m))) };
  }
  return parts.early.has(id) ? 'entry' : parts.start.has(id) ? 'start' : null;
}

export default defineConfig({
  // Relative, so the built site works at a domain's root and under a folder alike.
  base: './',
  publicDir: false,
  plugins: [servedModules(), react(), tailwindcss(), contentSecurityPolicy(), firstPaint(), siteFiles(), devPages()],
  resolve: {
    alias: {
      '@': path.join(ROOT, 'src'),
      '@lib': path.join(ROOT, 'app/js'),
    },
  },
  // The repo's root is the site's root, and it also holds folders that are no part of the site.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    watch: { ignored: ['**/manga-image-translator/**', '**/desktop/**', '**/extension/**', '**/plans/**', '**/graphify-out/**', '**/dist/**'] },
  },
  build: {
    outDir: 'dist', emptyOutDir: true,
    // (The start's one chunk is over the 500 kB the bundler warns of, by design: it was that much in
    // several files before.)
    chunkSizeWarningLimit: 1024,
    // A route's chunk comes with the app's served modules it runs (build/plugins.ts).
    modulePreload: { resolveDependencies: routeDependencies },
    rolldownOptions: { output: { codeSplitting: { groups: [
      { debugName: 'entry', priority: 2, name: (id, ctx) => (startChunk(id, (m) => ctx.getModuleInfo(m)) === 'entry' ? 'entry' : null) },
      { debugName: 'start', priority: 1, name: (id, ctx) => (startChunk(id, (m) => ctx.getModuleInfo(m)) === 'start' ? 'start' : null) },
    ] } } },
  },
});
