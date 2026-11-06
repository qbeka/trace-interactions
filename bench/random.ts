import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { writeJson } from '../src/case.ts';
import { loadRegistry, serveBuild } from '../src/runner/registry.ts';
import { runScenario } from '../src/runner/run.ts';
import { staticProblem } from '../src/scenario/validate.ts';
import { generateScenario, GENERATED_FIXTURES } from './generate.ts';
import { manifestFor } from './manifest.ts';

/**
 * Random sessions against the correct build of each fixture. A violation here is
 * a false alarm or a real bug in the fixture, and both matter. Invalid sequences
 * are reported as their own count.
 */
const { values } = parseArgs({ options: { seeds: { type: 'string', default: '40' }, out: { type: 'string', default: 'results/random' }, build: { type: 'string', default: 'correct' } } });
const root = resolve(import.meta.dirname, '..');
const out = resolve(values.out!);
const registry = loadRegistry(join(root, 'trace.fixtures.json'));
const browser = await chromium.launch();
const seeds = Array.from({ length: Number(values.seeds) }, (_, i) => i + 1);
const started = performance.now();
const rows: unknown[] = [];
const summary: Record<string, unknown> = {};

for (const id of GENERATED_FIXTURES) {
  const fixture = registry.get(id)!;
  const build = await serveBuild(fixture, values.build!);
  let completed = 0;
  let invalidStatic = 0;
  let invalidRun = 0;
  let flagged = 0;
  const reasons: Record<string, number> = {};
  for (const seed of seeds) {
    const scenario = generateScenario(root, id, seed);
    if (staticProblem(scenario)) {
      invalidStatic += 1;
      rows.push({ fixture: id, seed, outcome: 'invalid-static' });
      continue;
    }
    const r = await runScenario({ browser, url: build.url, scenario, stateAllowlist: fixture.manifest.stateAllowlist });
    if (r.status === 'invalid') {
      invalidRun += 1;
      const reason = (r.invalid?.reason ?? 'unknown').replace(/"[^"]*"/g, '"…"').slice(0, 40);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      rows.push({ fixture: id, seed, outcome: 'invalid-run', reason: r.invalid?.reason, actionIndex: r.invalid?.actionIndex });
      continue;
    }
    completed += 1;
    if (r.violations.length > 0) flagged += 1;
    rows.push({ fixture: id, seed, outcome: r.violations.length ? 'flagged' : 'clean', violations: r.violations.map((v) => v.sentence), ms: r.durationMs });
    if (r.violations.length > 0) console.log(`FLAGGED ${id} seed ${seed}: ${r.violations[0]!.sentence}`);
  }
  summary[id] = { seeds: seeds.length, invalidStatic, invalidRun, completed, flagged, reasons };
  await build.stop();
}
writeJson(join(out, 'rows.json'), rows);
writeJson(join(out, 'summary.json'), summary);
writeJson(join(out, 'manifest.json'), { ...manifestFor(browser, root, 'bench/random.ts'), seeds, wallSeconds: Math.round((performance.now() - started) / 1000), repetitions: 1, warmup: 0, exclusions: [] });
await browser.close();
console.log(JSON.stringify(summary, null, 2));
console.log(`${Math.round((performance.now() - started) / 1000)} s`);
