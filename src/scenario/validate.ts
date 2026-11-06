import type { Action, Requirement, Scenario as ScenarioType } from './schema.ts';
import { Scenario } from './schema.ts';

/** A scenario problem is the author's to fix. It is never a product regression. */
export class InvalidScenario extends Error {
  constructor(
    readonly reason: string,
    readonly actionIndex: number | null = null,
  ) {
    super(actionIndex === null ? reason : `action ${actionIndex}: ${reason}`);
    this.name = 'InvalidScenario';
  }
}

export function parseScenario(raw: unknown): ScenarioType {
  const parsed = Scenario.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    throw new InvalidScenario(`${first.path.join('.') || 'scenario'}: ${first.message}`);
  }
  const problem = staticProblem(parsed.data);
  if (problem) throw new InvalidScenario(problem.reason, problem.actionIndex);
  return parsed.data;
}

function actionTargets(a: Action): string[] {
  const names: string[] = [];
  if ('target' in a && a.target) names.push(a.target);
  if ('point' in a && a.point.space === 'target-fraction') names.push(a.point.target);
  return names;
}

function requirementTargets(r: Requirement): { names: string[]; observed: string[] } {
  switch (r.kind) {
    case 'focus-stays-on':
      return { names: [r.target], observed: [r.target] };
    case 'focus-restored':
      return { names: [r.to], observed: [r.to] };
    case 'geometry-continuous':
    case 'geometry-fits':
    case 'single-interactive':
      return { names: [r.target], observed: [r.target] };
    case 'geometry-origin':
      return { names: [r.target, r.anchor], observed: [r.target, r.anchor] };
    case 'relationship-resolves':
      return { names: [r.from, r.to], observed: [r.from, r.to] };
    default:
      return { names: [], observed: [] };
  }
}

/**
 * Checks that need no browser. The reducer calls this on every candidate
 * sequence, so a deletion that leaves a `pointerUp` without its `pointerDown` is
 * rejected and counted without paying for a page load.
 */
export function staticProblem(s: ScenarioType): { reason: string; actionIndex: number | null } | null {
  for (const name of Object.keys(s.targets)) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) return { reason: `bad target name "${name}"`, actionIndex: null };
  }
  for (const r of s.requirements) {
    const { names, observed } = requirementTargets(r);
    for (const name of names) {
      if (!s.targets[name]) return { reason: `requirement ${r.kind} names unknown target "${name}"`, actionIndex: null };
    }
    for (const name of observed) {
      if (!s.targets[name]?.traceId) {
        return { reason: `requirement ${r.kind} observes "${name}", which needs a traceId`, actionIndex: null };
      }
    }
  }
  return sequenceProblem(s.actions, s.targets) ?? sequenceProblem(s.cleanup, s.targets, s.actions);
}

/** Time must not run backwards, and pointer gestures must be well formed. */
export function sequenceProblem(
  actions: Action[],
  targets: ScenarioType['targets'],
  before: Action[] = [],
): { reason: string; actionIndex: number } | null {
  let pressed = before.reduce((p, a) => {
    if (a.type === 'pointerDown') return true;
    if (a.type === 'pointerUp' || a.type === 'pointerCancel') return false;
    return p;
  }, false);
  // Cleanup times count from the end of the main actions, so each list starts at zero.
  let last = 0;
  for (const [i, a] of actions.entries()) {
    if (a.at < last) return { reason: `time runs backwards (${a.at} ms after ${last} ms)`, actionIndex: i };
    last = a.at;
    for (const name of actionTargets(a)) {
      if (!targets[name]) return { reason: `unknown target "${name}"`, actionIndex: i };
    }
    if (a.type === 'pointerDown') {
      if (pressed) return { reason: 'pointerDown while a pointer is already down', actionIndex: i };
      pressed = true;
    } else if (a.type === 'pointerUp' || a.type === 'pointerCancel') {
      if (!pressed) return { reason: `${a.type} with no pointer down`, actionIndex: i };
      pressed = false;
    }
  }
  return null;
}

/** Non-empty after a run means the pointer stayed down, which `cleanup` must finish. */
export function endsWithPointerDown(actions: Action[]): boolean {
  return actions.reduce((p, a) => {
    if (a.type === 'pointerDown') return true;
    if (a.type === 'pointerUp' || a.type === 'pointerCancel') return false;
    return p;
  }, false);
}
