import { rectAt, timelines } from '../viewer/src/model.ts';
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

  // The same marks the page draws on the broken build, from the recorded rectangles.
  const svg = document.getElementById('marks')!;
  const box = svg.getBoundingClientRect();
  const row = box.height / cells.length;
  const x = (px: number) => ((px - crop.x) / crop.w) * box.width;
  const goodLine = timelines(good.events);
  const badLine = timelines(bad.events);
  const from = cells.findIndex((c) => c.t >= jump.t);
  const to = cells.findIndex((c) => c.t >= jump.settled);
  let ghost = '';
  let edge = '';
  for (let i = from; i < to; i++) {
    const a = rectAt(goodLine, 'panel', cells[i]!.t);
    const b = rectAt(badLine, 'panel', cells[i]!.t);
    if (!a || !b || scanY < a.y || scanY > a.y + a.h) continue;
    ghost += `${ghost ? 'L' : 'M'}${x(a.x).toFixed(1)} ${(i * row).toFixed(1)}V${((i + 1) * row).toFixed(1)}`;
    edge += `${edge ? 'L' : 'M'}${x(b.x).toFixed(1)} ${(i * row).toFixed(1)}V${((i + 1) * row).toFixed(1)}`;
  }
  const bx = box.width - 14;
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `<path class="ghost" d="${ghost}"/><path class="edge" d="${edge}"/><path class="span" d="M${bx - 10} ${from * row}H${bx}V${to * row}H${bx - 10}"/>`;
  document.body.dataset.ready = 'true';
}

draw().catch((error) => {
  document.body.dataset.ready = String(error);
});
