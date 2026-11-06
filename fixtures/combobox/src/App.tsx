import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAdapter, initialState, usePublish } from '../../shared/adapter.ts';

/**
 * A search combobox with slow, out-of-order results. This fixture is the holdout
 * family: it was written after the oracle was frozen, so nothing in the oracle was
 * tuned against it. See corpus/holdout.json.
 */
declare const __VARIANT__: string;
const VARIANT = __VARIANT__;

const adapter = createAdapter('combobox', '1');
const OPTIONS = ['Apple', 'Apricot', 'Avocado', 'Banana', 'Blueberry', 'Cherry', 'Date', 'Fig'];
const DEBOUNCE_MS = VARIANT === 'legit-fast-debounce' ? 40 : 120;

/** Shorter queries are slower, so an early request can answer after a later one. */
const latencyFor = (query: string): number => Math.max(60, 420 - query.length * 120);

function Combobox({ onState }: { onState: (s: { listbox: string; resultsFor: string; count: number }) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [resultsFor, setResultsFor] = useState('');
  const [listWidth, setListWidth] = useState<number | null>(null);
  const token = useRef(0);
  const debounce = useRef(0);
  const reply = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => onState({ listbox: open ? 'open' : 'closed', resultsFor, count: results.length }));

  useLayoutEffect(() => {
    if (VARIANT === 'stale-list-width' && open) setListWidth(root.current!.clientWidth);
  }, [open]);

  function search(value: string) {
    const id = ++token.current;
    reply.current = window.setTimeout(() => {
      if (VARIANT !== 'stale-response' && id !== token.current) return;
      setResults(OPTIONS.filter((o) => o.toLowerCase().startsWith(value.toLowerCase())));
      setResultsFor(value);
    }, latencyFor(value));
  }

  function change(value: string) {
    setQuery(value);
    setOpen(true);
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => search(value), DEBOUNCE_MS);
  }

  useEffect(() => {
    if (VARIANT === 'poll-leak') {
      window.setInterval(() => {}, 1000);
    }
    return () => {
      window.clearTimeout(debounce.current);
      window.clearTimeout(reply.current);
    };
  }, []);

  return (
    <div className={VARIANT === 'legit-restyle' ? 'box restyled' : 'box'} ref={root}>
      <label htmlFor="fruit">Search fruit</label>
      <input
        key={VARIANT === 'remount-on-results' ? results.length : 'input'}
        id="fruit"
        role="combobox"
        aria-expanded={open}
        aria-controls="fruit-list"
        aria-autocomplete="list"
        autoComplete="off"
        data-trace-id="input"
        autoFocus={VARIANT === 'remount-on-results' ? false : undefined}
        value={query}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && VARIANT !== 'escape-keeps-open') setOpen(false);
        }}
      />
      {VARIANT === 'duplicate-list-id' && <ul id="fruit-list" className="template" aria-hidden="true" />}
      {open && (
        <ul
          id="fruit-list"
          role="listbox"
          aria-label="Results"
          data-trace-id="list"
          className={VARIANT === 'legit-wide-list' ? 'list wide' : 'list'}
          style={{ width: listWidth ?? undefined }}
        >
          {results.map((r) => (
            <li key={r} role="option" aria-selected={false}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function App() {
  const init = initialState();
  const [mounted, setMounted] = useState(init.mounted !== false);
  const [view, setView] = useState({ listbox: 'closed', resultsFor: '', count: 0 });

  adapter.onRequest((next) => {
    if (typeof next.mounted === 'boolean') setMounted(next.mounted);
  });

  usePublish(adapter, { ...view, mounted });

  return mounted ? (
    <Combobox onState={(s) => setView((v) => (v.listbox === s.listbox && v.resultsFor === s.resultsFor && v.count === s.count ? v : s))} />
  ) : (
    <p>Search removed</p>
  );
}
