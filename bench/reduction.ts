import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { writeJson } from '../src/case.ts';
import { median } from '../src/perf.ts';
import { reduceScenario, type ReductionReport } from '../src/reduce/reduce.ts';
import { exportReport } from '../src/report/export.ts';
import { loadRegistry, serveBuild } from '../src/runner/registry.ts';
import { runScenario } from '../src/runner/run.ts';
import { generateScenario } from './generate.ts';
import { manifestFor } from './manifest.ts';

/**
 * Reduction on generated sessions. For each seeded bug, the first seed whose
 * session fails on the candidate and passes on the baseline is the workload.
 * The choice depends only on the fixture, the build and the seed order, so it
 * repeats. Each repetition uses a new browser and starts from the full session.
 */
const WORKLOADS: [string, string][] = [
  ['inspector', 'stale-completion'],
  ['inspector', 'stale-resize'],
  ['overlay', 'no-restore'],
  ['overlay', 'live-exit-clone'],
  ['timeline', 'drag-stuck-on-cancel'],
];

const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, out: { type: 'string', default: 'results/reduction' }, 'max-seeds': { type: 'string', default: '60' } } });
const runs = Number(values.runs);
const root = resolve(import.meta.dirname, '..');
const out = resolve(values.out!);
const registry = loadRegistry(join(root, 'trace.fixtures.json'));
const rows: unknown[] = [];
const started = performance.now();
const manifestBrowser = await chromium.launch();
const manifest = manifestFor(manifestBrowser, root, 'bench/reduction.ts');
await manifestBrowser.close();

for (const [id, buildName] of WORKLOADS) {
  const fixture = registry.get(id)!;
  const allow = fixture.manifest.stateAllowlist;
  const baseline = await serveBuild(fixture, 'correct');
  const candidate = await serveBuild(fixture, buildName);
  let browser = await chromium.launch();
  let chosen: { seed: number; fingerprint: string; scanned: number; invalid: number } | null = null;
  let invalid = 0;
  for (let seed = 1; seed <= Number(values['max-seeds']) && !chosen; seed++) {
    const scenario = generateScenario(root, id, seed);
    const base = await runScenario({ browser, url: baseline.url, scenario, stateAllowlist: allow });
    const cand = await runScenario({ browser, url: candidate.url, scenario, stateAllowlist: allow });
    if (base.status === 'invalid' || cand.status === 'invalid') {
      invalid += 1;
      continue;
    }
    const known = new Set(base.violations.map((v) => v.fingerprint));
    const fresh = cand.violations.find((v) => !known.has(v.fingerprint));
    if (fresh) chosen = { seed, fingerprint: fresh.fingerprint, scanned: seed, invalid };
  }
  await browser.close();
  if (!chosen) {
    rows.push({ fixture: id, build: buildName, chosen: null, scanned: Number(values['max-seeds']), invalid });
    console.log(`${id}@${buildName}: no failing session in ${values['max-seeds']} seeds`);
    await baseline.stop();
    await candidate.stop();
    continue;
  }
  const scenario = generateScenario(root, id, chosen.seed);
  const reports: ReductionReport[] = [];
  for (let n = 0; n < runs; n++) {
    browser = await chromium.launch();
    const dir = join(out, 'runs', `${id}-${buildName}-${n}`);
    const report = await reduceScenario({
      browser,
      scenario,
      stateAllowlist: allow,
      baselineUrl: baseline.url,
      candidateUrl: candidate.url,
      fingerprint: chosen.fingerprint,
      out: dir,
      budget: { maxAttempts: 80, maxMs: 180_000 },
      confirmRuns: 3,
      reproductionRuns: 10,
    });
    await browser.close();
    reports.push(report);
    console.log(`${id}@${buildName} run ${n}: ${report.originalActions} to ${report.reducedActions} in ${report.attempts} attempts, ${(report.elapsedMs / 1000).toFixed(1)} s, reproduced ${report.reducedReproduction.reproduced}/${report.reducedReproduction.runs}`);
  }
  rows.push({
    fixture: id,
    build: buildName,
    chosen,
    fingerprint: chosen.fingerprint,
    originalActions: reports[0]!.originalActions,
    reducedActions: reports.map((r) => r.reducedActions),
    elapsedMs: { median: Math.round(median(reports.map((r) => r.elapsedMs))), min: Math.min(...reports.map((r) => r.elapsedMs)), max: Math.max(...reports.map((r) => r.elapsedMs)), n: reports.length },
    attempts: reports.map((r) => r.attempts),
    outcomes: reports[0]!.outcomes,
    reproduction: reports.map((r) => r.reducedReproduction),
    baselineReproduction: reports.map((r) => r.baselineReproduction),
    oneMinimal: reports.map((r) => r.oneMinimal),
    status: reports.map((r) => r.status),
  });
  await baseline.stop();
  await candidate.stop();
}

// Report cost, measured on a real run directory.
const reportTimes: number[] = [];
const sample = join(out, 'report-sample');
rmSync(sample, { recursive: true, force: true });
mkdirSync(join(sample, 'raw'), { recursive: true });
const fixture = registry.get('inspector')!;
const scenario = generateScenario(root, 'inspector', 3);
const browser = await chromium.launch();
const base = await serveBuild(fixture, 'correct');
const a = await runScenario({ browser, url: base.url, scenario, stateAllowlist: fixture.manifest.stateAllowlist });
await browser.close();
await base.stop();
for (const [name, value] of [['original.scenario', scenario], ['original.baseline', a], ['original.candidate', a], ['original.comparison', { verdict: 'pass', sentence: 'sample', introduced: [], resolved: [], shared: [] }]] as const) {
  writeFileSync(join(sample, 'raw', `${name}.json`), JSON.stringify(value));
}
writeFileSync(join(sample, 'manifest.json'), JSON.stringify({ baseline: { ref: 'a' }, candidate: { ref: 'b' } }));
for (let n = 0; n < 6; n++) {
  const t = performance.now();
  await exportReport(sample);
  if (n > 0) reportTimes.push(performance.now() - t);
}
const size = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
const report = {
  scenarioActions: scenario.actions.length,
  events: a.events.length,
  traceBytes: statSync(join(sample, 'raw', 'original.candidate.json')).size,
  bytesPerEvent: Math.round(statSync(join(sample, 'raw', 'original.candidate.json')).size / a.events.length),
  reportBytes: size(join(sample, 'report')),
  generationMs: { median: Math.round(median(reportTimes) * 10) / 10, min: Math.round(Math.min(...reportTimes) * 10) / 10, max: Math.round(Math.max(...reportTimes) * 10) / 10, n: reportTimes.length },
};
writeJson(join(out, 'summary.json'), { rows, report });
writeJson(join(out, 'manifest.json'), { ...manifest, repetitions: runs, warmup: 0, confirmRuns: 3, reproductionRuns: 10, budget: { maxAttempts: 80, maxSeconds: 180 }, wallSeconds: Math.round((performance.now() - started) / 1000), exclusions: [] });
console.log(JSON.stringify({ rows, report }, null, 2));
