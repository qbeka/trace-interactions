import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReportData } from '../../viewer/src/types.ts';
import type { Requirement } from '../../src/scenario/schema.ts';
import { lineProblem } from '../../site/lines.ts';
import { actionName, actionSpan, describeRequirement, failureFrame, fit, frameAt, originGap, alignTime, focusAt, lastAt, primaryTarget, rectAt, shotAt, skipIdle, STAGE_ASPECT, stateAt, stateSegments, takenBefore, timelines, trailAt, windowFrame } from '../../viewer/src/model.ts';
import { scenario, trace } from './helpers.ts';

const box = (x: number) => ({ x, y: 0, w: 10, h: 10 });

describe('viewer model', () => {
  it('finds the last item at or before a time', () => {
    const items = [{ t: 0 }, { t: 10 }, { t: 10 }, { t: 20 }];
    expect(lastAt(items, -1)).toBe(-1);
    expect(lastAt(items, 10)).toBe(2);
    expect(lastAt(items, 999)).toBe(3);
  });

  it('reads rect, state and focus at a time', () => {
    const t = trace().at(0).rect('panel', box(0)).state('panel', 'opening').focus('input', 1).at(16).rect('panel', box(30)).at(32).rect('panel', null).state('panel', 'closed').focus(null);
    const line = timelines(t.events);
    expect(rectAt(line, 'panel', 20)?.x).toBe(30);
    expect(rectAt(line, 'panel', 40)).toBeNull();
    expect(stateAt(line, 'panel', 10)).toBe('opening');
    expect(focusAt(line, 40)).toBeNull();
    expect(focusAt(line, 10)?.traceId).toBe('input');
  });

  it('draws a trail only since the target last appeared', () => {
    const t = trace().at(0).rect('panel', box(0)).at(10).rect('panel', box(10)).at(20).rect('panel', null).at(30).rect('panel', box(50)).at(40).rect('panel', box(60));
    expect(trailAt(timelines(t.events), 'panel', 45).map((p) => p.x)).toEqual([55, 65]);
  });

  it('is the identity when both builds share a clock', () => {
    const a = timelines(trace().at(0).action(0, 'activate').at(100).action(1, 'activate').at(200).state('x', 1).events);
    expect(alignTime(a, a, 137)).toBeCloseTo(137);
  });

  it('lines up wall clock runs by action, not by milliseconds', () => {
    const a = timelines(trace().at(100).action(0, 'activate').at(200).action(1, 'activate').at(300).state('x', 1).events);
    const b = timelines(trace().at(120).action(0, 'activate').at(260).action(1, 'activate').at(400).state('x', 1).events);
    expect(alignTime(a, b, 100)).toBeCloseTo(120);
    expect(alignTime(a, b, 150)).toBeCloseTo(190);
    expect(alignTime(a, b, 200)).toBeCloseTo(260);
  });

  it('builds state segments that end at the next change', () => {
    const line = timelines(trace().at(0).state('p', 'a').at(100).state('p', 'b').at(300).state('q', 1).events);
    expect(stateSegments(line, 'p')).toEqual([{ from: 0, to: 100, value: 'a' }, { from: 100, to: 300, value: 'b' }]);
  });

  it('skips a quiet gap and stops before the next event', () => {
    const busy = [0, 16, 1000, 1016].map((t) => ({ t }));
    expect(skipIdle(busy, 8)).toBe(8);
    expect(skipIdle(busy, 100)).toBe(960);
    expect(skipIdle(busy, 1008)).toBe(1008);
    expect(skipIdle(busy, 2000)).toBe(2000);
  });

  it('frames what either build recorded during the action under the clock, at one shape', () => {
    const build = (x: number) => timelines(trace()
      .at(0).action(0, 'activate').rect('trigger', { x: 700, y: 10, w: 80, h: 30 }).rect('panel', { x, y: 40, w: 100, h: 50 })
      .at(16).rect('panel', { x: x - 100, y: 40, w: 200, h: 90 })
      .at(400).action(1, 'activate').rect('panel', null)
      .at(416).rect('trigger', { x: 100, y: 10, w: 80, h: 30 }).events);
    const lines = [build(500), build(520)];
    const first = frameAt(lines, 8, { width: 900, height: 600 });
    // Both builds, and the trigger that was standing when the action began.
    expect(first.x).toBeLessThan(400);
    expect(first.x + first.w).toBeGreaterThan(780);
    expect(first.w / first.h).toBeCloseTo(STAGE_ASPECT);
    // The frame holds still for the whole action, and moves on with the next one.
    expect(frameAt(lines, 300, { width: 900, height: 600 })).toEqual(first);
    const second = frameAt(lines, 410, { width: 900, height: 600 });
    expect(second).not.toEqual(first);
    expect(second.x).toBeLessThan(100);
    expect(actionSpan(lines[0]!, 8)).toEqual({ from: 0, to: 400 });
    expect(actionSpan(lines[0]!, 500)).toEqual({ from: 400, to: Infinity });
    expect(frameAt([timelines([])], 0, { width: 900, height: 600 })).toEqual({ x: -150, y: 0, w: 1200, h: 600 });
  });

  it('picks the target a geometry requirement names', () => {
    const s = scenario({ requirements: [{ kind: 'focus-valid' }, { kind: 'geometry-continuous', target: 'panel', maxStepPx: 10 }] });
    expect(primaryTarget(s)).toBe('panel');
  });
});

describe('what a report says about an action and a measured gap', () => {
  const report = JSON.parse(readFileSync(join(import.meta.dirname, '../../demo/regression/report.json'), 'utf8')) as ReportData;
  const fixed = JSON.parse(readFileSync(join(import.meta.dirname, '../../demo/fixed/report.json'), 'utf8')) as ReportData;

  it('names a resize by its size, and anything else by its note or type', () => {
    expect(actionName({ type: 'resize', width: 920, height: 640, at: 0, note: 'widen' })).toBe('resize to 920 × 640');
    expect(actionName({ type: 'activate', target: 'trigger', at: 0, note: 'reopen' })).toBe('reopen');
    expect(actionName({ type: 'press', key: 'Escape', at: 0 })).toBe('press');
  });

  it('measures the same distance the verdict states, on the build that failed', () => {
    for (const c of report.cases) {
      const gap = originGap(c)!;
      expect(c.comparison.sentence).toContain(`${gap.px} px away from ${gap.anchor} at ${gap.t} ms`);
      expect(Math.round(gap.to.x - gap.from.x)).toBe(80);
    }
    // After the fix the failure is on the baseline, and the gap is read from there.
    const gap = originGap(fixed.cases[0]!)!;
    expect(gap.px).toBe(80);
    expect(fixed.cases[0]!.comparison.verdict).toBe('fixed');
  });

  it('closes in on the two rectangles of a measured failure, and can show the whole window', () => {
    const gap = originGap(report.cases[0]!)!;
    const close = failureFrame(gap);
    for (const r of [gap.from, gap.to]) {
      expect(r.x).toBeGreaterThan(close.x);
      expect(r.x + r.w).toBeLessThan(close.x + close.w);
      expect(r.y).toBeGreaterThan(close.y);
      expect(r.y + r.h).toBeLessThan(close.y + close.h);
    }
    expect(close.w).toBeLessThan(400);
    expect(close.w / close.h).toBeCloseTo(STAGE_ASPECT);
    expect(windowFrame({ width: 1000, height: 640 })).toEqual({ x: -140, y: 0, w: 1280, h: 640 });
    expect(fit({ x: 0, y: 0, w: 400, h: 100 }, 0)).toEqual({ x: 0, y: -50, w: 400, h: 200 });
  });

  it('offers the screenshot of a moment only where it shows the page as the trace has it', () => {
    const c = report.cases.find((x) => x.id === 'reduced')!;
    const shots = c.candidate.screenshots;
    // Two screenshots share the failure's time. The clock's one came before the action, and the action's one after.
    const at = shots.filter((s) => s.t === 4000);
    expect(at.map((s) => s.label)).toEqual(['at 4000 ms', 'reopen']);
    expect(takenBefore(at[0]!, shots)).toBe(true);
    expect(takenBefore(at[1]!, shots)).toBe(false);
    expect(shotAt(c.candidate, 4000, 8)).toBe(at[1]);
    expect(shotAt(c.candidate, 4016, 8)).toBeNull();
    expect(shotAt(c.candidate, 4500, 8)?.label).toBe('settled');
    // Wall clock runs do not line up with the screenshot pass, so they get none.
    expect(shotAt({ ...c.candidate, clock: { ...c.candidate.clock, mode: 'wall' } }, 4000, 8)).toBeNull();
  });

  it('has no gap to draw when nothing failed', () => {
    const c = report.cases[0]!;
    expect(originGap({ ...c, comparison: { ...c.comparison, introduced: [], shared: [], resolved: [] } })).toBeNull();
  });
});

describe('what a report says a requirement is', () => {
  it('is one sentence with no closing period, for every kind of requirement', () => {
    const kinds = [
      { kind: 'latest-request-wins', key: 'panel', terminal: ['open', 'closed'] },
      { kind: 'focus-stays-on', target: 'input', whileState: { panel: 'open' } },
      { kind: 'focus-restored', to: 'trigger', withinMs: 100, whenState: { panel: 'closed' } },
      { kind: 'focus-valid' },
      { kind: 'geometry-continuous', target: 'panel', maxStepPx: 160 },
      { kind: 'geometry-origin', target: 'panel', anchor: 'trigger', tolerancePx: 4 },
      { kind: 'geometry-fits', target: 'panel', insetPx: 8, tolerancePx: 2 },
      { kind: 'single-interactive', target: 'panel' },
      { kind: 'relationship-resolves', from: 'input', attribute: 'aria-controls', to: 'list' },
      { kind: 'transient-cleared', state: { dragging: false }, after: 'pointerUp' },
      { kind: 'resources-released', key: 'mounted' },
    ] as unknown as Requirement[];
    const lines = kinds.map(describeRequirement);
    expect(new Set(lines).size).toBe(11);
    expect(lines.filter((line) => lineProblem(line))).toEqual([]);
    expect(describeRequirement(kinds[5]!)).toBe('panel appears at trigger or at its final position (within 4 px)');
  });
});
