# Report

Trace replays one action list on two builds, judges each with requirements that do not
depend on the other build, and reduces a failure to the actions that cause it.

**Environment.** Apple M5 Pro, 18 cores, 48 GB, macOS (Darwin 25.6.0, arm64), on AC power.
Node 22.16.0, Playwright 1.65.0, Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2. The
machine ran other work, so timings are not from an idle system. The final run held the
display awake.

**Source.** Every result comes from commit `7c971c1` with a clean source tree, except the
one holdout run at `432cf66`. Each manifest records its commit. The plan is in
`docs/MEASUREMENT.md`, which was revised before this run.

## How this report changed

An earlier version of this report made claims that did not survive review. An independent
reviewer, working on a clean clone with the repository and none of my conclusions, found
25 issues. These changed what can be claimed.

| What I had claimed | What was wrong | What is true now |
|---|---|---|
| A comparison misses bugs that Trace finds | My control compared only 3 channels, and my explanation of its misses was false | A full comparison catches all 18. Trace's advantage is rejecting legitimate changes |
| 18 of 18 on WebKit, unqualified | A reviewer's rerun of that exact corpus missed 4 of 5 timeline bugs, because WebKit put presses far off target and nothing checked | Such a run is now invalid. Cause unproven. See "WebKit input" |
| Requirements that held | Several passed without checking anything, including one with a misspelled key | Each now reports `held`, `broken` or `not exercised`, and a misspelled key is invalid |
| 0 false alarms on random sessions | True for that oracle, but it missed ignored requests | A stricter check flags 2 sessions. Both are a real bug in my fixture |
| Identical repeated runs | Verdicts repeat, but traces can reorder events at equal times | Stated below |

Fixes cover vacuous checks, ignored requests, dangling ARIA references, late
acknowledgements, held pointer capture, an idle jump that could skip timers and change a
verdict, a reducer that accepted sequences the baseline could not run, a run folder that
could choose a registry and run commands, a static server crash on a malformed URL, and
stale files mixing two runs in one report. Counterexamples for these are in the tests.

## Correctness

### Tuned corpus

31 builds across 3 fixtures: 18 seeded bugs and 13 clean builds (3 identical controls and
10 legitimate changes). Each build runs over all of its fixture's scenarios, once.

| Browser | Seeded caught | Wrong category | Missed | Clean flagged | Run |
|---|---|---|---|---|---|
| Chromium | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-chromium` |
| Firefox | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-firefox` |
| WebKit | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-webkit` |

On every browser, 2 of the 144 scenario runs were `diverged` and were not scored as
detections. Both builds were caught by another scenario.

Firefox and WebKit ran the same fixtures and scenarios with no engine-specific changes.
Their pointer cancels are synthetic. Screenshot controls ran only on Chromium.

**This score is tuned, and it is not the headline.** The first run scored much worse.

| Run | Caught | Wrong category | Missed | Clean flagged |
|---|---|---|---|---|
| First run (`results/development`) | 12 of 18 | 1 | 5 | 3 of 13 |
| Final run | 18 of 18 | 0 | 0 | 0 of 13 |

The change between them was not only the oracle. The same work edited 7 scenario files,
changed the `ack` format and changed the recorder. I did not measure how much each edit
contributed. One early commit message says the first run missed 7. The saved run says 5.

Before accepting this table I read every detection's sentence, to confirm it fired for the
seeded mechanism.

`corpus/labels.json` was committed before the detector ran on the overlay and timeline
fixtures. It had already run on 2 inspector builds, so the labels are not fully blind.

### Controls

| Detector | Seeded caught | Clean flagged |
|---|---|---|
| Never flags | 0 of 18 | 0 of 13 |
| Any recorded difference, Chromium | 18 of 18 | 9 of 13 |
| Any recorded difference, WebKit | 18 of 18 | 9 of 13 |
| Any recorded difference, Firefox | 18 of 18 | 13 of 13 |
| Final screenshot difference, Chromium | 11 of 18 | 5 of 13 |

This is the most important table here. Comparing two full traces finds every seeded bug,
so on these bugs Trace finds nothing extra. Its value is that it does not flag legitimate
changes, and that it can fail a bug both builds share, which a comparison cannot do by
construction. Firefox flags 13 of 13 because event times there differ between runs of the
same build. That is noise, and it is also a measure of how brittle comparison is.

### Holdout

The combobox family was written after the oracle stopped changing. Labels were committed
first, and only its correct build ran beforehand, which the git history is consistent with
but cannot prove. It ran once, at `432cf66`, with one seeded bug per failure category, all
by the same author.

| Detector | Seeded caught | Clean flagged |
|---|---|---|
| **Trace** | **6 of 6** | **1 of 4** |
| Any recorded difference | 5 of 6 at that commit, with the blinded control | 2 of 4 |
| Final screenshot difference | 2 of 6 | 0 of 4 |

The false alarm: `legit-wide-list` fails a declared inset at 360 px wide. Its right edge
reaches the viewport edge, 8 px short of the requirement, and 6 px past its tolerance. I
labeled that build clean before the run, so it counts as a false positive. The requirement
did what it says, and it would fail a designer who chose that layout on purpose. Of the 4
clean builds, 1 is identical, so on legitimate changes alone this is 1 of 3.

The oracle changed after this run, and the review that changed it had seen this fixture. So
this is a held-out result for the oracle at `432cf66`, and no result here tests the final
oracle on unseen code. Rerun on final code as a regression check
(`results/holdout-final-oracle`), Trace still scores 6 of 6 and 1 of 4, and the repaired
difference control scores 6 of 6 and 2 of 4.

### Random sessions on correct builds

Sessions of 18 actions, from seeds 1001 to 1100, which no development run used. Moves are
guided by what a user could do. One move in 100 ignores that on purpose.

| Fixture | Seeds | Invalid before a browser | Invalid in the browser | Completed | Flagged | Crashed |
|---|---|---|---|---|---|---|
| inspector | 100 | 0 | 2 | 98 | 0 | 0 |
| overlay | 100 | 0 | 1 | 99 | 2 | 0 |
| timeline | 100 | 1 | 1 | 98 | 0 | 0 |
| **All** | **300** | **1** | **4** | **295** | **2** | **0** |

**Both flagged sessions are a real bug in my own "correct" overlay.** If a dialog is
cancelled in the same ms it opens, no exit transition runs, `transitionend` never fires, and
the dialog stays in `closing` forever. It reproduces on all three engines. A gap of 16 ms or
more closes normally. No written scenario reached this, and the old oracle passed it. The
measured fixture is unchanged, so the numbers here describe what ran.

**What this does not show.** These sessions use a reduced requirement list. They carry no
acknowledgements and leave out `focus-stays-on`, `geometry-continuous`, `geometry-origin` and
`resources-released`. Requirements in fixed scenarios hold values specific to one sequence,
and applying them to random sessions fails correct builds: the review saw 24 of 26 on
timeline. So this measures false alarms from the checks it runs, not from all of them.

Development rounds found 3 kinds of false alarm the corpus had not: judging a panel still in
flight, reading the next action's state, and treating a user's Tab as a failed restore. My
first generator completed 0 of 48 sessions, so a clean result then would have meant nothing.

### Model-generated traces

Kept apart from browser results. 2,000 seeds gave 920 valid action lists, and the rest
were rejected and counted. Each runs through a small state machine in correct and stale
forms. The oracle agrees with ground truth computed from the action list alone. This covers
one requirement kind of 11. See `tests/unit/model.test.ts`.

## WebKit input

A reviewer's rerun at the measured commit, with identical fixture hashes and WebKit 27.2,
failed `timeline@correct` in 40 of 40 runs. `pointerdown` arrived at clientX -850, clientY
1250, off the handle. The published run and two reruns of mine, with the display awake,
passed 9 of 9 timeline builds, and presses landed within 1 px in 6 of 6 direct checks.

The reviewer's run happened during the display's 2 hour idle window, so a sleeping display
is a plausible cause. I did not test that, and it is unproven. What is proven is the Trace
weakness: nothing checked that a press landed, so scenarios expecting nothing to stay stuck
passed with no drag at all. A press more than 3 px from its aim now makes the run invalid.

## Reduction

Each repetition starts from the full session, with a new browser. An accepted step must keep
the same fingerprint, reproduce 3 times, and pass on the baseline. A sequence the baseline
cannot run is rejected. Budget: 80 attempts or 180 s.

| Bug | Session | Actions | Attempts | Time, median (range) over 5 | Reproduced | On baseline |
|---|---|---|---|---|---|---|
| `inspector@stale-completion` | Generated, seed 4 | 18 to 2 | 9 | 29.1 s (29.1 to 29.2) | 10 of 10 | 0 of 3 |
| `overlay@no-restore` | Generated, seed 1 | 18 to 2 | 17 | 40.0 s (39.9 to 40.3) | 10 of 10 | 0 of 3 |
| `timeline@drag-stuck-on-cancel` | Generated, seed 2 | 18 to 2 | 5 | 12.5 s (12.5 to 12.5) | 10 of 10 | 0 of 3 |
| `inspector@stale-origin` | Written | 14 to 4 | 26 | 61.0 s (61.0 to 61.0) | 10 of 10 | 0 of 3 |

All 20 runs ended 1-minimal: removing any one remaining action loses this failure, makes the
sequence invalid, or changes the failure. Each repetition of a workload gave the same
sequence, which a deterministic clock should, so these runs say little about unstable
failures. No measured workload was unstable, so the unstable path is covered by tests only.

**Workloads that did not run.** 2 of the 5 planned generated workloads found no session in 60
seeds. `inspector@stale-resize` needs a window narrower than the generator's smallest, 480 px.
`overlay@live-exit-clone` left a covering copy that made 59 of 60 sessions impossible to
finish. Written scenarios catch both bugs. Runs: `results/reduction`,
`results/reduction-written`.

## Reports and traces

From `results/reduction/summary.json`, on an 18 action session.

| Quantity | Value |
|---|---|
| Events | 764 |
| Trace size | 103,242 bytes, 135 bytes per event |
| Report size, no screenshots | 861,281 bytes |
| Report generation | 4.2 ms median (3.7 to 6.0, 5 runs) |

The report size is mostly the viewer and fonts.

## Performance

Measured in real time on Chromium, with a new browser for each run and no screenshots or
video. Scenario: `long-session`, 14 actions. Seven rounds after 2 warmup rounds. Levels rotate
inside each round, and each difference is paired within a round.

| Level | Task ms, median (range) | Script ms, median (range) |
|---|---|---|
| Off (no recorder) | 72.95 (71.6 to 79.4) | 10.5 (10.2 to 11.3) |
| Timestamps | 84.1 (76.5 to 91.6) | 11.3 (10.6 to 13.6) |
| Full | 121.9 (116.3 to 151.7) | 27.7 (26.3 to 37.9) |

| Added cost, paired by round | Task ms | Script ms |
|---|---|---|
| Timestamps | 11.4 (3.5 to 18.5) | 0.4 (-0.4 to 3.5) |
| Full | 46.1 (42.3 to 78.6) | 17.0 (15.0 to 27.7) |

Full recording costs about 3.3 ms of main thread work per action in this scenario. The
previous run of this experiment put the timestamp level at 5.9 ms (-3.7 to 13.4), so that
level is small and poorly resolved here.

Input timings from the timestamp level, as a median of per-run medians, over 7 runs.

| Event | input-to-handler | input-to-commit | input-to-render |
|---|---|---|---|
| Click | 0.45 ms | 16.4 ms | 32.8 ms |
| Key press | 0.10 ms | 0.8 ms | 11.0 ms |

Clicks take longer to commit because this fixture publishes state after a passive effect. That
is a property of the fixture, not of React or the browser. `input-to-render` is one message
task after the next `requestAnimationFrame`. It is not a displayed frame, and none of this is
INP. Timer resolution in Chromium is coarse at this scale, so the smallest values mean "under
about a millisecond".

### A number I did not publish

The first overhead run showed `input-to-commit` at 1.2 ms with timestamps and 0.3 ms with full
recording. More instrumentation should not be faster, so I read the raw samples. The median
pooled clicks (about 16 ms) with key presses (about 0.3 to 1 ms), so it described neither.
Timings are now grouped by event type. That first run is in
`results/development/overhead-pooled`.

The gap remains on key presses, 0.8 ms against 0.3 ms, and is stable across runs. I do not know
why. One guess is that the full recorder's frame loop keeps the main thread awake, but I did
not test that. It is not a speed-up.

## Interface checks

63 browser tests cover keyboard transport, widths of 320, 390, 768 and 1440, half-width for 200
percent zoom, touch, reduced motion, long labels and dense data, and empty and error states.
axe-core found no serious or critical issues on a failing or passing report. Automated checks do
not establish full accessibility.

I inspected real renders in three passes. The first found the main design flaw: the stage showed
the whole viewport, so the action was a speck in a corner and the candidate fell below the fold on
a phone. Both stages now frame the region where anything moved. The second confirmed playback and
idle skipping. The third covered empty, invalid and diverged reports. After the review, the
requirements table gained `not exercised` and an acknowledgement row.

## Failures worth knowing about

- **Tick semantics.** All 4 leak bugs were missed at first, because a mount and the checkpoint
  before it shared a tick. The requirement passed with nothing to compare, which is what the
  review later found more of.
- **Script order.** Firefox and WebKit hung forever on the first matrix run. A page-level init
  script runs after the clock there, so the saved "real" frame function was fake.
- **Ctrl-C.** Playwright's default SIGINT handler killed the browser and exited before the reducer
  could save its result.
- **Refused URLs.** The CLI opened a browser before refusing a remote URL, then hung.
- **Navigation timeout.** The short action timeout also capped page load, so a busy machine could
  crash a reduction.
- **Frozen install.** On a clean clone, `pnpm install --frozen-lockfile` exited 1, because pnpm 12
  stops on an unapproved build script. It only showed up on a clean checkout.

## Known open issues

These are real, and they are not fixed.

- The overlay's correct build has the stuck `closing` bug above.
- Wall mode has no ticks between actions, so a focus loss early in a long gap can be judged against
  later state. Controlled mode does not have this gap.
- Uncaught page exceptions are not recorded, so a throwing handler alone is not a failure.
- `geometry-continuous` does not compare across a node replacement, so a jump by remount passes it.
- A same-origin redirect is not stopped by the network guard.

## Next bounded improvements

1. Fix the overlay's exit path and rerun, so "correct" means correct.
2. Write a new held-out family for the final oracle. That is the missing measurement.
3. Let a requirement state a design range, which addresses the holdout false alarm.
4. Add a narrow width and a keyboard path to the generator, then rerun the 2 unreached workloads.
5. Test the WebKit input failure with the display asleep, to settle its cause.
6. Run real participants through `docs/USABILITY.md`.

## Reproduce

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm exec playwright install chromium firefox webkit
```

```bash
pnpm build
```

```bash
caffeinate -d -i pnpm bench
```

`caffeinate` is macOS only. Timings will differ on another machine. Counts should not, with one
exception: the difference control depends on run-to-run timing noise.
