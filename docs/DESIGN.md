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

The report uses a serif for editorial text and a readable sans for dense
controls. The verdict sentence uses Geist Serif, tables and controls use Geist
Sans, and trace values use Geist Mono. All three ship with the report, so it
needs no network. Colors and spacing are design tokens in the viewer stylesheet.

There are no metric tiles. A passing report has the same shape as a failing one:
the sentence says what held, and the stages still replay.

## What the runner does not do

Trace does not check out repositories, run remote code or test sites off this
machine. Builds come from a manifest the user wrote and URLs on the loopback
interface. See `src/runner/registry.ts`.
