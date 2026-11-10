import { rectAt, timelines, viewportAt } from '../viewer/src/model.ts';
import { cellsOf, type Data } from './cells.ts';
import { compose, pack, type Packed } from './scan.ts';

/**
 * Draws the art for the share card: the two slit scans of the full session, cut
 * from the recorded frames by the same code the page runs. The script that takes
 * the picture waits for `data-ready`.
 */
declare const __OG__: { data: Data; base: string };

async function draw(): Promise<void> {
  const { data, base } = __OG__;
  const { frame, crop, jump, steps, scanY } = data;
  const session = data.sessions[0]!;
  const good = data.runs[session.good]!;
  const bad = data.runs[session.bad]!;
  const cells = cellsOf(good, bad, steps, session.kept);
  const frames = new Map<string, Packed>();
  const canvas = new OffscreenCanvas(frame.width * frame.scale, frame.height * frame.scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  for (const name of new Set(cells.flatMap((c) => [c.good, c.bad]))) {
    const bitmap = await createImageBitmap(await (await fetch(`${base}frames/${name}.webp`)).blob());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    frames.set(name, pack(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, frame.scale));
  }
  const width = 2 * Math.round(document.getElementById('good')!.getBoundingClientRect().width);
  const result = compose(frames, { id: 1, good: cells.map((c) => c.good), bad: cells.map((c) => c.bad), y: scanY, x0: crop.x, x1: crop.x + crop.w, width, mode: 'shots' }, frame.scale, frame.scale);
  for (const side of ['good', 'bad'] as const) {
    const target = document.getElementById(side) as HTMLCanvasElement;
    target.width = result.width;
    target.height = result.rows;
    target.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result[side]), result.width, result.rows), 0, 0);
  }

  // The same toning the page lays over its scans, from the recorded rectangles: the panel's
  // band, the rows where the broken build has it out of place, and where it should have been.
  const goodLine = timelines(good.events);
  const badLine = timelines(bad.events);
  const crosses = (r: { y: number; h: number } | null) => !!r && scanY >= r.y && scanY <= r.y + r.h;
  for (const side of ['good', 'bad'] as const) {
    const svg = document.getElementById(`marks-${side}`)!;
    const box = svg.getBoundingClientRect();
    const row = box.height / cells.length;
    const x = (px: number) => Math.max(0, Math.min(box.width, ((px - crop.x) / crop.w) * box.width));
    let veil = `M0 0H${box.width}V${box.height}H0Z`;
    let band = '';
    let off = '';
    let wedge = '';
    let ghost = '';
    let drawing = false;
    cells.forEach((cell, i) => {
      const own = rectAt(side === 'good' ? goodLine : badLine, 'panel', cell.t);
      const other = rectAt(goodLine, 'panel', cell.t);
      const apart = side === 'bad' && !!own && !!other && Math.abs(own.x - other.x) >= 0.5;
      if (!apart || !crosses(other)) drawing = false;
      if (!own || !crosses(own)) return;
      const edge = viewportAt(goodLine, cell.t, { width: frame.width, height: frame.height }).width;
      const l = x(own.x);
      const r = x(Math.min(own.x + own.w, edge));
      const path = `M${l.toFixed(1)} ${(i * row).toFixed(1)}H${r.toFixed(1)}V${((i + 1) * row).toFixed(1)}H${l.toFixed(1)}Z`;
      veil += path;
      if (apart) off += path;
      else band += path;
      if (!apart || !other || !crosses(other)) return;
      const g = x(other.x);
      ghost += `${drawing ? 'L' : 'M'}${g.toFixed(1)} ${(i * row).toFixed(1)}V${((i + 1) * row).toFixed(1)}`;
      drawing = true;
      wedge += `M${g.toFixed(1)} ${(i * row).toFixed(1)}H${l.toFixed(1)}V${((i + 1) * row).toFixed(1)}H${g.toFixed(1)}Z`;
    });
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.innerHTML = `<path class="veil" fill-rule="evenodd" d="${veil}"/><path class="band" d="${band}"/><path class="off" d="${off}"/><path class="wedge" d="${wedge}"/><path class="ghost" d="${ghost}"/>`;
  }
  document.body.dataset.ready = 'true';
}

draw().catch((error) => {
  document.body.dataset.ready = String(error);
});
