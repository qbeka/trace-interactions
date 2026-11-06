import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(root, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Installed alongside the CLI, not copied into it.
  external: ['playwright', 'zod'],
  logLevel: 'warning',
});
