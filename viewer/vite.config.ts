import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The report must open from a static server and from file://. Browsers block
 * module scripts on file://, so the build emits one classic script.
 */
export default defineConfig({
  root: resolve(import.meta.dirname),
  base: './',
  plugins: [
    react(),
    {
      name: 'classic-script',
      enforce: 'post',
      transformIndexHtml: (html) =>
        html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script defer src="$1"></script>'),
    },
  ],
  server: { port: 5175, strictPort: false },
  build: {
    outDir: resolve(import.meta.dirname, '../dist/viewer'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: false,
    rolldownOptions: { output: { format: 'iife', entryFileNames: 'assets/viewer.js', assetFileNames: 'assets/[name][extname]' } },
  },
});
