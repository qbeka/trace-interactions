import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markupLines, stageLines } from '../../scripts/build-page.ts';
import { coreNote, endsLine, frameLabel, lineProblem, OUTCOMES, readout, SAID, VIEWS } from '../../site/lines.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const data = JSON.parse(/<script id="trace-data" type="application\/json">(.*?)<\/script>/s.exec(read('demo/index.html'))![1]!);
const css = read('site/foundation.css') + read('site/styles.css');
const story = /<article class="story"[^>]*>(.*?)<\/article>/s.exec(read('demo/index.html'))![1]!;

describe('one-line strings on the stage', () => {
  it('accepts one sentence with no closing mark, and says what is wrong with anything else', () => {
    expect(lineProblem('Replay finished')).toBeNull();
    expect(lineProblem('Attempt 4 ran 10 steps and the panel still jumped, so the 4 steps it left out are gone for good')).toBeNull();
    expect(lineProblem('It took 61.3 s to write report.json')).toBeNull();
    expect(lineProblem('Replay finished.')).toBe('ends in a closing mark');
    expect(lineProblem('Did it finish?')).toBe('ends in a closing mark');
    expect(lineProblem('The trail shows the path. The candidate starts 80 px away')).toBe('is more than one sentence');
  });

  it('finds every line the stage can show, and none of them breaks the rule', () => {
    const lines = stageLines(data, read('site/template.html'), css, story);
    expect(lines.length).toBeGreaterThan(160);
    expect(lines).toContain('Both builds end on the same frame, so a final screenshot would miss this');
    expect(lines).toContain('26 attempts left 4 steps, and taking any one of them away loses the jump');
    expect(lines).toContain('This frame did not load');
    expect(lines).toContain('Go to the jump');
    expect(lines).toContain('Each row below is this line of pixels in one recorded frame');
    expect(lines).toContain('Move the scan line');
    // The story under the stage: its headings, captions, labels and limits, and none of its prose.
    expect(lines).toContain('Both builds end on the same frame');
    expect(lines).toContain('One fixture family held out of a corpus I wrote, run once on an earlier oracle');
    expect(lines).toContain('Nobody outside this project has used it yet');
    expect(lines).toContain('A comparison would see no difference');
    expect(lines.some((line) => line.startsWith('Trace does not diff the two builds'))).toBe(false);
    expect(lines.filter((line) => lineProblem(line))).toEqual([]);
  });

  it('says every changing line on the stage in one sentence, whatever it is given', () => {
    const lines = [
      ...VIEWS.flatMap((v) => [readout(v, true), readout(v, false), coreNote(v)]),
      ...Object.values(OUTCOMES),
      ...[2, 96, 318].flatMap((y) => [SAID.scan(y), SAID.scanShort(y)]),
      ...[true, false].flatMap((on) => [SAID.whole(on), SAID.wholeLabel(on), SAID.act(on), SAID.inPlay(14, on)]),
      SAID.duration(240), SAID.goodAt(4000), SAID.makeFrame(1, 16, 0),
      endsLine(true, 58, false), endsLine(true, 0, false), endsLine(false, 0, true), endsLine(false, 0, false),
    ];
    expect(lines.every(Boolean)).toBe(true);
    expect(lines.filter((line) => lineProblem(line))).toEqual([]);
    expect(endsLine(true, 58, false)).toBe('The broken build is 58 px to the right');
    expect(endsLine(false, 0, true)).toBe('The last frame of each build is the same frame');
  });

  it('would stop the build on a verdict, an attempt note, markup or a stylesheet string that ends in a full stop', () => {
    const broken = (lines: string[]) => lines.filter((line) => lineProblem(line));
    const verdict = { ...data, sessions: [{ verdict: { before: 'The two builds match so far.' } }] };
    expect(broken(stageLines(verdict, '', ''))).toEqual(['The two builds match so far.']);
    expect(broken(stageLines(data, '<button aria-label="Replay the reduction.">Go</button><p>The replay needs JavaScript. The details still work</p>', ''))).toEqual(['The replay needs JavaScript. The details still work', 'Replay the reduction.']);
    expect(broken(stageLines(data, '', ".x::before { content: 'Loading this frame.'; }"))).toEqual(['Loading this frame.']);
    expect(broken(stageLines(data, '', '', '<p class="prose">Prose may run on. It is not checked.</p><figcaption>A caption that stops.</figcaption><h2 class="display">Two parts. Like this</h2>'))).toEqual(['A caption that stops.', 'Two parts. Like this']);
  });

  it('reads markup the way a visitor does, leaving out scripts, styles and comments', () => {
    expect(markupLines('<style>a{}</style><!-- note. --><p>One</p><script>var a = "x. y";</script><i title="Two"></i>')).toEqual(['One', 'Two']);
    // A key cap, a line of code and a passage of prose are not labels.
    expect(markupLines('<dt><kbd>?</kbd></dt><dd>This list</dd><pre><code>a. b</code></pre><p class="prose">One. Two.</p>')).toEqual(['This list']);
  });

  it('names a frame for a screen reader in one sentence', () => {
    expect(frameLabel(4000, 12, 14, 'Reopen', true, 80)).toBe('4000 ms, step 12 of 14, Reopen, with the broken build 80 px to the right of the last good build');
    expect(frameLabel(3600, 11, 14, 'Resize to 920 px', false, 0)).toBe('3600 ms, step 11 of 14, Resize to 920 px, where both builds show the same frame');
    expect(readout('shots', true)).toBe('The two builds show different frames');
  });
});
