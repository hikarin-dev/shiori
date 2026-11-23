import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ROOT, servedModules, contentSecurityPolicy, copiedFiles } from './build/plugins.ts';

export default defineConfig({
  // Relative, so the built site works at a domain's root and under a folder alike.
  base: './',
  publicDir: false,
  plugins: [servedModules(), react(), tailwindcss(), contentSecurityPolicy(), copiedFiles()],
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
  build: { outDir: 'dist', emptyOutDir: true },
});
