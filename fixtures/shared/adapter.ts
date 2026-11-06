import { useLayoutEffect } from 'react';

/**
 * The fixture side of the contract. A fixture publishes a small state map and
 * accepts state requests. The file has no dependency on Trace, and a fixture can
 * copy it or write its own: the recorder only needs `window.__traceFixture`.
 */
export type FixtureState = Record<string, string | number | boolean | null>;

export function createAdapter(id: string, version: string) {
  let state: FixtureState = {};
  const listeners = new Set<() => void>();
  let onRequest: (state: FixtureState) => void = () => {};

  const adapter = {
    id,
    version,
    getState: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    request: (next: FixtureState) => onRequest(next),
    publish(next: FixtureState) {
      state = next;
      for (const cb of listeners) cb();
    },
    onRequest(handler: (state: FixtureState) => void) {
      onRequest = handler;
    },
  };
  (window as unknown as { __traceFixture: unknown }).__traceFixture = adapter;
  return adapter;
}

/** Publishes in a layout effect, so the recorder sees the state of the commit. */
export function usePublish(adapter: ReturnType<typeof createAdapter>, state: FixtureState): void {
  useLayoutEffect(() => {
    adapter.publish(state);
  });
}

/** Initial state from the scenario, or an empty map outside a run. */
export function initialState(): FixtureState {
  return (window as unknown as { __traceInit?: FixtureState }).__traceInit ?? {};
}
