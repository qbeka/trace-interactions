/**
 * In-page recorder. Injected before any page script and compiled to one IIFE.
 *
 * It watches the page from outside React. The only thing it takes from the
 * fixture is an allowlisted state map, so a broken fixture cannot hide a focus
 * loss, a duplicate node or a leaked listener by misreporting them.
 *
 * Privacy rule: this file never reads textContent, input values or labels. It
 * keeps tag names, roles, data-trace-id values and rectangles.
 */
import type { NodeRef, PendingEvent, Rect, TraceEvent } from '../trace/types.ts';
import type { Primitive } from '../scenario/schema.ts';

export interface RecorderConfig {
  mode: 'controlled' | 'wall';
  /** full records everything. stamps keeps only input and commit timestamps. */
  recording: 'full' | 'stamps';
  targets: { name: string; traceId: string }[];
  relations: { from: string; fromTraceId: string; attribute: string }[];
  stateAllowlist: string[];
}

/** Published by the fixture. This is the whole contract between page and recorder. */
export interface FixtureAdapter {
  id: string;
  version: string;
  getState(): Record<string, unknown>;
  subscribe(cb: () => void): () => void;
  request?(state: Record<string, unknown>): void;
}

export interface LatencySample {
  name: string;
  /** Event.timeStamp, the time the browser says the input happened. */
  input: number;
  /** When the recorder's capture listener ran, before any page handler. */
  handler: number;
  /** When the fixture published the state this input caused. Null if none did. */
  commit: number | null;
  /** First rAF after the commit, then one message task. Not a displayed frame. */
  render: number | null;
}

interface RealFns {
  raf: (cb: FrameRequestCallback) => number;
  setTimeout: (cb: () => void, ms: number) => number;
}

declare global {
  interface Window {
    __traceReal?: RealFns;
    __traceSeed?: number;
    __traceFixture?: FixtureAdapter;
    __trace: ReturnType<typeof createRecorder>;
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;

function createRecorder() {
  const real: RealFns = window.__traceReal ?? {
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
  };

  // Native references kept before fixtures can touch anything.
  const addListener = EventTarget.prototype.addEventListener;
  const removeListener = EventTarget.prototype.removeEventListener;

  let config: RecorderConfig | null = null;
  let events: TraceEvent[] = [];
  let seq = 0;
  let tickNo = 0;
  let t0 = 0;
  let running = false;

  const push = (e: PendingEvent): void => {
    events.push({ ...e, seq: seq++, t: round(performance.now() - t0), tick: tickNo } as TraceEvent);
  };

  // --- Resource ledger -------------------------------------------------------
  // Wraps the places a component can leave something running. `once` listeners
  // remove themselves, so they are not counted.

  const ledger = new Map<string, Set<unknown>>();
  const entry = (key: string): Set<unknown> => {
    let set = ledger.get(key);
    if (!set) ledger.set(key, (set = new Set()));
    return set;
  };

  const patchListeners = (label: string, host: Window | Document): void => {
    const h = host as unknown as Record<string, unknown>;
    const identity = new Map<unknown, Map<string, object>>();
    const token = (fn: unknown, capture: boolean): object => {
      let perFn = identity.get(fn);
      if (!perFn) identity.set(fn, (perFn = new Map()));
      const key = String(capture);
      let t = perFn.get(key);
      if (!t) perFn.set(key, (t = {}));
      return t;
    };
    h.addEventListener = function (type: string, fn: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean) {
      addListener.call(host, type, fn, opts);
      if (!fn) return;
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      if (typeof opts === 'object' && opts?.once) return;
      const key = `${label}:${type}`;
      const t = token(fn, capture);
      entry(key).add(t);
      if (typeof opts === 'object' && opts?.signal) {
        addListener.call(opts.signal, 'abort', () => entry(key).delete(t));
      }
    };
    h.removeEventListener = function (type: string, fn: EventListenerOrEventListenerObject | null, opts?: EventListenerOptions | boolean) {
      removeListener.call(host, type, fn, opts);
      if (!fn) return;
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      entry(`${label}:${type}`).delete(token(fn, capture));
    };
  };
  patchListeners('window', window);
  patchListeners('document', document);

  const patchObserver = (name: 'ResizeObserver' | 'IntersectionObserver' | 'MutationObserver'): void => {
    const Native = window[name] as unknown as { new (cb: never, opts?: never): Record<string, (...args: never[]) => unknown> };
    if (!Native) return;
    class Counted extends (Native as new (cb: never, opts?: never) => object) {
      private watched = new Set<unknown>();
      observe(this: Counted & { __o?: never }, target: Element, opts?: never): void {
        (Native.prototype.observe as (t: Element, o?: never) => void).call(this, target, opts);
        this.watched.add(target);
        entry(`observer:${name}`).add(this);
      }
      unobserve(target: Element): void {
        (Native.prototype.unobserve as (t: Element) => void).call(this, target);
        this.watched.delete(target);
        if (this.watched.size === 0) entry(`observer:${name}`).delete(this);
      }
      disconnect(): void {
        (Native.prototype.disconnect as () => void).call(this);
        this.watched.clear();
        entry(`observer:${name}`).delete(this);
      }
    }
    (window as unknown as Record<string, unknown>)[name] = Counted;
  };
  patchObserver('ResizeObserver');
  patchObserver('IntersectionObserver');
  patchObserver('MutationObserver');

  // Wrapped after Playwright's clock install, so the page sees the virtual
  // functions and the ledger still sees every call.
  const wrapped = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    raf: window.requestAnimationFrame,
    caf: window.cancelAnimationFrame,
  };
  type Timer = (fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => number;
  const due = new Map<number, number>();
  (window as unknown as { setTimeout: Timer }).setTimeout = (fn, ms, ...rest) => {
    const id = (wrapped.setTimeout as unknown as Timer).call(
      window,
      (...args: unknown[]) => {
        entry('timer:timeout').delete(id);
        due.delete(id);
        fn(...args);
      },
      ms,
      ...rest,
    );
    entry('timer:timeout').add(id);
    due.set(id, performance.now() + (ms ?? 0));
    return id;
  };
  window.clearTimeout = ((id: number) => {
    entry('timer:timeout').delete(id);
    due.delete(id);
    wrapped.clearTimeout.call(window, id);
  }) as typeof window.clearTimeout;
  (window as unknown as { setInterval: Timer }).setInterval = (fn, ms, ...rest) => {
    const id = (wrapped.setInterval as unknown as Timer).call(window, fn, ms, ...rest);
    entry('timer:interval').add(id);
    return id;
  };
  window.clearInterval = ((id: number) => {
    entry('timer:interval').delete(id);
    wrapped.clearInterval.call(window, id);
  }) as typeof window.clearInterval;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = wrapped.raf.call(window, (t) => {
      entry('timer:frame').delete(id);
      cb(t);
    });
    entry('timer:frame').add(id);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    entry('timer:frame').delete(id);
    wrapped.caf.call(window, id);
  }) as typeof window.cancelAnimationFrame;

  const counts = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, set] of [...ledger].sort(([a], [b]) => a.localeCompare(b))) {
      if (set.size > 0) out[key] = set.size;
    }
    return out;
  };

  // --- Channels controlled time cannot hold still ----------------------------
  // The page is free to use these. Saying so is the honest part.

  const usedChannels = new Set<string>();
  const noteChannel = (channel: string, detail: string): void => {
    if (usedChannels.has(channel)) return;
    usedChannels.add(channel);
    push({ k: 'unsupported', channel, detail });
  };
  const NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, opts?: WorkerOptions) {
        noteChannel('worker', 'A Worker runs on its own real clock.');
        super(url, opts);
      }
    };
  }
  const nativeScrollTo = Element.prototype.scrollTo as (o?: ScrollToOptions) => void;
  Element.prototype.scrollTo = function (this: Element, arg?: unknown, y?: number) {
    if (typeof arg === 'object' && (arg as ScrollToOptions | null)?.behavior === 'smooth') {
      noteChannel('smooth-scroll', 'Native smooth scrolling runs on the compositor.');
    }
    if (typeof arg === 'number') (Element.prototype.scroll as (x: number, y: number) => void).call(this, arg, y ?? 0);
    else nativeScrollTo.call(this, arg as ScrollToOptions);
  } as typeof Element.prototype.scrollTo;

  // --- Sampling --------------------------------------------------------------

  const nodeIds = new WeakMap<Element, number>();
  let nextNode = 1;
  const nodeId = (el: Element): number => {
    let id = nodeIds.get(el);
    if (id === undefined) nodeIds.set(el, (id = nextNode++));
    return id;
  };

  const isRendered = (el: Element): boolean =>
    el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions) : true;

  const isHiddenFromUser = (el: Element): boolean =>
    el.closest('[inert],[aria-hidden="true"],[hidden]') !== null || !isRendered(el);

  const refOf = (el: Element): NodeRef => ({
    node: nodeId(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    traceId: el.getAttribute('data-trace-id'),
    hidden: isHiddenFromUser(el),
    connected: el.isConnected,
  });

  const lastGeometry = new Map<string, string>();
  const lastRelation = new Map<string, string>();
  const lastState = new Map<string, Primitive>();
  let lastFocus: string | null = null;
  let lastFocusRef: Element | null = null;

  const sampleState = (): void => {
    const adapter = window.__traceFixture;
    if (!adapter || !config) return;
    const state = adapter.getState();
    for (const key of config.stateAllowlist) {
      if (!(key in state)) continue;
      const raw = state[key];
      // Only short primitives pass. An object or long string is treated as not allowlisted.
      const value: Primitive =
        typeof raw === 'number' || typeof raw === 'boolean' || raw === null
          ? (raw as Primitive)
          : typeof raw === 'string' && raw.length <= 64
            ? raw
            : null;
      if (lastState.has(key) && lastState.get(key) === value) continue;
      lastState.set(key, value);
      push({ k: 'state', key, value });
    }
  };

  const sampleFocus = (): void => {
    const active = document.activeElement;
    const el = active && active !== document.body && active !== document.documentElement ? active : null;
    const ref = el ? refOf(el) : null;
    const key = JSON.stringify(ref);
    if (key === lastFocus && el === lastFocusRef) return;
    lastFocus = key;
    lastFocusRef = el;
    push({ k: 'focus', ref });
  };

  const sampleTargets = (): void => {
    if (!config) return;
    for (const { name, traceId } of config.targets) {
      const all = [...document.querySelectorAll(`[data-trace-id="${CSS.escape(traceId)}"]`)];
      const live = all.filter((el) => !isHiddenFromUser(el));
      const primary = live[0] ?? all.find(isRendered) ?? null;
      let rect: Rect | null = null;
      if (primary) {
        const r = primary.getBoundingClientRect();
        rect = { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
      }
      const key = JSON.stringify([rect, all.length, live.length, primary ? nodeId(primary) : null]);
      if (lastGeometry.get(name) === key) continue;
      lastGeometry.set(name, key);
      push({
        k: 'geometry',
        target: name,
        rect,
        node: primary ? nodeId(primary) : null,
        count: all.length,
        interactive: live.length,
      });
    }
    for (const { from, fromTraceId, attribute } of config.relations) {
      const owner = document.querySelector(`[data-trace-id="${CSS.escape(fromTraceId)}"]`);
      if (!owner) continue;
      const id = owner.getAttribute(attribute);
      const matches = id ? document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length : 0;
      // `getElementById` is what assistive technology follows: the first match wins.
      const found = id ? document.getElementById(id) : null;
      const resolved = found?.getAttribute('data-trace-id') ?? null;
      const key = JSON.stringify([id, matches, resolved]);
      if (lastRelation.get(`${from}:${attribute}`) === key) continue;
      lastRelation.set(`${from}:${attribute}`, key);
      push({ k: 'relation', from, attribute, id, matches, resolved });
    }
  };

  const sample = (): void => {
    if (!running || config?.recording !== 'full') return;
    sampleState();
    sampleFocus();
    sampleTargets();
  };

  // --- Animation seeking (controlled mode) -----------------------------------
  // Playwright's clock does not reach the animation timeline. Each animation is
  // paused the moment it is seen, then stepped by the virtual time that passed.
  // `getAnimations` also flushes style, so a CSS transition that this tick's
  // commit started is seen in the same tick.

  // Kept as a set because `document.getAnimations` drops an animation whose
  // element left the DOM, and that animation's `finished` promise still fires
  // in real time. A stale completion on an unmounted panel depends on it.
  const adopted = new Set<Animation>();
  let lastSeek = 0;

  const seekAnimations = (): void => {
    const now = performance.now();
    const dt = now - lastSeek;
    lastSeek = now;
    for (const a of new Set([...adopted, ...document.getAnimations()])) {
      if (a.playState === 'finished' || a.playState === 'idle') {
        adopted.delete(a);
        continue;
      }
      const end = a.effect?.getComputedTiming().endTime;
      const endMs = typeof end === 'number' ? end : Number(end ?? 0);
      if (!adopted.has(a)) {
        adopted.add(a);
        if (a.playState === 'running') a.pause();
        // Real time passed before adoption. Virtual time did not, so rewind it.
        a.currentTime = a.playbackRate < 0 ? endMs : 0;
        continue;
      }
      if (a.playState === 'running') a.pause(); // reverse() and play() resume real time
      const current = Number(a.currentTime ?? 0) + dt * a.playbackRate;
      if ((a.playbackRate > 0 && current >= endMs) || (a.playbackRate < 0 && current <= 0)) a.finish();
      else a.currentTime = current;
    }
  };

  /**
   * Waits for one real frame and one message task. ResizeObserver callbacks run
   * in the rendering step and `finish` events are queued for it, and React
   * schedules work through MessageChannel. None of them follow the virtual clock.
   */
  const frame = (): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(0);
      };
      real.raf(finish);
      real.setTimeout(finish, 100); // a hidden page stops frames, so do not hang on it
    });

  const settle = async (): Promise<void> => {
    if (config?.mode === 'controlled') seekAnimations();
    sample();
    await frame();
    if (config?.mode === 'controlled') seekAnimations();
    sample();
  };

  // --- Input events ----------------------------------------------------------

  const watched = [
    'pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
    'keydown', 'click', 'focusin', 'focusout',
  ] as const;

  let captureOwner: Element | null = null;
  let capturedPointer: number | null = null;

  const onEvent = (e: Event): void => {
    if (e.type === 'gotpointercapture') {
      captureOwner = e.target as Element;
      capturedPointer = (e as PointerEvent).pointerId;
    } else if (e.type === 'lostpointercapture') {
      captureOwner = null;
    }
    if (!running || config?.recording !== 'full') return;
    const el = e.target instanceof Element ? e.target : null;
    push({
      k: 'event',
      name: e.type,
      target: el?.getAttribute('data-trace-id') ?? null,
      ...(e instanceof PointerEvent ? { pointerId: e.pointerId } : {}),
      // A printable key is user text. Only named keys such as Escape are kept.
      ...(e instanceof KeyboardEvent && e.key.length > 1 ? { key: e.key } : {}),
    });
    if (e.type === 'focusin' || e.type === 'focusout') sampleFocus();
  };

  // Latency stamps for wall mode. Kept in both recording levels so overhead can be compared.
  const latency: LatencySample[] = [];
  const onLatency = (e: Event): void => {
    if (!running || config?.mode !== 'wall') return;
    latency.push({ name: e.type, input: e.timeStamp, handler: performance.now(), commit: null, render: null });
  };
  const noteCommit = (): void => {
    if (!running || config?.mode !== 'wall') return;
    const last = latency.at(-1);
    if (!last || last.commit !== null) return;
    last.commit = performance.now();
    real.raf(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        last.render = performance.now();
      };
      channel.port2.postMessage(0);
    });
  };

  for (const name of watched) addListener.call(window, name, onEvent, { capture: true });
  for (const name of ['pointerdown', 'pointerup', 'keydown', 'click']) {
    addListener.call(window, name, onLatency, { capture: true });
  }

  const wallLoop = (): void => {
    if (!running) return;
    sample();
    real.raf(wallLoop);
  };

  /**
   * What the clock has to step through. With no animation, frame or interval
   * pending, nothing can change before `nextDue`, so the runner may jump there.
   * Scenario text and sampling do not depend on this: skipped ticks saw no change.
   */
  const activity = (): { busy: boolean; nextDue: number | null } => {
    const animating = [...document.getAnimations()].some((a) => a.playState !== 'finished' && a.playState !== 'idle');
    const busy = animating || adopted.size > 0 || (ledger.get('timer:frame')?.size ?? 0) > 0 || (ledger.get('timer:interval')?.size ?? 0) > 0;
    const soonest = Math.min(...due.values());
    return { busy, nextDue: Number.isFinite(soonest) ? round(soonest - t0) : null };
  };

  let ambient: Record<string, number> = {};
  let unsubscribe: (() => void) | null = null;
  let probe: { hits: { timer: boolean; frame: boolean }; el: Element; waapi: Animation; before: { perf: number; date: number } } | null = null;

  return {
    configure(next: RecorderConfig) {
      config = next;
    },
    start() {
      ambient = counts();
      t0 = performance.now();
      lastSeek = t0;
      running = true;
      unsubscribe = window.__traceFixture?.subscribe(() => {
        if (config?.recording === 'full') sampleState();
        noteCommit();
      }) ?? null;
      if (config?.mode === 'wall' && config.recording === 'full') wallLoop();
      sample();
    },
    stop() {
      running = false;
      unsubscribe?.();
    },
    /** One step of controlled time: move animations, then observe. */
    async tick() {
      tickNo += 1;
      await settle();
      return activity();
    },
    settle,
    sample,
    mark(e: PendingEvent) {
      // An action starts a new tick. Without this, an action and the sample
      // before it would count as simultaneous, and the state before the action
      // could never be read back.
      if (e.k === 'action' && e.phase === 'start') tickNo += 1;
      push(e);
    },
    /** Counts above the level at `start`, which leaves out Playwright's own listeners. */
    checkpoint() {
      const out: Record<string, number> = {};
      for (const [key, count] of Object.entries(counts())) {
        const extra = count - (ambient[key] ?? 0);
        if (extra > 0) out[key] = extra;
      }
      push({ k: 'resources', counts: out });
    },
    state(): Record<string, Primitive> {
      return Object.fromEntries(lastState);
    },
    now() {
      return round(performance.now() - t0);
    },
    usedChannels() {
      return [...usedChannels];
    },
    /** See the `pointerCancel` case in the runner for why this exists. */
    syntheticCancel() {
      const el = captureOwner ?? document.activeElement ?? document.documentElement;
      const pointerId = capturedPointer ?? 1;
      el.dispatchEvent(new PointerEvent('pointercancel', { pointerId, bubbles: true, cancelable: false, pointerType: 'mouse' }));
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
      const swallow = (e: Event): void => {
        e.stopImmediatePropagation();
        if (e.type === 'click' || e.type === 'mouseup') removeListener.call(window, e.type, swallow, { capture: true });
      };
      for (const type of ['pointerup', 'mouseup', 'click']) addListener.call(window, type, swallow, { capture: true });
      noteChannel('synthetic-pointer-cancel', 'This engine has no real cancel input. The event was dispatched by script.');
    },
    /**
     * Clock contract check, part one. The runner advances the clock by
     * `CLOCK_PROBE_MS` between the two parts, so each source can be held to it.
     */
    clockProbeStart() {
      const hits = { timer: false, frame: false };
      wrapped.setTimeout.call(window, () => (hits.timer = true), 8);
      wrapped.raf.call(window, () => (hits.frame = true));
      const el = document.createElement('div');
      document.documentElement.append(el);
      const waapi = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
      seekAnimations();
      const before = { perf: performance.now(), date: Date.now() };
      return (probe = { hits, el, waapi, before });
    },
    clockProbeEnd(ms: number): Record<string, boolean> {
      const p = probe!;
      seekAnimations();
      const verified = {
        timers: p.hits.timer,
        frames: p.hits.frame,
        performance: performance.now() - p.before.perf === ms,
        date: Date.now() - p.before.date === ms,
        animations: Math.abs(Number(p.waapi.currentTime) - ms) < 0.5,
      };
      p.waapi.cancel();
      p.el.remove();
      adopted.delete(p.waapi);
      probe = null;
      return verified;
    },
    drain() {
      const out = events;
      events = [];
      return out;
    },
    latency() {
      return latency;
    },
  };
}

window.__trace = createRecorder();

// Same seed, same `Math.random`. mulberry32, because it is short and well known.
if (typeof window.__traceSeed === 'number') {
  let s = window.__traceSeed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}
