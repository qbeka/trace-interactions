# Design

## Who this is for

The target user is an engineer changing an interaction component. They have a
branch and want to know whether the change broke behavior under the same actions.

**The problem.** A panel can look right in its final screenshot and still have
lost focus, accepted a stale transition or jumped during a resize. Screenshot
tests compare end states. Browser tests pass or fail one assertion. Neither
explains how an interrupted interaction went wrong.

**The primary task.** Read one failure. The reader should see which action broke
what, on which build, without reading a console dump.

## Two approaches to the central workflow

### A. Tape inspector (rejected)

A DevTools-style view. A wide timeline runs along the top with one row per data
channel: state, focus, geometry, events. Clicking a row opens detail in a side
panel.

```
+-------------------------------------------------+
| state   ==========|======|====                  |
| focus   ----|----------x                        |
| geometry  /\/\/\_____                           |
+----------------------------------+--------------+
|                                  | detail panel |
+----------------------------------+--------------+
```

This is good for an expert already looking for something. It fails the ten-second
test: it shows everything and states nothing. It also collapses badly on a phone,
and the report must stay useful there. Trace Viewer already covers this shape for
one run, so a copy would add little.

### B. Case file (chosen)

The report reads top to bottom like a short written finding.

1. One sentence that states the verdict.
2. Two small stages, baseline and candidate, drawn from recorded rectangles. They
   show the focus marker and the geometry trail. Both replay from one transport.
3. A shared action rail under the stages. Each action is a tick, the failure has
   a pin, and the two builds line up by action.
4. Below that, tables for actions, focus history and geometry, with the reduction
   summary and environment.

The stages are the memorable interaction: one scrubber moves two drawings, and
the place where they part is the bug. They are drawn from data, not from video,
so they stay small, deterministic and legible at 320 px. Screenshots appear as
supporting evidence next to the moment they were taken.

Rejected alternative in this shape: video side by side. Video would show pixels
but not focus, is costly to capture, and cannot draw the path a panel took.

## Layout and type

The report and the project page share one set of tokens: white paper, dark ink, one forest
green, and one burnt orange that only ever marks a failure. Geist Serif sets the verdict and
the reading passages. Geist sets controls, labels and data, with tabular figures so a table
of numbers still lines up. Both fonts ship with the report, so it needs no network.

A report opens on the verdict, then the requirement that failed in its own words. Under
that, one bordered deck holds the two stages, a strip of the diagnostic screenshots to step
along, the aligned traces and the transport. When the replay sits on a failed
`geometry-origin` sample, the failing stage draws the distance the verdict states as a
dimension line, read from the same two rectangles the oracle read.

There are no metric tiles. A passing report has the same shape as a failing one:
the sentence says what held, and the stages still replay.

A status line, hint, caption or label is one sentence with no closing period, on the page
and in a report. The page build stops if one of its own lines breaks that, and the tests
check the same in a browser. Passages of several sentences are ordinary prose, and so is
the verdict, which is saved with the run and shown as it was written.

## The project page

The page compares the two builds in one viewer instead of two stacked panes, because the
failure is a difference and reads best where the two pictures share one set of
coordinates. Overlay, Swipe and Difference blend the recorded screenshots in the browser.
Geometry draws the report's rectangles and the path each panel took. The outlines and the
ruler are always drawn from the report's rectangles, never from the pictures.

The timeline is a film strip with one cell for each recorded frame, sliding under a fixed
gate, over a line that plots how far apart the builds are across the whole recording. The
reduction is a grid with one row for each step and one column for each attempt the reducer
saved, so the invalid and rejected attempts stay in view.

## What the runner does not do

Trace does not check out repositories, run remote code or test sites off this
machine. Builds come from a manifest the user wrote and URLs on the loopback
interface. See `src/runner/registry.ts`.
