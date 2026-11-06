import type { Category, Primitive, Scenario } from '../scenario/schema.ts';

/** Bumped when the shape of saved traces changes. */
export const TRACE_SCHEMA = 'trace.events/1';

/** Rounded to 0.01 px so float noise does not read as movement. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the recorder keeps about an element. Text and values are never included. */
export interface NodeRef {
  /** Stable for one DOM node. A remount gets a new id. */
  node: number;
  tag: string;
  role: string | null;
  traceId: string | null;
  /** Inside an `inert`, `aria-hidden` or `hidden` subtree, or not rendered. */
  hidden: boolean;
  connected: boolean;
}

interface Base {
  /** Global order within one run. Equal `t` values are ordered by this. */
  seq: number;
  /** Ms since the run started: virtual in controlled mode, real in wall mode. */
  t: number;
  /** Sample number. Events inside one tick count as simultaneous for the oracle. */
  tick: number;
}

export type TraceEvent =
  | (Base & { k: 'action'; phase: 'start' | 'end'; index: number; cleanup: boolean; type: string; label: string })
  | (Base & { k: 'state'; key: string; value: Primitive })
  | (Base & { k: 'focus'; ref: NodeRef | null })
  | (Base & { k: 'geometry'; target: string; rect: Rect | null; node: number | null; count: number; interactive: number })
  | (Base & { k: 'relation'; from: string; attribute: string; id: string | null; matches: number; resolved: string | null })
  | (Base & { k: 'a11y'; target: string; matches: number })
  | (Base & { k: 'event'; name: string; target: string | null; pointerId?: number; key?: string })
  | (Base & { k: 'resources'; counts: Record<string, number> })
  | (Base & { k: 'viewport'; width: number; height: number })
  | (Base & { k: 'unsupported'; channel: string; detail: string })
  | (Base & { k: 'wait-timeout'; index: number });

type Unstamped<T> = T extends unknown ? Omit<T, 'seq' | 't' | 'tick'> : never;
/** An event before the recorder gives it a position in the run. */
export type PendingEvent = Unstamped<TraceEvent>;

export type Violation = {
  requirement: string;
  category: Category;
  /** One plain sentence a person can act on. */
  sentence: string;
  /** Where the failure became visible. */
  at: { seq: number; t: number; tick: number };
  target: string | null;
  /** Stable across runs of one failure. The reducer holds this fixed. */
  fingerprint: string;
};

export type RunStatus = 'completed' | 'invalid';

export interface InvalidInfo {
  actionIndex: number | null;
  reason: string;
}

export interface ClockReport {
  mode: 'controlled' | 'wall';
  /** Each channel the runner verified this run. */
  verified: Record<string, boolean>;
  /** Time sources this mode does not control, whether or not the page used them. */
  uncontrolled: string[];
  /** Channels the page actually used that this mode cannot control. */
  used: string[];
}

export interface Screenshot {
  label: string;
  tick: number;
  t: number;
  path: string;
}

export interface RunResult {
  schema: typeof TRACE_SCHEMA;
  status: RunStatus;
  invalid: InvalidInfo | null;
  events: TraceEvent[];
  violations: Violation[];
  clock: ClockReport;
  screenshots: Screenshot[];
  durationMs: number;
}

export type { Category, Scenario };
