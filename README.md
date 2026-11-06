# Trace

Trace replays the same user actions on two builds of a React component, checks what
must stay true, and shrinks a failure to the few actions that cause it.

A panel can look right in its final screenshot and still have lost focus, accepted a
stale transition or jumped during a resize. Trace finds those failures and explains
each one in a sentence, with two aligned replays that show where the builds part.

![A Trace report. Two stages show the same four actions on two builds. The candidate's panel starts 80 px from its trigger.](docs/assets/cover.png)

Watch the [20 second demo](docs/assets/trace-demo.mp4) or the
[67 second walkthrough](docs/assets/trace-walkthrough.mp4). The walkthrough has captions and no voice.
There is no hosted demo yet. `pnpm demo` builds the same reports locally.

| | |
|---|---|
| **Seeded bugs, tuned corpus** | 18 of 18 caught in the right category, on Chromium, Firefox and WebKit |
| **Clean builds, tuned corpus** | 0 of 13 flagged on all three browsers |
| **Holdout, never tuned against** | 6 of 6 seeded bugs caught, and 1 of 4 clean builds wrongly flagged |
| **Random sessions on correct builds** | 300 seeded, 25 invalid, 275 completed, 0 flagged |
| **Reduction** | 18 actions to 2 on 3 generated sessions, and 14 to 4 on a written one. Reproduced in 10 of 10 fresh runs, 0 of 3 on the baseline. |
| **Reduction reach** | 2 of 5 planned generated workloads found no usable session |
| **Recording cost** | 50 ms more main thread work across a 14 action, 5.4 s scenario (40 to 63 ms over 7 rounds), which is 66 percent of a mostly idle page |

Measured on one Apple M5 Pro Mac. The first corpus run missed 5 seeded bugs, mislabeled
1 and flagged 3 clean builds. The fixes tuned the oracle to that corpus, which is why
the holdout exists and why its false alarm stays in the table. These counts describe
this small corpus. They are not an accuracy claim about other code.
[What the numbers leave out](#what-the-numbers-leave-out) has the details.

## Run it

You need Node 22.16 or later and pnpm.

```bash
pnpm install
```

```bash
pnpm exec playwright install chromium firefox webkit
```

```bash
pnpm build
```

Run the same session on a good build and a broken one.

```bash
pnpm trace run fixtures/inspector/scenarios/long-session.json --baseline inspector@correct --candidate inspector@stale-origin --out .trace/demo
```

```text
REGRESSION: panel appeared 80 px away from trigger at 4000 ms. It should start at trigger or at its final position.
Report: .trace/demo/report/index.html
```

Shrink it, then replay the small version.

```bash
pnpm trace reduce .trace/demo
```

```text
REDUCED: 14 actions to 4, in 26 attempts and 61.2 s.
Reproduced in 10 of 10 runs. Baseline showed it in 0 of 3.
Attempts: 6 fails, 5 passes, 13 invalid, 0 unstable, 2 other-failure. Stopped: minimal.
```

```bash
pnpm trace replay .trace/demo
```

Read the report. It is a static folder, and it also opens from `file://`.

```bash
pnpm trace serve .trace/demo/report
```

Open <http://127.0.0.1:5175>. In the report, `Space` plays, `[` and `]` step by action,
`F` jumps to the failure, and `R` switches between the reduced and original sequence.

## A short example

A scenario says what a user does and what must stay true. Requirements live in the
scenario, not in a baseline, so a bug both builds share still fails.

```json
{
  "schema": "trace.scenario/1",
  "id": "reopen-during-close",
  "fixture": { "id": "inspector", "version": "1" },
  "seed": 1,
  "initialState": {},
  "viewport": { "width": 900, "height": 640, "deviceScaleFactor": 1 },
  "timing": { "mode": "controlled", "stepMs": 16, "settleMs": 500 },
  "targets": {
    "trigger": { "role": "button", "name": "Inspect", "traceId": "trigger" },
    "close": { "role": "button", "name": "Done", "traceId": "close" }
  },
  "requirements": [
    { "kind": "latest-request-wins", "key": "panel", "terminal": ["open", "closed"] },
    { "kind": "focus-valid" }
  ],
  "actions": [
    { "at": 0, "type": "activate", "target": "trigger", "requests": { "panel": "open" } },
    { "at": 400, "type": "activate", "target": "close", "requests": { "panel": "closed" } },
    { "at": 500, "type": "activate", "target": "trigger", "requests": { "panel": "open" } }
  ],
  "cleanup": []
}
```

[docs/SCENARIOS.md](docs/SCENARIOS.md) covers every action, every requirement, and how to
register your own fixture.

## What a run gives you

| Verdict | Meaning | Exit code |
|---|---|---|
| `pass` | Both builds met every requirement | 0 |
| `fixed` | The baseline failed and the candidate does not | 0 |
| `regression` | The candidate breaks a requirement the baseline meets | 1 |
| `shared-failure` | Both builds break the same requirement | 1 |
| `invalid` | The scenario cannot run on the baseline | 2 |
| `diverged` | It ran on the baseline and could not finish on the candidate | 2 |

A failed selector or unsupported command is never reported as a regression.

## Results

Every number links to a saved run with a manifest. See [docs/REPORT.md](docs/REPORT.md).

### Detection

Each build is compared with its fixture's correct build across all of that fixture's
scenarios. Labels were committed first. Two controls show the corpus can tell approaches
apart.

| Detector | Tuned corpus: seeded caught | Tuned corpus: clean flagged | Holdout: seeded caught | Holdout: clean flagged |
|---|---|---|---|---|
| **Trace** | 18 of 18 | 0 of 13 | 6 of 6 | 1 of 4 |
| Any trace difference (control) | 13 of 18 | 9 of 13 | 5 of 6 | 2 of 4 |
| Final screenshot difference (control) | 11 of 18 | 5 of 13 | 2 of 6 | 0 of 4 |

The screenshot control compares two captures from one run on one machine, which is its
best case. Runs: [tuned corpus](results/corpus-chromium/summary.json),
[Firefox](results/corpus-firefox/summary.json), [WebKit](results/corpus-webkit/summary.json),
[holdout](results/holdout/summary.json).

### Recording cost

Chromium's own counters, read from outside the page, over 7 rounds after 2 warmup rounds,
with a new browser for each run. Scenario: `long-session`, 14 actions, 5.4 s.

| Recording level | Main thread work added | Script time added |
|---|---|---|
| Timestamps only (performance pass) | 5.9 ms (range -3.7 to 13.4) | 0.75 ms (range -0.5 to 1.0) |
| Full trace (diagnostic pass) | 50.2 ms (range 40.4 to 63.1), 66 percent | 18.4 ms (range 17.3 to 20.4) |

The control did 75.9 ms of main thread work in that 5.4 s, so the percentage looks large
because the page is mostly idle. The timestamp level's range crosses zero, so this
experiment cannot tell its cost from noise.
[Raw samples](results/overhead/raw.json).

## What the numbers leave out

- **The corpus is small and I wrote it.** It has 4 fixture families and 41 builds. It says
  nothing about how many real bugs Trace would catch.
- **The 18 of 18 is tuned.** Five oracle fixes came from reading this corpus. The holdout is
  the fairer number, and it has only 10 builds.
- **The holdout false alarm is a real limit.** A wider list ended 2 px short of a declared
  8 px inset at 360 px wide. The oracle did what the requirement said, but a person
  labeled that build as a legitimate change. A strict numeric requirement can fail a
  design change.
- **Trace only finds what a scenario reaches.** Each seeded bug was caught by the
  scenarios written for its fixture, often only one. Random sessions never reached 2 of
  5 reduction targets: one needs a window narrower than the generator tries, and the
  other makes almost every session impossible to finish.
- **Controlled time has gaps.** It holds timers, frames, `Date`, `performance` and
  animations. It does not hold `ResizeObserver` delivery, React's scheduler, workers,
  compositor scrolling, media, network or rasterization. Each run reports this list. See
  [docs/RESEARCH.md](docs/RESEARCH.md).
- **Animation starts are rounded.** An animation started by a timer inside a step is
  adopted at the end of that step, 16 ms by default.
- **Cancel is synthetic on Firefox and WebKit.** Only Chromium has a real input path for
  `pointercancel`. Those runs say so.
- **Timings are lab numbers from one machine.** They are not INP. `input-to-render` is the
  next frame the page observed, not a frame shown on screen.
- **Automated accessibility checks passed, and that is all.** axe found no serious issues
  on the report. That does not establish full accessibility.
- **Nobody else has used it.** There is a task script and a self-review in
  [docs/USABILITY.md](docs/USABILITY.md), and no user research.

## Tests and benchmarks

| Command | What it does | Time here |
|---|---|---|
| `pnpm check` | Type checks everything | Under 1 s |
| `pnpm test` | Unit tests, including 2,000 model-generated traces with saved seeds | Under 1 s |
| `pnpm test:e2e` | Real browser tests on all three engines | About 5 minutes |
| `pnpm bench:smoke` | One good pair and one seeded failure. Target under 60 s | 3.9 s |
| `pnpm bench` | The full measurement. Budget 40 minutes | 35 minutes |
| `pnpm demo` | Builds the static demo into `demo/` | About 80 s |
| `pnpm verify:artifacts` | Checks saved results against their hashes | Under 1 s |

The plan was frozen in [docs/MEASUREMENT.md](docs/MEASUREMENT.md) before the final run.

## Architecture

```
scenario.json ──> runner ──> two browsers, one action list
                    │           └─ recorder (in the page, outside React)
                    │                focus, geometry, state, events, resources
                    v
              trace events ──> oracle ──> violations ──> verdict
                    │                                      │
                    v                                      v
                 raw files ──> report export          reducer (deletes actions,
                                 static folder         keeps the failure fixed)
```

| Path | Role |
|---|---|
| `src/scenario` | The versioned format and checks that need no browser |
| `src/recorder` | Runs in the page. It reads no text or input values |
| `src/runner` | Clock, input, build serving, run manifest |
| `src/oracle` | Pure functions from a scenario and one trace to violations |
| `src/reduce` | Bounded delta debugging, then the browser predicate |
| `src/report`, `viewer` | Portable report and the case file viewer |
| `fixtures` | Four fixture families with seeded and legitimate variants |
| `corpus` | Labels, committed before the detector ran |
| `bench`, `results` | Reproducible measurements and raw data |

The design choices are in [docs/DESIGN.md](docs/DESIGN.md), and what the primary sources
say, including where Trace differs, is in [docs/RESEARCH.md](docs/RESEARCH.md).

Trace does not check out repositories, run remote code or test sites off this machine.
Trace is not a general test runner, and it does not replace Playwright Trace Viewer. It
adds requirements, comparison and reduction for interrupted interactions.

## License

MIT for the code in this repository. Bundled fonts and dependencies keep their own
licenses. See [ATTRIBUTION.md](ATTRIBUTION.md).
