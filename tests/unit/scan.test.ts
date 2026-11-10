import { describe, expect, it } from 'vitest';
import { cellsOf } from '../../site/cells.ts';
import { compose, pack, unpack, type Packed } from '../../site/scan.ts';

/** A frame of one colour, with a block of another colour somewhere in it. */
function picture(width: number, height: number, block: { x: number; y: number; w: number; h: number; color: number }, ground = 0xff101010): Uint8ClampedArray {
  const px = new Uint32Array(width * height).fill(ground);
  for (let y = block.y; y < block.y + block.h; y++) px.fill(block.color, y * width + block.x, y * width + block.x + block.w);
  return new Uint8ClampedArray(px.buffer);
}
const RED = 0xff0000ff;
const rows = (buffer: ArrayBuffer, width: number) => {
  const px = new Uint32Array(buffer);
  return Array.from({ length: px.length / width }, (_, r) => [...px.subarray(r * width, (r + 1) * width)]);
};

describe('a frame kept as runs', () => {
  it('gives back every kept line exactly', () => {
    const data = picture(40, 20, { x: 10, y: 4, w: 12, h: 6, color: RED });
    const frame = pack(data, 40, 20, 2);
    expect(frame.offsets).toHaveLength(11);
    const line = new Uint32Array(40);
    const source = new Uint32Array(data.buffer);
    for (let i = 0; i < 10; i++) {
      unpack(frame, i, line);
      expect([...line]).toEqual([...source.subarray(i * 2 * 40, i * 2 * 40 + 40)]);
    }
    // Three runs on a line through the block, and one on a line that misses it.
    expect(frame.offsets[3]! - frame.offsets[2]!).toBe(3);
    expect(frame.offsets[1]! - frame.offsets[0]!).toBe(1);
    // A line past either end is the nearest one, so a scan line never reads outside the frame.
    unpack(frame, 99, line);
    expect(line[0]).toBe(0xff101010);
  });

  it('grows to hold a frame with no flat colour at all', () => {
    const px = Uint32Array.from({ length: 300 * 4 }, (_, i) => 0xff000000 | i);
    const frame = pack(new Uint8ClampedArray(px.buffer), 300, 4, 1);
    expect(frame.colors).toHaveLength(1200);
    const line = new Uint32Array(300);
    unpack(frame, 3, line);
    expect(line[299]).toBe((0xff000000 | 1199) >>> 0);
  });
});

describe('a slit scan', () => {
  const frames = new Map<string, Packed>();
  // The block starts 4 px further right in `late` than in `early`, on the same lines.
  frames.set('early', pack(picture(40, 20, { x: 10, y: 4, w: 12, h: 6, color: RED }), 40, 20, 2));
  frames.set('late', pack(picture(40, 20, { x: 14, y: 4, w: 12, h: 6, color: RED }), 40, 20, 2));
  const request = { id: 7, good: ['early', 'early', 'early'], bad: ['early', 'late', 'missing'], y: 3, x0: 0, x1: 20, width: 40, mode: 'shots' as const };

  it('takes the same line from every frame, one row for each', () => {
    const result = compose(frames, request, 2, 2);
    expect(result).toMatchObject({ id: 7, width: 40, rows: 3, missing: 1 });
    const good = rows(result.good, 40);
    const bad = rows(result.bad, 40);
    // Page line 3 is frame line 6, which runs through the block.
    expect(good[0]!.slice(8, 24)).toEqual([0xff101010, 0xff101010, ...Array(12).fill(RED), 0xff101010, 0xff101010]);
    expect(bad[0]).toEqual(good[0]);
    expect(bad[1]!.indexOf(RED)).toBe(14);
    // A frame that has not arrived leaves its row clear in both pictures.
    expect(new Set(bad[2])).toEqual(new Set([0]));
    expect(new Set(good[2])).toEqual(new Set([0]));
  });

  it('reads a line that misses the block as flat ground', () => {
    const result = compose(frames, { ...request, y: 0 }, 2, 2);
    expect(new Set(rows(result.bad, 40)[1])).toEqual(new Set([0xff101010]));
  });

  it('keeps a thin edge when the picture is made narrower', () => {
    const result = compose(frames, { ...request, width: 10 }, 2, 2);
    const row = rows(result.good, 10)[0]!;
    // Each output pixel is four source pixels. The block covers source pixels 10 to 21,
    // so output pixels 2 and 5 are half red, and the two between them are all red.
    expect(row[1]).toBe(0xff101010);
    expect(row[3]).toBe(RED);
    expect(row[4]).toBe(RED);
    expect(row[6]).toBe(0xff101010);
    for (const x of [2, 5]) {
      expect(row[x]! & 0xff).toBeGreaterThan(0x70);
      expect(row[x]! & 0xff).toBeLessThan(0x98);
    }
  });

  it('lights only the places where the two builds differ', () => {
    const result = compose(frames, { ...request, mode: 'difference' }, 2, 2);
    const bad = rows(result.bad, 40);
    expect(new Set(bad[0])).toEqual(new Set([0xff000000]));
    const lit = bad[1]!.map((p, x) => (p !== 0xff000000 ? x : -1)).filter((x) => x >= 0);
    // The block left pixels 10 to 13 and arrived at pixels 22 to 25.
    expect(lit).toEqual([10, 11, 12, 13, 22, 23, 24, 25]);
    // The last good build's own picture is left as it was.
    expect(rows(result.good, 40)[1]!.indexOf(RED)).toBe(10);
  });
});

describe('the list of recorded frames', () => {
  const good = { frames: [{ t: 0, f: 'a' }, { t: 16, f: 'b' }, { t: 400, f: 'c' }], events: [] };
  const bad = { frames: [{ t: 0, f: 'a' }, { t: 16, f: 'x' }, { t: 32, f: 'c' }], events: [] };
  const steps = [{ at: 0 }, { at: 200 }, { at: 400 }];

  it('has a cell wherever either build changed, and one where each step starts', () => {
    const cells = cellsOf(good, bad, steps, [0, 1, 2]);
    expect(cells.map((c) => c.t)).toEqual([0, 16, 32, 200, 400]);
    expect(cells.map((c) => `${c.good}${c.bad}`)).toEqual(['aa', 'bx', 'bc', 'bc', 'cc']);
    expect(cells.map((c) => c.differs)).toEqual([false, true, true, true, false]);
    expect(cells.map((c) => c.step)).toEqual([0, 0, 0, 1, 2]);
    expect(cells.map((c) => c.first)).toEqual([true, false, false, true, true]);
  });

  it('leaves out a step the session does not have', () => {
    const cells = cellsOf(good, bad, steps, [0, 2]);
    expect(cells.map((c) => c.t)).toEqual([0, 16, 32, 400]);
    expect(cells.map((c) => c.step)).toEqual([0, 0, 0, 2]);
  });
});
