import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { writeJson } from '../src/case.ts';
import { median, perfRun, summarize, type PerfRun } from '../src/perf.ts';
import { loadRegistry, serveBuild } from '../src/runner/registry.ts';
import { parseScenario } from '../src/scenario/validate.ts';
import { manifestFor } from './manifest.ts';

/**
 * What the recorder costs. The same scenario runs at three recording levels.
 *
 *   off     a stub with no listeners or wrappers, the control
 *   stamps  the performance pass: wrappers plus input and commit timestamps
 *   full    the diagnostic pass: focus, geometry, state, relations, ledger
 *
 * Levels rotate inside each round, so slow drift in the machine lands on all of
 * them. Each run is a new browser process. The first rounds are warmup and are
 * discarded. Costs come from Chromium's own counters, read from outside the page.
 */
const LEVELS = ['off', 'stamps', 'full'] as const;
const { values } = parseArgs({ options: { runs: { type: 'string', default: '7' }, warmup: { type: 'string', default: '2' }, out: { type: 'string', default: 'results/overhead' } } });
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const root = resolve(import.meta.dirname, '..');
const fixture = loadRegistry(join(root, 'trace.fixtures.json')).get('inspector')!;
const scenario = parseScenario(JSON.parse(readFileSync(join(root, 'fixtures/inspector/scenarios/long-session.json'), 'utf8')));
const build = await serveBuild(fixture, 'correct');
const results: Record<(typeof LEVELS)[number], PerfRun[]> = { off: [], stamps: [], full: [] };

for (let n = 0; n < warmup + runs; n++) {
  for (let i = 0; i < LEVELS.length; i++) {
    const level = LEVELS[(n + i) % LEVELS.length]!;
    const r = await perfRun({ type: chromium, url: build.url, scenario, stateAllowlist: fixture.manifest.stateAllowlist, recording: level }, n);
    if (n >= warmup) results[level].push(r);
  }
}
await build.stop();

const summary = {
  off: summarize(results.off, warmup),
  stamps: summarize(results.stamps, warmup),
  full: summarize(results.full, warmup),
};
const delta = (level: 'stamps' | 'full', metric: 'taskMs' | 'scriptMs') => {
  const control = results.off.map((r) => r[metric]!);
  const measured = results[level].map((r) => r[metric]!);
  // Each round is a pair: the same moment in time on the same machine.
  const diffs = measured.map((v, i) => v - control[i]!);
  return { medianMs: Math.round(median(diffs) * 100) / 100, minMs: Math.round(Math.min(...diffs) * 100) / 100, maxMs: Math.round(Math.max(...diffs) * 100) / 100, percentOfControl: Math.round((median(diffs) / median(control)) * 1000) / 10 };
};
const overhead = {
  stamps: { task: delta('stamps', 'taskMs'), script: delta('stamps', 'scriptMs') },
  full: { task: delta('full', 'taskMs'), script: delta('full', 'scriptMs') },
  actions: scenario.actions.length,
};
writeJson(join(resolve(values.out!), 'raw.json'), results);
writeJson(join(resolve(values.out!), 'summary.json'), { summary, overhead });
const probe = await chromium.launch();
writeJson(join(resolve(values.out!), 'manifest.json'), { ...manifestFor(probe, root, 'bench/overhead.ts'), scenario: scenario.id, build: 'inspector@correct', repetitions: runs, warmup, levels: LEVELS, exclusions: [] });
await probe.close();
console.log(JSON.stringify({ summary, overhead }, null, 2));
