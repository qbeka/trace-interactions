/**
 * Reads the reducer's saved attempts back the way the reducer used them. Only an
 * attempt that kept the failure changes which steps are still in play, so the
 * page can show the working list after any attempt without guessing.
 */
export interface Attempt { kept: number[]; outcome: string }

/** The steps still in play after the first `n` attempts. */
export function aliveAfter(attempts: Attempt[], count: number, n: number): number[] {
  let alive = Array.from({ length: count }, (_, i) => i);
  for (const attempt of attempts.slice(0, n)) if (attempt.outcome === 'fails') alive = attempt.kept;
  return alive;
}

/** The attempt that dropped a step for good, counted from 0, or null if the step survived. */
export function diedAt(attempts: Attempt[], step: number): number | null {
  const at = attempts.findIndex((a) => a.outcome === 'fails' && !a.kept.includes(step));
  return at < 0 ? null : at;
}

const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

/** One sentence for the attempt on screen. `n` attempts have run, so `n` of 0 is the start. */
export function attemptNote(attempts: Attempt[], count: number, n: number): string {
  const total = attempts.length;
  if (n <= 0) return `All ${count} steps reproduce the jump, so Trace starts deleting steps to find the ones it needs.`;
  const alive = aliveAfter(attempts, count, n).length;
  if (n >= total) {
    // Minimal only if every attempt since the last accepted one removed a single step and none kept the failure.
    const accepted = attempts.findLastIndex((a) => a.outcome === 'fails');
    const proof = attempts.slice(accepted + 1);
    const minimal = proof.length === alive && proof.every((a) => a.kept.length === alive - 1);
    return minimal
      ? `${total} attempts left ${steps(alive)}, and taking any one of them away loses the jump.`
      : `${total} attempts left ${steps(alive)}.`;
  }
  const attempt = attempts[n - 1]!;
  const ran = steps(attempt.kept.length);
  switch (attempt.outcome) {
    case 'fails': {
      const dropped = aliveAfter(attempts, count, n - 1).length - alive;
      return `Attempt ${n} ran ${ran} and the panel still jumped, so the ${dropped === 1 ? 'one step' : `${dropped} steps`} it left out ${dropped === 1 ? 'is' : 'are'} gone for good.`;
    }
    case 'passes':
      return `Attempt ${n} ran ${ran} and nothing failed, so something it left out is needed.`;
    case 'invalid':
      return `Attempt ${n} could not run with these ${ran}, so it says nothing either way.`;
    case 'other-failure':
      return `Attempt ${n} ran ${ran} and it failed, but not as this bug, so it does not count.`;
    default:
      return `Attempt ${n} ran ${ran} and failed only some of the time, so Trace kept what it left out.`;
  }
}
