import { z } from 'zod';

/**
 * Scenario format, version 1.
 *
 * A scenario is plain JSON that says what a user does, in what order, and what
 * must stay true while they do it. Requirements live here and not in a baseline
 * build, because two builds that share a bug would otherwise agree with each other.
 */
export const SCENARIO_SCHEMA = 'trace.scenario/1';

const Ms = z.number().int().min(0);
const Name = z.string().min(1).max(64);
const Primitive = z.union([z.string().max(64), z.number(), z.boolean(), z.null()]);
export type Primitive = z.infer<typeof Primitive>;

/**
 * Actions find elements with `role` and `name` through Playwright locators.
 * Observation needs `traceId`, because the recorder samples inside the page on
 * every tick and computing accessible names there would be slow and approximate.
 */
export const Target = z
  .strictObject({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .refine((t) => t.role !== undefined || t.traceId !== undefined, {
    message: 'a target needs a role or a traceId',
  });
export type Target = z.infer<typeof Target>;

/** Coordinates exist only for spatial gestures, and each one names its space. */
export const Point = z.discriminatedUnion('space', [
  z.strictObject({ space: z.literal('viewport-px'), x: z.number(), y: z.number() }),
  z.strictObject({
    space: z.literal('target-fraction'),
    target: Name,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
]);
export type Point = z.infer<typeof Point>;

const StateMap = z.record(Name, Primitive);

const ActionBase = {
  /** Scenario time in ms. Two actions may share a value; array order breaks the tie. */
  at: Ms,
  note: z.string().max(120).optional(),
  /** The reducer keeps setup actions. */
  setup: z.boolean().optional(),
  /** The semantic state this action asks for. `latest-request-wins` reads this. */
  requests: StateMap.optional(),
  /** State that must hold before the action runs, or the scenario is invalid. */
  requires: StateMap.optional(),
  /** State change that proves the page received the action. */
  ack: z
    .strictObject({ key: Name, equals: Primitive, withinMs: Ms })
    .optional(),
};

export const Action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('focus'), target: Name, ...ActionBase }),
  z.strictObject({ type: z.literal('type'), target: Name, text: z.string().max(200), ...ActionBase }),
  z.strictObject({ type: z.literal('activate'), target: Name, ...ActionBase }),
  z.strictObject({ type: z.literal('press'), key: z.string().min(1).max(32), target: Name.optional(), ...ActionBase }),
  z.strictObject({ type: z.literal('pointerDown'), point: Point, ...ActionBase }),
  z.strictObject({ type: z.literal('pointerMove'), point: Point, ...ActionBase }),
  z.strictObject({ type: z.literal('pointerUp'), ...ActionBase }),
  z.strictObject({ type: z.literal('pointerCancel'), ...ActionBase }),
  z.strictObject({
    type: z.literal('resize'),
    width: z.number().int().min(100).max(4000),
    height: z.number().int().min(100).max(4000),
    ...ActionBase,
  }),
  z.strictObject({ type: z.literal('scroll'), target: Name, top: z.number().min(0), ...ActionBase }),
  z.strictObject({ type: z.literal('requestState'), state: StateMap, ...ActionBase }),
  z.strictObject({
    type: z.literal('waitFor'),
    state: StateMap,
    timeoutMs: Ms,
    ...ActionBase,
  }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action['type'];

/** Failure categories. Each requirement maps to exactly one. */
export const CATEGORIES = [
  'stale-final-state',
  'lost-focus',
  'geometry-discontinuity',
  'duplicate-interactive',
  'incomplete-cleanup',
  'missed-ack',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const Requirement = z.discriminatedUnion('kind', [
  /** After a request for one terminal value, the key may not reach a different terminal value. */
  z.strictObject({
    kind: z.literal('latest-request-wins'),
    key: Name,
    terminal: z.array(Primitive).min(2),
  }),
  /** The target keeps focus, on the same DOM node, while the state holds. */
  z.strictObject({
    kind: z.literal('focus-stays-on'),
    target: Name,
    whileState: StateMap,
  }),
  /** When the state starts to hold, focus must land on the target within `withinMs`. */
  z.strictObject({
    kind: z.literal('focus-restored'),
    to: Name,
    whenState: StateMap,
    withinMs: Ms,
  }),
  /** Focus never sits on a hidden, inert or detached element. Always a bug. */
  z.strictObject({ kind: z.literal('focus-valid') }),
  /** Between two samples the target's edges move at most `maxStepPx`. Samples across a resize are skipped. */
  z.strictObject({
    kind: z.literal('geometry-continuous'),
    target: Name,
    maxStepPx: z.number().positive(),
  }),
  /** When the target appears it must either sit at its final rect (no motion) or start at the anchor. */
  z.strictObject({
    kind: z.literal('geometry-origin'),
    target: Name,
    anchor: Name,
    tolerancePx: z.number().min(0),
  }),
  /** After each resize settles, the target stays inside the viewport by `insetPx`. */
  z.strictObject({
    kind: z.literal('geometry-fits'),
    target: Name,
    insetPx: z.number().min(0),
    tolerancePx: z.number().min(0),
  }),
  /** At most one visible, non-inert element answers to the target. */
  z.strictObject({ kind: z.literal('single-interactive'), target: Name }),
  /** The id named by an ARIA relationship resolves to exactly one element, the declared one. */
  z.strictObject({
    kind: z.literal('relationship-resolves'),
    from: Name,
    attribute: z.enum(['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns']),
    to: Name,
  }),
  /** After the named action settles, transient state and pointer capture are gone. */
  z.strictObject({
    kind: z.literal('transient-cleared'),
    after: z.enum(['pointerUp', 'pointerCancel', 'press']),
    state: StateMap,
  }),
  /** After removal, listeners, observers, timers and frames return to the count before mount. */
  z.strictObject({
    kind: z.literal('resources-released'),
    key: Name,
    removedValue: Primitive,
    ignore: z.array(z.string()).optional(),
  }),
]);
export type Requirement = z.infer<typeof Requirement>;
export type RequirementKind = Requirement['kind'];

export const Viewport = z.strictObject({
  width: z.number().int().min(100).max(4000),
  height: z.number().int().min(100).max(4000),
  deviceScaleFactor: z.number().min(1).max(4),
});
export type Viewport = z.infer<typeof Viewport>;

export const Timing = z.strictObject({
  mode: z.enum(['controlled', 'wall']),
  /** Virtual ms between samples in controlled mode. */
  stepMs: z.number().int().min(1).max(100),
  /** Time the runner keeps observing after the last action. */
  settleMs: Ms,
});
export type Timing = z.infer<typeof Timing>;

export const Scenario = z
  .strictObject({
    schema: z.literal(SCENARIO_SCHEMA),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().max(240).optional(),
    fixture: z.strictObject({ id: Name, version: Name }),
    seed: z.number().int().min(0),
    initialState: StateMap,
    viewport: Viewport,
    timing: Timing,
    targets: z.record(Name, Target),
    requirements: z.array(Requirement),
    actions: z.array(Action).min(1),
    cleanup: z.array(Action),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;
