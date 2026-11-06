import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The full measurement. Declared budget: 50 minutes on the reference machine.
 * Workload and pass criteria are frozen in docs/MEASUREMENT.md.
 */
const BUDGET_MS = 50 * 60_000;
const root = resolve(import.meta.dirname, '..');
const steps: [string, string[]][] = [
  ['smoke', ['bench/smoke.ts']],
  ['corpus on chromium', ['bench/corpus.ts', '--out', 'results/corpus-chromium']],
  ['corpus on firefox', ['bench/corpus.ts', '--browser', 'firefox', '--out', 'results/corpus-firefox']],
  ['corpus on webkit', ['bench/corpus.ts', '--browser', 'webkit', '--out', 'results/corpus-webkit']],
  ['random sessions', ['bench/random.ts', '--seeds', '100', '--first-seed', '1001', '--out', 'results/random']],
  ['holdout on final code', ['bench/corpus.ts', '--labels', 'corpus/holdout.json', '--out', 'results/holdout-final-oracle']],
  ['reduction', ['bench/reduction.ts', '--out', 'results/reduction']],
  ['reduction of the written session', ['bench/reduction.ts', '--written', 'inspector,stale-origin,long-session', '--out', 'results/reduction-written']],
  ['overhead', ['bench/overhead.ts', '--out', 'results/overhead']],
];
const only = process.argv[2];
const started = Date.now();
for (const [name, args] of steps) {
  if (only && !name.includes(only)) continue;
  console.log(`\n=== ${name}`);
  const t = Date.now();
  const r = spawnSync('node_modules/.bin/tsx', args, { cwd: root, stdio: 'inherit' });
  console.log(`=== ${name}: exit ${r.status}, ${Math.round((Date.now() - t) / 1000)} s`);
  if (r.status !== 0) process.exitCode = 1;
}
const total = Date.now() - started;
console.log(`\nTotal ${Math.round(total / 1000)} s. Budget ${BUDGET_MS / 1000} s. ${total <= BUDGET_MS ? 'Within budget.' : 'OVER BUDGET.'}`);
