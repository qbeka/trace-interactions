/**
 * The slit scan. One line of pixels is taken at the same height from every
 * recorded frame, and the lines are stacked in time order, so a whole session
 * becomes one picture. Nothing is drawn here that a screenshot did not hold.
 *
 * A frame is kept as runs of equal pixels, one list for each line. Interface
 * screenshots are mostly flat colour, so a frame costs a few kilobytes instead of
 * five megabytes, and any line of any frame can be read back at full sharpness.
 */
export interface Packed {
  width: number;
  /** Where each kept line starts in `colors` and `lengths`, with one more entry for the end. */
  offsets: Uint32Array;
  colors: Uint32Array;
  lengths: Uint16Array;
}

export interface ScanRequest {
  id: number;
  /** The frame behind each row of the picture, for the last good build and for the broken one. */
  good: string[];
  bad: string[];
  /** The line to read, in page px from the top of the frame. */
  y: number;
  /** The part of the line to keep, in page px. */
  x0: number;
  x1: number;
  /** How many pixels wide to make each row. */
  width: number;
  /** `shots` copies the line. `difference` lights the places where the two builds disagree. */
  mode: 'shots' | 'difference';
}

export interface ScanResult {
  id: number;
  width: number;
  rows: number;
  good: ArrayBuffer;
  bad: ArrayBuffer;
  /** Rows whose frame has not arrived yet. They are left clear. */
  missing: number;
}

/** Keeps every `step`th line of a decoded frame as runs. `pixels` is RGBA, row by row. */
export function pack(pixels: Uint8ClampedArray, width: number, height: number, step: number): Packed {
  const px = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
  const lines = Math.floor(height / step);
  const offsets = new Uint32Array(lines + 1);
  let colors = new Uint32Array(lines * 48);
  let lengths = new Uint16Array(lines * 48);
  let n = 0;
  for (let line = 0; line < lines; line++) {
    offsets[line] = n;
    const from = line * step * width;
    const to = from + width;
    let i = from;
    while (i < to) {
      const color = px[i]!;
      let j = i + 1;
      while (j < to && px[j] === color) j += 1;
      if (n === colors.length) {
        const c = new Uint32Array(n * 2);
        c.set(colors);
        colors = c;
        const l = new Uint16Array(n * 2);
        l.set(lengths);
        lengths = l;
      }
      colors[n] = color;
      lengths[n] = j - i;
      n += 1;
      i = j;
    }
  }
  offsets[lines] = n;
  return { width, offsets, colors: colors.slice(0, n), lengths: lengths.slice(0, n) };
}

/** Writes one kept line back out as pixels. */
export function unpack(frame: Packed, line: number, into: Uint32Array): void {
  const last = frame.offsets.length - 2;
  const at = Math.max(0, Math.min(last, line));
  let x = 0;
  for (let i = frame.offsets[at]!; i < frame.offsets[at + 1]!; i++) {
    const end = x + frame.lengths[i]!;
    into.fill(frame.colors[i]!, x, end);
    x = end;
  }
}

/** Averages the source pixels under each output pixel, so a thin border never drops out. */
function resample(line: Uint32Array, from: number, to: number, out: Uint8ClampedArray, at: number, width: number): void {
  const bytes = new Uint8Array(line.buffer, line.byteOffset, line.length * 4);
  const span = (to - from) / width;
  for (let x = 0; x < width; x++) {
    const a = Math.floor(from + x * span);
    const b = Math.max(a + 1, Math.floor(from + (x + 1) * span));
    let r = 0;
    let g = 0;
    let bl = 0;
    let al = 0;
    for (let s = a; s < b; s++) {
      const alpha = bytes[s * 4 + 3]!;
      r += bytes[s * 4]! * alpha;
      g += bytes[s * 4 + 1]! * alpha;
      bl += bytes[s * 4 + 2]! * alpha;
      al += alpha;
    }
    const o = at + x * 4;
    if (al) {
      out[o] = r / al;
      out[o + 1] = g / al;
      out[o + 2] = bl / al;
      out[o + 3] = al / (b - a);
    }
  }
}

/**
 * Builds the two pictures for one scan line. `scale` is frame pixels per page px,
 * and `step` is how many frame lines apart the kept lines are.
 */
export function compose(frames: Map<string, Packed>, request: ScanRequest, scale: number, step: number): ScanResult {
  const { good, bad, width, mode } = request;
  const rows = good.length;
  const outGood = new Uint8ClampedArray(width * rows * 4);
  const outBad = new Uint8ClampedArray(width * rows * 4);
  const line = Math.round((request.y * scale) / step);
  let missing = 0;
  let a: Uint32Array | null = null;
  let b: Uint32Array | null = null;
  for (let row = 0; row < rows; row++) {
    const g = frames.get(good[row]!);
    const c = frames.get(bad[row]!);
    if (!g || !c) {
      missing += 1;
      continue;
    }
    a ??= new Uint32Array(g.width);
    b ??= new Uint32Array(g.width);
    const from = Math.round(request.x0 * scale);
    const to = Math.min(g.width, Math.round(request.x1 * scale));
    const at = row * width * 4;
    unpack(g, line, a);
    resample(a, from, to, outGood, at, width);
    if (good[row] === bad[row]) {
      if (mode === 'shots') outBad.set(outGood.subarray(at, at + width * 4), at);
      else for (let x = 0; x < width; x++) outBad[at + x * 4 + 3] = 255;
      continue;
    }
    unpack(c, line, b);
    resample(b, from, to, outBad, at, width);
    if (mode === 'difference') {
      // Black where the two lines agree, and lit by how far apart they are where they do not.
      for (let x = 0; x < width; x++) {
        const o = at + x * 4;
        const d = Math.max(Math.abs(outGood[o]! - outBad[o]!), Math.abs(outGood[o + 1]! - outBad[o + 1]!), Math.abs(outGood[o + 2]! - outBad[o + 2]!), Math.abs(outGood[o + 3]! - outBad[o + 3]!));
        const v = Math.min(1, (d * 4) / 255);
        outBad[o] = 255 * v;
        outBad[o + 1] = 182 * v;
        outBad[o + 2] = 128 * v;
        outBad[o + 3] = 255;
      }
    }
  }
  return { id: request.id, width, rows, good: outGood.buffer, bad: outBad.buffer, missing };
}
