import type { Scenario } from '../../src/scenario/schema.ts';
import { focusAt, focusName, rectAt, stateAt, trailAt, viewportAt, type Frame, type OriginGap, type Timelines } from './model.ts';

interface Props {
  title: string;
  label: string;
  line: Timelines;
  /** The other build, drawn as a faint ghost so a divergence shows at a glance. */
  ghost: { line: Timelines; time: number } | null;
  time: number;
  scenario: Scenario;
  primary: string | null;
  stateKey: string | null;
  failing: boolean;
  frame: Frame;
  /** The measured distance behind the failure, drawn while the replay sits on it. */
  gap: OriginGap | null;
  /** What the verdict says about this build, for the caption. */
  outcome: 'held' | 'failed' | null;
}

/**
 * Draws the recorded rectangles, not a video. The stage shows what a screenshot
 * cannot: where focus is and the path the panel took to get there.
 */
export function Stage({ title, label, line, ghost, time, scenario, primary, stateKey, failing, frame, gap, outcome }: Props) {
  const vp = viewportAt(line, time, scenario.viewport);
  const names = Object.keys(scenario.targets).filter((n) => scenario.targets[n]?.traceId);
  const focus = focusAt(line, time);
  const focusTarget = focus ? names.find((n) => scenario.targets[n]?.traceId === focus.traceId) : undefined;
  const focusRect = focusTarget ? rectAt(line, focusTarget, time) : null;
  const trail = primary ? trailAt(line, primary, time) : [];
  const unit = Math.max(frame.w, frame.h) / 100;
  const state = stateKey ? stateAt(line, stateKey, time) : null;
  const ghostRect = ghost && primary ? rectAt(ghost.line, primary, ghost.time) : null;
  const summary = `${title} at ${Math.round(time)} ms, where ${stateKey ?? 'state'} is ${state ?? 'unknown'} and focus is on ${focusName(focus)}`;

  return (
    <figure className={failing ? 'stage is-failing' : 'stage'}>
      <figcaption>
        <span className="stage-title">{title}</span>
        <span className="stage-label">{label}</span>
        {outcome && <span className={`stage-outcome is-${outcome}`}>{outcome === 'failed' ? 'Fails here' : 'Holds'}</span>}
      </figcaption>
      <svg viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet" style={{ aspectRatio: String(Math.max(1.5, Math.min(2.4, frame.w / frame.h))) }}>
        <rect className="outside" x={frame.x} y={frame.y} width={frame.w} height={frame.h} />
        <rect className="vp" x={0.5} y={frame.y - unit * 20} width={vp.width - 1} height={vp.height + unit * 40} />
        {names.map((n) => {
          const r = rectAt(line, n, time);
          if (!r || n === primary) return null;
          return (
            <g key={n}>
              <rect className="node" x={r.x} y={r.y} width={r.w} height={r.h} rx={unit * 0.5} />
              {r.w >= unit * 6 && <text className="node-name" x={r.x + r.w / 2} y={r.y + r.h / 2 + unit * 0.7} style={{ fontSize: unit * 1.9 }}>{n}</text>}
            </g>
          );
        })}
        {ghostRect && <rect className="ghost" x={ghostRect.x} y={ghostRect.y} width={ghostRect.w} height={ghostRect.h} rx={unit * 0.8} />}
        {primary && (() => {
          const r = rectAt(line, primary, time);
          return r ? <rect className="primary" x={r.x} y={r.y} width={r.w} height={r.h} rx={unit * 0.8} /> : null;
        })()}
        {trail.length > 1 && <polyline className="trail" points={trail.map((p) => `${p.x},${p.y}`).join(' ')} />}
        {trail.map((p, i) => (
          <circle key={i} className="trail-dot" cx={p.x} cy={p.y} r={unit * 0.3} />
        ))}
        {focusRect ? (
          <rect
            className={focus?.hidden ? 'focus is-invalid' : 'focus'}
            x={focusRect.x - unit * 0.6}
            y={focusRect.y - unit * 0.6}
            width={focusRect.w + unit * 1.2}
            height={focusRect.h + unit * 1.2}
            rx={unit * 0.9}
          />
        ) : (
          <circle className="focus-lost" cx={frame.x + unit * 3} cy={frame.y + unit * 3} r={unit * 1.1} />
        )}
        {gap && <Gap gap={gap} unit={unit} />}
      </svg>
      <dl className="stage-readout">
        <div>
          <dt>{stateKey ?? 'state'}</dt>
          <dd>{state ?? 'none'}</dd>
        </div>
        <div>
          <dt>focus</dt>
          <dd className={!focus ? 'muted-value' : undefined}>{focusName(focus)}</dd>
        </div>
      </dl>
    </figure>
  );
}

/** A dimension line between where the target should have started and where it did. */
function Gap({ gap, unit }: { gap: OriginGap; unit: number }) {
  const { from, to } = gap;
  const across = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  const text = `${gap.px} px`;
  const wide = unit * (text.length * 1.25 + 2.4);
  if (across) {
    const y = Math.max(from.y + from.h, to.y + to.h) + unit * 4;
    const mid = (from.x + to.x) / 2;
    return (
      <g className="gap">
        <rect className="gap-start" x={to.x} y={to.y} width={to.w} height={to.h} rx={unit * 0.8} />
        <path className="gap-extend" d={`M${from.x} ${from.y + from.h + unit}V${y + unit}M${to.x} ${to.y + to.h + unit}V${y + unit}`} />
        <path className="gap-line" d={`M${from.x} ${y}H${to.x}`} />
        <rect className="gap-pill" x={mid - wide / 2} y={y + unit * 1.4} width={wide} height={unit * 3.6} rx={unit * 1.8} />
        <text className="gap-text" x={mid} y={y + unit * 3.9} style={{ fontSize: unit * 2.1 }}>{text}</text>
      </g>
    );
  }
  const x = Math.max(from.x + from.w, to.x + to.w) + unit * 4;
  const mid = (from.y + to.y) / 2;
  return (
    <g className="gap">
      <rect className="gap-start" x={to.x} y={to.y} width={to.w} height={to.h} rx={unit * 0.8} />
      <path className="gap-extend" d={`M${from.x + from.w + unit} ${from.y}H${x + unit}M${to.x + to.w + unit} ${to.y}H${x + unit}`} />
      <path className="gap-line" d={`M${x} ${from.y}V${to.y}`} />
      <rect className="gap-pill" x={x + unit * 1.4} y={mid - unit * 1.8} width={wide} height={unit * 3.6} rx={unit * 1.8} />
      <text className="gap-text" x={x + unit * 1.4 + wide / 2} y={mid + unit * 0.7} style={{ fontSize: unit * 2.1 }}>{text}</text>
    </g>
  );
}
