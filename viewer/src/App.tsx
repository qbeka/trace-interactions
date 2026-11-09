import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Stage } from './Stage.tsx';
import { Strip } from './Strip.tsx';
import {
  actionName,
  alignTime,
  busyTimes,
  describeRequirement,
  failingSide,
  focusName,
  formatMs,
  frameOf,
  mainStateKey,
  lastAt,
  originGap,
  primaryTarget,
  primaryViolation,
  ackStatus,
  requirementStatus,
  skipIdle,
  timelines,
} from './model.ts';
import { REPORT_SCHEMA, type ReportCase, type ReportData, type RunSide } from './types.ts';

declare global {
  interface Window {
    __TRACE_REPORT__?: ReportData;
  }
}

const VERDICT: Record<string, string> = {
  pass: 'Pass',
  regression: 'Regression',
  fixed: 'Fixed',
  'shared-failure': 'Shared failure',
  invalid: 'Invalid scenario',
  diverged: 'Could not finish',
};

const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const [data, setData] = useState<ReportData | null>(() => window.__TRACE_REPORT__ ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data || window.location.protocol === 'file:') return;
    fetch('report.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setData(j))
      .catch(() => {});
  }, [data]);

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.schema !== REPORT_SCHEMA) throw new Error(`expected ${REPORT_SCHEMA}`);
      setData(parsed);
      setError(null);
    } catch (err) {
      setError(`That file is not a Trace report: ${(err as Error).message}.`);
    }
  };

  if (!data || data.cases.length === 0) {
    return (
      <main className="empty">
        <span className="brand">Trace</span>
        <h1>No report loaded</h1>
        <p>
          Run <code>trace run</code> to create a report, or open a <code>report.json</code> from an earlier run.
        </p>
        <label className="button primary">
          Open report.json
          <input className="visually-hidden" type="file" accept="application/json" onChange={open} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
      </main>
    );
  }
  return <Report data={data} />;
}

function Report({ data }: { data: ReportData }) {
  const [caseId, setCaseId] = useState(data.cases[0]!.id);
  const active = data.cases.find((c) => c.id === caseId) ?? data.cases[0]!;
  const hasBoth = data.cases.length > 1;
  const toggle = useCallback(() => {
    setCaseId((id) => (id === 'reduced' ? 'original' : 'reduced'));
  }, []);
  const count = (id: ReportCase['id']) => data.cases.find((c) => c.id === id)?.scenario.actions.length;
  return (
    <div className="page">
      <header className="masthead">
        <span className="brand">Trace</span>
        <span className="mast-meta mast-id">{active.scenario.id}</span>
        <span className="mast-meta mast-builds">
          <span>{active.baseline.label}</span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{active.candidate.label}</span>
        </span>
        <span className="mast-meta mast-clock">{active.baseline.clock.mode === 'controlled' ? 'controlled time' : 'wall clock'}</span>
        {hasBoth && (
          <div className="seg sequence-switch" role="group" aria-label="Sequence">
            <button type="button" className="button" aria-label="Reduced sequence" aria-pressed={active.id === 'reduced'} onClick={active.id === 'reduced' ? undefined : toggle}>
              Reduced<span className="count">{count('reduced')}</span>
            </button>
            <button type="button" className="button" aria-label="Original sequence" aria-pressed={active.id === 'original'} onClick={active.id === 'original' ? undefined : toggle}>
              Original<span className="count">{count('original')}</span>
            </button>
          </div>
        )}
      </header>
      <CaseView key={active.id} data={data} c={active} canToggle={hasBoth} onToggle={toggle} />
    </div>
  );
}

function CaseView({ data, c, canToggle, onToggle }: { data: ReportData; c: ReportCase; canToggle: boolean; onToggle: () => void }) {
  const base = useMemo(() => timelines(c.baseline.events), [c]);
  const cand = useMemo(() => timelines(c.candidate.events), [c]);
  const end = Math.max(base.end, 1);
  const primary = useMemo(() => primaryTarget(c.scenario), [c]);
  const frame = useMemo(() => frameOf([base, cand], c.scenario.viewport), [base, cand, c]);
  const stateKey = useMemo(() => mainStateKey(c.scenario), [c]);
  const failure = primaryViolation(c);
  const side = failingSide(c);
  // A failure time is on its own build's clock. The transport runs on the baseline's.
  const pin = failure ? (side === 'candidate' ? alignTime(cand, base, failure.at.t) : failure.at.t) : null;
  const [time, setTime] = useState(pin === null ? end : Math.min(pin, end));
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.25);
  const busy = useMemo(() => busyTimes(c.baseline.events, c.candidate.events), [c]);
  const clock = useRef<{ wall: number; trace: number } | null>(null);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    clock.current = { wall: performance.now(), trace: time >= end ? 0 : time };
    const step = (now: number) => {
      const start = clock.current!;
      let next = start.trace + (now - start.wall) * rate;
      // Long quiet gaps carry no information, so playback skips them.
      const skipped = skipIdle(busy, next);
      if (skipped !== next) {
        next = skipped;
        clock.current = { wall: now, trace: next };
      }
      if (next >= end) {
        setTime(end);
        setPlaying(false);
        return;
      }
      setTime(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // `time` is only the starting point. Restarting on every frame would stall.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, end]);

  const seek = useCallback((t: number) => {
    setPlaying(false);
    setTime(Math.max(0, Math.min(end, t)));
  }, [end]);

  const stepMs = c.scenario.timing.stepMs;
  const actionTimes = useMemo(() => base.actions.map((a) => a.t), [base]);
  const prevAction = useCallback(() => seek([...actionTimes].reverse().find((t) => t < time - 0.5) ?? 0), [actionTimes, time, seek]);
  const nextAction = useCallback(() => seek(actionTimes.find((t) => t > time + 0.5) ?? end), [actionTimes, time, end, seek]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && e.key !== ' ') return;
      if (e.key === ' ') {
        if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || el.tagName === 'A') return;
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft') seek(time - stepMs);
      else if (e.key === 'ArrowRight') seek(time + stepMs);
      else if (e.key === '[') prevAction();
      else if (e.key === ']') nextAction();
      else if ((e.key === 'f' || e.key === 'F') && pin !== null) seek(pin);
      else if ((e.key === 'r' || e.key === 'R') && canToggle) onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [time, stepMs, seek, prevAction, nextAction, pin, canToggle, onToggle]);

  const candTime = alignTime(base, cand, time);
  const verdict = c.comparison.verdict;
  const reduction = data.reduction;
  const gap = useMemo(() => originGap(c), [c]);
  // The measured distance belongs to one sample, so it shows only while the replay sits on it.
  const onFailure = pin !== null && Math.abs(time - pin) < stepMs / 2;
  const broken = failure?.index !== undefined ? c.scenario.requirements[failure.index] : undefined;
  const outcome = (which: 'baseline' | 'candidate') => (side === null ? null : side === which || c.comparison.shared.length > 0 ? 'failed' : 'held');

  return (
    <main>
      <section className="finding" aria-labelledby="verdict">
        <p className={`verdict verdict-${verdict}`}>{VERDICT[verdict]}</p>
        <h1 id="verdict">{c.comparison.sentence}</h1>
        <p className="lede">
          {c.baseline.label} against {c.candidate.label}, {c.scenario.actions.length} action{c.scenario.actions.length === 1 ? '' : 's'}
          {reduction && reduction.status === 'reduced' && c.id === 'reduced'
            ? `, reduced from ${reduction.originalActions}. Reproduced in ${reduction.reducedReproduction.reproduced} of ${reduction.reducedReproduction.runs} runs.`
            : '.'}
        </p>
        {failure && broken && (
          <p className="broken-rule">
            <span className="broken-label">Requirement that failed</span>
            <span className="broken-text">{describeRequirement(broken)}</span>
            <code>{broken.kind}</code>
            {pin !== null && <button type="button" className="link" onClick={() => seek(pin)}>at {formatMs(failure.at.t)}</button>}
          </p>
        )}
      </section>

      <section className="deck" aria-label="Replay">
        <div className="stages">
          <Stage title="Baseline" label={c.baseline.label} line={base} ghost={null} time={time} scenario={c.scenario} primary={primary} stateKey={stateKey} frame={frame} failing={side === 'baseline' && pin !== null && time >= pin} gap={side === 'baseline' && onFailure ? gap : null} outcome={outcome('baseline')} />
          <Stage title="Candidate" label={c.candidate.label} line={cand} ghost={{ line: base, time }} time={candTime} scenario={c.scenario} primary={primary} stateKey={stateKey} frame={frame} failing={side === 'candidate' && pin !== null && time >= pin} gap={side === 'candidate' && onFailure ? gap : null} outcome={outcome('candidate')} />
        </div>
        <Legend gap={gap !== null} />
        <Film c={c} side={side ?? 'candidate'} time={time} onSeek={seek} />
        <Strip baseline={base} candidate={cand} stateKey={stateKey} end={end} time={time} pin={pin} />
        <div className="transport" role="group" aria-label="Replay transport">
          <button type="button" className="button primary play" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
            {playing ? 'Pause' : time >= end ? 'Replay' : 'Play'}
          </button>
          <button type="button" className="button outline" onClick={prevAction}>Previous action</button>
          <button type="button" className="button outline" onClick={nextAction}>Next action</button>
          {pin !== null && (
            <button type="button" className="button outline to-failure" onClick={() => seek(pin)}>Go to failure</button>
          )}
          <label className="scrub">
            <span className="visually-hidden">Replay position in milliseconds</span>
            <input type="range" min={0} max={end} step={1} value={time} onChange={(e) => seek(Number(e.target.value))} aria-valuetext={formatMs(time)} style={{ '--at': time / end } as CSSProperties} />
          </label>
          <output className="time">{formatMs(time)}</output>
          <div className="seg rate" role="group" aria-label="Speed">
            {RATES.map((r) => (
              <button key={r} type="button" className="button" aria-pressed={rate === r} onClick={() => setRate(r)}>{r}x</button>
            ))}
          </div>
        </div>
        <p className="keys">
          <kbd>Space</kbd> play, <kbd>←</kbd> <kbd>→</kbd> one sample, <kbd>[</kbd> <kbd>]</kbd> one action, <kbd>F</kbd> failure
          {canToggle && <>, <kbd>R</kbd> reduced or original</>}
          {prefersReducedMotion() && '. Reduced motion is on, so nothing plays until you press Play.'}
        </p>
      </section>

      <div className="columns">
        <div>
          <Requirements c={c} onSeek={seek} />
          {reduction && <Reduction data={data} active={c} />}
        </div>
        <div>
          <Violations c={c} onSeek={seek} />
          <Actions c={c} onSeek={seek} time={time} />
        </div>
      </div>
      <FocusHistory c={c} onSeek={seek} />
      <Geometry c={c} primary={primary} onSeek={seek} pin={pin} />
      <Screenshots c={c} onSeek={seek} />
      <Environment data={data} c={c} />
    </main>
  );
}

const RATES = [0.1, 0.25, 0.5, 1];

function Legend({ gap }: { gap: boolean }) {
  return (
    <ul className="legend" aria-label="Legend">
      <li><span className="key key-primary" /> tracked element</li>
      <li><span className="key key-trail" /> geometry trail</li>
      <li><span className="key key-focus" /> focus</li>
      <li><span className="key key-lost" /> focus on body</li>
      <li><span className="key key-ghost" /> baseline position</li>
      {gap && <li><span className="key key-gap" /> measured at the failure</li>}
    </ul>
  );
}

/**
 * The screenshots from the diagnostic pass, in order, as a strip to step along.
 * They are evidence beside the trace and take no part in the verdict.
 */
function Film({ c, side, time, onSeek }: { c: ReportCase; side: 'baseline' | 'candidate'; time: number; onSeek: (t: number) => void }) {
  const shots = c[side].screenshots;
  if (shots.length === 0) return null;
  // Two screenshots can share a time. The one taken for the failure is the one to show there.
  const last = lastAt(shots, time);
  const sameTime = shots.findIndex((s) => s.t === shots[last]?.t && s.label.startsWith('at '));
  const current = sameTime >= 0 ? sameTime : last;
  return (
    <div className="film">
      <p className="film-title">{side === 'candidate' ? 'Candidate' : 'Baseline'} screenshots, one for each action</p>
      <ol className="film-reel">
        {shots.map((s, i) => {
          const failure = s.label.startsWith('at ');
          const action = c.scenario.actions.find((a) => a.at === s.t && (a.note ?? a.type) === s.label);
          return (
            <li key={i}>
              <button type="button" className={`frame${failure ? ' is-failure' : ''}`} aria-current={i === current ? 'true' : undefined} onClick={() => onSeek(s.t)}>
                <img src={`screenshots/${s.path}`} alt="" loading="lazy" decoding="async" />
                <span className="frame-name">{failure ? 'failure' : action ? actionName(action) : s.label}</span>
                <span className="frame-time">{formatMs(s.t)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Requirements({ c, onSeek }: { c: ReportCase; onSeek: (t: number) => void }) {
  const failures = [...c.comparison.introduced, ...c.comparison.shared, ...c.comparison.resolved];
  return (
    <section className="block">
      <h2>What was checked</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Requirements table">
        <table className="checks">
          <thead>
            <tr><th scope="col">Requirement</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr>
          </thead>
          <tbody>
            {c.scenario.requirements.map((r, i) => {
              const hit = failures.find((v) => v.index === i);
              return (
                <tr key={i} className={hit ? 'is-broken' : undefined}>
                  <td>
                    {describeRequirement(r)}
                    <span className="kind">{r.kind}</span>
                    {hit && <button type="button" className="link" onClick={() => onSeek(hit.at.t)}>Broke at {formatMs(hit.at.t)}</button>}
                  </td>
                  <Status value={requirementStatus(i, c.baseline)} />
                  <Status value={requirementStatus(i, c.candidate)} />
                </tr>
              );
            })}
            {c.scenario.actions.some((a) => a.ack) && (
              <tr>
                <td>Each declared action was acknowledged.</td>
                <Status value={ackStatus(c.baseline)} />
                <Status value={ackStatus(c.candidate)} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Status({ value }: { value: string }) {
  return <td className={`status status-${value.replace(' ', '-')}`}><span>{value}</span></td>;
}

function Violations({ c, onSeek }: { c: ReportCase; onSeek: (t: number) => void }) {
  const all = [
    ...c.comparison.introduced.map((v) => ({ v, where: 'Candidate only' })),
    ...c.comparison.shared.map((v) => ({ v, where: 'Both builds' })),
    ...c.comparison.resolved.map((v) => ({ v, where: 'Baseline only' })),
  ];
  if (all.length === 0) return null;
  return (
    <section className="block">
      <h2>Failures</h2>
      <ol className="violations">
        {all.map(({ v, where }, i) => (
          <li key={i}>
            <button type="button" className="link" onClick={() => onSeek(v.at.t)}>{formatMs(v.at.t)}</button>
            <span>{v.sentence}</span>
            <span className="tag">{v.category}, {where.toLowerCase()}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const OUTCOMES = [['fails'], ['passes'], ['invalid'], ['other-failure'], ['unstable']] as const;

function Reduction({ data, active }: { data: ReportData; active: ReportCase }) {
  const r = data.reduction!;
  const original = data.cases.find((x) => x.id === 'original') ?? active;
  const kept = new Set(r.keptIndices);
  if (r.status !== 'reduced') {
    return (
      <section className="block">
        <h2>Reduction</h2>
        <p>
          {r.status === 'unstable'
            ? `The failure appeared in ${r.reducedReproduction.runs > 0 ? `${r.reducedReproduction.reproduced} of ${r.reducedReproduction.runs} runs of the reduced sequence` : `${r.originalReproduction.reproduced} of ${r.originalReproduction.runs} runs`}, so it is unstable and the original trace is the evidence.`
            : 'The failure did not appear again, so nothing was reduced.'}
        </p>
      </section>
    );
  }
  return (
    <section className="block">
      <h2>Reduction</h2>
      <p>
        {r.originalActions} actions became {r.reducedActions}. It took {r.attempts} attempts in {(r.elapsedMs / 1000).toFixed(1)} s.
        The result {r.oneMinimal ? 'is 1-minimal: removing any one remaining action loses this failure, makes the sequence invalid, or changes the failure' : `is not proven minimal (${r.stopped})`}.
        The failure appeared in {r.reducedReproduction.reproduced} of {r.reducedReproduction.runs} candidate runs and {r.baselineReproduction.reproduced} of {r.baselineReproduction.runs} baseline runs.
      </p>
      <ol className="kept">
        {original.scenario.actions.map((a, i) => (
          <li key={i} className={kept.has(i) ? 'is-kept' : 'is-dropped'}>
            <span className="visually-hidden">{kept.has(i) ? 'Kept: ' : 'Removed: '}</span>
            {actionName(a)}
          </li>
        ))}
      </ol>
      <div className="outcomes" aria-hidden="true">
        {OUTCOMES.map(([key]) => r.outcomes[key] > 0 && <span key={key} className={`outcome outcome-${key}`} style={{ flexGrow: r.outcomes[key] }} />)}
      </div>
      <p className="note">
        Attempts: {r.outcomes.fails} kept the failure, {r.outcomes.passes} lost it, {r.outcomes.invalid} were invalid,
        {' '}{r.outcomes['other-failure']} failed differently, {r.outcomes.unstable} were unstable.
      </p>
    </section>
  );
}

function Actions({ c, onSeek, time }: { c: ReportCase; onSeek: (t: number) => void; time: number }) {
  const rows = useMemo(() => {
    const events = (side: RunSide) => side.events.filter((e) => e.k === 'action' && e.phase === 'start' && !e.cleanup) as Extract<RunSide['events'][number], { k: 'action' }>[];
    const b = events(c.baseline);
    const d = events(c.candidate);
    return b.map((a, i) => ({ a, d: d[i] }));
  }, [c]);
  return (
    <section className="block">
      <h2>Actions</h2>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Action list">
        <table>
          <thead>
            <tr><th scope="col">#</th><th scope="col">Time</th><th scope="col">Action</th></tr>
          </thead>
          <tbody>
            {rows.map(({ a }, i) => (
              <tr key={i} className={time >= a.t && (rows[i + 1]?.a.t ?? Infinity) > time ? 'is-current' : undefined}>
                <td>{i + 1}</td>
                <td><button type="button" className="link" onClick={() => onSeek(a.t)}>{formatMs(a.t)}</button></td>
                <td>{c.scenario.actions[a.index] ? actionName(c.scenario.actions[a.index]!) : a.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FocusHistory({ c, onSeek }: { c: ReportCase; onSeek: (t: number) => void }) {
  const rows = useMemo(() => {
    const collect = (side: RunSide, name: 'b' | 'c') =>
      side.events.flatMap((e) => (e.k === 'focus' ? [{ t: e.t, seq: e.seq, name, value: `${focusName(e.ref)}${e.ref?.hidden ? ' (hidden)' : ''}` }] : []));
    const merged = new Map<number, { t: number; b: string[]; c: string[] }>();
    for (const row of [...collect(c.baseline, 'b'), ...collect(c.candidate, 'c')]) {
      if (!merged.has(row.t)) merged.set(row.t, { t: row.t, b: [], c: [] });
      merged.get(row.t)![row.name].push(row.value);
    }
    return [...merged.values()].sort((a, b) => a.t - b.t);
  }, [c]);
  return (
    <details className="block">
      <summary><h2>Focus history</h2></summary>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Focus history">
        <table>
          <thead>
            <tr><th scope="col">Time</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const last = (x: string[]) => x.join(' then ') || '-';
              return (
                <tr key={r.t} className={last(r.b) !== last(r.c) ? 'is-different' : undefined}>
                  <td><button type="button" className="link" onClick={() => onSeek(r.t)}>{formatMs(r.t)}</button></td>
                  <td>{last(r.b)}</td>
                  <td>{last(r.c)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Geometry({ c, primary, onSeek, pin }: { c: ReportCase; primary: string | null; onSeek: (t: number) => void; pin: number | null }) {
  const rows = useMemo(() => {
    if (!primary) return [];
    const of = (side: RunSide) =>
      side.events.flatMap((e) => (e.k === 'geometry' && e.target === primary ? [e] : []));
    const b = of(c.baseline);
    const d = of(c.candidate);
    const times = [...new Set([...b, ...d].map((e) => e.t))].sort((x, y) => x - y);
    const fmt = (e?: (typeof b)[number]) => (!e ? '-' : !e.rect ? 'gone' : `${Math.round(e.rect.x)}, ${Math.round(e.rect.y)}, ${Math.round(e.rect.w)} × ${Math.round(e.rect.h)}`);
    return times.map((t) => ({ t, b: fmt(b.filter((e) => e.t === t).at(-1)), c: fmt(d.filter((e) => e.t === t).at(-1)) }));
  }, [c, primary]);
  if (rows.length === 0) return null;
  return (
    <details className="block">
      <summary><h2>Geometry timeline for {primary}</h2></summary>
      <div className="table-scroll tall" tabIndex={0} role="region" aria-label="Geometry timeline">
        <table>
          <thead>
            <tr><th scope="col">Time</th><th scope="col">Baseline x, y, w × h</th><th scope="col">Candidate x, y, w × h</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t} className={r.t === pin ? 'is-failure' : r.b !== r.c ? 'is-different' : undefined}>
                <td><button type="button" className="link" onClick={() => onSeek(r.t)}>{formatMs(r.t)}</button></td>
                <td>{r.b}</td>
                <td>{r.c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Screenshots({ c, onSeek }: { c: ReportCase; onSeek: (t: number) => void }) {
  const shots = useMemo(() => {
    const failing = c.candidate.screenshots.filter((s) => s.label.startsWith('at '));
    const list = failing.length > 0 ? failing : c.candidate.screenshots.slice(-1);
    return list.map((s) => ({ s, b: c.baseline.screenshots.find((x) => x.label === s.label && x.t === s.t) ?? c.baseline.screenshots.at(-1) }));
  }, [c]);
  if (shots.length === 0) return null;
  return (
    <section className="block">
      <h2>Screenshots</h2>
      <p className="note">Supporting evidence from a separate diagnostic pass. They did not decide the verdict.</p>
      {shots.map(({ s, b }, i) => (
        <div className="shots" key={i}>
          {b && (
            <figure>
              <img src={`screenshots/${b.path}`} alt={`Baseline at ${b.t} ms`} loading="lazy" />
              <figcaption>Baseline at <button type="button" className="link" onClick={() => onSeek(b.t)}>{formatMs(b.t)}</button></figcaption>
            </figure>
          )}
          <figure>
            <img src={`screenshots/${s.path}`} alt={`Candidate at ${s.t} ms`} loading="lazy" />
            <figcaption>Candidate at <button type="button" className="link" onClick={() => onSeek(s.t)}>{formatMs(s.t)}</button></figcaption>
          </figure>
        </div>
      ))}
    </section>
  );
}

function Environment({ data, c }: { data: ReportData; c: ReportCase }) {
  const m = data.manifest;
  const clock = c.candidate.clock;
  const verified = Object.entries(clock.verified);
  return (
    <details className="block">
      <summary><h2>Environment and clock</h2></summary>
      <dl className="facts">
        <dt>Browser</dt><dd>{m.environment.browser.name} {m.environment.browser.version}</dd>
        <dt>Machine</dt><dd>{m.environment.hardware.cpu}, {m.environment.hardware.cores} cores, {m.environment.hardware.memoryGb} GB</dd>
        <dt>OS</dt><dd>{m.environment.os.platform} {m.environment.os.release} {m.environment.os.arch}</dd>
        <dt>Viewport</dt><dd>{c.scenario.viewport.width} × {c.scenario.viewport.height} at {c.scenario.viewport.deviceScaleFactor}x</dd>
        <dt>Fonts</dt><dd>{c.candidate.raster?.fontFamily ?? 'not recorded'}{c.candidate.raster?.loadedFonts.length ? `, loaded ${c.candidate.raster.loadedFonts.join(', ')}` : ''}</dd>
        <dt>Seed</dt><dd>{c.scenario.seed}</dd>
        <dt>Source</dt><dd>{m.source.commit?.slice(0, 12) ?? 'not a git checkout'}{m.source.dirty ? ' with local changes' : ''}</dd>
        <dt>Clock checks</dt><dd>{verified.length ? verified.map(([k, ok]) => `${k} ${ok ? 'held' : 'failed'}`).join(', ') : 'not run in wall mode'}</dd>
        <dt>Not controlled</dt><dd>{clock.uncontrolled.join('; ')}</dd>
        <dt>Used by the page</dt><dd>{clock.used.length ? clock.used.join(', ') : 'none of the uncontrolled channels Trace can detect'}</dd>
      </dl>
      <p className="note">Raw evidence: <a href="report.json">report.json</a>. Regenerate with <code>trace report</code>.</p>
    </details>
  );
}
