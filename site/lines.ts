/**
 * Every fixed one-line string the page shows or announces. A status, hint,
 * caption or label is one sentence with no closing period, and the build stops
 * when one of these, or a line it writes from the saved runs, breaks that.
 */
export type View = 'shots' | 'difference' | 'geometry';
export const VIEWS: View[] = ['shots', 'difference', 'geometry'];

export const SOURCE: Record<View, string> = {
  shots: 'Recorded screenshots',
  difference: 'Recorded screenshots',
  geometry: 'Recorded geometry',
};

/** What the corner of the first frame says about the pair of frames on show. */
export function readout(view: View, differs: boolean): string {
  if (view === 'geometry') return 'Rectangles from the report, with the path each panel took';
  if (view === 'difference') return differs ? 'Lit where the two frames differ' : 'No pixel differs in this frame';
  return differs ? 'The two builds show different frames' : 'The two frames are the same';
}

/** The one line between the frames and the pictures under them, which says what those pictures are. */
export function coreNote(view: View): string {
  if (view === 'geometry') return 'Time runs down these two pictures, and each row shows where the recorded rectangles sat under the line a moment later';
  if (view === 'difference') return 'Time runs down these two pictures, and the one on the right is lit only where the two builds differ';
  return 'Time runs down these two pictures, with each row showing the strip of page under the line a moment later, so the shaded shape is the panel opening and closing';
}

/** The frame's name for a screen reader: where the replay is, and how the two builds compare there. */
export function frameLabel(t: number, step: number, steps: number, label: string, differs: boolean, offset: number): string {
  const compare = !differs ? 'where both builds show the same frame'
    : offset ? `with the broken build ${offset} px to the right of the last good build`
    : 'where the two builds differ';
  return `${t} ms, step ${step} of ${steps}, ${label}, ${compare}`;
}

/** What the figure under the stage says about the pair of frames it shows. */
export function endsLine(differs: boolean, offset: number, last: boolean): string {
  if (!differs) return last ? 'The last frame of each build is the same frame' : 'Both builds show the same frame';
  return offset ? `The broken build is ${offset} px to the right` : 'The two frames differ';
}

/** What each mark in the search means, beside how many attempts ended that way. */
export const OUTCOMES: Record<string, string> = {
  fails: 'kept the failure',
  passes: 'lost it',
  invalid: 'could not run',
  'other-failure': 'failed in another way',
};

export const SAID = {
  finished: 'Replay finished',
  scenario: 'The four steps are on the clipboard as a Trace scenario',
  command: 'Copied',
  copyFailed: 'Copying did not work in this browser',
  replaying: (attempts: number) => `Replaying ${attempts} attempts`,
  view: (name: string) => `${name} view`,
  scan: (y: number) => `${y} px from the top of the page`,
  scanShort: (y: number) => `Row ${y}`,
  whole: (on: boolean) => (on ? 'Showing the whole frame' : 'Showing the part of the page where the panel opens'),
  wholeLabel: (on: boolean) => (on ? 'Show the part where the panel opens' : 'Show the whole frame'),
  act: (search: boolean) => (search ? 'The search for the steps that matter' : 'The jump, frame by frame'),
  inPlay: (total: number, done: boolean) => (done ? `of ${total} steps are needed` : `of ${total} steps still in play`),
  goodAt: (t: number) => `Last good build at ${t} ms`,
  makeFrame: (n: number, total: number, t: number) => `Frame ${n} of ${total}, at ${t} ms`,
  axisStart: 'Start',
  axisEnd: 'End',
  breakHow: (px: number) => `Opens ${px} px to the right`,
  breakWhen: (ms: number, step: string) => `for ${ms} ms, at ${step}`,
};

/**
 * Why a line is not one sentence without a closing period, or null when it is.
 * A mark that ends a sentence is a full stop, question mark or exclamation mark
 * at the end of the line or before a space. A decimal or a file name has neither after it.
 */
export function lineProblem(text: string): string | null {
  if (/[.!?]\s*$/.test(text)) return 'ends in a closing mark';
  if (/[.!?]\s/.test(text)) return 'is more than one sentence';
  return null;
}
