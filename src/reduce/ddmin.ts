/**
 * Bounded delta debugging over a list of actions. The only moves are deletions.
 *
 * Zeller's ddmin splits the removable items into `n` chunks and tries to delete
 * each chunk. A deletion that keeps the failure is accepted and `n` shrinks;
 * otherwise `n` doubles. When `n` passes the item count and nothing can be
 * removed, the result is 1-minimal: removing any single removable item loses the
 * failure. Worst case is quadratic in tests, hence the budget.
 *
 * This file knows nothing about browsers, so its tests run on pure predicates.
 */
export type Outcome = 'fails' | 'passes' | 'invalid' | 'unstable' | 'other-failure';

export interface Budget {
  maxAttempts: number;
  maxMs: number;
}

export type StopReason = 'minimal' | 'attempts' | 'time' | 'cancelled';

export interface Attempt {
  kept: number[];
  outcome: Outcome;
}

export interface ReduceState {
  /** Indices into the original list that are still in the sequence. */
  kept: number[];
  granularity: number;
  attempts: Attempt[];
}

export interface ReduceResult extends ReduceState {
  stopped: StopReason;
}

export interface ReduceOptions {
  count: number;
  /** Indices that may not be deleted, such as setup actions. */
  required: ReadonlySet<number>;
  test: (kept: number[]) => Promise<Outcome>;
  budget: Budget;
  signal?: AbortSignal;
  /** Called after each attempt, so progress survives a crash or a cancel. */
  onProgress?: (state: ReduceState) => void;
  resume?: ReduceState;
  clock?: () => number;
}

export async function ddmin(o: ReduceOptions): Promise<ReduceResult> {
  const now = o.clock ?? Date.now;
  const started = now();
  const state: ReduceState = o.resume ?? {
    kept: Array.from({ length: o.count }, (_, i) => i),
    granularity: 2,
    attempts: [],
  };
  const seen = new Map(state.attempts.map((a) => [a.kept.join(','), a.outcome]));

  const stop = (): StopReason | null => {
    if (o.signal?.aborted) return 'cancelled';
    if (state.attempts.length >= o.budget.maxAttempts) return 'attempts';
    if (now() - started >= o.budget.maxMs) return 'time';
    return null;
  };

  for (;;) {
    const removable = state.kept.filter((i) => !o.required.has(i));
    if (removable.length === 0) return { ...state, stopped: 'minimal' };
    const chunks = split(removable, Math.min(state.granularity, removable.length));
    let reduced = false;
    for (const chunk of chunks) {
      const reason = stop();
      if (reason) return { ...state, stopped: reason };
      const gone = new Set(chunk);
      const kept = state.kept.filter((i) => !gone.has(i));
      const key = kept.join(',');
      let outcome = seen.get(key);
      if (outcome === undefined) {
        outcome = await o.test(kept);
        seen.set(key, outcome);
        state.attempts.push({ kept, outcome });
      }
      if (outcome === 'fails') {
        state.kept = kept;
        state.granularity = Math.max(state.granularity - 1, 2);
        reduced = true;
        o.onProgress?.(state);
        break;
      }
      o.onProgress?.(state);
    }
    if (reduced) continue;
    if (chunks.length >= removable.length) return { ...state, stopped: 'minimal' };
    state.granularity = Math.min(state.granularity * 2, removable.length);
  }
}

function split<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.ceil((items.length - start) / (n - i));
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
}
