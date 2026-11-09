import { focusSegments, formatMs, stateSegments, type Segment, type Timelines } from './model.ts';

interface Props {
  baseline: Timelines;
  candidate: Timelines;
  stateKey: string | null;
  end: number;
  time: number;
  pin: number | null;
}

const pct = (t: number, end: number): string => `${(t / Math.max(end, 1)) * 100}%`;

function Lane({ build, name, segments, end }: { build: string; name: string; segments: Segment[]; end: number }) {
  return (
    <div className="lane">
      <span className="lane-name"><b>{build}</b> {name}</span>
      <div className="lane-track">
        {segments.map((s, i) => (
          <span
            key={i}
            className={`seg seg-${(i % 2) + 1}`}
            style={{ left: pct(s.from, end), width: pct(s.to - s.from, end) }}
            title={`${s.value}, ${formatMs(s.from)} to ${formatMs(s.to)}`}
          >
            {(s.to - s.from) / end > 0.06 && <span className="seg-text">{s.value}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Two aligned traces. Action ticks and the failure pin cross both. */
export function Strip({ baseline, candidate, stateKey, end, time, pin }: Props) {
  return (
    <div className="strip" aria-hidden="true">
      <div className="strip-rows">
        {stateKey && <Lane build="Baseline" name={stateKey} segments={stateSegments(baseline, stateKey)} end={end} />}
        {stateKey && <Lane build="Candidate" name={stateKey} segments={stateSegments(candidate, stateKey)} end={end} />}
        <Lane build="Baseline" name="focus" segments={focusSegments(baseline)} end={end} />
        <Lane build="Candidate" name="focus" segments={focusSegments(candidate)} end={end} />
        <div className="strip-overlay">
          {candidate.actions.map((a) => (
            <span key={a.seq} className="tick" style={{ left: pct(a.t, end) }} />
          ))}
          {pin !== null && <span className="pin" style={{ left: pct(pin, end) }} />}
          <span className="playhead" style={{ left: pct(time, end) }} />
        </div>
      </div>
    </div>
  );
}
