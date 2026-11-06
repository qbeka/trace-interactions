import { describe, expect, it } from 'vitest';
import { median, sampleMetrics, summarize, type PerfRun } from '../../src/perf.ts';

describe('perf', () => {
  it('takes the middle of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('keeps the three latency quantities apart', () => {
    const s = { name: 'click', input: 100, handler: 101, commit: 105, render: 120 };
    expect(sampleMetrics(s)).toEqual({ 'input-to-handler': 1, 'input-to-commit': 5, 'input-to-render': 20 });
  });

  it('leaves out a quantity that was not observed', () => {
    const s = { name: 'pointerdown', input: 100, handler: 101, commit: null, render: null };
    expect(sampleMetrics(s)).toEqual({ 'input-to-handler': 1 });
  });

  it('counts each run once, whatever its sample count', () => {
    const run = (n: number, value: number): PerfRun => ({ run: n, wallMs: 10, medians: { 'click input-to-commit': value }, taskMs: 1, scriptMs: 1, samples: [] });
    const s = summarize([run(0, 1), run(1, 2), run(2, 9)], 1);
    expect(s.metrics['click input-to-commit']).toEqual({ median: 2, min: 1, max: 9, n: 3 });
    expect(s.runs).toBe(3);
  });
});
