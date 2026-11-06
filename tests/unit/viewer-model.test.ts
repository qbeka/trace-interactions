import { describe, expect, it } from 'vitest';
import { alignTime, focusAt, lastAt, primaryTarget, rectAt, skipIdle, stateAt, stateSegments, timelines, trailAt } from '../../viewer/src/model.ts';
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

  it('picks the target a geometry requirement names', () => {
    const s = scenario({ requirements: [{ kind: 'focus-valid' }, { kind: 'geometry-continuous', target: 'panel', maxStepPx: 10 }] });
    expect(primaryTarget(s)).toBe('panel');
  });
});
