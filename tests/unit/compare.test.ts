import { describe, expect, it } from 'vitest';
import { compare, exitCode } from '../../src/compare.ts';
import type { RunResult, Violation } from '../../src/trace/types.ts';

const v = (fingerprint: string): Violation => ({
  requirement: 'r',
  category: 'lost-focus',
  sentence: `broken: ${fingerprint}`,
  at: { seq: 1, t: 1, tick: 1 },
  target: null,
  fingerprint,
});

const run = (violations: Violation[], status: RunResult['status'] = 'completed'): RunResult => ({
  schema: 'trace.events/1',
  status,
  invalid: status === 'invalid' ? { reason: 'no target', actionIndex: 2 } : null,
  events: [],
  violations,
  requirements: [],
  clock: { mode: 'controlled', verified: {}, uncontrolled: [], used: [] },
  screenshots: [],
  durationMs: 1,
});

describe('compare', () => {
  it('passes when neither build fails', () => {
    expect(compare(run([]), run([])).verdict).toBe('pass');
  });
  it('reports a regression when only the candidate fails', () => {
    expect(compare(run([]), run([v('a')])).verdict).toBe('regression');
  });
  it('does not call a shared bug a pass, which a pure diff would', () => {
    expect(compare(run([v('a')]), run([v('a')])).verdict).toBe('shared-failure');
  });
  it('reports a fix', () => {
    expect(compare(run([v('a')]), run([])).verdict).toBe('fixed');
  });
  it('prefers regression when a change fixes one thing and breaks another', () => {
    const c = compare(run([v('a')]), run([v('b')]));
    expect(c.verdict).toBe('regression');
    expect(c.resolved).toHaveLength(1);
  });
  it('calls a scenario that fails on the baseline invalid', () => {
    expect(compare(run([], 'invalid'), run([])).verdict).toBe('invalid');
  });
  it('separates a replay that cannot finish on the candidate from a regression', () => {
    const c = compare(run([]), run([], 'invalid'));
    expect(c.verdict).toBe('diverged');
    expect(c.sentence).toMatch(/action 3/);
  });
  it('does not claim every requirement held when some were not reached', () => {
    const b = { ...run([]), requirements: [{ index: 0, kind: 'a', status: 'held' as const }, { index: 1, kind: 'b', status: 'not-exercised' as const }] };
    expect(compare(b, b).sentence).toBe('Both builds met the 1 of 2 requirements this run reached.');
  });
  it('maps verdicts to exit codes', () => {
    expect(['pass', 'fixed', 'regression', 'shared-failure', 'invalid', 'diverged'].map((x) => exitCode(x as never))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
