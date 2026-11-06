import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import { compare, type Comparison } from './compare.ts';
import { runScenario, type RunOutput } from './runner/run.ts';
import { sha256 } from './runner/environment.ts';
import type { ServedBuild } from './runner/registry.ts';
import type { Scenario } from './scenario/schema.ts';

export interface CaseOptions {
  browser: Browser;
  scenario: Scenario;
  stateAllowlist: string[];
  baseline: ServedBuild;
  candidate: ServedBuild;
  out: string;
  mode?: 'controlled' | 'wall';
  /** Second pass that takes screenshots at the failure. Off for measurements. */
  screenshots?: boolean;
  label?: string;
  adapterScript?: string;
}

export interface CaseResult {
  comparison: Comparison;
  baseline: RunOutput;
  candidate: RunOutput;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** A new run replaces the old one, so a report can never mix evidence from two runs. */
export function clearRun(dir: string): void {
  for (const name of ['raw', 'screenshots', 'report', 'reduced.scenario.json', 'reduction.json', 'reduction.progress.json']) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/** Hash of the behavior a run showed, for comparing repeated runs. Ignores sequence numbers. */
export function behaviorHash(run: RunOutput): string {
  const shape = run.events.flatMap((e) => {
    if (e.k === 'state') return [`${e.t} ${e.key}=${e.value}`];
    if (e.k === 'focus') return [`${e.t} focus ${e.ref?.traceId ?? e.ref?.tag ?? 'body'}`];
    if (e.k === 'action' && e.phase === 'start') return [`${e.t} action ${e.index}`];
    return [];
  });
  return sha256(shape.join('\n'));
}

/**
 * Runs one scenario on two builds and saves the raw evidence. The diagnostic
 * screenshot pass repeats the run, because a screenshot perturbs real timing and
 * must not sit inside the pass whose events are judged.
 */
export async function runCase(o: CaseOptions): Promise<CaseResult> {
  const label = o.label ?? 'original';
  const dir = resolve(o.out);
  const allow = o.stateAllowlist;
  const common = { browser: o.browser, scenario: o.scenario, stateAllowlist: allow, mode: o.mode, adapterScript: o.adapterScript };
  const baseline = await runScenario({ ...common, url: o.baseline.url });
  const candidate = await runScenario({ ...common, url: o.candidate.url });
  const comparison = compare(baseline, candidate);

  if (o.screenshots && baseline.status === 'completed' && candidate.status === 'completed') {
    const shots = join(dir, 'screenshots');
    mkdirSync(shots, { recursive: true });
    const times = [...new Set([...comparison.introduced, ...comparison.shared, ...comparison.resolved].map((v) => v.at.t))];
    const b = await runScenario({ ...common, url: o.baseline.url, screenshots: { dir: shots, prefix: `${label}-baseline`, times } });
    const c = await runScenario({ ...common, url: o.candidate.url, screenshots: { dir: shots, prefix: `${label}-candidate`, times } });
    baseline.screenshots = b.screenshots;
    candidate.screenshots = c.screenshots;
  }

  writeJson(join(dir, 'raw', `${label}.scenario.json`), o.scenario);
  writeJson(join(dir, 'raw', `${label}.baseline.json`), baseline);
  writeJson(join(dir, 'raw', `${label}.candidate.json`), candidate);
  writeJson(join(dir, 'raw', `${label}.comparison.json`), comparison);
  return { comparison, baseline, candidate };
}
