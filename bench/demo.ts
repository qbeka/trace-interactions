import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPage } from '../scripts/build-page.ts';

/**
 * Builds the static demo: a real regression, reduced and replayed, the same
 * reduced scenario showing the fix, and the project page that replays them.
 * Every report comes from a real run.
 */
const root = resolve(import.meta.dirname, '..');
const work = join(root, '.trace', 'demo-build');
const out = resolve(process.argv[2] ?? join(root, 'demo'));
const trace = (...args: string[]) => {
  const r = spawnSync('node_modules/.bin/tsx', ['src/cli.ts', ...args], { cwd: root, encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.status;
};

rmSync(work, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const regression = join(work, 'regression');
const fixed = join(work, 'fixed');

if (trace('run', 'fixtures/inspector/scenarios/long-session.json', '--baseline', 'inspector@correct', '--candidate', 'inspector@stale-origin', '--out', regression) !== 1) {
  throw new Error('The demo needs a real regression.');
}
if (trace('reduce', regression) !== 0) throw new Error('The demo reduction failed.');
if (trace('replay', regression) !== 1) throw new Error('The reduced scenario no longer fails.');
if (trace('run', join(regression, 'reduced.scenario.json'), '--baseline', 'inspector@stale-origin', '--candidate', 'inspector@correct', '--out', fixed) !== 0) {
  throw new Error('The fix report should pass.');
}
cpSync(join(regression, 'report'), join(out, 'regression'), { recursive: true });
cpSync(join(fixed, 'report'), join(out, 'fixed'), { recursive: true });
cpSync(join(regression, 'reduced.scenario.json'), join(out, 'reduced.scenario.json'));
await buildPage(out);
console.log(`Demo written to ${out}`);
