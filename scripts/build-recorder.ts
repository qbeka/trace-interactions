import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [resolve(root, 'src/recorder/recorder.ts')],
  outfile: resolve(root, 'dist/recorder.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: false,
  logLevel: 'warning',
});
