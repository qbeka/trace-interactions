import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

/**
 * Builds every fixture variant as a separate static site. Baseline and candidate
 * are real, separate bundles: the runner never toggles a flag inside one build.
 */
const root = resolve(import.meta.dirname, '..');
const only = process.argv[2];

for (const id of await readdir(join(root, 'fixtures'))) {
  if (id === 'shared' || (only && id !== only)) continue;
  const manifestPath = join(root, 'fixtures', id, 'fixture.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'));
  if (!manifest) continue;
  for (const variant of Object.keys(manifest.builds)) {
    await build({
      root: join(root, 'fixtures', id),
      base: './',
      logLevel: 'warn',
      configFile: false,
      plugins: [react()],
      define: { __VARIANT__: JSON.stringify(variant) },
      build: { outDir: join(root, '.build/fixtures', id, variant), emptyOutDir: true, minify: true, reportCompressedSize: false },
    });
  }
  console.log(`built ${id}: ${Object.keys(manifest.builds).length} variants`);
}
