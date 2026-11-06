import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Builds the static demo: a real regression, reduced and replayed, and the same
 * reduced scenario showing the fix. Every report comes from a real run.
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
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace demo</title>
<style>body{max-width:560px;margin:15vh auto;padding:0 20px;background:#fbf8f4;color:#111511;font:16px/1.5 system-ui,sans-serif}h1{font-weight:500}a{color:#1d3a2a}li{margin:8px 0}</style></head>
<body><h1>Trace demo</h1><p>Both reports come from real runs on two builds of a small inspector panel.</p>
<ul><li><a href="regression/index.html">The regression</a>: 14 actions reduced, with the failure pinned.</li>
<li><a href="fixed/index.html">The fix</a>: the same reduced scenario, with the bug gone.</li></ul></body></html>
`);
console.log(`Demo written to ${out}`);
