# Research notes

Versions in use: Playwright 1.65.0, React 19.3.1, Vite 8.3.6, Vitest 5.1.0, TypeScript
7.0.2, Zod 4.6.7. Sources were read on 2026-11-06. The pinned versions are in
`package.json` and `pnpm-lock.yaml`.

## Browser clock

Source: [Playwright clock](https://playwright.dev/docs/clock).

**What it says.** `clock.install` overrides `Date`, `setTimeout`, `setInterval`,
`requestAnimationFrame`, `requestIdleCallback`, `performance` and `Event.timeStamp`.
`runFor` fires timers and animation frames in order. `pauseAt` advances to a time and
freezes. `install` must come before other clock calls.

**What it does not cover.** The page lists what it overrides and stops there. Testing
showed what that leaves out: CSS transitions and Web Animations run on the document
timeline, so they keep real time. So do `ResizeObserver` delivery, which belongs to
the rendering step, and React's scheduler, which uses `MessageChannel`.

**What Trace does about it.**

- Each animation is paused the moment the recorder sees it, then stepped by the
  virtual time that passed. See `seekAnimations` in `src/recorder/recorder.ts`.
- After each step the recorder waits one real frame and one message task, so
  observers and React work finish before sampling.
- Before a run depends on the clock, the runner proves it: timers, frames,
  `performance`, `Date` and animation seeking are each held to one 16 ms step. If a
  page breaks one, the run is invalid. A test proves this with a page that replaces
  `performance.now`.
- The report lists what is not controlled, and which of those channels the page used.
  Trace detects `Worker` and smooth scrolling. It cannot detect every channel.

**Difference from the docs.** They show `page.clock` before `page.goto`. On Firefox and
WebKit a page-level init script runs after the context's clock script, so the "real"
`requestAnimationFrame` a recorder saves there is already the fake one, and waiting on
it hangs forever. Chromium ran them in the other order, so this was invisible until the
browser matrix. Everything now goes on the context, in a fixed order.

## Why not virtual time in the browser

Chromium has `Emulation.setVirtualTimePolicy`. It reaches further than a JavaScript
clock, but it exists only in Chromium. The brief starts with Chromium and then asks for
Firefox and WebKit, so Trace uses the one mechanism all three share.

## Web Animations

Source: [MDN Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API).

`document.getAnimations()` returns animations in effect, and it flushes style, so a CSS
transition started by the latest commit is visible at once. It leaves out an animation
whose element left the DOM, and that animation's `finished` promise still fires. That
is the mechanism behind one seeded bug, so the recorder keeps its own set of animations
it has adopted.

A paused animation never finishes, so the recorder calls `finish()` when virtual time
reaches the end. `finish` and `transitionend` events are queued for the next rendering
step, which is another reason each tick waits for a real frame.

**Known limit.** An animation started by a timer inside a step is adopted at the end of
that step, so its start is rounded up to the step size, 16 ms by default.

## Screenshots

Source: [Playwright snapshots](https://playwright.dev/docs/test-snapshots).

The page says results vary with OS, browser, hardware, power source and headless mode,
and that baselines should come from the same environment. Trace therefore uses
screenshots as supporting evidence and never as a verdict. A saved report records the
browser, OS, viewport and device scale. The screenshot control in the corpus compares
two captures from one machine in one run, which is the most favorable case for it.

## Trace Viewer

Source: [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer).

Trace Viewer inspects one recorded run: actions, DOM snapshots, network and console. It
does not compare two runs or judge behavior. It is excellent at what it does. Trace
does not replace it. Trace adds requirements that do not depend on a baseline,
comparison, reduction, and a view built around focus and geometry.

## Latency terms

Source: [web.dev INP](https://web.dev/articles/inp).

INP is a field metric. It counts clicks, taps and key presses over a whole visit, and
each interaction ends when the browser can paint the next frame. Trace reports lab
quantities and names them differently, so nobody reads them as INP. Definitions are in
`src/perf.ts`.

- `input-to-handler` is `Event.timeStamp` to the first page code.
- `input-to-commit` is `Event.timeStamp` to the fixture publishing the resulting state.
- `input-to-render` is `Event.timeStamp` to one message task after the next
  `requestAnimationFrame`. It is the next frame the page observed, not the frame shown.

A `requestAnimationFrame` interval is a scheduling proxy. It does not establish
displayed frame rate.

## Focus

Source: [APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

Focus moves inside on open. Tab and Shift+Tab stay inside. Escape closes. On close,
focus normally returns to the element that opened the dialog. If that element is gone,
it moves somewhere logical. The `focus-restored` requirement encodes the normal case
and takes the target as a parameter, so a fixture with a different workflow can declare
its own.

## Pointer cancel

No Playwright API sends `pointercancel`. Chromium has a real path: CDP touch input ends
in `touchCancel`, and the browser fires the event and releases capture. Firefox and
WebKit have no equivalent, so Trace dispatches the event from script, releases capture
as the spec requires, swallows the following mouse up, and marks the run as using a
synthetic cancel. Swallowing matters: a later `pointerup` would end the drag and hide
the bug being tested. A test confirms the synthetic path still catches the stuck drag on
both engines.

## Reduction

Delta debugging is from Zeller and Hildebrandt, "Simplifying and Isolating
Failure-Inducing Input" (2002). Trace uses deletion only, and adds what a browser needs:
a fixed failure fingerprint, repeated confirmation, a check that the baseline still
passes, and budgets for attempts and time.

A sequence that fails differently is rejected. Otherwise a shrinker can walk from the
real bug to an unrelated crash and report success.
