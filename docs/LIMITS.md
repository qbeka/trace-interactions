# Limits

What the numbers leave out, in full. The README has the short version.

- **The corpus is small and I wrote it.** It has 4 fixture families and 41 builds, with
  one seeded bug per failure category in the holdout. It says nothing about how many real
  bugs Trace would catch.
- **The 18 of 18 is tuned.** Oracle and scenario changes came from reading this corpus.
- **The holdout is one run on an earlier oracle.** It ran once, at commit `432cf66`. The
  oracle changed afterward, and the rerun on final code is a regression check, not a
  second holdout. No result here tests the final oracle on unseen code.
- **Labels came first, with one exception.** The detector had already run on 2 inspector
  builds before `corpus/labels.json` was committed.
- **The holdout false alarm is a real limit.** A wider list reached the viewport edge at
  360 px wide, against a declared 8 px inset. The oracle did what the requirement said,
  but I had labeled that build a legitimate change. A numeric requirement can fail a
  design change.
- **Trace only finds what a scenario reaches.** Most seeded bugs were caught by exactly one
  scenario. Random sessions never reached 2 of 5 reduction targets. A requirement the run
  never reached says `not exercised`, for example a focus requirement on a target that
  never had focus. That status is per requirement: one judged occurrence makes it `held`,
  even if another was skipped.
- **Random sessions use a reduced requirement list.** They carry no acknowledgements and
  leave out 4 requirement kinds. Applying a fixture's fixed requirements to random sessions
  fails correct builds: 23 of 26 on timeline in the review, because a transient state is
  judged before it settles unless the scenario sets `settledMs`. So the result covers false
  alarms from these checks only.
- **Some leaks are invisible.** The ledger counts listeners on `window` and `document`,
  observers, timers, frames and idle callbacks. It misses `document.body` listeners,
  `matchMedia`, `visualViewport` and `BroadcastChannel`. A component already mounted at load
  has no count from before mount, so that scenario reports `not exercised`.
- **Controlled time has gaps.** It holds timers, frames, `Date`, `performance` and
  animations. It does not hold `ResizeObserver` delivery, React's scheduler, workers,
  compositor scrolling, media, network, `crypto` randomness or rasterization. Each run
  reports this list. See [RESEARCH.md](RESEARCH.md).
- **Animation starts are rounded.** An animation started by a timer inside a step is
  adopted at the end of that step, 16 ms by default.
- **Cancel is synthetic on Firefox and WebKit.** Only Chromium has a real input path for
  `pointercancel`. Those runs say so. A reducer that deletes the cancel also switches
  Chromium from touch to mouse input.
- **WebKit input depends on the machine.** On a run during a long idle period, WebKit put
  every press far off target, on a reviewer's rerun of this exact corpus. The cause is
  unproven, and I could not reproduce it with the display awake. Such a run is now invalid
  instead of a quiet pass. The final run held the display awake.
- **Corpus numbers come from one repetition.** Verdicts repeated across the runs I made, but
  recorded event order at equal times can swap between runs.
- **Timings are lab numbers from one machine.** They are not INP. `input-to-render` is the
  next frame the page observed, not a frame shown on screen.
- **What a report contains.** The recorder keeps no text or input values, and it drops
  attributes that do not look like identifiers. An allowlisted state key can still carry
  text, as the combobox's `resultsFor` does, and reports include the scenario's typed text
  and unmasked screenshots. Use synthetic data.
- **Automated accessibility checks passed, and that is all.** axe found no serious issues
  on the report. That does not establish full accessibility.
- **Nobody else has used it.** There is no user research.
