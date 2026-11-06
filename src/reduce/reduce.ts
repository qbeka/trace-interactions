import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import { writeJson, behaviorHash } from '../case.ts';
import { runScenario, type RunOutput } from '../runner/run.ts';
import type { Scenario } from '../scenario/schema.ts';
import { sequenceProblem } from '../scenario/validate.ts';
import { ddmin, type Budget, type Outcome, type ReduceState, type StopReason } from './ddmin.ts';

export interface ReductionReport {
  schema: 'trace.reduction/1';
  status: 'reduced' | 'unstable' | 'not-reproduced';
  fingerprint: string;
  fixture: { id: string; version: string };
  seed: number;
  originalActions: number;
  reducedActions: number;
  attempts: number;
  /** Attempts by outcome, so invalid and rejected sequences stay in the denominator. */
  outcomes: Record<Outcome, number>;
  stopped: StopReason | null;
  /** Every remaining removable action was tested and is needed. */
  oneMinimal: boolean;
  elapsedMs: number;
  /** Fresh runs of the original, before reduction started. */
  originalReproduction: { reproduced: number; runs: number };
  /** Fresh runs of the final sequence. */
  reducedReproduction: { reproduced: number; runs: number };
  /** Runs of the final sequence on the baseline that also showed the failure. Should be 0. */
  baselineReproduction: { reproduced: number; runs: number };
  distinctBehaviors: number;
  keptIndices: number[];
}

export interface ReduceInput {
  browser: Browser;
  scenario: Scenario;
  stateAllowlist: string[];
  baselineUrl: string;
  candidateUrl: string;
  fingerprint: string;
  out: string;
  budget: Budget;
  /** Runs an accepted sequence must reproduce on, all of them. */
  confirmRuns: number;
  /** Runs used for the published reproduction rate. */
  reproductionRuns: number;
  mode?: 'controlled' | 'wall';
  signal?: AbortSignal;
  resume?: boolean;
}

export const subset = (s: Scenario, kept: number[]): Scenario => ({ ...s, actions: kept.map((i) => s.actions[i]!) });

const hasPrint = (r: RunOutput, print: string): boolean => r.status === 'completed' && r.violations.some((v) => v.fingerprint === print);

export async function reduceScenario(i: ReduceInput): Promise<ReductionReport> {
  const started = Date.now();
  const dir = resolve(i.out);
  const progressPath = join(dir, 'reduction.progress.json');
  const common = { browser: i.browser, stateAllowlist: i.stateAllowlist, mode: i.mode };
  const candidateRun = (scenario: Scenario) => runScenario({ ...common, scenario, url: i.candidateUrl });
  const baselineRun = (scenario: Scenario) => runScenario({ ...common, scenario, url: i.baselineUrl });
  const behaviors = new Set<string>();

  const rate = async (run: (s: Scenario) => Promise<RunOutput>, s: Scenario, runs: number) => {
    let reproduced = 0;
    for (let n = 0; n < runs; n++) {
      const r = await run(s);
      if (r.status === 'completed') behaviors.add(behaviorHash(r));
      if (hasPrint(r, i.fingerprint)) reproduced += 1;
    }
    return { reproduced, runs };
  };

  const base: Omit<ReductionReport, 'status' | 'elapsedMs'> = {
    schema: 'trace.reduction/1',
    fingerprint: i.fingerprint,
    fixture: i.scenario.fixture,
    seed: i.scenario.seed,
    originalActions: i.scenario.actions.length,
    reducedActions: i.scenario.actions.length,
    attempts: 0,
    outcomes: { fails: 0, passes: 0, invalid: 0, unstable: 0, 'other-failure': 0 },
    stopped: null,
    oneMinimal: false,
    originalReproduction: { reproduced: 0, runs: 0 },
    reducedReproduction: { reproduced: 0, runs: 0 },
    baselineReproduction: { reproduced: 0, runs: 0 },
    distinctBehaviors: 0,
    keptIndices: i.scenario.actions.map((_, n) => n),
  };

  // A failure that does not reproduce on the full sequence cannot be reduced
  // honestly. It is labelled and the original trace is kept as the evidence.
  base.originalReproduction = await rate(candidateRun, i.scenario, i.confirmRuns);
  if (base.originalReproduction.reproduced < i.confirmRuns) {
    const status = base.originalReproduction.reproduced === 0 ? 'not-reproduced' : 'unstable';
    const report = { ...base, status, distinctBehaviors: behaviors.size, elapsedMs: Date.now() - started } as ReductionReport;
    writeJson(join(dir, 'reduction.json'), report);
    return report;
  }

  const test = async (kept: number[]): Promise<Outcome> => {
    const s = subset(i.scenario, kept);
    if (sequenceProblem(s.actions, s.targets)) return 'invalid';
    const first = await candidateRun(s);
    if (first.status === 'invalid') return 'invalid';
    if (!hasPrint(first, i.fingerprint)) return first.violations.length > 0 ? 'other-failure' : 'passes';
    // Reproduced once. Now it has to keep reproducing.
    for (let n = 1; n < i.confirmRuns; n++) {
      if (!hasPrint(await candidateRun(s), i.fingerprint)) return 'unstable';
    }
    // A smaller sequence that also fails the baseline is no longer this regression.
    return hasPrint(await baselineRun(s), i.fingerprint) ? 'other-failure' : 'fails';
  };

  const required = new Set(i.scenario.actions.flatMap((a, n) => (a.setup ? [n] : [])));
  const resume: ReduceState | undefined =
    i.resume && existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : undefined;

  const result = await ddmin({
    count: i.scenario.actions.length,
    required,
    test,
    budget: i.budget,
    signal: i.signal,
    resume,
    onProgress: (state) => writeJson(progressPath, state),
  });

  const reduced = subset(i.scenario, result.kept);
  writeJson(join(dir, 'reduced.scenario.json'), { ...reduced, id: `${i.scenario.id}-reduced` });

  // Distinct behaviors counts the final sequence only. Above 1 means timing varied between runs.
  behaviors.clear();
  base.reducedReproduction = await rate(candidateRun, reduced, i.reproductionRuns);
  const distinctBehaviors = behaviors.size;
  base.baselineReproduction = await rate(baselineRun, reduced, Math.min(i.reproductionRuns, 3));
  for (const a of result.attempts) base.outcomes[a.outcome] += 1;

  const report: ReductionReport = {
    ...base,
    status: base.reducedReproduction.reproduced === base.reducedReproduction.runs ? 'reduced' : 'unstable',
    reducedActions: result.kept.length,
    attempts: result.attempts.length,
    stopped: result.stopped,
    oneMinimal: result.stopped === 'minimal',
    keptIndices: result.kept,
    distinctBehaviors,
    elapsedMs: Date.now() - started,
  };
  writeJson(join(dir, 'reduction.json'), report);
  return report;
}
