import type { BrowserType } from 'playwright';
import type { LatencySample } from './recorder/recorder.ts';
import { runScenario } from './runner/run.ts';
import type { Scenario } from './scenario/schema.ts';

/**
 * Wall-clock timing, in ms, for one input event in one real run.
 *
 * input-to-handler   From Event.timeStamp to the recorder's capture listener,
 *                    the first page code to run. Input delay, not processing.
 * input-to-commit    From Event.timeStamp to the fixture publishing the state
 *                    this input caused, in a layout effect.
 * input-to-render    From Event.timeStamp to one message task after the next
 *                    requestAnimationFrame that follows the commit. This is the
 *                    next frame the page observed. It is not the frame shown.
 *
 * None of these is INP. INP is a field metric over a whole visit, and it ends
 * at the frame the user sees. Virtual time is never used here.
 */
export const METRICS = ['input-to-handler', 'input-to-commit', 'input-to-render'] as const;
export type Metric = (typeof METRICS)[number];

export function sampleMetrics(s: LatencySample): Partial<Record<Metric, number>> {
  const out: Partial<Record<Metric, number>> = { 'input-to-handler': s.handler - s.input };
  if (s.commit !== null) out['input-to-commit'] = s.commit - s.input;
  if (s.render !== null) out['input-to-render'] = s.render - s.input;
  return out;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (n: number): number => Math.round(n * 100) / 100;

export interface PerfRun {
  run: number;
  wallMs: number;
  /** Median of each metric across this run's inputs. One value per run. */
  medians: Partial<Record<Metric, number>>;
  /** Browser-side work during the run, from Chromium Performance.getMetrics. */
  taskMs: number | null;
  scriptMs: number | null;
  samples: LatencySample[];
}

export interface PerfSummary {
  runs: number;
  warmup: number;
  /** Median and range across runs. Each run counts once, however many inputs it had. */
  metrics: Record<string, { median: number; min: number; max: number; n: number }>;
}

/** Thousands of samples in one browser are not thousands of experiments. */
export function summarize(runs: PerfRun[], warmup: number): PerfSummary {
  const metrics: PerfSummary['metrics'] = {};
  const add = (name: string, values: number[]) => {
    if (values.length) metrics[name] = { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)), n: values.length };
  };
  for (const m of METRICS) add(m, runs.flatMap((r) => (r.medians[m] === undefined ? [] : [r.medians[m]!])));
  add('task-ms', runs.flatMap((r) => (r.taskMs === null ? [] : [r.taskMs])));
  add('script-ms', runs.flatMap((r) => (r.scriptMs === null ? [] : [r.scriptMs])));
  add('wall-ms', runs.map((r) => r.wallMs));
  return { runs: runs.length, warmup, metrics };
}

export interface PerfOptions {
  type: BrowserType;
  url: string;
  scenario: Scenario;
  stateAllowlist: string[];
  recording: 'full' | 'stamps' | 'off';
}

/** One independent run: a new browser process, so runs share no JIT or cache state. */
export async function perfRun(o: PerfOptions, run: number): Promise<PerfRun> {
  const browser = await o.type.launch();
  try {
    const r = await runScenario({ browser, url: o.url, scenario: o.scenario, stateAllowlist: o.stateAllowlist, mode: 'wall', recording: o.recording });
    if (r.status !== 'completed') throw new Error(`perf run failed: ${r.invalid?.reason}`);
    const samples = r.latency as LatencySample[];
    const perMetric = samples.map(sampleMetrics);
    const medians: Partial<Record<Metric, number>> = {};
    for (const m of METRICS) {
      const values = perMetric.flatMap((p) => (p[m] === undefined ? [] : [p[m]!]));
      if (values.length) medians[m] = round(median(values));
    }
    return {
      run,
      wallMs: r.durationMs,
      medians,
      taskMs: r.metrics?.TaskDuration ?? null,
      scriptMs: r.metrics?.ScriptDuration ?? null,
      samples,
    };
  } finally {
    await browser.close();
  }
}
