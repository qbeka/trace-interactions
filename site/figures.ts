import { rectAt, timelines } from '../viewer/src/model.ts';
import { cellsOf, type Cell, type Data } from './cells.ts';
import { endsLine, SAID } from './lines.ts';

/**
 * The figures under the stage. They wait until they are about to scroll into
 * view, and draw from the same recorded frames the stage plays.
 */
interface Context {
  data: Data;
  images: Map<string, HTMLImageElement>;
  loaded: Set<string>;
  want(names: string[]): void;
  watch(fn: (name: string) => void): void;
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initFigures(ctx: Context): void {
  // Sections arrive as they are scrolled to. Without the observer they are simply there.
  const reveals = [...document.querySelectorAll('.reveal')];
  if (!('IntersectionObserver' in window) || calm()) {
    for (const node of reveals) node.classList.add('in');
  } else {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        seen.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const node of reveals) seen.observe(node);
  }

  // A figure is set up when it is about to be scrolled to, and not before.
  const figures: [string, (ctx: Context, root: HTMLElement) => void][] = [['ends', endsFigure], ['make', makeFigure]];
  for (const [id, start] of figures) {
    const root = document.getElementById(id);
    if (!root) continue;
    if (!('IntersectionObserver' in window)) {
      start(ctx, root);
      continue;
    }
    const near = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      near.disconnect();
      start(ctx, root);
    }, { rootMargin: '240px 0px' });
    near.observe(root);
  }
}

/** Copies part of a recorded frame onto a canvas, at the canvas's own size. */
function crisp(ctx: Context, canvas: HTMLCanvasElement, name: string, from: { x: number; y: number; w: number; h: number }): void {
  const c = canvas.getContext('2d')!;
  const s = ctx.data.frame.scale;
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.imageSmoothingQuality = 'high';
  c.drawImage(ctx.images.get(name)!, from.x * s, from.y * s, from.w * s, from.h * s, 0, 0, canvas.width, canvas.height);
}

/**
 * How a slit scan is made, on the first time the panel opens: the frame on the
 * left, and on the right one row for each frame so far, cut along the line.
 */
function makeFigure(ctx: Context, root: HTMLElement): void {
  const { data, images, loaded, want, watch } = ctx;
  const { frame, crop, steps, scanY } = data;
  const session = data.sessions[0]!;
  const cells = cellsOf(data.runs[session.good]!, data.runs[session.good]!, steps, session.kept).filter((c) => c.step === 0);
  const shot = document.getElementById('make-shot') as HTMLCanvasElement;
  const core = document.getElementById('make-core') as HTMLCanvasElement;
  const range = document.getElementById('make-range') as HTMLInputElement;
  const rows = document.getElementById('make-rows')!;
  const link = document.getElementById('make-link')!;
  const count = document.getElementById('make-n')!;
  const ROW = 12;
  const line = document.createElement('canvas');
  shot.width = crop.w * frame.scale;
  shot.height = crop.h * frame.scale;
  core.width = Math.round(crop.w * 1.5);
  core.height = cells.length * ROW;
  line.width = core.width;
  line.height = 1;
  const done = cells.map(() => false);
  let shown = cells.length - 1;
  let timer = 0;

  function place(): void {
    root.style.setProperty('--row', String(shown));
    root.style.setProperty('--rows', String(cells.length));
    // A thread from the line on the frame to the row it has just become.
    const box = root.getBoundingClientRect();
    const a = shot.getBoundingClientRect();
    const b = core.getBoundingClientRect();
    if (!box.width || b.left <= a.right) return link.setAttribute('d', '');
    const y1 = a.top - box.top + ((scanY - crop.y) / crop.h) * a.height;
    const y2 = b.top - box.top + ((shown + 0.5) / cells.length) * b.height;
    const x1 = a.right - box.left;
    const x2 = b.left - box.left;
    const mid = (x1 + x2) / 2;
    link.setAttribute('d', `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`);
  }

  function show(i: number): void {
    shown = Math.max(0, Math.min(cells.length - 1, i));
    const cell = cells[shown]!;
    count.textContent = SAID.makeFrame(shown + 1, cells.length, cell.t);
    range.value = String(shown);
    range.setAttribute('aria-valuetext', count.textContent);
    want([cell.good]);
    if (loaded.has(cell.good)) crisp(ctx, shot, cell.good, crop);
    place();
  }

  // One row a tick: the frame's line is squeezed to the picture's width, then stretched to the row's height.
  let pending = false;
  function drawRows(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const i = done.findIndex((d, k) => !d && loaded.has(cells[k]!.good));
      if (i < 0) return;
      const s = frame.scale;
      const l = line.getContext('2d')!;
      l.clearRect(0, 0, line.width, 1);
      l.drawImage(images.get(cells[i]!.good)!, crop.x * s, scanY * s, crop.w * s, s, 0, 0, line.width, 1);
      const c = core.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.drawImage(line, 0, 0, line.width, 1, 0, i * ROW, core.width, ROW);
      done[i] = true;
      drawRows();
    });
  }

  range.max = String(cells.length - 1);
  range.addEventListener('input', () => {
    clearInterval(timer);
    show(Number(range.value));
  });
  rows.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearInterval(timer);
    const box = rows.getBoundingClientRect();
    show(Math.floor(((e.clientY - box.top) / box.height) * cells.length));
  });
  rows.addEventListener('click', (e) => {
    clearInterval(timer);
    const box = rows.getBoundingClientRect();
    show(Math.floor(((e.clientY - box.top) / box.height) * cells.length));
  });
  rows.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && document.activeElement !== range) show(cells.length - 1);
  });
  watch((name) => {
    if (cells[shown]!.good === name) crisp(ctx, shot, name, crop);
    drawRows();
  });
  new ResizeObserver(place).observe(root);
  want(cells.map((c) => c.good));
  drawRows();
  // The first time it is seen, the picture is built one row at a time.
  if (calm()) return show(cells.length - 1);
  show(0);
  timer = window.setInterval(() => {
    if (shown >= cells.length - 1) return clearInterval(timer);
    show(shown + 1);
  }, 150);
}

/** The last frame of each build, with the frames of the reopen under it to move through. */
function endsFigure(ctx: Context, root: HTMLElement): void {
  const { data, loaded, want, watch } = ctx;
  const { frame, crop, jump, steps } = data;
  const session = data.sessions[0]!;
  const good = data.runs[session.good]!;
  const bad = data.runs[session.bad]!;
  const all = cellsOf(good, bad, steps, session.kept);
  const cells: Cell[] = all.filter((c) => c.t >= jump.t);
  const goodLine = timelines(good.events);
  const badLine = timelines(bad.events);
  const offset = (t: number) => {
    const a = rectAt(goodLine, 'panel', t);
    const b = rectAt(badLine, 'panel', t);
    return a && b ? Math.round(Math.abs(b.x - a.x)) : 0;
  };
  const big = { good: document.getElementById('ends-good') as HTMLCanvasElement, bad: document.getElementById('ends-bad') as HTMLCanvasElement };
  const strip = document.getElementById('ends-strip')!;
  const range = document.getElementById('ends-range') as HTMLInputElement;
  const sign = document.getElementById('ends-sign')!;
  const when = document.getElementById('ends-time')!;
  const say = document.getElementById('ends-say')!;
  const THUMB = { x: 600, y: 0, w: 400, h: 200 };
  const lastIndex = cells.length - 1;
  let shown = lastIndex;

  for (const canvas of Object.values(big)) {
    canvas.width = crop.w * frame.scale;
    canvas.height = crop.h * frame.scale;
  }
  const thumbs = cells.map((cell) => {
    const node = document.createElement('div');
    node.className = cell.differs ? 'ends-cell differs' : 'ends-cell';
    const pair = (['good', 'bad'] as const).map(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 80;
      node.append(canvas);
      return canvas;
    });
    const label = document.createElement('span');
    label.textContent = String(cell.t);
    node.append(label);
    strip.insertBefore(node, range);
    return { node, pair, done: [false, false] };
  });

  function drawBig(): void {
    const cell = cells[shown]!;
    if (loaded.has(cell.good)) crisp(ctx, big.good, cell.good, crop);
    if (loaded.has(cell.bad)) crisp(ctx, big.bad, cell.bad, crop);
  }

  function show(i: number): void {
    shown = Math.max(0, Math.min(lastIndex, i));
    const cell = cells[shown]!;
    thumbs.forEach((t, k) => t.node.classList.toggle('on', k === shown));
    root.classList.toggle('differs', cell.differs);
    sign.textContent = cell.differs ? '≠' : '=';
    when.textContent = `${cell.t} ms`;
    const px = offset(cell.t);
    say.textContent = endsLine(cell.differs, px, shown === lastIndex);
    range.value = String(shown);
    range.setAttribute('aria-valuetext', `${cell.t} ms, ${say.textContent}`);
    big.bad.setAttribute('aria-label', `Broken build at ${cell.t} ms`);
    big.good.setAttribute('aria-label', `Last good build at ${cell.t} ms`);
    want([cell.good, cell.bad]);
    drawBig();
  }

  // The small frames are drawn a few at a time, as their screenshots arrive.
  let pending = false;
  function drawThumbs(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      // Each first drawing of a frame costs a decode, so only two a frame.
      let budget = 2;
      for (const [i, t] of thumbs.entries()) {
        const cell = cells[i]!;
        for (const [k, name] of [cell.good, cell.bad].entries()) {
          if (t.done[k] || !loaded.has(name)) continue;
          if (!budget) return drawThumbs();
          crisp(ctx, t.pair[k]!, name, THUMB);
          t.done[k] = true;
          budget -= 1;
        }
      }
    });
  }

  range.max = String(lastIndex);
  range.addEventListener('input', () => show(Number(range.value)));
  // A mouse only has to pass over the strip, and the last frame comes back when it leaves.
  strip.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const box = strip.getBoundingClientRect();
    show(Math.floor(((e.clientX - box.left) / box.width) * cells.length));
  });
  strip.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && document.activeElement !== range) show(lastIndex);
  });
  watch((name) => {
    const cell = cells[shown]!;
    if (cell.good === name || cell.bad === name) drawBig();
    drawThumbs();
  });
  want(cells.flatMap((c) => [c.good, c.bad]));
  show(lastIndex);
  drawThumbs();
}
