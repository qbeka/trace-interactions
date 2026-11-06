import type { Action, Requirement, Scenario } from '../../src/scenario/schema.ts';
import type { PendingEvent, TraceEvent } from '../../src/trace/types.ts';

export function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    schema: 'trace.scenario/1',
    id: 'unit',
    fixture: { id: 'f', version: '1' },
    seed: 1,
    initialState: {},
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    timing: { mode: 'controlled', stepMs: 16, settleMs: 100 },
    targets: {
      trigger: { traceId: 'trigger' },
      panel: { traceId: 'panel' },
      input: { traceId: 'input' },
    },
    requirements: [],
    actions: [{ type: 'activate', target: 'trigger', at: 0 }],
    cleanup: [],
    ...over,
  };
}

/** Builds a trace in order. Time and tick only move when asked. */
export function trace() {
  const events: TraceEvent[] = [];
  let seq = 0;
  let t = 0;
  let tick = 0;
  const builder = {
    at(ms: number) {
      t = ms;
      tick += 1;
      return builder;
    },
    add(e: PendingEvent) {
      events.push({ ...e, seq: seq++, t, tick } as TraceEvent);
      return builder;
    },
    action(index: number, type: Action['type'], cleanup = false) {
      builder.add({ k: 'action', phase: 'start', index, cleanup, type, label: type });
      builder.add({ k: 'action', phase: 'end', index, cleanup, type, label: type });
      return builder;
    },
    state(key: string, value: string | number | boolean | null) {
      return builder.add({ k: 'state', key, value });
    },
    focus(traceId: string | null, node = 1, extra: { hidden?: boolean; connected?: boolean } = {}) {
      return builder.add({
        k: 'focus',
        ref: traceId === null ? null : { node, tag: 'input', role: null, traceId, hidden: extra.hidden ?? false, connected: extra.connected ?? true },
      });
    },
    rect(target: string, rect: { x: number; y: number; w: number; h: number } | null, node: number | null = 1, interactive = 1) {
      return builder.add({ k: 'geometry', target, rect, node, count: interactive, interactive });
    },
    viewport(width: number, height: number) {
      return builder.add({ k: 'viewport', width, height });
    },
    resources(counts: Record<string, number>) {
      return builder.add({ k: 'resources', counts });
    },
    events,
  };
  return builder;
}

export const need = (r: Requirement, actions?: Action[]): Partial<Scenario> => ({ requirements: [r], ...(actions ? { actions } : {}) });
