import type { Requirement, Scenario } from '../../src/scenario/schema.ts';
import type { NodeRef, Rect, TraceEvent, Violation } from '../../src/trace/types.ts';
import type { ReportCase, RunSide } from './types.ts';

/**
 * Pure reading of a saved trace. The viewer draws everything from these
 * functions, and the tests call them without a DOM.
 */

type Of<K extends TraceEvent['k']> = Extract<TraceEvent, { k: K }>;

export const pick = <K extends TraceEvent['k']>(events: TraceEvent[], k: K): Of<K>[] =>
  events.filter((e): e is Of<K> => e.k === k);

/** Index of the last item with `t <= time`, or -1. Events are sorted by time. */
export function lastAt<T extends { t: number }>(items: T[], time: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (items[mid]!.t <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export interface Timelines {
  rects: Map<string, Of<'geometry'>[]>;
  focus: Of<'focus'>[];
  states: Map<string, Of<'state'>[]>;
  viewports: Of<'viewport'>[];
  actions: Of<'action'>[];
  end: number;
}

export function timelines(events: TraceEvent[]): Timelines {
  const rects = new Map<string, Of<'geometry'>[]>();
  const states = new Map<string, Of<'state'>[]>();
  for (const e of events) {
    if (e.k === 'geometry') {
      if (!rects.has(e.target)) rects.set(e.target, []);
      rects.get(e.target)!.push(e);
    } else if (e.k === 'state') {
      if (!states.has(e.key)) states.set(e.key, []);
      states.get(e.key)!.push(e);
    }
  }
  return {
    rects,
    states,
    focus: pick(events, 'focus'),
    viewports: pick(events, 'viewport'),
    actions: pick(events, 'action').filter((a) => a.phase === 'start' && !a.cleanup),
    end: events.at(-1)?.t ?? 0,
  };
}

export function rectAt(line: Timelines, target: string, time: number): Rect | null {
  const samples = line.rects.get(target);
  if (!samples) return null;
  return samples[lastAt(samples, time)]?.rect ?? null;
}

export function focusAt(line: Timelines, time: number): NodeRef | null {
  return line.focus[lastAt(line.focus, time)]?.ref ?? null;
}

export function stateAt(line: Timelines, key: string, time: number): string | null {
  const samples = line.states.get(key);
  if (!samples) return null;
  const hit = samples[lastAt(samples, time)];
  return hit ? String(hit.value) : null;
}

export function viewportAt(line: Timelines, time: number, fallback: { width: number; height: number }) {
  return line.viewports[lastAt(line.viewports, time)] ?? fallback;
}

/** The path a target took since it last appeared, up to `time`. */
export function trailAt(line: Timelines, target: string, time: number): { x: number; y: number }[] {
  const samples = line.rects.get(target);
  if (!samples) return [];
  const last = lastAt(samples, time);
  const points: { x: number; y: number }[] = [];
  for (let i = last; i >= 0; i--) {
    const r = samples[i]!.rect;
    if (!r) break;
    points.unshift({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  }
  return points;
}

/**
 * Maps a baseline time to the same moment on the candidate. Controlled runs
 * share a clock and this is the identity. Wall runs differ, so time is stretched
 * between action starts: the two traces line up by action, not by milliseconds.
 */
export function alignTime(from: Timelines, to: Timelines, time: number): number {
  const anchors: [number, number][] = [[0, 0]];
  const count = Math.min(from.actions.length, to.actions.length);
  for (let i = 0; i < count; i++) anchors.push([from.actions[i]!.t, to.actions[i]!.t]);
  anchors.push([from.end, to.end]);
  for (let i = 1; i < anchors.length; i++) {
    const [a0, b0] = anchors[i - 1]!;
    const [a1, b1] = anchors[i]!;
    if (time <= a1) return a1 === a0 ? b1 : b0 + ((time - a0) / (a1 - a0)) * (b1 - b0);
  }
  return to.end;
}

export interface Segment {
  from: number;
  to: number;
  value: string;
}

/** State over time as bars for the trace strip. */
export function stateSegments(line: Timelines, key: string): Segment[] {
  const samples = line.states.get(key) ?? [];
  return samples.map((s, i) => ({ from: s.t, to: samples[i + 1]?.t ?? line.end, value: String(s.value) })).filter((s) => s.to > s.from || s === undefined);
}

export function focusName(ref: NodeRef | null): string {
  if (!ref) return 'body';
  return ref.traceId ?? ref.tag;
}

export function focusSegments(line: Timelines): Segment[] {
  const out: Segment[] = [];
  for (const [i, f] of line.focus.entries()) {
    const to = line.focus[i + 1]?.t ?? line.end;
    if (to > f.t) out.push({ from: f.t, to, value: focusName(f.ref) });
  }
  return out;
}

/** The state key the requirements care about most, for the strip. */
export function mainStateKey(s: Scenario): string | null {
  for (const r of s.requirements) {
    if (r.kind === 'latest-request-wins') return r.key;
  }
  for (const r of s.requirements) {
    if (r.kind === 'focus-stays-on') return Object.keys(r.whileState)[0] ?? null;
    if (r.kind === 'focus-restored') return Object.keys(r.whenState)[0] ?? null;
    if (r.kind === 'transient-cleared') return Object.keys(r.state)[0] ?? null;
    if (r.kind === 'resources-released') return r.key;
  }
  for (const a of s.actions) {
    const key = Object.keys(a.requests ?? {})[0];
    if (key) return key;
  }
  return null;
}

/** The target whose path the stage draws: the first one a geometry requirement names. */
export function primaryTarget(s: Scenario): string | null {
  for (const r of s.requirements) {
    if (r.kind === 'geometry-origin' || r.kind === 'geometry-continuous' || r.kind === 'geometry-fits' || r.kind === 'single-interactive') return r.target;
  }
  return Object.keys(s.targets).find((n) => s.targets[n]?.traceId) ?? null;
}

export function primaryViolation(c: ReportCase): Violation | null {
  return c.comparison.introduced[0] ?? c.comparison.shared[0] ?? c.comparison.resolved[0] ?? null;
}

export function failingSide(c: ReportCase): 'baseline' | 'candidate' | null {
  if (c.comparison.introduced.length > 0 || c.comparison.shared.length > 0) return 'candidate';
  if (c.comparison.resolved.length > 0) return 'baseline';
  return null;
}

/** Plain sentence for each requirement, so a passing report still says what held. */
export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case 'latest-request-wins':
      return `The latest request owns ${r.key}.`;
    case 'focus-stays-on':
      return `${r.target} keeps focus on the same node while ${entries(r.whileState)}.`;
    case 'focus-restored':
      return `Focus returns to ${r.to} within ${r.withinMs} ms of ${entries(r.whenState)}.`;
    case 'focus-valid':
      return 'Focus never sits on a hidden, inert or detached element.';
    case 'geometry-continuous':
      return `${r.target} moves at most ${r.maxStepPx} px between samples.`;
    case 'geometry-origin':
      return `${r.target} appears at ${r.anchor} or at its final position (within ${r.tolerancePx} px).`;
    case 'geometry-fits':
      return `${r.target} stays ${r.insetPx} px inside the viewport after a resize.`;
    case 'single-interactive':
      return `Only one live ${r.target} exists at a time.`;
    case 'relationship-resolves':
      return `${r.attribute} on ${r.from} resolves to one element, ${r.to}.`;
    case 'transient-cleared':
      return `${entries(r.state)} after ${r.after}.`;
    case 'resources-released':
      return `Listeners, observers and timers return to their count before mount.`;
  }
}

const entries = (state: Record<string, unknown>): string =>
  Object.entries(state).map(([k, v]) => `${k} is ${String(v)}`).join(' and ');

export function requirementStatus(r: Requirement, side: RunSide): 'held' | 'broken' | 'not run' {
  if (side.status === 'invalid') return 'not run';
  return side.violations.some((v) => v.requirement === r.kind) ? 'broken' : 'held';
}

export function formatMs(t: number): string {
  return `${Math.round(t)} ms`;
}
