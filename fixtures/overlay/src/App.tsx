import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAdapter, initialState, usePublish } from '../../shared/adapter.ts';

/**
 * A modal dialog with focus restoration, built on plain DOM. The exit is a CSS
 * transition, so this fixture exercises the CSS channel of the controlled clock.
 * See the inspector fixture for how `__VARIANT__` works.
 */
declare const __VARIANT__: string;
const VARIANT = __VARIANT__;

type Phase = 'closed' | 'open' | 'closing';

const adapter = createAdapter('overlay', '1');
const GHOST_MS = 160;

function Dialog({ phase, ghost, onClose, onEnd, input, password, setPassword }: {
  phase: Phase;
  ghost: boolean;
  onClose: () => void;
  onEnd: () => void;
  input?: React.RefObject<HTMLInputElement | null>;
  password: string;
  setPassword: (v: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  // Tab stays inside a modal dialog: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = [...dialog.current!.querySelectorAll<HTMLElement>('input, button')];
    const first = items[0]!;
    const last = items.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={phase === 'closing' ? 'backdrop leaving' : 'backdrop'} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        data-trace-id="dialog"
        className={`dialog${VARIANT === 'legit-large' ? ' large' : ''}${ghost ? ' ghost' : ''}`}
        onKeyDown={onKeyDown}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'opacity' && e.target === e.currentTarget) onEnd();
        }}
      >
        <h2 id="dialog-title" data-trace-id="title">Archive project</h2>
        <p>Confirm with the synthetic password. This fixture stores nothing.</p>
        <label>
          Password
          <input ref={input} type="password" autoComplete="off" data-trace-id="dialog-input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="row">
          <button type="button" data-trace-id="cancel" onClick={onClose}>Cancel</button>
          <button type="button" data-trace-id="confirm" onClick={onClose}>Archive</button>
        </div>
      </div>
    </div>
  );
}

function Overlay({ onPhase, requested }: { onPhase: (p: Phase, length: number) => void; requested: { dialog?: string; nonce: number } }) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [password, setPassword] = useState('');
  const [opens, setOpens] = useState(0);
  const [ghosts, setGhosts] = useState<number[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saved = useRef<HTMLButtonElement | null>(null);

  useEffect(() => onPhase(phase, password.length));

  function open() {
    if (phase === 'open') return;
    if (VARIANT === 'stale-restore') saved.current = trigger.current;
    setPhase('open');
    setOpens((n) => n + 1);
  }

  function close() {
    if (phase !== 'open') return;
    if (VARIANT === 'live-exit-clone') {
      // Mistake: the exit plays on a copy that stays interactive, so a fast
      // reopen gives the user two live dialogs.
      const id = opens;
      setGhosts((g) => [...g, id]);
      setTimeout(() => setGhosts((g) => g.filter((x) => x !== id)), GHOST_MS);
      setPhase('closed');
      return;
    }
    setPhase(VARIANT === 'legit-instant' ? 'closed' : 'closing');
  }

  useLayoutEffect(() => {
    if (phase !== 'open') return;
    if (VARIANT === 'hidden-clone-focus') {
      // Mistake: finds the input by selector, and the first match is the measuring clone.
      document.querySelector<HTMLElement>('[data-trace-id="dialog-input"]')?.focus();
    } else {
      input.current?.focus();
    }
  }, [phase]);

  useLayoutEffect(() => {
    if (phase === 'open') return;
    if (VARIANT === 'no-restore') return;
    const target = VARIANT === 'stale-restore' ? saved.current : trigger.current;
    if (opens > 0) target?.focus();
    // Runs when the dialog leaves, on the commit that lifts `inert` from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== 'open') return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && VARIANT !== 'escape-ignored') close();
    };
    document.addEventListener('keydown', onEscape);
    return () => {
      if (VARIANT !== 'listener-leak') document.removeEventListener('keydown', onEscape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, opens]);

  useEffect(() => {
    if (requested.dialog === 'open') open();
    if (requested.dialog === 'closed') close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested.nonce]);

  return (
    <div className={VARIANT === 'legit-restyle' ? 'app restyled' : 'app'}>
      <main inert={phase === 'open'}>
        <h1>Project settings</h1>
        <section>
          <h2 id={VARIANT === 'duplicate-id' ? 'dialog-title' : undefined}>Danger zone</h2>
          <p>Archiving hides the project from every list.</p>
          <button key={VARIANT === 'stale-restore' ? opens : 0} ref={trigger} type="button" data-trace-id="trigger" aria-haspopup="dialog" onClick={open}>
            Archive project
          </button>
        </section>
      </main>
      {VARIANT === 'hidden-clone-focus' && phase === 'open' && (
        <div className="measure" aria-hidden="true">
          <input data-trace-id="dialog-input" aria-label="Password copy" />
        </div>
      )}
      {ghosts.map((id) => (
        <Dialog key={id} phase="open" ghost onClose={() => {}} onEnd={() => {}} password={password} setPassword={setPassword} />
      ))}
      {phase !== 'closed' && (
        <Dialog
          phase={phase}
          ghost={false}
          onClose={close}
          onEnd={() => phase === 'closing' && setPhase('closed')}
          input={input}
          password={password}
          setPassword={setPassword}
        />
      )}
    </div>
  );
}

export function App() {
  const init = initialState();
  const [mounted, setMounted] = useState(init.mounted !== false);
  const [requested, setRequested] = useState<{ dialog?: string; nonce: number }>({ nonce: 0 });
  const [view, setView] = useState<{ dialog: Phase; passwordLength: number }>({ dialog: 'closed', passwordLength: 0 });

  adapter.onRequest((next) => {
    if (typeof next.mounted === 'boolean') setMounted(next.mounted);
    if (typeof next.dialog === 'string') setRequested((r) => ({ dialog: next.dialog as string, nonce: r.nonce + 1 }));
  });

  usePublish(adapter, { dialog: mounted ? view.dialog : 'closed', passwordLength: view.passwordLength, mounted });

  return mounted ? (
    <Overlay requested={requested} onPhase={(dialog, passwordLength) => setView((v) => (v.dialog === dialog && v.passwordLength === passwordLength ? v : { dialog, passwordLength }))} />
  ) : (
    <p className="removed">Settings removed</p>
  );
}
