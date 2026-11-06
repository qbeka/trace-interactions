import type { RunResult, Violation } from './trace/types.ts';

/**
 * regression      the candidate breaks a requirement the baseline meets
 * fixed           the baseline breaks a requirement the candidate meets
 * shared-failure  both builds break the same requirement
 * pass            neither build breaks anything
 * invalid         the scenario could not run on the baseline
 * diverged        it ran on the baseline but could not finish on the candidate
 */
export type Verdict = 'pass' | 'regression' | 'fixed' | 'shared-failure' | 'invalid' | 'diverged';

export interface Comparison {
  verdict: Verdict;
  /** One sentence that stands alone at the top of a report. */
  sentence: string;
  /** Violations only the candidate has, earliest first. */
  introduced: Violation[];
  resolved: Violation[];
  shared: Violation[];
}

const prints = (v: Violation[]): Set<string> => new Set(v.map((x) => x.fingerprint));

export function compare(baseline: RunResult, candidate: RunResult): Comparison {
  const empty = { introduced: [], resolved: [], shared: [] };
  if (baseline.status === 'invalid') {
    return { verdict: 'invalid', sentence: `The scenario is invalid: ${baseline.invalid?.reason}.`, ...empty };
  }
  if (candidate.status === 'invalid') {
    const at = candidate.invalid?.actionIndex;
    return {
      verdict: 'diverged',
      sentence: `The scenario ran on the baseline but could not finish on the candidate${at === null || at === undefined ? '' : ` at action ${at + 1}`}: ${candidate.invalid?.reason}.`,
      ...empty,
    };
  }
  const base = prints(baseline.violations);
  const cand = prints(candidate.violations);
  const introduced = candidate.violations.filter((v) => !base.has(v.fingerprint));
  const resolved = baseline.violations.filter((v) => !cand.has(v.fingerprint));
  const shared = candidate.violations.filter((v) => base.has(v.fingerprint));
  if (introduced.length > 0) {
    return { verdict: 'regression', sentence: introduced[0]!.sentence, introduced, resolved, shared };
  }
  if (shared.length > 0) {
    return {
      verdict: 'shared-failure',
      sentence: `Both builds fail: ${shared[0]!.sentence}`,
      introduced,
      resolved,
      shared,
    };
  }
  if (resolved.length > 0) {
    return { verdict: 'fixed', sentence: `The candidate fixes this: ${resolved[0]!.sentence}`, introduced, resolved, shared };
  }
  return { verdict: 'pass', sentence: 'Both builds met every declared requirement.', introduced, resolved, shared };
}

/** 0 pass or fixed, 1 a real failure, 2 the scenario could not run. */
export function exitCode(verdict: Verdict): number {
  if (verdict === 'pass' || verdict === 'fixed') return 0;
  if (verdict === 'regression' || verdict === 'shared-failure') return 1;
  return 2;
}
