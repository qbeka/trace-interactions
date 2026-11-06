import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/oracle/oracle.ts';
import { sequenceProblem } from '../../src/scenario/validate.ts';
import type { Action, Requirement } from '../../src/scenario/schema.ts';
import type { PendingEvent, TraceEvent } from '../../src/trace/types.ts';
import { scenario } from './helpers.ts';

/**
 * Model-generated cases. These never touch a browser and are reported apart from
 * browser scenarios. A tiny state machine stands in for a panel, in a correct
 * form and a stale form, so the oracle meets many interleavings cheaply.
 *
 * Every sequence comes from a saved seed. Sequences that break the action
 * grammar are rejected and counted, not dropped.
 */
const CLOSE_MS = 240;
const OPEN_MS = 240;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generated {
  actions: Action[];
}

/** Random toggles with random gaps. One action in eight is a stray pointer up, which is invalid. */
function generate(seed: number): Generated {
  const random = mulberry32(seed);
  const actions: Action[] = [];
  let t = 0;
  let want: 'open' | 'closed' = 'closed';
  const length = 2 + Math.floor(random() * 10);
  for (let i = 0; i < length; i++) {
    t += Math.floor(random() * 400);
    if (random() < 0.125) {
      actions.push({ type: 'pointerUp', at: t });
      continue;
    }
    want = want === 'open' ? 'closed' : 'open';
    actions.push({ type: 'activate', target: 'trigger', at: t, requests: { panel: want } });
  }
  return { actions };
}

interface Timer {
  at: number;
  value: 'open' | 'closed';
}

/** Simulates the panel. `stale` keeps old completion timers, which is the bug. */
function simulate(actions: Action[], stale: boolean): TraceEvent[] {
  const events: TraceEvent[] = [];
  let seq = 0;
  let tick = 0;
  const push = (t: number, e: PendingEvent) => {
    tick += 1;
    events.push({ ...e, seq: seq++, t, tick } as TraceEvent);
  };
  let timers: Timer[] = [];
  push(0, { k: 'state', key: 'panel', value: 'closed' });
  const fire = (until: number) => {
    const due = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at);
    timers = timers.filter((x) => x.at > until);
    for (const x of due) push(x.at, { k: 'state', key: 'panel', value: x.value });
  };
  actions.forEach((a, index) => {
    fire(a.at);
    push(a.at, { k: 'action', phase: 'start', index, cleanup: false, type: a.type, label: a.type });
    const want = a.requests?.panel;
    if (want === 'open') {
      if (!stale) timers = [];
      push(a.at, { k: 'state', key: 'panel', value: 'opening' });
      timers.push({ at: a.at + OPEN_MS, value: 'open' });
    } else if (want === 'closed') {
      if (!stale) timers = [];
      push(a.at, { k: 'state', key: 'panel', value: 'closing' });
      timers.push({ at: a.at + CLOSE_MS, value: 'closed' });
    }
    push(a.at, { k: 'action', phase: 'end', index, cleanup: false, type: a.type, label: a.type });
  });
  fire(Infinity);
  return events;
}

/**
 * Ground truth, worked out from the action list alone: a request's completion
 * lands after a newer request, and carries a different value than the request
 * in force at that moment. A timer due at the same ms as an action fires first.
 */
function staleCompletionVisible(actions: Action[]): boolean {
  const requests = actions.filter((a) => a.requests?.panel);
  return requests.some((a) => {
    const done = a.at + (a.requests!.panel === 'open' ? OPEN_MS : CLOSE_MS);
    const owner = requests.filter((q) => q.at < done).at(-1)!;
    return owner !== a && owner.requests!.panel !== a.requests!.panel;
  });
}

const req: Requirement = { kind: 'latest-request-wins', key: 'panel', terminal: ['open', 'closed'] };

describe('model-generated traces', () => {
  const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

  it('agrees with ground truth on every valid sequence, and never flags the correct model', () => {
    let valid = 0;
    let invalid = 0;
    let stale = 0;
    let quiet = 0;
    for (const seed of SEEDS) {
      const { actions } = generate(seed);
      if (sequenceProblem(actions, scenario().targets)) {
        invalid += 1;
        continue;
      }
      valid += 1;
      const s = scenario({ actions, requirements: [req] });
      expect(evaluate(s, simulate(actions, false)), `seed ${seed}, correct model`).toEqual([]);
      const truth = staleCompletionVisible(actions);
      const flagged = evaluate(s, simulate(actions, true)).length > 0;
      expect(flagged, `seed ${seed}, stale model`).toBe(truth);
      if (truth) stale += 1;
      else quiet += 1;
    }
    // Denominators stay explicit: every seed lands in exactly one bucket.
    expect(valid + invalid).toBe(SEEDS.length);
    expect(stale + quiet).toBe(valid);
    expect(invalid).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(50);
    expect(quiet).toBeGreaterThan(50);
  });

  it('flags the stale model on a known interleaving', () => {
    const actions: Action[] = [
      { type: 'activate', target: 'trigger', at: 0, requests: { panel: 'open' } },
      { type: 'activate', target: 'trigger', at: 400, requests: { panel: 'closed' } },
      { type: 'activate', target: 'trigger', at: 500, requests: { panel: 'open' } },
    ];
    const s = scenario({ actions, requirements: [req] });
    const [v] = evaluate(s, simulate(actions, true));
    expect(v?.category).toBe('stale-final-state');
    expect(v?.at.t).toBe(640);
  });
});
