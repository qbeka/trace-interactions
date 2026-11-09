# Report

Trace replays one action list on two builds, judges each with requirements that do not
depend on the other build, and reduces a failure to the actions that cause it.

**Environment.** Apple M5 Pro, 18 cores, 48 GB, macOS (Darwin 25.6.0, arm64), on AC power.
Node 22.16.0, Playwright 1.65.0, Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2. The
machine ran other work, so timings are not from an idle system. The final run held the
display awake.

**Source.** Every result comes from commit `9af1d42` with a clean source tree, except the
one holdout run at `432cf66`. Each manifest records its commit. The plan is in
`docs/MEASUREMENT.md`, which was revised before this run. A full run took 42 minutes,
within the revised 50 minute budget.

## How this report changed

An earlier version of this report made claims that did not survive review. An independent
reviewer, working on a clean clone with the repository and none of my conclusions, found
25 issues, then rechecked my fixes and found 7 regressions, including one that could delete
user files in `--out` and a wrong explanation of a control result. These changed what can
be claimed.

| What I had claimed | What was wrong | What is true now |
|---|---|---|
| A comparison misses bugs that Trace finds | My control compared only 3 channels, and my explanation of its misses was false | A full comparison catches all 18. Trace's advantage is rejecting legitimate changes |
| 18 of 18 on WebKit, unqualified | A reviewer's rerun of that exact corpus missed 4 of 5 timeline bugs, because WebKit put presses far off target and nothing checked | Such a run is now invalid. Cause unproven. See "WebKit input" |
| Requirements that held | Several passed without checking anything, including one with a misspelled key | Each now reports `held`, `broken` or `not exercised`, and a misspelled key is invalid |
| 0 false alarms on random sessions | True for that oracle, but it missed ignored requests | A stricter check flags 2 sessions. Both are a real bug in my fixture |
| Identical repeated runs | Verdicts repeat, but traces can reorder events at equal times | Stated below |

Fixes cover vacuous checks, ignored requests, dangling ARIA references, held pointer capture, an idle jump that could skip timers and change a
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
| Any recorded difference, on each of 3 browsers | 18 of 18 | 9 of 13 |
| Final screenshot difference, Chromium | 11 of 18 | 5 of 13 |

This is the most important table here. Comparing two full traces finds every seeded bug,
so on these bugs Trace finds nothing extra. All 9 clean builds it flags are legitimate
changes, and it flags no identical build. Trace's value here is that its requirements did
not flag those changes on this tuned corpus, and that it can fail a bug both builds share,
which a comparison cannot do by construction. On held-out builds that gap is smaller: Trace
flagged 1 of 3 legitimate changes, and the control 2 of 3. An earlier version of this
control flagged 13 of 13 on Firefox. That was my bug: it compared `pointerId`, a counter
Firefox raises between runs.

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
`resources-released`. Applying a fixture's fixed requirements to random sessions fails
correct builds: the review saw 23 of 26 on timeline, nearly all from `transient-cleared`,
which judges just before the next action unless the scenario sets `settledMs`. So this
measures false alarms from the checks it runs, not from all of them.

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
1250, off the handle. Two reruns of mine, with the display awake, passed 9 of 9 timeline
builds (`results/development/webkit-recheck`), and presses landed within 1 px in 6 of 6
direct checks, which I did not save. The final run's 18 of 18 had no invalid runs, and the
reviewer's later rerun also found WebKit clean.

This machine's display sleeps after 2 hours, and the reviewer's run came during a long idle
stretch, so a sleeping display is a plausible cause. I did not test that, and it is
unproven. What is proven is the Trace weakness: nothing checked that a press landed, so scenarios expecting nothing to stay stuck
passed with no drag at all. A press more than 3 px from its aim now makes the run invalid.

## Reduction

Each repetition starts from the full session, with a new browser. An accepted step must keep
the same fingerprint, reproduce 3 times, and pass on the baseline. A sequence the baseline
cannot run is rejected. Budget: 80 attempts or 180 s.

| Bug | Session | Actions | Attempts | Time, median (range) over 5 | Reproduced | On baseline |
|---|---|---|---|---|---|---|
| `inspector@stale-completion` | Generated, seed 4 | 18 to 2 | 9 | 29.5 s (29.5 to 29.5) | 10 of 10 | 0 of 3 |
| `overlay@no-restore` | Generated, seed 1 | 18 to 2 | 17 | 40.0 s (39.8 to 40.4) | 10 of 10 | 0 of 3 |
| `timeline@drag-stuck-on-cancel` | Generated, seed 2 | 18 to 2 | 5 | 12.8 s (12.7 to 12.8) | 10 of 10 | 0 of 3 |
| `inspector@stale-origin` | Written | 14 to 4 | 26 | 60.8 s (60.7 to 61.5) | 10 of 10 | 0 of 3 |

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
| Report size, no screenshots | 861,282 bytes |
| Report generation | 4.0 ms median (3.8 to 6.1, 5 runs) |

The report size is mostly the viewer and fonts.

## Performance

Measured in real time on Chromium, with a new browser for each run and no screenshots or
video. Scenario: `long-session`, 14 actions. Seven rounds after 2 warmup rounds. Levels rotate
inside each round, and each difference is paired within a round.

| Level | Task ms, median (range) | Script ms, median (range) |
|---|---|---|
| Off (no recorder) | 111.1 (104.4 to 113.2) | 17.6 (16.7 to 18.2) |
| Timestamps | 116.6 (110.8 to 118.1) | 17.8 (17.5 to 18.5) |
| Full | 169.8 (162.4 to 175.0) | 42.5 (40.2 to 44.8) |

| Added cost, paired by round | Task ms | Script ms |
|---|---|---|
| Timestamps | 4.9 (-2.3 to 12.2) | 0.1 (-0.7 to 1.7) |
| Full | 60.5 (49.2 to 70.6) | 24.9 (22.1 to 28.1) |

Full recording cost about 4.3 ms of main thread work per action in this run. The whole
experiment moves between runs, even with rounds paired, because other work shares the
machine:

| Run of this experiment | Off, task ms | Full added | Timestamps added |
|---|---|---|---|
| Before the review, commit `9ae376e` | 75.9 | 50.2 | 5.9 (range crosses zero) |
| After the first fixes, commit `9f5868e` | 73.0 | 46.1 | 11.4 |
| Final, commit `9af1d42` | 111.1 | 60.5 | 4.9 (range crosses zero) |

So full recording costs tens of ms in this scenario, and the timestamp level is small and
not resolved by this experiment. Only the final run's raw data is in `results/overhead`.
The earlier figures are quoted from their runs, which that run replaced.

Input timings from the timestamp level, as a median of per-run medians, over 7 runs.

| Event | input-to-handler | input-to-commit | input-to-render |
|---|---|---|---|
| Click | 0.75 ms | 16.4 ms | 33.1 ms |
| Key press | 0.10 ms | 1.4 ms | 6.9 ms |

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

The gap remains on key presses, 1.4 ms against 0.4 ms, and it appeared in every run. I do not
know why. One guess is that the full recorder's frame loop keeps the main thread awake, but I did
not test that. It is not a speed-up.

## Interface checks

65 browser tests and 117 unit tests pass on a clean clone. The browser tests cover keyboard transport, widths of 320, 390, 768 and 1440, half-width for 200
percent zoom, touch, reduced motion, long labels and dense data, and empty and error states.
axe-core found no serious or critical issues on a failing or passing report. Automated checks do
not establish full accessibility.

I inspected real renders in three passes. The first found the main design flaw: the stage showed
the whole viewport, so the action was a speck in a corner and the candidate fell below the fold on
a phone. Both stages now frame the region where anything moved. The second confirmed playback and
idle skipping. The third covered empty, invalid and diverged reports. After the review, the
requirements table gained `not exercised` and an acknowledgement row.

## Changes after the first freeze

These came after `docs/MEASUREMENT.md` was first committed. Revisions 2 and 3 in that file
cover the larger changes.

| Change | Commit | Reason |
|---|---|---|
| Action timeout raised from 1 s to 2 s, adapter wait from 5 s to 10 s, navigation timeout added | `432cf66`, before the holdout ran | A busy machine could crash a reduction |
| `pointerMove` with no finger down became invalid | `9ae376e` | A random run crashed on it. 4 sessions then counted as invalid in that run |
| Timings grouped by event type | `9ae376e` | See "A number I did not publish" |
| Written reduction workload added | `9ae376e` | The demo's 14 to 4 had no repeated measurement |
| `--adapter` added | after `9ae376e` | To check a local page with no change to it |
| Oracle, reducer, control and trust fixes | `9f5868e`, `9af1d42` | The two reviews |
| Exported reports drop local paths | after `9af1d42` | A report is made to be shared. This touches only the export step, so no measured result depends on it. The 861,282 byte report was measured before this change and would now be a few hundred bytes smaller |
| Report viewer and project page redesigned | after `9af1d42` | To make a report read like a tool. The viewer's script and fonts grew from 299,738 to 406,997 bytes, so every report is 107,259 bytes larger. The 861,282 byte report above was measured before this and was not measured again |

The project page and the report's move to Geist Serif also came after `9af1d42`, as did the redesign of both. None of them touches the runner, recorder, oracle or reducer, so no other measured result depends on them. The demo reports kept the runs they had recorded: only the viewer files beside them were replaced.

The history was rewritten once before the first public push, to remove working notes and
local paths from demo reports. Commit hashes in the saved results and in these docs were
updated to match, and that is the only edit to any saved result. The source at the measured
commit is unchanged.

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
- The network guard does not stop a same-origin redirect, or a socket opened from a Worker.
- An acknowledgement can be satisfied by the late answer to an earlier action, because a trace
  cannot say which action caused a change. A scenario can narrow this with `oneOf`.
- A typo only inside `requests` is not caught. That requirement then reports `not exercised`.
- A run that ends with the pointer still down completes without complaint.
- `not exercised` is per requirement, so one judged occurrence hides a skipped one.

## Next bounded improvements

1. Fix the overlay's exit path and rerun, so "correct" means correct.
2. Write a new held-out family for the final oracle. That is the missing measurement.
3. Let a requirement state a design range, which addresses the holdout false alarm.
4. Add a narrow width and a keyboard path to the generator, then rerun the 2 unreached workloads.
5. Test the WebKit input failure with the display asleep, to settle its cause.
6. Watch real participants use it.

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
