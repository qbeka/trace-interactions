import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markupLines, stageLines } from '../../scripts/build-page.ts';
import { frameLabel, lineProblem, readout } from '../../site/lines.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const data = JSON.parse(/<script id="trace-data" type="application\/json">(.*?)<\/script>/s.exec(read('demo/index.html'))![1]!);
const css = read('site/foundation.css') + read('site/styles.css');

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
    const lines = stageLines(data, read('site/template.html'), css);
    expect(lines.length).toBeGreaterThan(90);
    expect(lines).toContain('Both builds end on the same frame, so a final screenshot would miss this');
    expect(lines).toContain('26 attempts left 4 steps, and taking any one of them away loses the jump');
    expect(lines).toContain('This frame did not load');
    expect(lines).toContain('Go to the jump');
    expect(lines.filter((line) => lineProblem(line))).toEqual([]);
  });

  it('would stop the build on a verdict, an attempt note, markup or a stylesheet string that ends in a full stop', () => {
    const broken = (lines: string[]) => lines.filter((line) => lineProblem(line));
    const verdict = { ...data, sessions: [{ verdict: { before: 'The two builds match so far.' } }] };
    expect(broken(stageLines(verdict, '', ''))).toEqual(['The two builds match so far.']);
    expect(broken(stageLines(data, '<button aria-label="Replay the reduction.">Go</button><p>The replay needs JavaScript. The details still work</p>', ''))).toEqual(['The replay needs JavaScript. The details still work', 'Replay the reduction.']);
    expect(broken(stageLines(data, '', ".x::before { content: 'Loading this frame.'; }"))).toEqual(['Loading this frame.']);
  });

  it('reads markup the way a visitor does, leaving out scripts, styles and comments', () => {
    expect(markupLines('<style>a{}</style><!-- note. --><p>One</p><script>var a = "x. y";</script><i title="Two"></i>')).toEqual(['One', 'Two']);
  });

  it('names a frame for a screen reader in one sentence', () => {
    expect(frameLabel(4000, 12, 14, 'Reopen', true, 80)).toBe('4000 ms, step 12 of 14, Reopen, with the broken build 80 px to the right of the last good build');
    expect(frameLabel(3600, 11, 14, 'Resize to 920 px', false, 0)).toBe('3600 ms, step 11 of 14, Resize to 920 px, where both builds show the same frame');
    expect(readout('swipe', true)).toBe('');
  });
});
