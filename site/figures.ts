import { rectAt, timelines } from '../viewer/src/model.ts';
import { cellsOf, type Cell, type Data } from './cells.ts';
import { endsLine } from './lines.ts';

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

  const ends = document.getElementById('ends');
  if (!ends) return;
  if (!('IntersectionObserver' in window)) return void endsFigure(ctx, ends);
  const near = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    near.disconnect();
    endsFigure(ctx, ends);
  }, { rootMargin: '240px 0px' });
  near.observe(ends);
}

/** The last frame of each build, with the frames of the reopen under it to move through. */
function endsFigure({ data, images, loaded, want, watch }: Context, root: HTMLElement): void {
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

  const crisp = (canvas: HTMLCanvasElement, name: string, from: { x: number; y: number; w: number; h: number }) => {
    const c = canvas.getContext('2d')!;
    const s = frame.scale;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.imageSmoothingQuality = 'high';
    c.drawImage(images.get(name)!, from.x * s, from.y * s, from.w * s, from.h * s, 0, 0, canvas.width, canvas.height);
  };

  function drawBig(): void {
    const cell = cells[shown]!;
    if (loaded.has(cell.good)) crisp(big.good, cell.good, crop);
    if (loaded.has(cell.bad)) crisp(big.bad, cell.bad, crop);
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
          crisp(t.pair[k]!, name, THUMB);
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
