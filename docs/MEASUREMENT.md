# Measurement plan

This file was committed before the final measurement. The commit that adds it is the
freeze. Anything changed afterward is listed in `docs/REPORT.md`.

## Rules

- Correctness, stress, ordinary workflows and performance are reported separately.
- Each number links to a saved run with a manifest. Raw samples stay apart from
  summaries, in `results/`.
- A run is excluded only for a stated reason, listed in the manifest.
- Timings use the same browser, fixture, input order and machine. Timing numbers never
  come from virtual time.
- The development corpus is tuned. The first run missed 5 of 18 seeded bugs, mislabeled
  1 and flagged 3 of 13 clean builds, and the oracle changed because of it. That raw run
  is in `results/development`. A score on this corpus shows the harness works. It does
  not show the oracle generalizes.

## Workloads

| Name | What runs | Repetitions | Script |
|---|---|---|---|
| Development corpus | 31 builds of 3 fixtures, each against that fixture's correct build, over all its scenarios | 1, controlled time | `bench/corpus.ts` |
| Browser matrix | The same corpus on Firefox and WebKit | 1, controlled time | `bench/corpus.ts --browser` |
| Holdout | 10 builds of the combobox fixture, over 5 scenarios | Once only | `bench/corpus.ts --labels corpus/holdout.json` |
| Random sessions | 100 seeded sessions of 18 actions on each correct build | 1 per seed | `bench/random.ts` |
| Reduction | 5 seeded bugs on generated sessions | 5 per bug, new browser each | `bench/reduction.ts` |
| Overhead | `long-session` on the correct inspector, at 3 recording levels | 7 after 2 warmup rounds, new browser each | `bench/overhead.ts` |

## Holdout rules

The combobox fixture was written after the oracle stopped changing. Its labels were
committed before any detector run on it. Only its correct build ran beforehand, to
confirm the scenarios are valid. It runs once. A miss or false alarm is reported as it
is, and the oracle does not change to fix it.

## Controls

The corpus reports three controls next to Trace, so the score has something to mean.

- `never` flags nothing.
- `trace-diff` flags any difference in recorded state, focus or geometry.
- `final-screenshot` flags more than 576 differing pixels in the settled screenshot,
  which is 0.1 percent of 900 x 640, with `pixelmatch` at threshold 0.1. It compares two
  captures from one run on one machine, the most favorable case for it.

## Scoring

A build is scored once, over all its fixture's scenarios.

- A seeded build is a true positive if the expected category appears in a regression.
- It is a wrong category if something else is flagged and the expected one is not.
- It is a false negative if nothing is flagged.
- A clean build is a false positive if any scenario reports a regression.
- A scenario that cannot finish on the candidate is `diverged`. It counts as neither a
  detection nor a false alarm, and it is listed.

Results are counts with denominators. They describe this corpus. They are not an
accuracy claim about other code.

## Metrics

Definitions are in `src/perf.ts`.

- `input-to-handler`: `Event.timeStamp` to the recorder's capture listener.
- `input-to-commit`: `Event.timeStamp` to the fixture publishing state in a layout effect.
- `input-to-render`: `Event.timeStamp` to one message task after the next
  `requestAnimationFrame` following the commit. This is the next frame the page
  observed, not a displayed frame.
- `task-ms`, `script-ms`: Chromium `Performance.getMetrics` deltas across the scenario,
  read over CDP from outside the page.
- Overhead: per round, level minus the `off` level from the same round. The median and
  range across rounds are reported.
- Reproduction rate: fresh runs showing the same failure fingerprint, out of 10.
- Reduction time: wall clock from start to finished report, including the confirmation
  and reproduction runs. Budget per reduction: 80 attempts or 180 s.

Each run counts once. Thousands of events inside one browser are not independent
samples. Lab timings are not INP.

## Pass criteria

| Check | Target |
|---|---|
| Smoke suite | Under 60 s after install |
| Full benchmark | Under 40 minutes on the reference machine |
| Seeded control detection on the development corpus | Every seeded bug caught. Any miss invalidates the result. |
| Reduction | Same fingerprint, reproduced in 10 of 10 fresh runs, 0 on the baseline |
| Holdout | Reported as measured. No target, because a target would invite tuning. |
| Overhead | Reported as measured |
