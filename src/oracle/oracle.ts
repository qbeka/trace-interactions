import type { Category, Primitive, Requirement, Scenario } from '../scenario/schema.ts';
import type { Rect, TraceEvent, Violation } from '../trace/types.ts';

/**
 * The oracle reads one scenario and one trace. It never sees the other build.
 * That is what lets it fail a baseline, and what makes "both builds agree" worth
 * nothing on its own.
 *
 * Every function here is pure, so the unit tests drive it with hand-written and
 * model-generated traces, without a browser.
 */

type Of<K extends TraceEvent['k']> = Extract<TraceEvent, { k: K }>;
type At = Pick<TraceEvent, 'seq' | 't' | 'tick'>;

const only = <K extends TraceEvent['k']>(events: TraceEvent[], k: K): Of<K>[] =>
  events.filter((e): e is Of<K> => e.k === k);

function violation(req: string, category: Category, sentence: string, at: At, target: string | null): Violation {
  return {
    requirement: req,
    category,
    sentence,
    at: { seq: at.seq, t: at.t, tick: at.tick },
    target,
    fingerprint: `${category}/${req}/${target ?? '-'}`,
  };
}

const CATEGORY: Record<Requirement['kind'], Category> = {
  'latest-request-wins': 'stale-final-state',
  'focus-stays-on': 'lost-focus',
  'focus-restored': 'lost-focus',
  'focus-valid': 'lost-focus',
  'geometry-continuous': 'geometry-discontinuity',
  'geometry-origin': 'geometry-discontinuity',
  'geometry-fits': 'geometry-discontinuity',
  'single-interactive': 'duplicate-interactive',
  'relationship-resolves': 'duplicate-interactive',
  'transient-cleared': 'incomplete-cleanup',
  'resources-released': 'incomplete-cleanup',
};

const fmt = (v: Primitive): string => (v === null ? 'null' : String(v));

/** Actions in the main list that actually started, by index. */
function starts(events: TraceEvent[]): Of<'action'>[] {
  return only(events, 'action').filter((e) => e.phase === 'start' && !e.cleanup);
}

/** Holds the state value in force at the end of a tick, by key. */
function stateTimeline(events: TraceEvent[]) {
  const states = only(events, 'state');
  return (key: string, atTick: number): Primitive | undefined => {
    let value: Primitive | undefined;
    for (const s of states) {
      if (s.tick > atTick) break;
      if (s.key === key) value = s.value;
    }
    return value;
  };
}

function holdsAt(state: ReturnType<typeof stateTimeline>, want: Record<string, Primitive>, tick: number): boolean {
  return Object.entries(want).every(([k, v]) => state(k, tick) === v);
}

function latestRequestWins(s: Scenario, r: Extract<Requirement, { kind: 'latest-request-wins' }>, events: TraceEvent[]): Violation[] {
  const requests = starts(events)
    .map((e) => ({ e, value: s.actions[e.index]?.requests?.[r.key] }))
    .filter((x): x is { e: Of<'action'>; value: Primitive } => x.value !== undefined);
  if (requests.length === 0) return [];
  const out: Violation[] = [];
  const last = requests.at(-1)!;
  for (const st of only(events, 'state')) {
    if (st.key !== r.key || !r.terminal.includes(st.value)) continue;
    const owner = requests.filter((q) => q.e.seq < st.seq).at(-1);
    if (owner && st.value !== owner.value) {
      out.push(
        violation(
          r.kind,
          'stale-final-state',
          `${r.key} became "${fmt(st.value)}" at ${st.t} ms, but the latest request at ${owner.e.t} ms was "${fmt(owner.value)}".`,
          st,
          r.key,
        ),
      );
      break;
    }
  }
  if (out.length === 0) {
    const finals = only(events, 'state').filter((st) => st.key === r.key && st.seq > last.e.seq && !isCleanupEra(events, st));
    const end = finals.at(-1)?.value;
    if (finals.length > 0 && end !== last.value) {
      out.push(
        violation(r.kind, 'stale-final-state', `${r.key} ended as "${fmt(end ?? null)}", but the latest request was "${fmt(last.value)}".`, finals.at(-1)!, r.key),
      );
    }
  }
  return out;
}

function isCleanupEra(events: TraceEvent[], e: At): boolean {
  const first = only(events, 'action').find((a) => a.cleanup && a.phase === 'start');
  return first !== undefined && e.seq > first.seq;
}

const FOCUS_MOVING: ReadonlySet<string> = new Set(['focus', 'activate', 'press', 'pointerDown', 'type']);

/**
 * True if the event happened while an action that may move focus was running.
 * Only the action in progress can excuse a focus change: an earlier `type` says
 * nothing about focus lost during a later resize.
 */
function duringFocusAction(events: TraceEvent[], at: At): boolean {
  const all = only(events, 'action');
  return all.some((a) => {
    if (a.phase !== 'start' || !FOCUS_MOVING.has(a.type)) return false;
    const end = all.find((b) => b.phase === 'end' && b.index === a.index && b.cleanup === a.cleanup);
    return a.seq < at.seq && (end === undefined || at.seq < end.seq);
  });
}

function focusStaysOn(s: Scenario, r: Extract<Requirement, { kind: 'focus-stays-on' }>, events: TraceEvent[]): Violation[] {
  const traceId = s.targets[r.target]!.traceId!;
  const state = stateTimeline(events);
  let held: { node: number } | null = null;
  for (const f of only(events, 'focus')) {
    if (isCleanupEra(events, f)) break;
    if (f.ref?.traceId === traceId) {
      if (held && f.ref.node !== held.node && holdsAt(state, r.whileState, f.tick)) {
        return [violation(r.kind, 'lost-focus', `${r.target} was remounted at ${f.t} ms, so the focused node was replaced.`, f, r.target)];
      }
      held = { node: f.ref.node };
      continue;
    }
    if (!held) continue;
    if (!duringFocusAction(events, f) && holdsAt(state, r.whileState, f.tick)) {
      const where = f.ref ? (f.ref.traceId ?? f.ref.tag) : 'the page body';
      return [violation(r.kind, 'lost-focus', `${r.target} lost focus to ${where} at ${f.t} ms with no user action.`, f, r.target)];
    }
    held = null;
  }
  return [];
}

function focusRestored(s: Scenario, r: Extract<Requirement, { kind: 'focus-restored' }>, events: TraceEvent[]): Violation[] {
  const traceId = s.targets[r.to]!.traceId!;
  const focus = only(events, 'focus');
  const state = stateTimeline(events);
  const keyed = only(events, 'state').filter((st) => st.key in r.whenState);
  let wasHolding = holdsAt(state, r.whenState, -1);
  const actionEnds = only(events, 'action');
  for (const st of keyed) {
    const holds = holdsAt(state, r.whenState, st.tick);
    if (holds && !wasHolding) {
      // Only closes that a scenario action caused count. The first render does not.
      if (actionEnds.some((a) => a.seq < st.seq) && !isCleanupEra(events, st)) {
        // Judged where the state stops holding or at the deadline, whichever is
        // first. If the user reopens at once, focus moving on is correct.
        const ended = keyed.find((x) => x.seq > st.seq && !holdsAt(state, r.whenState, x.tick));
        const untilTick = ended ? ended.tick : Infinity;
        const deadline = st.t + r.withinMs;
        const inWindow = (e: At): boolean => e.tick < untilTick && e.t <= deadline;
        const held = focus.filter(inWindow).at(-1);
        const after = events.filter((e) => e.seq >= st.seq && inWindow(e)).at(-1) ?? st;
        if (held?.ref?.traceId !== traceId || held.ref.hidden) {
          const where = held?.ref ? (held.ref.traceId ?? held.ref.tag) : 'the page body';
          return [violation(r.kind, 'lost-focus', `Focus should return to ${r.to}, but it was on ${where} at ${after.t} ms.`, after, r.to)];
        }
      }
    }
    wasHolding = holds;
  }
  return [];
}

function focusValid(events: TraceEvent[]): Violation[] {
  for (const f of only(events, 'focus')) {
    if (!f.ref) continue;
    if (!f.ref.connected || f.ref.hidden) {
      const name = f.ref.traceId ?? f.ref.tag;
      const why = f.ref.connected ? 'a hidden or inert element' : 'a detached element';
      return [violation('focus-valid', 'lost-focus', `Focus moved to ${why} (${name}) at ${f.t} ms.`, f, f.ref.traceId)];
    }
  }
  return [];
}

function edgeStep(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.w - (b.x + b.w)),
    Math.abs(a.y + a.h - (b.y + b.h)),
  );
}

function geometryContinuous(r: Extract<Requirement, { kind: 'geometry-continuous' }>, events: TraceEvent[]): Violation[] {
  const resizes = only(events, 'action').filter((a) => a.type === 'resize' && a.phase === 'start');
  const ends = only(events, 'action').filter((a) => a.type === 'resize' && a.phase === 'end');
  // A resize moves things on purpose. Skip pairs that span one, up to the next
  // sample after it ended, so that only movement inside a transition is judged.
  const spansResize = (a: At, b: At): boolean =>
    resizes.some((s, i) => {
      const end = ends[i];
      return a.seq < (end?.seq ?? Infinity) && b.tick <= (end?.tick ?? Infinity) + 1 && b.seq > s.seq;
    });
  let prev: Of<'geometry'> | null = null;
  for (const g of only(events, 'geometry')) {
    if (g.target !== r.target) continue;
    if (g.rect && prev?.rect && g.node === prev.node && !spansResize(prev, g)) {
      const step = edgeStep(prev.rect, g.rect);
      if (step > r.maxStepPx) {
        return [
          violation(r.kind, 'geometry-discontinuity', `${r.target} jumped ${Math.round(step)} px in one sample at ${g.t} ms. The limit is ${r.maxStepPx} px.`, g, r.target),
        ];
      }
    }
    prev = g;
  }
  return [];
}

function geometryOrigin(r: Extract<Requirement, { kind: 'geometry-origin' }>, events: TraceEvent[]): Violation[] {
  const geometry = only(events, 'geometry');
  const samples = geometry.filter((g) => g.target === r.target);
  for (const [i, g] of samples.entries()) {
    const previous = samples[i - 1];
    if (!g.rect || previous?.rect) continue;
    const anchor = geometry.filter((a) => a.target === r.anchor && a.seq < g.seq && a.rect).at(-1);
    // Where the entrance ended: the last rect before the target vanished or the
    // next action began. A later resize moves it for a different reason.
    const next = starts(events).find((a) => a.seq > g.seq)?.seq ?? Infinity;
    const stop = samples.slice(i).findIndex((x) => !x.rect || x.seq > next);
    const rest = stop === -1 ? samples.slice(i) : samples.slice(i, i + stop);
    const final = rest.at(-1)?.rect;
    if (!anchor?.rect || !final) continue;
    const fromAnchor = edgeStep(g.rect, anchor.rect);
    const fromFinal = edgeStep(g.rect, final);
    if (fromAnchor > r.tolerancePx && fromFinal > r.tolerancePx) {
      return [
        violation(
          r.kind,
          'geometry-discontinuity',
          `${r.target} appeared ${Math.round(fromAnchor)} px away from ${r.anchor} at ${g.t} ms. It should start at ${r.anchor} or at its final position.`,
          g,
          r.target,
        ),
      ];
    }
  }
  return [];
}

function geometryFits(r: Extract<Requirement, { kind: 'geometry-fits' }>, events: TraceEvent[]): Violation[] {
  const viewports = only(events, 'viewport');
  const geometry = only(events, 'geometry').filter((g) => g.target === r.target);
  const main = starts(events);
  for (const a of only(events, 'action').filter((e) => e.type === 'resize' && e.phase === 'end' && !e.cleanup)) {
    const vp = viewports.filter((v) => v.seq < a.seq).at(-1);
    if (!vp) continue;
    const next = main.find((m) => m.seq > a.seq);
    const before = geometry.filter((g) => g.seq < (next?.seq ?? Infinity)).at(-1);
    if (!before?.rect) continue;
    const limit = r.insetPx - r.tolerancePx;
    const { x, y, w, h } = before.rect;
    const over = Math.max(limit - x, limit - y, x + w - (vp.width - limit), y + h - (vp.height - limit));
    if (over > 0) {
      return [
        violation(r.kind, 'geometry-discontinuity', `${r.target} overflows the ${vp.width}x${vp.height} viewport by ${Math.round(over)} px after the resize.`, before, r.target),
      ];
    }
  }
  return [];
}

function singleInteractive(r: Extract<Requirement, { kind: 'single-interactive' }>, events: TraceEvent[]): Violation[] {
  for (const g of only(events, 'geometry')) {
    if (g.target === r.target && g.interactive > 1) {
      return [violation(r.kind, 'duplicate-interactive', `${g.interactive} live copies of ${r.target} existed at ${g.t} ms.`, g, r.target)];
    }
  }
  for (const a of only(events, 'a11y')) {
    if (a.target === r.target && a.matches > 1) {
      return [violation(r.kind, 'duplicate-interactive', `${a.matches} elements answered to ${r.target} in the accessibility tree at ${a.t} ms.`, a, r.target)];
    }
  }
  return [];
}

function relationshipResolves(s: Scenario, r: Extract<Requirement, { kind: 'relationship-resolves' }>, events: TraceEvent[]): Violation[] {
  const want = s.targets[r.to]!.traceId!;
  for (const rel of only(events, 'relation')) {
    if (rel.from !== r.from || rel.attribute !== r.attribute || rel.id === null) continue;
    if (rel.matches === 0) continue; // the panel is closed, so the id has nothing to point at yet
    if (rel.matches > 1 || rel.resolved !== want) {
      return [
        violation(
          r.kind,
          'duplicate-interactive',
          `${r.attribute} on ${r.from} points at "${rel.id}", which matched ${rel.matches} element(s) and resolved to ${rel.resolved ?? 'an unmarked element'}, not ${r.to}.`,
          rel,
          r.to,
        ),
      ];
    }
  }
  return [];
}

function transientCleared(r: Extract<Requirement, { kind: 'transient-cleared' }>, events: TraceEvent[]): Violation[] {
  const state = stateTimeline(events);
  const actions = only(events, 'action').filter((a) => a.type === r.after && a.phase === 'end' && !a.cleanup);
  const main = starts(events);
  const lastTick = events.at(-1)?.tick ?? 0;
  for (const a of actions) {
    const next = main.find((m) => m.seq > a.seq);
    const settled = next ? next.tick : lastTick;
    for (const [key, value] of Object.entries(r.state)) {
      if (state(key, settled) !== value) {
        const at = next ?? a;
        return [violation(r.kind, 'incomplete-cleanup', `${key} was still ${fmt(state(key, settled) ?? null)} after ${r.after} at ${a.t} ms. It should be ${fmt(value)}.`, at, key)];
      }
    }
  }
  return [];
}

function resourcesReleased(r: Extract<Requirement, { kind: 'resources-released' }>, events: TraceEvent[]): Violation[] {
  const ignore = new Set(r.ignore ?? []);
  const checkpoints = only(events, 'resources');
  const state = stateTimeline(events);
  const removed = (tick: number): boolean => state(r.key, tick) === r.removedValue;
  const before = checkpoints.find((c) => removed(c.tick));
  const after = checkpoints.at(-1);
  if (!before || !after || before === after || !removed(after.tick)) return [];
  for (const [key, count] of Object.entries(after.counts)) {
    if (ignore.has(key)) continue;
    const allowed = before.counts[key] ?? 0;
    if (count > allowed) {
      return [violation(r.kind, 'incomplete-cleanup', `${count - allowed} ${key} still active after removal. There were ${allowed} before mount.`, after, key)];
    }
  }
  return [];
}

function acks(s: Scenario, events: TraceEvent[]): Violation[] {
  const out: Violation[] = [];
  const states = only(events, 'state');
  for (const a of starts(events)) {
    const action = s.actions[a.index];
    const ack = action?.ack;
    if (ack) {
      const accepts = (v: Primitive): boolean => ack.oneOf === undefined || ack.oneOf.includes(v);
      const hit = states.find((st) => st.seq > a.seq && st.key === ack.key && accepts(st.value) && st.t <= a.t + ack.withinMs);
      if (!hit) {
        const want = ack.oneOf ? `set ${ack.key} to ${ack.oneOf.map(fmt).join(' or ')}` : `change ${ack.key}`;
        out.push(violation('action-acknowledged', 'missed-ack', `"${a.label}" at ${a.t} ms did not ${want} within ${ack.withinMs} ms.`, a, ack.key));
        break;
      }
    }
  }
  for (const w of only(events, 'wait-timeout')) {
    out.push(violation('wait-condition', 'missed-ack', `The condition for action ${w.index} never held.`, w, null));
    break;
  }
  return out;
}

/** Runs every declared requirement. The earliest violation comes first. */
export function evaluate(s: Scenario, events: TraceEvent[]): Violation[] {
  const out: Violation[] = [...acks(s, events)];
  for (const r of s.requirements) {
    switch (r.kind) {
      case 'latest-request-wins':
        out.push(...latestRequestWins(s, r, events));
        break;
      case 'focus-stays-on':
        out.push(...focusStaysOn(s, r, events));
        break;
      case 'focus-restored':
        out.push(...focusRestored(s, r, events));
        break;
      case 'focus-valid':
        out.push(...focusValid(events));
        break;
      case 'geometry-continuous':
        out.push(...geometryContinuous(r, events));
        break;
      case 'geometry-origin':
        out.push(...geometryOrigin(r, events));
        break;
      case 'geometry-fits':
        out.push(...geometryFits(r, events));
        break;
      case 'single-interactive':
        out.push(...singleInteractive(r, events));
        break;
      case 'relationship-resolves':
        out.push(...relationshipResolves(s, r, events));
        break;
      case 'transient-cleared':
        out.push(...transientCleared(r, events));
        break;
      case 'resources-released':
        out.push(...resourcesReleased(r, events));
        break;
    }
  }
  return out.sort((a, b) => a.at.seq - b.at.seq);
}

export { CATEGORY };
