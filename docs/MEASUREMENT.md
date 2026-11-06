# Measurement plan

This file was committed before the first frozen measurement, and revision 2 at the end
was committed before the second. Anything changed after a freeze is listed in
`docs/REPORT.md`.

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
| Full benchmark | Under 40 minutes on the reference machine. Revision 2 raises this to 50, because it adds 2 steps. |
| Seeded control detection on the development corpus | Every seeded bug caught. Any miss invalidates the result. |
| Reduction | Same fingerprint, reproduced in 10 of 10 fresh runs, 0 on the baseline |
| Holdout | Reported as measured. No target, because a target would invite tuning. |
| Overhead | Reported as measured |

## Revision 2

An independent review on a clean clone found real problems after the first frozen run:
requirements that passed without checking anything, an idle jump that could change a
verdict, a reducer that accepted a sequence the baseline could not run, a run folder that
could run commands, and a blinded control. Fixing them changed the oracle, so everything
is measured again on the final code.

- **Oracle.** Each requirement now reports `held`, `broken` or `not-exercised`. Several
  requirements became stricter. A key the page never publishes makes the scenario invalid.
- **Trace difference control.** It now compares every recorded channel, sorted within
  each ms. The first version compared only state, focus and geometry, which blinded it.
- **Holdout.** The result from `432cf66` stands as the only held-out result, and it
  belongs to the oracle of that commit. The combobox family has now been seen, and some
  fixes came from a review that used it, so the rerun on final code is a regression
  check. It is reported under its own name and is not a second holdout.
- **Random sessions.** Seeds are 1001 to 1100, which no development run used. The
  requirement list stays the reduced one in `bench/generate.ts`, and the report says so.
- **Input check.** A press that does not land within 3 px of its aim now makes the run
  invalid. The review saw WebKit misplace presses, and those runs had passed silently.
- **Display.** The full run holds the display awake with `caffeinate -d`. The reviewer's
  WebKit failures happened during a long idle period. The cause is unproven.
- **Scoring.** A build that fails to run a scenario because of input is listed as invalid,
  and it never counts as a detection.

## Revision 3

The reviewer rechecked revision 2 and found regressions in my fixes. These changes come
before the final run, and everything except the one holdout run is measured again.

- An acknowledgement search now ends at a later action on the same key, not at any action.
- A reference removed while its target animates out is no longer a failure.
- Typing into a field no longer excuses that field losing focus.
- `traceId` values are restricted to the shape the recorder keeps.
- The difference control ignores `pointerId`, a counter that Firefox raises between runs.
- `trace run` refuses to clear a folder that is not a Trace run. Same-origin sockets pass.
