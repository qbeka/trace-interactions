# Report

Trace replays one action list on two builds, judges each with requirements that do not
depend on the other build, and reduces a failure to the actions that cause it.

**Environment.** Apple M5 Pro, 18 cores, 48 GB, macOS (Darwin 25.6.0, arm64), on AC power.
Node 22.16.0, Playwright 1.65.0, Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2. The
machine ran other work, so timings are not from an idle system.

**Source.** The plan was frozen in `docs/MEASUREMENT.md`. Each result's manifest holds the
commit it ran on.

| Runs | Commit |
|---|---|
| Holdout | `432cf66` |
| Corpus on 3 browsers, reduction on generated sessions | `95cb8ce`, a docs commit after `432cf66` with no source change |
| Random sessions, overhead, written reduction | `1412c34` |

Those manifests say `dirty: true`, because each benchmark wrote results into the checkout
before it recorded source state. No source file was modified. The check now leaves out
`results/`.

## Changes after the freeze

| Change | Why | Effect on results |
|---|---|---|
| `pointerMove` with no finger down is now invalid | The random run crashed on it. Its first attempt saved nothing, and the step reran in full | Reached only by that path. No finished run used it |
| Timings grouped by event type | See "A number I did not publish" | Overhead was rerun. The pooled run is kept in `results/development/overhead-pooled` |
| Written reduction added | The demo's 14 to 4 had no repeated measurement | Extra workload, reported on its own |
| `--adapter` option added | For the optional portfolio check | Not used by any measurement |
| `dirty` check leaves out `results/` | See above | None |

## Correctness

### Tuned corpus

31 builds across 3 fixtures: 18 seeded bugs and 13 clean builds (3 identical controls and
10 legitimate changes). Each build runs over all of its fixture's scenarios.

| Browser | Seeded caught | Wrong category | Missed | Clean flagged | Run |
|---|---|---|---|---|---|
| Chromium | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-chromium` |
| Firefox | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-firefox` |
| WebKit | 18 of 18 | 0 | 0 | 0 of 13 | `results/corpus-webkit` |

On every browser, 2 of the 144 scenario runs were `diverged` and were not scored as
detections. `escape-ignored` left the panel open, so `long-session` could not finish.
`hidden-clone-focus` gave a target 2 matches. Both builds were caught by another scenario.

Firefox and WebKit ran the same fixtures and scenarios with no engine-specific changes.
Their pointer cancels are synthetic. Screenshot controls ran only on Chromium.

**This score is tuned, and it is not the headline.** The first run scored much worse.

| Run | Caught | Wrong category | Missed | Clean flagged |
|---|---|---|---|---|
| First run (`results/development`) | 12 of 18 | 1 | 5 | 3 of 13 |
| Frozen run | 18 of 18 | 0 | 0 | 0 of 13 |

One early commit message says the first run missed 7. The saved run says 5, and the saved
run is right.

Every detection's sentence was read before this table was accepted, to confirm it fired
for the seeded mechanism and not by accident.

### Controls

| Detector | Seeded caught | Clean flagged |
|---|---|---|
| Never flags | 0 of 18 | 0 of 13 |
| Any trace difference | 13 of 18 | 9 of 13 |
| Final screenshot difference | 11 of 18 | 5 of 13 |

The control that flags any difference found fewer bugs than Trace, because a comparison
cannot see a bug on a path both builds take the same way: a leak after a final removal
does not change state, focus or geometry. The screenshot control is limited by what a
final frame shows. These show the corpus separates approaches. They are not a comparison
with any product.

### Holdout

The combobox family was written after the oracle stopped changing. Labels were committed
first, and only its correct build ran beforehand. It ran once, at `432cf66`.

| Detector | Seeded caught | Clean flagged |
|---|---|---|
| **Trace** | **6 of 6** | **1 of 4** |
| Any trace difference | 5 of 6 | 2 of 4 |
| Final screenshot difference | 2 of 6 | 0 of 4 |

The false alarm: `legit-wide-list` overflows the declared inset by 6 px at 360 px wide
(`resize-with-list-open`). The list's right edge reaches the viewport edge, and the
requirement asks for 8 px with 2 px of tolerance. I labeled that build clean before the
run, so it counts as a false positive. The requirement did what it says, and it would
fail a designer who chose that layout on purpose. That is a real cost of numeric
requirements.

One seeded build, `remount-on-results`, also raised `missed-ack`, which is a fair
consequence of the bug. It still counts as caught, in its expected category.

### Random sessions on correct builds

Sessions of 18 actions, from saved seeds, with moves guided by what a user could do. One
move in 100 ignores that on purpose, so the invalid path stays in the count.

| Fixture | Seeds | Invalid before a browser | Invalid in the browser | Completed | Flagged | Crashed |
|---|---|---|---|---|---|---|
| inspector | 100 | 0 | 7 | 93 | 0 | 0 |
| overlay | 100 | 0 | 7 | 93 | 0 | 0 |
| timeline | 100 | 7 | 4 | 89 | 0 | 0 |
| **All** | **300** | **7** | **18** | **275** | **0** | **0** |

Run: `results/random`. Development rounds of this test mattered more than the final
table. They found 3 kinds of false alarm the corpus had not: judging a panel still in
flight, reading the next action's state, and treating a user's Tab as a failed restore.
My first generator completed 0 of 48 sessions, so a "no false alarms" claim would have
been empty.

This result can only speak to false alarms. It has teeth because the same oracle fails
broken builds on these sessions: the reduction scan below found failures quickly on 3 of
5 bugs.

### Model-generated traces

Kept apart from browser results. 2,000 seeded action lists run through a small state
machine in correct and stale forms. The oracle agrees exactly with ground truth computed
from the action list alone, and it never flags the correct form. See
`tests/unit/model.test.ts`.

## Reduction

Each repetition starts from the full session, with a new browser. An accepted step must
keep the same fingerprint, reproduce 3 times, and still pass on the baseline. Budget: 80
attempts or 180 s.

| Bug | Session | Actions | Attempts | Time, median (range) over 5 | Reproduced | On baseline |
|---|---|---|---|---|---|---|
| `inspector@stale-completion` | Generated, seed 4 | 18 to 2 | 9 | 29.5 s (29.2 to 29.7) | 10 of 10 | 0 of 3 |
| `overlay@no-restore` | Generated, seed 1 | 18 to 2 | 17 | 40.2 s (40.1 to 40.3) | 10 of 10 | 0 of 3 |
| `timeline@drag-stuck-on-cancel` | Generated, seed 2 | 18 to 2 | 5 | 12.5 s (12.5 to 12.6) | 10 of 10 | 0 of 3 |
| `inspector@stale-origin` | Written, added after the freeze | 14 to 4 | 26 | 65.0 s (61.7 to 65.3) | 10 of 10 | 0 of 3 |

All 20 runs ended 1-minimal: removing any remaining action loses the failure. Each
repetition of a workload gave the same sequence, which is what a deterministic clock
should do, and it means these 5 runs say little about unstable failures. No measured
workload was unstable, so the unstable path is covered by tests, not by this table.

**Workloads that did not run.** 2 of the 5 planned generated workloads found no session in
60 seeds. `inspector@stale-resize` needs a window narrower than the generator's smallest,
480 px. `overlay@live-exit-clone` left a covering copy that made 59 of 60 sessions
impossible to finish. Their seeded bugs are caught by written scenarios. The generator did
not reach them, and I did not widen it after seeing this. Runs: `results/reduction`,
`results/reduction-written`.

The written workload is the demo: 14 actions become open, close, widen, reopen.

## Reports and traces

From `results/reduction/summary.json`, on an 18 action session.

| Quantity | Value |
|---|---|
| Events | 764 |
| Trace size | 102,956 bytes, 135 bytes per event |
| Report size, no screenshots | 859,513 bytes |
| Report generation | 4.5 ms median (4.0 to 4.7, 5 runs) |

The report size is mostly the viewer and fonts.

## Performance

Measured in real time on Chromium, with a new browser for each run and no screenshots or
video. Scenario: `long-session`, 14 actions. Seven rounds after 2 warmup rounds. Levels
rotate inside each round, and each difference is paired within a round.

| Level | Task ms, median (range) | Script ms, median (range) |
|---|---|---|
| Off (no recorder) | 75.9 (69.3 to 91.7) | 10.25 (9.75 to 11.63) |
| Timestamps | 80.8 (75.2 to 88.5) | 11.04 (9.69 to 11.27) |
| Full | 128.4 (115.7 to 135.9) | 28.96 (27.46 to 30.66) |

| Added cost, paired by round | Task ms | Script ms |
|---|---|---|
| Timestamps | 5.9 (-3.7 to 13.4) | 0.75 (-0.51 to 1.02) |
| Full | 50.2 (40.4 to 63.1) | 18.4 (17.3 to 20.4) |

Full recording costs about 3.6 ms of main thread work per action in this scenario. The
timestamp level's range crosses zero, so this experiment cannot separate it from noise.

Input timings from the timestamp level, as a median of per-run medians, over 7 runs.

| Event | input-to-handler | input-to-commit | input-to-render |
|---|---|---|---|
| Click | 0.40 ms | 16.15 ms | 32.40 ms |
| Key press | 0.10 ms | 0.90 ms | 10.70 ms |

Clicks take longer to commit because this fixture publishes state after a passive effect.
That is a property of the fixture, not of React or the browser. `input-to-render` is one
message task after the next `requestAnimationFrame`. It is not a displayed frame, and none
of this is INP. Timer resolution in Chromium is coarse at this scale, so the smallest
values mean "under about a millisecond".

### A number I did not publish

The first overhead run showed `input-to-commit` at 1.2 ms with timestamps and 0.3 ms with
full recording. More instrumentation should not be faster, so I read the raw samples. The
median pooled clicks (about 16 ms) with key presses (about 0.3 to 1 ms), so it described
neither. Timings are now grouped by event type.

The gap remains on key presses: 0.9 ms against 0.3 ms, stable across runs. I do not know
why. One guess is that the full recorder's frame loop keeps the main thread awake, but I
did not test that. It is not a speed-up, and it should not be read as one.

## Interface checks

54 browser tests cover keyboard transport, widths of 320, 390, 768 and 1440, half-width
for 200 percent zoom, touch, reduced motion, long labels and dense data, and empty and
error states. axe-core found no serious or critical issues on a failing or passing report.
Automated checks do not establish full accessibility.

I inspected real renders in three passes. The first found the main design flaw: the stage
showed the whole viewport, so the action was a speck in a corner and the candidate fell
below the fold on a phone. Both stages now frame the region where anything moved. The
second confirmed playback and idle skipping. The third covered empty, invalid and
diverged reports.

## Failures worth knowing about

- **Tick semantics.** All 4 leak bugs were missed at first, because a mount and the
  checkpoint before it shared a tick. One line fixed all 4.
- **Script order.** Firefox and WebKit hung forever on the first matrix run. A page-level
  init script runs after the clock there, so the saved "real" frame function was fake.
- **Ctrl-C.** Playwright's default SIGINT handler killed the browser and exited before the
  reducer could save its result.
- **Refused URLs.** The CLI opened a browser before refusing a remote URL, then hung.
- **Navigation timeout.** The short action timeout also capped page load, so a busy machine
  could crash a reduction.

## Next bounded improvements

1. Let a requirement state a design range, so an inset can allow a declared alternative.
   That addresses the holdout false alarm.
2. Add a narrow width to the generator and a keyboard path around covering elements, then
   rerun the 2 workloads that found no session, as a new measurement.
3. Run real participants through `docs/USABILITY.md`.

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
pnpm bench
```

```bash
pnpm exec tsx bench/corpus.ts --labels corpus/holdout.json --out results/holdout
```

```bash
pnpm exec tsx bench/reduction.ts --written inspector,stale-origin,long-session --out results/reduction-written
```

Timings will differ on another machine. Counts should not.
