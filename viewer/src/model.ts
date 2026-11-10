import type { Action, Requirement, Scenario } from '../../src/scenario/schema.ts';
import type { NodeRef, Rect, Screenshot, TraceEvent, Violation } from '../../src/trace/types.ts';
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

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The stages are drawn at this shape, so the deck keeps its height whatever they frame. */
export const STAGE_ASPECT = 2;

/** Adds a margin to a box and widens or deepens it to the stage's shape, about its centre. */
export function fit(box: Frame, margin = Math.max(12, Math.max(box.w, box.h) * 0.08)): Frame {
  let w = box.w + margin * 2;
  let h = box.h + margin * 2;
  if (w / h < STAGE_ASPECT) w = h * STAGE_ASPECT;
  else h = w / STAGE_ASPECT;
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
}

function bounds(rects: Rect[]): Frame {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  return { x: left, y: top, w: Math.max(...rects.map((r) => r.x + r.w)) - left, h: Math.max(...rects.map((r) => r.y + r.h)) - top };
}

/** The stretch of the run an action owns: from its start to the start of the next one. */
export function actionSpan(line: Timelines, time: number): { from: number; to: number } {
  const next = line.actions.find((a) => a.t > time);
  const from = line.actions.filter((a) => a.t <= time).at(-1)?.t ?? 0;
  return { from, to: next?.t ?? Infinity };
}

/**
 * The region the stages show while one action plays out: everything either build
 * recorded from that action until the next, and whatever was already in place.
 * Both stages share it, so a position on one means the same thing on the other,
 * and it only changes when the action does, so the frame never moves under a motion.
 * The full viewport would leave the action as a speck in a corner.
 */
export function frameAt(lines: Timelines[], time: number, fallback: { width: number; height: number }): Frame {
  const { from, to } = actionSpan(lines[0]!, time);
  const rects = lines.flatMap((line) => [...line.rects.entries()].flatMap(([target, samples]) => {
    const standing = rectAt(line, target, from);
    const during = samples.flatMap((g) => (g.rect && g.t >= from && g.t < to ? [g.rect] : []));
    return standing ? [standing, ...during] : during;
  }));
  if (rects.length === 0) return fit({ x: 0, y: 0, w: fallback.width, h: fallback.height }, 0);
  return fit(bounds(rects));
}

/** The close view of a measured failure: where the target should have started, and where it did. */
export function failureFrame(gap: OriginGap): Frame {
  const box = bounds([gap.from, gap.to]);
  return fit(box, Math.max(24, Math.max(box.w, box.h) * 0.34));
}

/**
 * The screenshot that shows the page as the trace has it at `time`, or null.
 * Screenshots come from a separate pass, so one is only offered under controlled
 * time, where both passes reach the same state at the same moment. An action's
 * own screenshot is taken after it ran and comes last among those at its time.
 */
export function shotAt(side: RunSide, time: number, within: number): Screenshot | null {
  if (side.clock.mode !== 'controlled') return null;
  return side.screenshots.filter((s) => Math.abs(s.t - time) < within).at(-1) ?? null;
}

/** Whether a screenshot was taken as the clock reached an action's time, before that action ran. */
export function takenBefore(shot: Screenshot, shots: Screenshot[]): boolean {
  return shot.label.startsWith('at ') && shots.findLast((s) => s.t === shot.t) !== shot;
}

/** The whole window, at the stage's shape. */
export function windowFrame(viewport: { width: number; height: number }): Frame {
  return fit({ x: 0, y: 0, w: viewport.width, h: viewport.height }, 0);
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

/** One plain sentence for each requirement, with no closing period, so a passing report still says what held. */
export function describeRequirement(r: Requirement): string {
  switch (r.kind) {
    case 'latest-request-wins':
      return `The latest request owns ${r.key}`;
    case 'focus-stays-on':
      return `${r.target} keeps focus on the same node while ${entries(r.whileState)}`;
    case 'focus-restored':
      return `Focus returns to ${r.to} within ${r.withinMs} ms of ${entries(r.whenState)}`;
    case 'focus-valid':
      return 'Focus never sits on a hidden, inert or detached element';
    case 'geometry-continuous':
      return `${r.target} moves at most ${r.maxStepPx} px between samples`;
    case 'geometry-origin':
      return `${r.target} appears at ${r.anchor} or at its final position (within ${r.tolerancePx} px)`;
    case 'geometry-fits':
      return `${r.target} stays ${r.insetPx} px inside the viewport after a resize`;
    case 'single-interactive':
      return `Only one live ${r.target} exists at a time`;
    case 'relationship-resolves':
      return `${r.attribute} on ${r.from} resolves to one element, ${r.to}`;
    case 'transient-cleared':
      return `${entries(r.state)} after ${r.after}`;
    case 'resources-released':
      return `Listeners, observers and timers return to their count before mount`;
  }
}

const entries = (state: Record<string, unknown>): string =>
  Object.entries(state).map(([k, v]) => `${k} is ${String(v)}`).join(' and ');

export function requirementStatus(index: number, side: RunSide): 'held' | 'broken' | 'not exercised' | 'not run' {
  if (side.status === 'invalid') return 'not run';
  const status = side.requirements?.find((r) => r.index === index)?.status ?? 'not-exercised';
  return status === 'not-exercised' ? 'not exercised' : status;
}

/** Acknowledgements are not in the requirement list, so they get their own row. */
export function ackStatus(side: RunSide): 'held' | 'broken' | 'not run' {
  if (side.status === 'invalid') return 'not run';
  return side.violations.some((v) => v.category === 'missed-ack') ? 'broken' : 'held';
}

/** Sorted times at which anything was recorded, on either build. */
export function busyTimes(a: TraceEvent[], b: TraceEvent[]): { t: number }[] {
  return [...new Set([...a, ...b].map((e) => e.t))].sort((x, y) => x - y).map((t) => ({ t }));
}

const IDLE_GAP_MS = 120;

/** Moves a playback time past a quiet gap, stopping just before the next event. */
export function skipIdle(busy: { t: number }[], time: number): number {
  const index = lastAt(busy, time);
  const next = busy[index + 1]?.t;
  if (next === undefined) return time;
  if (next - (busy[index]?.t ?? 0) < IDLE_GAP_MS) return time;
  return Math.max(time, next - 40);
}

export function formatMs(t: number): string {
  return `${Math.round(t)} ms`;
}

/**
 * What a row calls an action. A resize says its size, because a note such as
 * "widen" describes the session it was written for and a reduced session can
 * reach the same width from the other side.
 */
export function actionName(a: Action): string {
  if (a.type === 'resize') return `resize to ${a.width} × ${a.height}`;
  return a.note ?? a.type;
}

export interface OriginGap {
  /** Where the target should have started. */
  from: Rect;
  /** Where it did start. */
  to: Rect;
  px: number;
  t: number;
  target: string;
  anchor: string;
}

/**
 * The two rectangles behind a `geometry-origin` failure, read the way the oracle
 * read them: the target's first sample, and the anchor's last one before it.
 */
export function originGap(c: ReportCase): OriginGap | null {
  const v = primaryViolation(c);
  const side = failingSide(c);
  if (!v || !side || v.index === undefined) return null;
  const r = c.scenario.requirements[v.index];
  if (r?.kind !== 'geometry-origin') return null;
  const geometry = pick(c[side].events, 'geometry');
  const hit = geometry.find((g) => g.target === r.target && g.seq === v.at.seq);
  const anchor = geometry.filter((g) => g.target === r.anchor && g.seq < v.at.seq && g.rect).at(-1);
  if (!hit?.rect || !anchor?.rect) return null;
  const a = hit.rect;
  const b = anchor.rect;
  const px = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - (b.x + b.w)), Math.abs(a.y + a.h - (b.y + b.h)));
  return { from: b, to: a, px: Math.round(px), t: v.at.t, target: r.target, anchor: r.anchor };
}
