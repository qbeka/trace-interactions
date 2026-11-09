import { join, resolve } from 'node:path';
import { refreshViewer } from '../src/report/export.ts';
import { buildPage } from './build-page.ts';

/**
 * Brings the committed demo up to date with the viewer and the page as they are
 * now, without running anything again. The reports keep the runs they recorded,
 * so a change to how a report looks never changes what it says. Build the viewer
 * first with `pnpm build:viewer`.
 */
const root = resolve(import.meta.dirname, '..');
const demo = resolve(process.argv[2] ?? join(root, 'demo'));
for (const name of ['regression', 'fixed']) await refreshViewer(join(demo, name));
await buildPage(demo);
console.log(`Viewer and page refreshed in ${demo}`);
