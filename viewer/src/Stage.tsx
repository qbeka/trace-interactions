import type { Scenario } from '../../src/scenario/schema.ts';
import { focusAt, focusName, rectAt, stateAt, trailAt, viewportAt, type Frame, type Timelines } from './model.ts';

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
}

/**
 * Draws the recorded rectangles, not a video. The stage shows what a screenshot
 * cannot: where focus is and the path the panel took to get there.
 */
export function Stage({ title, label, line, ghost, time, scenario, primary, stateKey, failing, frame }: Props) {
  const vp = viewportAt(line, time, scenario.viewport);
  const names = Object.keys(scenario.targets).filter((n) => scenario.targets[n]?.traceId);
  const focus = focusAt(line, time);
  const focusTarget = focus ? names.find((n) => scenario.targets[n]?.traceId === focus.traceId) : undefined;
  const focusRect = focusTarget ? rectAt(line, focusTarget, time) : null;
  const trail = primary ? trailAt(line, primary, time) : [];
  const unit = Math.max(frame.w, frame.h) / 100;
  const state = stateKey ? stateAt(line, stateKey, time) : null;
  const ghostRect = ghost && primary ? rectAt(ghost.line, primary, ghost.time) : null;
  const summary = `${title} at ${Math.round(time)} ms. ${stateKey ?? 'state'} is ${state ?? 'unknown'}. Focus is on ${focusName(focus)}.`;

  return (
    <figure className={failing ? 'stage is-failing' : 'stage'}>
      <figcaption>
        <span className="stage-title">{title}</span>
        <span className="stage-label">{label}</span>
      </figcaption>
      <svg viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        <rect className="outside" x={frame.x} y={frame.y} width={frame.w} height={frame.h} />
        <rect className="vp" x={0.5} y={0.5} width={vp.width - 1} height={vp.height - 1} />
        {names.map((n) => {
          const r = rectAt(line, n, time);
          if (!r || n === primary) return null;
          return (
            <g key={n}>
              <rect className="node" x={r.x} y={r.y} width={r.w} height={r.h} rx={unit * 0.4} />
              <text className="node-name" x={r.x + r.w / 2} y={r.y + r.h + unit * 2.4} style={{ fontSize: unit * 2 }}>{n}</text>
            </g>
          );
        })}
        {ghostRect && <rect className="ghost" x={ghostRect.x} y={ghostRect.y} width={ghostRect.w} height={ghostRect.h} rx={unit * 0.6} />}
        {primary && (() => {
          const r = rectAt(line, primary, time);
          return r ? <rect className="primary" x={r.x} y={r.y} width={r.w} height={r.h} rx={unit * 0.6} /> : null;
        })()}
        {trail.length > 1 && (
          <polyline className="trail" style={{ strokeWidth: unit * 0.22 }} points={trail.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
        {trail.map((p, i) => (
          <circle key={i} className="trail-dot" cx={p.x} cy={p.y} r={unit * 0.28} />
        ))}
        {focusRect ? (
          <rect
            className={focus?.hidden ? 'focus is-invalid' : 'focus'}
            style={{ strokeWidth: unit * 0.35 }}
            x={focusRect.x - unit * 0.6}
            y={focusRect.y - unit * 0.6}
            width={focusRect.w + unit * 1.2}
            height={focusRect.h + unit * 1.2}
            rx={unit * 0.9}
          />
        ) : (
          <circle className="focus-lost" cx={unit * 3} cy={unit * 3} r={unit * 1.1} style={{ strokeWidth: unit * 0.3 }} />
        )}
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
