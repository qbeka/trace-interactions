import type { Category, Primitive, Requirement, Scenario } from '../scenario/schema.ts';
import type { Rect, RequirementResult, TraceEvent, Violation } from '../trace/types.ts';

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

/** Set by a check when it actually judged something, so an empty pass stays visible. */
interface Judged {
  n: number;
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

/** The value a key held just before the event with this sequence number. */
function valueBefore(events: TraceEvent[], key: string, seq: number): Primitive | undefined {
  return only(events, 'state').filter((st) => st.key === key && st.seq < seq).at(-1)?.value;
}

function holdsAt(state: ReturnType<typeof stateTimeline>, want: Record<string, Primitive>, tick: number): boolean {
  return Object.entries(want).every(([k, v]) => state(k, tick) === v);
}

function latestRequestWins(s: Scenario, r: Extract<Requirement, { kind: 'latest-request-wins' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const requests = starts(events)
    .map((e) => ({ e, value: s.actions[e.index]?.requests?.[r.key] }))
    .filter((x): x is { e: Of<'action'>; value: Primitive } => x.value !== undefined);
  if (requests.length === 0) return [];
  judged.n += 1;
  const last = requests.at(-1)!;
  const states = only(events, 'state').filter((st) => st.key === r.key && !isCleanupEra(events, st));
  for (const st of states) {
    if (!r.terminal.includes(st.value)) continue;
    const owner = requests.filter((q) => q.e.seq < st.seq).at(-1);
    if (owner && st.value !== owner.value) {
      return [
        violation(
          r.kind,
          'stale-final-state',
          `${r.key} became "${fmt(st.value)}" at ${st.t} ms, but the latest request at ${owner.e.t} ms was "${fmt(owner.value)}".`,
          st,
          r.key,
        ),
      ];
    }
  }
  // The key must end where the last request asked, even if it never changed:
  // a request the build ignored produces no event at all.
  const end = states.at(-1)?.value;
  if (end !== last.value) {
    return [violation(r.kind, 'stale-final-state', `${r.key} ended as "${fmt(end ?? null)}", but the latest request was "${fmt(last.value)}".`, states.at(-1) ?? last.e, r.key)];
  }
  return [];
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

function focusStaysOn(s: Scenario, r: Extract<Requirement, { kind: 'focus-stays-on' }>, events: TraceEvent[], judged: Judged): Violation[] {
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
      if (holdsAt(state, r.whileState, f.tick)) judged.n += 1;
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

function focusRestored(s: Scenario, r: Extract<Requirement, { kind: 'focus-restored' }>, events: TraceEvent[], judged: Judged): Violation[] {
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
        judged.n += 1;
        // Judged where the state stops holding, where the user next moves focus,
        // or at the deadline, whichever is first. Focus moving on after that is
        // the user's doing, not a failed restore.
        const ended = keyed.find((x) => x.seq > st.seq && !holdsAt(state, r.whenState, x.tick));
        const moved = starts(events).find((a) => a.seq > st.seq && FOCUS_MOVING.has(a.type));
        const untilTick = Math.min(ended?.tick ?? Infinity, moved?.tick ?? Infinity);
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

function focusValid(events: TraceEvent[], judged: Judged): Violation[] {
  for (const f of only(events, 'focus')) {
    if (!f.ref) continue;
    judged.n += 1;
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

function geometryContinuous(r: Extract<Requirement, { kind: 'geometry-continuous' }>, events: TraceEvent[], judged: Judged): Violation[] {
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
      judged.n += 1;
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

function geometryOrigin(r: Extract<Requirement, { kind: 'geometry-origin' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const geometry = only(events, 'geometry');
  const samples = geometry.filter((g) => g.target === r.target);
  for (const [i, g] of samples.entries()) {
    const previous = samples[i - 1];
    if (!g.rect || previous?.rect) continue;
    const anchor = geometry.filter((a) => a.target === r.anchor && a.seq < g.seq && a.rect).at(-1);
    // Where the entrance ended: the last rect before the target vanished or the
    // next resize began, which moves it for a different reason. Other actions do
    // not stop the search, or one in the same ms would hide the whole entrance.
    const next = starts(events).find((a) => a.seq > g.seq && a.type === 'resize')?.seq ?? Infinity;
    const stop = samples.slice(i).findIndex((x) => !x.rect || x.seq > next);
    const rest = stop === -1 ? samples.slice(i) : samples.slice(i, i + stop);
    const final = rest.at(-1)?.rect;
    if (!anchor?.rect || !final) continue;
    judged.n += 1;
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

/** A target that moved this recently is still in flight, so its rect says nothing yet. */
const DEFAULT_SETTLED_MS = 100;

function geometryFits(r: Extract<Requirement, { kind: 'geometry-fits' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const viewports = only(events, 'viewport');
  const geometry = only(events, 'geometry').filter((g) => g.target === r.target);
  const main = starts(events);
  const settledMs = r.settledMs ?? DEFAULT_SETTLED_MS;
  const endT = events.at(-1)?.t ?? 0;
  for (const a of only(events, 'action').filter((e) => e.type === 'resize' && e.phase === 'end' && !e.cleanup)) {
    const vp = viewports.filter((v) => v.seq < a.seq).at(-1);
    if (!vp) continue;
    const next = main.find((m) => m.seq > a.seq);
    const last = geometry.filter((g) => g.seq < (next?.seq ?? Infinity)).at(-1);
    if (!last?.rect) continue;
    if ((next?.t ?? endT) - last.t < settledMs) continue;
    judged.n += 1;
    const limit = r.insetPx - r.tolerancePx;
    const { x, y, w, h } = last.rect;
    const over = Math.max(limit - x, limit - y, x + w - (vp.width - limit), y + h - (vp.height - limit));
    if (over > 0) {
      return [
        violation(r.kind, 'geometry-discontinuity', `${r.target} overflows the ${vp.width}x${vp.height} viewport by ${Math.round(over)} px after the resize.`, last, r.target),
      ];
    }
  }
  return [];
}

function singleInteractive(r: Extract<Requirement, { kind: 'single-interactive' }>, events: TraceEvent[], judged: Judged): Violation[] {
  for (const g of only(events, 'geometry')) {
    if (g.target === r.target && g.interactive > 0) judged.n += 1;
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

function relationshipResolves(s: Scenario, r: Extract<Requirement, { kind: 'relationship-resolves' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const want = s.targets[r.to]!.traceId!;
  const relations = only(events, 'relation').filter((x) => x.from === r.from && x.attribute === r.attribute);
  const broken = (rel: Of<'relation'>, at: At): Violation =>
    violation(
      r.kind,
      'duplicate-interactive',
      `${r.attribute} on ${r.from} points at "${rel.id ?? 'nothing'}", which matched ${rel.matches} element(s) and resolved to ${rel.resolved || 'an unmarked element'}, not ${r.to}.`,
      at,
      r.to,
    );
  for (const rel of relations) {
    if (rel.matches > 1) return [broken(rel, rel)];
  }
  // While the target exists, the reference must reach it. While it does not, an
  // unresolved id is normal, such as aria-controls on a closed panel.
  for (const g of only(events, 'geometry')) {
    if (g.target !== r.to || !g.rect) continue;
    const rel = relations.filter((x) => x.tick <= g.tick).at(-1);
    if (!rel) continue;
    judged.n += 1;
    const resolved = (rel.resolved ?? '').split(' ');
    if (rel.id === null || rel.missing > 0 || !resolved.includes(want)) return [broken(rel, g)];
  }
  return [];
}

function transientCleared(r: Extract<Requirement, { kind: 'transient-cleared' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const actions = only(events, 'action').filter((a) => a.type === r.after && a.phase === 'end' && !a.cleanup);
  const main = starts(events);
  const end = (events.at(-1)?.seq ?? 0) + 1;
  const captures = only(events, 'event');
  for (const a of actions) {
    // Judged just before the next action. That action may rightly set the same state again.
    const next = main.find((m) => m.seq > a.seq);
    if (next && next.t - a.t < (r.settledMs ?? 0)) continue;
    judged.n += 1;
    const limit = next?.seq ?? end;
    for (const [key, value] of Object.entries(r.state)) {
      const found = valueBefore(events, key, limit);
      if (found !== value) {
        return [violation(r.kind, 'incomplete-cleanup', `${key} was still ${fmt(found ?? null)} after ${r.after} at ${a.t} ms. It should be ${fmt(value)}.`, next ?? a, key)];
      }
    }
    const got = captures.filter((e) => e.seq < limit && e.name === 'gotpointercapture').length;
    const lost = captures.filter((e) => e.seq < limit && e.name === 'lostpointercapture').length;
    if (r.after !== 'press' && got > lost) {
      return [violation(r.kind, 'incomplete-cleanup', `Pointer capture was still held after ${r.after} at ${a.t} ms.`, next ?? a, 'pointer-capture')];
    }
  }
  return [];
}

function resourcesReleased(r: Extract<Requirement, { kind: 'resources-released' }>, events: TraceEvent[], judged: Judged): Violation[] {
  const ignore = new Set(r.ignore ?? []);
  const checkpoints = only(events, 'resources');
  const state = stateTimeline(events);
  const removed = (tick: number): boolean => state(r.key, tick) === r.removedValue;
  const before = checkpoints.find((c) => removed(c.tick));
  const after = checkpoints.at(-1);
  // Needs a count from before mount and a removal. Otherwise there is nothing to compare.
  if (!before || !after || before === after || !removed(after.tick)) return [];
  const mountedBetween = only(events, 'state').some((st) => st.key === r.key && st.value !== r.removedValue && st.seq > before.seq && st.seq < after.seq);
  if (!mountedBetween) return [];
  judged.n += 1;
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
      // Only this action can acknowledge itself: a late answer to an earlier action
      // must not count, so the search ends where the next action starts.
      const next = starts(events).find((m) => m.seq > a.seq)?.seq ?? Infinity;
      const hit = states.find((st) => st.seq > a.seq && st.seq < next && st.key === ack.key && accepts(st.value) && st.t <= a.t + ack.withinMs);
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

function check(s: Scenario, r: Requirement, events: TraceEvent[], judged: Judged): Violation[] {
  switch (r.kind) {
    case 'latest-request-wins':
      return latestRequestWins(s, r, events, judged);
    case 'focus-stays-on':
      return focusStaysOn(s, r, events, judged);
    case 'focus-restored':
      return focusRestored(s, r, events, judged);
    case 'focus-valid':
      return focusValid(events, judged);
    case 'geometry-continuous':
      return geometryContinuous(r, events, judged);
    case 'geometry-origin':
      return geometryOrigin(r, events, judged);
    case 'geometry-fits':
      return geometryFits(r, events, judged);
    case 'single-interactive':
      return singleInteractive(r, events, judged);
    case 'relationship-resolves':
      return relationshipResolves(s, r, events, judged);
    case 'transient-cleared':
      return transientCleared(r, events, judged);
    case 'resources-released':
      return resourcesReleased(r, events, judged);
  }
}

export interface Evaluation {
  violations: Violation[];
  requirements: RequirementResult[];
}

/** Runs every declared requirement, and says which ones the run actually reached. */
export function evaluateAll(s: Scenario, events: TraceEvent[]): Evaluation {
  const violations: Violation[] = acks(s, events).map((v) => ({ ...v, index: -1 }));
  const requirements = s.requirements.map((r, index) => {
    const judged: Judged = { n: 0 };
    const found = check(s, r, events, judged);
    violations.push(...found.map((v) => ({ ...v, index })));
    const status: RequirementResult['status'] = found.length > 0 ? 'broken' : judged.n > 0 ? 'held' : 'not-exercised';
    return { index, kind: r.kind, status };
  });
  return { violations: violations.sort((a, b) => a.at.seq - b.at.seq), requirements };
}

/** The earliest violation comes first. */
export function evaluate(s: Scenario, events: TraceEvent[]): Violation[] {
  return evaluateAll(s, events).violations;
}

export { CATEGORY };
