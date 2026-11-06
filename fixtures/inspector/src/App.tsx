import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createAdapter, initialState, usePublish } from '../../shared/adapter.ts';

/**
 * An editable inspector that grows out of its trigger, using a FLIP animation.
 *
 * `__VARIANT__` is a build-time constant. Vite removes the branches that do not
 * apply, so the correct build contains none of the seeded mistakes. Each branch
 * is a mistake a person could plausibly ship, kept next to the correct line so
 * the difference is easy to read.
 */
declare const __VARIANT__: string;
const VARIANT = __VARIANT__;

type Phase = 'closed' | 'opening' | 'open' | 'closing';

const adapter = createAdapter('inspector', '1');

const PANEL_CLASS = VARIANT === "legit-wide" ? "panel wide" : "panel";
const DURATION_MS = VARIANT === 'legit-slow' ? 360 : 240;
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const BREAKPOINT_PX = 640;

function flip(from: DOMRect, to: DOMRect): string {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/** Correct: one stable wrapper, so moving between layouts keeps the input mounted. */
function SideShell({ children }: { children: ReactNode }) {
  return <div className="shell">{children}</div>;
}
function SheetShell({ children }: { children: ReactNode }) {
  return <section className="shell">{children}</section>;
}

function Inspector({ onPhase, requested }: { onPhase: (p: Phase, narrow: boolean, length: number) => void; requested: { panel?: string; nonce: number } }) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [title, setTitle] = useState('Hero section');
  const [stageWidth, setStageWidth] = useState(window.innerWidth);
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef<Animation | null>(null);
  const token = useRef(0);
  const origin = useRef<DOMRect | null>(null);
  const cachedOrigin = useRef<DOMRect | null>(null);

  const narrow = stageWidth < BREAKPOINT_PX;

  useEffect(() => onPhase(phase, narrow, title.length));

  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setStageWidth(entries[0]!.contentRect.width);
    });
    observer.observe(stage.current!);
    return () => {
      if (VARIANT !== 'leak-observer') observer.disconnect();
    };
  }, []);

  /** Runs `done` when the animation ends, unless a newer one replaced it. */
  function track(animation: Animation, done: () => void) {
    const id = ++token.current;
    running.current = animation;
    animation.finished
      .then(() => {
        if (VARIANT === 'stale-completion' || token.current === id) done();
      })
      .catch(() => {}); // cancel() rejects `finished`. Replacing an animation is expected.
  }

  /** Stops the running animation and returns where the panel actually is. */
  function interrupt(): DOMRect | null {
    const rect = panel.current?.getBoundingClientRect() ?? null;
    if (VARIANT !== 'stale-completion') running.current?.cancel();
    return rect;
  }

  function open() {
    if (phase === 'open' || phase === 'opening') return;
    origin.current = phase === 'closing' ? interrupt() : null;
    if (VARIANT === 'stale-resize') {
      // Mistake: measures once at open and stores pixels.
      setFrozenWidth(Math.min(420, stage.current!.clientWidth - 32));
    }
    setPhase('opening');
  }

  function close() {
    if (phase === 'closed' || phase === 'closing') return;
    const from = interrupt();
    const to = trigger.current!.getBoundingClientRect();
    setPhase('closing');
    trigger.current!.focus({ preventScroll: true });
    const el = panel.current!;
    const keyframes =
      VARIANT === 'legit-fade'
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transformOrigin: '0 0', transform: from ? flip(from, el.getBoundingClientRect()) : 'none' },
            { transformOrigin: '0 0', transform: flip(to, el.getBoundingClientRect()) },
          ];
    track(el.animate(keyframes, { duration: DURATION_MS, easing: EASING, fill: 'forwards' }), () => setPhase('closed'));
  }

  useLayoutEffect(() => {
    if (phase !== 'opening') return;
    const el = panel.current!;
    const to = el.getBoundingClientRect();
    let from = origin.current ?? trigger.current!.getBoundingClientRect();
    if (VARIANT === 'stale-origin') {
      // Mistake: "the trigger never moves", so its rect is cached across opens.
      cachedOrigin.current ??= from;
      from = origin.current ?? cachedOrigin.current;
    }
    const keyframes =
      VARIANT === 'legit-fade'
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transformOrigin: '0 0', transform: flip(from, to) },
            { transformOrigin: '0 0', transform: 'none' },
          ];
    track(el.animate(keyframes, { duration: DURATION_MS, easing: EASING }), () => setPhase('open'));
    input.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (requested.panel === 'open') open();
    if (requested.panel === 'closed') close();
    // Only a new request runs this. `open` and `close` read the latest phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested.nonce]);

  const present = phase !== 'closed';
  const Shell = VARIANT === 'remount-on-breakpoint' && narrow ? SheetShell : SideShell;
  const width = VARIANT === 'stale-resize' && frozenWidth !== null ? frozenWidth : undefined;

  return (
    <div className={VARIANT === 'legit-restyle' ? 'stage restyled' : 'stage'} ref={stage}>
      <header className="toolbar">
        <strong>Page outline</strong>
        <button
          ref={trigger}
          type="button"
          className="trigger"
          data-trace-id="trigger"
          aria-expanded={phase === 'open' || phase === 'opening'}
          aria-controls="inspector-panel"
          onClick={() => (present && phase !== 'closing' ? close() : open())}
        >
          Inspect
        </button>
      </header>
      <ul className="outline">
        <li>Navigation</li>
        <li className="selected">{title}</li>
        <li>Feature grid</li>
        <li>Footer</li>
      </ul>
      {present && (
        <div
          ref={panel}
          id="inspector-panel"
          role="region"
          aria-label="Inspector"
          data-trace-id="panel"
          className={`${PANEL_CLASS}${narrow ? ' sheet' : ''}${phase === 'closing' ? ' leaving' : ''}`}
          style={{ width }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && VARIANT !== 'escape-ignored') close();
          }}
        >
          <Shell>
            <h2>Inspector</h2>
            <label>
              Name
              <input ref={input} data-trace-id="name-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <button type="button" data-trace-id="close" onClick={close}>
              Done
            </button>
          </Shell>
        </div>
      )}
    </div>
  );
}

export function App() {
  const init = initialState();
  const [mounted, setMounted] = useState(init.mounted !== false);
  const [requested, setRequested] = useState<{ panel?: string; nonce: number }>({ nonce: 0 });
  const [view, setView] = useState<{ panel: Phase; narrow: boolean; titleLength: number }>({ panel: 'closed', narrow: false, titleLength: 0 });

  adapter.onRequest((next) => {
    if (typeof next.mounted === 'boolean') setMounted(next.mounted);
    if (typeof next.panel === 'string') setRequested((r) => ({ panel: next.panel as string, nonce: r.nonce + 1 }));
  });

  usePublish(adapter, { panel: mounted ? view.panel : 'closed', narrow: view.narrow, titleLength: view.titleLength, mounted });

  return mounted ? (
    <Inspector requested={requested} onPhase={(panel, narrow, titleLength) => setView((v) => (v.panel === panel && v.narrow === narrow && v.titleLength === titleLength ? v : { panel, narrow, titleLength }))} />
  ) : (
    <p className="removed">Inspector removed</p>
  );
}
