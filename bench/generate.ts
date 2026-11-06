import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, Requirement, Scenario } from '../src/scenario/schema.ts';
import { parseScenario } from '../src/scenario/validate.ts';

/**
 * Seeded random sessions for the browser. A move is picked from what a user
 * could do in the state the session believes it is in. A small share ignores that
 * on purpose. Sequences are never filtered here: one that cannot run comes back
 * invalid from the runner and is counted, because dropping those quietly would
 * flatter the denominator.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  random: () => number;
  /** What a user believes the UI is doing. Moves update this. */
  open: boolean;
  openedAt: number;
  pressed: boolean;
}

/** `when` is the state a user could press this in. Unguarded moves test the invalid path. */
interface Move {
  when: (c: Ctx, at: number) => boolean;
  make: (at: number, c: Ctx) => Action;
}

/** About one sequence in six has a move a user could not make. */
export const UNGUARDED_RATE = 0.01;

const pick = <T,>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;
const OPEN_ANIMATION_MS = 260;
const opened = (c: Ctx, at: number): boolean => c.open && at - c.openedAt >= 0;

const INSPECTOR: Move[] = [
  {
    // The growing panel covers the trigger, so a user cannot click it mid-entrance.
    when: (c, at) => !c.open || at - c.openedAt >= OPEN_ANIMATION_MS,
    make: (at, c) => {
      c.open = !c.open;
      if (c.open) c.openedAt = at;
      return { at, type: 'activate', target: 'trigger', requests: { panel: c.open ? 'open' : 'closed' }, note: c.open ? 'open' : 'close' };
    },
  },
  {
    when: opened,
    make: (at, c) => {
      c.open = false;
      return { at, type: 'activate', target: 'close', requests: { panel: 'closed' }, note: 'press Done' };
    },
  },
  {
    when: opened,
    make: (at, c) => {
      c.open = false;
      return { at, type: 'press', key: 'Escape', target: 'nameInput', requests: { panel: 'closed' }, note: 'press Escape' };
    },
  },
  { when: opened, make: (at) => ({ at, type: 'type', target: 'nameInput', text: 'x', note: 'type' }) },
  {
    when: () => true,
    make: (at, c) => {
      const width = pick([480, 620, 700, 860, 1000], c.random);
      return { at, type: 'resize', width, height: 640, note: `resize to ${width}` };
    },
  },
];

const OVERLAY: Move[] = [
  {
    when: (c) => !c.open,
    make: (at, c) => {
      c.open = true;
      return { at, type: 'activate', target: 'trigger', requests: { dialog: 'open' }, note: 'open' };
    },
  },
  {
    when: (c) => c.open,
    make: (at, c) => {
      c.open = false;
      return { at, type: 'activate', target: 'cancel', requests: { dialog: 'closed' }, note: 'cancel' };
    },
  },
  {
    when: (c) => c.open,
    make: (at, c) => {
      c.open = false;
      return { at, type: 'press', key: 'Escape', requests: { dialog: 'closed' }, note: 'press Escape' };
    },
  },
  { when: (c) => c.open, make: (at) => ({ at, type: 'type', target: 'password', text: 'x', note: 'type' }) },
  { when: (c) => c.open, make: (at) => ({ at, type: 'press', key: 'Tab', note: 'press Tab' }) },
];

const down = (make: Move['make']): Move['make'] => (at, c) => {
  c.pressed = true;
  return make(at, c);
};
const up = (make: Move['make']): Move['make'] => (at, c) => {
  c.pressed = false;
  return make(at, c);
};

const TIMELINE: Move[] = [
  {
    when: (c) => !c.pressed,
    make: down((at) => ({ at, type: 'pointerDown', point: { space: 'target-fraction', target: 'handle', x: 0.5, y: 0.5 }, note: 'press the handle' })),
  },
  {
    when: (c) => c.pressed,
    make: (at, c) => {
      const x = Math.round(c.random() * 100) / 100;
      return { at, type: 'pointerMove', point: { space: 'target-fraction', target: 'track', x, y: 0.5 }, note: `move to ${x}` };
    },
  },
  { when: (c) => c.pressed, make: up((at) => ({ at, type: 'pointerUp', note: 'release' })) },
  { when: (c) => c.pressed, make: up((at) => ({ at, type: 'pointerCancel', note: 'cancel' })) },
  { when: (c) => !c.pressed, make: (at) => ({ at, type: 'focus', target: 'handle', note: 'focus the handle' }) },
  { when: (c) => !c.pressed, make: (at) => ({ at, type: 'press', key: 'ArrowRight', note: 'nudge' }) },
];

/** Requirements that make sense in any session, taken from each fixture's fixed scenarios. */
const SESSION: Record<string, { base: string; moves: Move[]; requirements: Requirement[] }> = {
  inspector: {
    base: 'long-session',
    moves: INSPECTOR,
    requirements: [
      { kind: 'latest-request-wins', key: 'panel', terminal: ['open', 'closed'] },
      { kind: 'focus-valid' },
      { kind: 'geometry-fits', target: 'panel', insetPx: 8, tolerancePx: 2 },
      { kind: 'single-interactive', target: 'panel' },
    ],
  },
  overlay: {
    base: 'open-and-cancel',
    moves: OVERLAY,
    requirements: [
      { kind: 'latest-request-wins', key: 'dialog', terminal: ['open', 'closed'] },
      { kind: 'focus-valid' },
      { kind: 'focus-restored', to: 'trigger', whenState: { dialog: 'closed' }, withinMs: 400 },
      { kind: 'single-interactive', target: 'dialog' },
      { kind: 'relationship-resolves', from: 'dialog', attribute: 'aria-labelledby', to: 'title' },
    ],
  },
  timeline: {
    base: 'cancel-drag',
    moves: TIMELINE,
    requirements: [
      { kind: 'transient-cleared', after: 'pointerCancel', state: { dragging: false } },
      { kind: 'transient-cleared', after: 'pointerUp', state: { dragging: false } },
      { kind: 'focus-valid' },
    ],
  },
};

export const GENERATED_FIXTURES = Object.keys(SESSION);

/** Same fixture and seed, same scenario, on any machine. */
export function generateScenario(root: string, fixture: string, seed: number, length = 18): Scenario {
  const session = SESSION[fixture]!;
  const template = parseScenario(JSON.parse(readFileSync(join(root, 'fixtures', fixture, 'scenarios', `${session.base}.json`), 'utf8')));
  const random = mulberry32(seed);
  const c: Ctx = { random, open: false, openedAt: 0, pressed: false };
  const actions: Action[] = [];
  let at = 0;
  for (let i = 0; i < length; i++) {
    // Short gaps interrupt transitions. Long gaps let them finish.
    at += pick([0, 40, 100, 200, 320, 500], random);
    const allowed = random() < UNGUARDED_RATE ? session.moves : session.moves.filter((m) => m.when(c, at));
    actions.push(pick(allowed, random).make(at, c));
  }
  return {
    ...template,
    id: `${fixture}-random-${seed}`,
    description: `Generated session, seed ${seed}.`,
    seed,
    requirements: session.requirements,
    actions,
    cleanup: [],
  };
}
