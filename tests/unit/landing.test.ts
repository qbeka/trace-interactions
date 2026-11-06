import { describe, expect, it } from 'vitest';
import { pressLanded } from '../../src/runner/run.ts';

describe('pressLanded', () => {
  it('accepts a press within rounding of the aim', () => {
    expect(pressLanded({ x: 311, y: 149 }, { x: 310, y: 148 })).toBe(true);
  });
  it('rejects the misplaced press seen on WebKit', () => {
    expect(pressLanded({ x: 311, y: 149 }, { x: -850, y: 1250 })).toBe(false);
  });
  it('rejects a press the page never saw', () => {
    expect(pressLanded({ x: 1, y: 1 }, null)).toBe(false);
  });
});
