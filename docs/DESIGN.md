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

The two stages share one frame: the part of the window that the tracked elements of either
build used during the action under the clock. The elements fill the stage, a position on one
stage means the same on the other, and the frame only changes when the action does, so it
never moves under a motion. Resting on a measured failure, the frame closes in on the two
rectangles the verdict is about. The whole window is one press away.

Where the diagnostic pass took a screenshot of the same moment, it lies under the
rectangles, and the stage says which it is drawing over. An action's own screenshot is taken
after the action ran, so it shows the page as the trace has it at that time. This is only
offered under controlled time, where both passes reach the same state at the same moment.
The strip of screenshots and the pair under the tables are cut to the same frames, and each
of the pair links to its whole window.

There are no metric tiles. A passing report has the same shape as a failing one:
the sentence says what held, and the stages still replay.

A status line, hint, caption or label is one sentence with no closing period, on the page
and in a report. The page build stops if one of its own lines breaks that, and the tests
check the same in a browser. Passages of several sentences are ordinary prose, and so is
the verdict, which is saved with the run and shown as it was written.

## The project page

The page shows each build twice: as the frame on the clock, and as a slit scan under it. A
slit scan takes one row of pixels at the same height from every recorded frame and stacks
the rows in time order, so a whole session is one picture. An opening panel draws a funnel,
a resize draws a step, and the failure is the place where the two pictures part. The scan
line can be moved, and both pictures are cut again along it.

The frames come first. The page opens on the first frame of the failure, close on the
Inspect button and the two places the panel starts, so the distance between them is the
largest thing on the stage. As the panel grows, the view opens out to the part of the
window where the panel is from the reopen onward, and away from the failure a frame and
its scan share that view and one horizontal scale. The whole frame is one press away. The
broken build carries both outlines and the ruler, so the distance is read in one set of
coordinates. Over a screenshot, only where the panel starts and where it ends are outlined,
and every rectangle between them is left to Geometry.

A scan has to read as a picture of time to someone who has never seen one. One line between
the frames and the scans says what they are. Over each scan, the panel's band is toned and
everything outside it is muted, so the shape the panel makes can be told from the page
around it. On the broken build the rows where the panel is out of place are toned as a
failure, the last good build's edge is dashed beside them, the gap between the two is
hatched, and one note says how far off the panel opened, for how long and on which step.
All of that is drawn from the report's rectangles, and the pixels under it are not changed.

The scans are read off the main thread. A worker keeps each frame as runs of equal pixels,
which is a few kilobytes for a screenshot of an interface, and answers with both pictures
whenever the line, the session or the view changes. Where a worker cannot start, as when the
page is opened from a file, the rows are copied straight from the frames on the page, a few
each tick.

Difference lights the pixels where the two builds disagree, in the frame and in the scan,
where everything outside the failure is black. Geometry draws the report's rectangles in the
frame, with the whole path of the panel, and in the scans the places where they cross the
line. The outlines, the ruler, the toning and the note are always drawn from the report's
rectangles, never from the pictures.

The reduction has the stage to itself in a second act. It is a grid with one row for each
step and one column for each attempt the reducer saved, over a band for each step that runs
for as long as the reducer still had that step in play, so the bands close in on the steps
that are left. The invalid and rejected attempts stay in view.

Under the stage, the page explains itself with figures drawn from the same runs: the last
frame of each build above the frames that differ, a scan built one row at a time, each
requirement with what each build did against it, and every measured result as one mark for
each build, run or session, with its scope in the caption. The figures start only when they
are near the screen.

## What the runner does not do

Trace does not check out repositories, run remote code or test sites off this
machine. Builds come from a manifest the user wrote and URLs on the loopback
interface. See `src/runner/registry.ts`.
