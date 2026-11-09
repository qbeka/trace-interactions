/**
 * Every fixed one-line string the stage shows or announces. A status, hint,
 * caption or label is one sentence with no closing period, and the build stops
 * when one of these, or a line it writes from the saved runs, breaks that.
 */
export type View = 'overlay' | 'swipe' | 'difference' | 'geometry';

export const SOURCE: Record<View, string> = {
  overlay: 'Recorded screenshots',
  swipe: 'Recorded screenshots',
  difference: 'Recorded screenshots',
  geometry: 'Recorded geometry',
};

/** What the corner of the viewer says about the frame on screen. Swipe needs no words. */
export function readout(view: View, differs: boolean): string {
  if (view === 'geometry') return 'Rectangles from the report, with the path each panel took';
  if (view === 'difference') return differs ? 'Lit where the two frames differ' : 'No pixel differs in this frame';
  if (view === 'overlay') return differs ? 'Both builds, one over the other' : 'The two frames are the same';
  return '';
}

/** The viewer's name for a screen reader: where the film is, and how the two builds compare there. */
export function frameLabel(t: number, step: number, steps: number, label: string, differs: boolean, offset: number): string {
  const compare = !differs ? 'where both builds show the same frame'
    : offset ? `with the broken build ${offset} px to the right of the last good build`
    : 'where the two builds differ';
  return `${t} ms, step ${step} of ${steps}, ${label}, ${compare}`;
}

export const SAID = {
  finished: 'Replay finished',
  scenario: 'The four steps are on the clipboard as a Trace scenario',
  command: 'Copied',
  copyFailed: 'Copying did not work in this browser',
  replaying: (attempts: number) => `Replaying ${attempts} attempts`,
  view: (name: string) => `${name} view`,
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
