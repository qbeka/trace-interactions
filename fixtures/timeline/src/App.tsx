import { useEffect, useRef, useState } from 'react';
import { createAdapter, initialState, usePublish } from '../../shared/adapter.ts';

/**
 * A timeline scrubber. Dragging previews a value. Release commits it, and a
 * cancel returns to the value from before the drag. `requestAnimationFrame`
 * settles the handle after release, which exercises the frame channel.
 * See the inspector fixture for how `__VARIANT__` works.
 */
declare const __VARIANT__: string;
const VARIANT = __VARIANT__;

const adapter = createAdapter('timeline', '1');
const MAX = 100;
const STEP = VARIANT === 'legit-fine-steps' ? 2 : 5;
const SETTLE_MS = 120;

const clamp = (v: number): number => Math.max(0, Math.min(MAX, v));
const snap = (v: number): number => clamp(Math.round(v / STEP) * STEP);

function Timeline({ onState }: { onState: (s: { value: number; dragging: boolean; settling: boolean }) => void }) {
  const [value, setValue] = useState(30);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const before = useRef(30);
  const frame = useRef(0);
  const windowMove = useRef<((e: PointerEvent) => void) | null>(null);

  useEffect(() => onState({ value, dragging, settling }));

  const fromX = (clientX: number): number => {
    const box = track.current!.getBoundingClientRect();
    return clamp(((clientX - box.left) / box.width) * MAX);
  };

  function begin(e: React.PointerEvent<HTMLDivElement>) {
    before.current = value;
    setDragging(true);
    if (VARIANT === 'window-listener-leak') {
      // Mistake: only a clean release removes this.
      windowMove.current = (ev) => setValue(fromX(ev.clientX));
      window.addEventListener('pointermove', windowMove.current);
    } else {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function move(e: React.PointerEvent<HTMLDivElement>) {
    if (dragging && VARIANT !== 'window-listener-leak') setValue(fromX(e.clientX));
  }

  /** Eases the handle to the nearest step. */
  function settle() {
    const start = performance.now();
    setSettling(true);
    const tick = (now: number) => {
      if (now - start >= SETTLE_MS) {
        setValue((v) => snap(v));
        setSettling(false);
        if (VARIANT !== 'raf-leak') return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }

  function release() {
    if (!dragging) return;
    setDragging(false);
    if (windowMove.current) {
      window.removeEventListener('pointermove', windowMove.current);
      windowMove.current = null;
    }
    settle();
  }

  function cancel() {
    if (VARIANT === 'drag-stuck-on-cancel' || !dragging) return;
    setDragging(false);
    if (VARIANT !== 'cancel-keeps-preview') setValue(before.current);
  }

  useEffect(() => () => {
    if (VARIANT !== 'raf-leak') cancelAnimationFrame(frame.current);
  }, []);

  return (
    <div className={VARIANT === 'legit-restyle' ? 'app restyled' : 'app'}>
      <h1>Sequence 04</h1>
      <p className="readout">Playhead at {Math.round(value)}</p>
      <div ref={track} className="track" data-trace-id="track">
        <div className="fill" style={{ width: `${value}%` }} />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Playhead"
          aria-valuemin={0}
          aria-valuemax={MAX}
          aria-valuenow={Math.round(value)}
          data-trace-id="handle"
          className={VARIANT === 'legit-thick-handle' ? 'handle thick' : 'handle'}
          style={{ left: `${value}%` }}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={cancel}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
            if (VARIANT === 'keyboard-ignored') return;
            if (e.key === 'ArrowRight') setValue((v) => snap(v + STEP));
            if (e.key === 'ArrowLeft') setValue((v) => snap(v - STEP));
          }}
        />
      </div>
    </div>
  );
}

export function App() {
  const init = initialState();
  const [mounted, setMounted] = useState(init.mounted !== false);
  const [view, setView] = useState({ value: 30, dragging: false, settling: false });

  adapter.onRequest((next) => {
    if (typeof next.mounted === 'boolean') setMounted(next.mounted);
  });

  usePublish(adapter, { value: mounted ? Math.round(view.value) : null, dragging: mounted && view.dragging, settling: mounted && view.settling, mounted });

  return mounted ? (
    <Timeline onState={(s) => setView((v) => (v.value === s.value && v.dragging === s.dragging && v.settling === s.settling ? v : s))} />
  ) : (
    <p className="removed">Timeline removed</p>
  );
}
