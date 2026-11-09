import type { TraceEvent } from '../src/trace/types.ts';
import { focusAt, lastAt, rectAt, timelines, viewportAt, type Timelines } from '../viewer/src/model.ts';
import { aliveAfter, attemptNote, diedAt } from './reduction.ts';

/**
 * The public project page. One viewer compares two recorded builds, a film strip
 * of the recorded frames moves under a fixed needle, and a grid replays every
 * attempt of the reduction. All numbers and sentences arrive in the data block,
 * written from the saved runs.
 */
interface Rect { x: number; y: number; w: number; h: number }
interface Run { frames: { t: number; f: string }[]; events: TraceEvent[] }
type Phase = 'before' | 'jump' | 'after';
type View = 'overlay' | 'swipe' | 'difference' | 'geometry';
interface Session {
  id: 'original' | 'reduced';
  count: string;
  kept: number[];
  good: string;
  bad: string;
  verdict: Record<Phase, string>;
}
interface Data {
  frame: { width: number; height: number; scale: number };
  axisEnd: number;
  jump: { t: number; settled: number; px: number; step: number };
  steps: { at: number; label: string }[];
  attempts: { kept: number[]; outcome: string }[];
  targets: { name: string; id: string; label: string }[];
  sessions: Session[];
  runs: Record<string, Run>;
  scenario: string;
}
interface Cell { t: number; good: string; bad: string; step: number; first: boolean; differs: boolean }

const data: Data = JSON.parse(document.getElementById('trace-data')!.textContent!);
const SVG = 'http://www.w3.org/2000/svg';
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const shape = (tag: string, cls: string, parent: Element) => {
  const node = document.createElementNS(SVG, tag);
  if (cls) node.setAttribute('class', cls);
  parent.append(node);
  return node;
};
const set = (node: Element, attrs: Record<string, number | string>) => {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
};
const show = (node: Element, on: boolean) => node.setAttribute('visibility', on ? 'visible' : 'hidden');
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const VIEWS: View[] = ['overlay', 'swipe', 'difference', 'geometry'];

const stage = $('stage');
const viewer = $('viewer');
const screen = $<HTMLCanvasElement>('screen');
const ctx = screen.getContext('2d')!;
const marks = $<SVGSVGElement>('marks');
const divider = $('divider');
const film = $('film');
const reel = $('reel');
const range = $<HTMLInputElement>('time');
const playButton = $('play');
const jumpButton = $('jump');
const status = $('status');
const { steps, jump, attempts, frame, axisEnd } = data;

/* Screenshots. They load behind the first paint, nearest the playhead first. */
const images = new Map<string, HTMLImageElement>();
const loaded = new Set<string>();
let queue: string[] = [];
let active = 0;

function pump(): void {
  while (active < 6 && queue.length) {
    const name = queue.shift()!;
    if (images.has(name)) continue;
    active += 1;
    const img = new Image();
    img.decoding = 'async';
    images.set(name, img);
    img.src = `frames/${name}.webp`;
    img.decode().then(() => {
      loaded.add(name);
      arrived(name);
    }, () => images.delete(name)).finally(() => {
      active -= 1;
      pump();
    });
  }
}

/** Asks for these first, ahead of anything already waiting. */
function want(names: string[]): void {
  const fresh = names.filter((n) => !images.has(n));
  if (!fresh.length) return;
  queue = [...new Set([...fresh, ...queue])];
  pump();
}

function wantLater(names: string[]): void {
  queue = [...new Set([...queue, ...names.filter((n) => !images.has(n))])];
  pump();
}

/* State */
let session = data.sessions[0]!;
let good!: Run;
let bad!: Run;
let goodLine!: Timelines;
let badLine!: Timelines;
let cells: Cell[] = [];
let jumpIndex = 0;
let settledIndex = 0;
let view: View = 'overlay';
let split = 0.56;
/** Where the film sits under the needle, in frames. The frame on screen is the nearest one. */
let pos = 0;
let index = -1;
let velocity = 0;
let target: number | null = null;
let dragging = false;
let playing = false;
let holding = false;
let hold = 0;
let cut = 0;
/** The opening still sits on the jump. The first press starts from the top. */
let poster = true;
/** How much of the ruler is drawn, from 0 to 1. */
let grow = 1;
let growFrom = 0;
let raf = 0;
let last = 0;
let dirty = true;
/** Until someone takes the controls, the stage plays the failure over, slowly. */
let idle = false;
let idleWait = 0;
let onScreen = true;

const time = () => cells[index]?.t ?? 0;
const phaseAt = (t: number): Phase => (t < jump.t ? 'before' : t < jump.settled ? 'jump' : 'after');
const offsetAt = (t: number): number => {
  const a = rectAt(goodLine, 'panel', t);
  const b = rectAt(badLine, 'panel', t);
  return a && b ? b.x - a.x : 0;
};

/* The viewer: one canvas of screenshots, and marks drawn in the same coordinates */
interface Camera { x: number; y: number; w: number; h: number; scale: number }
let cam: Camera = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
/** Where the two frames differ, kept as its own layer so the browser blends and scales it off the main thread. */
const glow = $<HTMLCanvasElement>('glow');
const scratch = document.createElement('canvas');
let drawn = '';

const world = shape('g', 'world', marks);
const worldView = shape('rect', 'g-view', world);
const nodes = new Map(data.targets.map((t) => [t.name, { rect: shape('rect', 'g-node', world), name: shape('text', 'g-name', world) }]));
for (const t of data.targets) nodes.get(t.name)!.name.textContent = t.label;
const fanGood = shape('path', 'g-fan good', world);
const fanBad = shape('path', 'g-fan bad', world);
const panelGood = shape('rect', 'g-panel good', world);
const panelBad = shape('rect', 'g-panel bad', world);
const focusRing = shape('rect', 'g-focus', world);
// Past the edge of the window there is no page, and the hatching says so.
const defs = shape('defs', '', marks);
const hatch = shape('pattern', '', defs);
set(hatch, { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
set(shape('line', 'm-hatch', hatch), { x1: 0, y1: 0, x2: 0, y2: 6 });
const outside = shape('rect', 'm-outside', marks);
marks.prepend(outside);
marks.prepend(defs);
const edge = shape('line', 'm-edge', marks);
const ruler = shape('g', 'ruler', marks);
const outlineGood = shape('rect', 'm-outline good', ruler);
const outlineBad = shape('rect', 'm-outline bad', ruler);
const extend = shape('path', 'm-extend', ruler);
const span = shape('path', 'm-span', ruler);
const pill = shape('rect', 'm-pill', ruler);
const label = shape('text', 'm-label', ruler);

function layout(): void {
  const { width, height } = viewer.getBoundingClientRect();
  if (!width || !height) return;
  // On a narrow viewer the labels would sit on the Inspect button, so the window starts below them.
  const head = width < 560 ? 34 : 0;
  // Large enough to read, and never so large that the open panel leaves the picture.
  const scale = Math.min(Math.max((height - head) / 300, width / frame.width), width / 548, 1.6);
  const w = Math.min(frame.width, width / scale);
  const h = height / scale;
  cam = { x: frame.width - w, y: -head / scale, w, h, scale: width / w };
  // The canvas holds the screenshot's own pixels for the part in view, so a frame is copied
  // across without resampling, and the browser scales the finished picture to fit.
  screen.width = Math.round(w * frame.scale);
  screen.height = Math.round(h * frame.scale);
  for (const canvas of [glow, scratch]) {
    canvas.width = screen.width;
    canvas.height = screen.height;
  }
  set(marks, { viewBox: `${cam.x} ${cam.y} ${cam.w} ${cam.h}` });
  const unit = 1 / cam.scale;
  set(label, { 'font-size': 12 * unit });
  for (const n of nodes.values()) set(n.name, { 'font-size': 11 * unit });
  drawn = '';
  dirty = true;
}

function blit(to: CanvasRenderingContext2D, name: string): void {
  const s = frame.scale;
  const k = to.canvas.width / (cam.w * s);
  // Only the part of the camera that the frame covers is drawn, at the place it belongs.
  const top = Math.max(0, cam.y);
  const bottom = Math.min(frame.height, cam.y + cam.h);
  const sx = Math.round(cam.x * s);
  const sw = Math.round(cam.w * s);
  const sh = Math.round((bottom - top) * s);
  to.drawImage(images.get(name)!, sx, Math.round(top * s), sw, sh, 0, Math.round((top - cam.y) * s * k), to.canvas.width, Math.round(sh * k));
}

/** Paints one build on white, so that the part outside the window compares as equal. */
function flat(canvas: HTMLCanvasElement, name: string): CanvasRenderingContext2D {
  const c = canvas.getContext('2d')!;
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  blit(c, name);
  return c;
}

function paint(): void {
  const cell = cells[index];
  if (!cell) return;
  const key = `${view}|${cell.good}|${cell.bad}|${view === 'swipe' ? split.toFixed(4) : ''}`;
  if (key === drawn) return;
  const { width: W, height: H } = screen;
  if (view === 'geometry') {
    ctx.clearRect(0, 0, W, H);
    drawn = key;
    return;
  }
  // A frame still on its way leaves the last one up, so nothing flashes empty.
  if (!loaded.has(cell.good) || !loaded.has(cell.bad)) {
    want([cell.good, cell.bad]);
    waiting(true);
    return;
  }
  waiting(false);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (view === 'overlay') {
    ctx.clearRect(0, 0, W, H);
    blit(ctx, cell.good);
    if (cell.differs) {
      ctx.globalAlpha = 0.5;
      blit(ctx, cell.bad);
      ctx.globalAlpha = 1;
    }
  } else if (view === 'swipe') {
    const x = Math.round(split * W);
    ctx.clearRect(0, 0, W, H);
    blit(ctx, cell.good);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, W - x, H);
    ctx.clip();
    ctx.clearRect(x, 0, W - x, H);
    blit(ctx, cell.bad);
    ctx.restore();
  } else {
    // Difference: black where the two frames agree, lit where they do not. The last
    // good build sits underneath, dimmed by the stylesheet, to show where things are.
    ctx.clearRect(0, 0, W, H);
    blit(ctx, cell.good);
    const a = glow.getContext('2d')!;
    if (cell.differs) {
      // The stylesheet brightens and tints this layer, so the main thread only subtracts.
      flat(glow, cell.good);
      flat(scratch, cell.bad);
      a.globalCompositeOperation = 'difference';
      a.drawImage(scratch, 0, 0);
      a.globalCompositeOperation = 'source-over';
    } else a.clearRect(0, 0, glow.width, glow.height);
  }
  drawn = key;
}

let waitTimer = 0;
function waiting(on: boolean): void {
  if (!on) {
    clearTimeout(waitTimer);
    waitTimer = 0;
    viewer.classList.remove('is-waiting');
  } else if (!waitTimer) {
    waitTimer = window.setTimeout(() => viewer.classList.add('is-waiting'), 180);
  }
}

const rectPath = (r: Rect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`;
/** Every rectangle a panel recorded since it last appeared, up to `t`. */
function fan(line: Timelines, t: number): string {
  const samples = line.rects.get('panel') ?? [];
  let d = '';
  for (let i = lastAt(samples, t) - 1; i >= 0; i--) {
    const r = samples[i]!.rect;
    if (!r) break;
    d += rectPath(r);
  }
  return d;
}

function drawMarks(): void {
  const t = time();
  const unit = 1 / cam.scale;
  const geometry = view === 'geometry';
  const vp = viewportAt(goodLine, t, { width: frame.width, height: frame.height });
  const narrow = vp.width < frame.width;
  show(edge, narrow && !geometry);
  show(outside, narrow);
  if (narrow) {
    set(edge, { x1: vp.width, y1: 0, x2: vp.width, y2: frame.height });
    set(outside, { x: vp.width, y: 0, width: frame.width - vp.width, height: frame.height });
  }

  const a = rectAt(goodLine, 'panel', t);
  const b = rectAt(badLine, 'panel', t);
  const gap = a && b ? b.x - a.x : 0;
  const on = !!a && !!b && Math.abs(gap) >= 0.5;
  show(ruler, on);
  if (on && a && b) {
    for (const [node, r] of [[outlineGood, a], [outlineBad, b]] as const) set(node, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 5 });
    show(outlineGood, !geometry);
    show(outlineBad, !geometry);
    // A dimension line under the panels, the way a drawing marks a distance.
    const y = Math.min(266, cam.y + cam.h - 16 * unit);
    const from = a.x;
    const to = a.x + gap * grow;
    const foot = Math.min(a.y + a.h, b.y + b.h) + 5 * unit;
    set(extend, { d: `M${a.x} ${foot}V${y + 6 * unit}M${b.x} ${foot}V${y + 6 * unit}` });
    let d = `M${from} ${y}H${to}`;
    for (let x = 0; x <= Math.abs(to - from) + 0.01; x += 10) d += `M${from + Math.sign(gap) * x} ${y - (x % 50 === 0 ? 5 : 3) * unit}V${y}`;
    set(span, { d });
    const text = `${Math.round(Math.abs(gap))} px`;
    if (label.textContent !== text) label.textContent = text;
    const wide = (text.length * 6.6 + 14) * unit;
    const fits = Math.abs(gap) > wide + 6 * unit;
    // Beside the line when it cannot sit over it, on whichever side still has room.
    const right = Math.max(a.x, b.x) + 8 * unit + wide / 2;
    const cx = fits ? (a.x + b.x) / 2 : right + wide / 2 < cam.x + cam.w - 4 * unit ? right : Math.min(a.x, b.x) - 8 * unit - wide / 2;
    const cy = fits ? y - 15 * unit : y - 1 * unit;
    set(pill, { x: cx - wide / 2, y: cy - 10 * unit, width: wide, height: 20 * unit, rx: 10 * unit });
    set(label, { x: cx, y: cy + 4.2 * unit });
    const done = grow > 0.85;
    show(pill, done);
    show(label, done);
  }

  show(world, geometry);
  if (!geometry) return;
  set(worldView, { x: 0.5, y: 0.5, width: vp.width - 1, height: frame.height - 0.5 });
  for (const [name, node] of nodes) {
    const r = rectAt(goodLine, name, t);
    show(node.rect, !!r);
    show(node.name, !!r && r.w >= 60);
    if (!r) continue;
    set(node.rect, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 });
    set(node.name, { x: r.x + r.w / 2, y: r.y + r.h / 2 + 4 * unit });
  }
  for (const [node, r] of [[panelGood, a], [panelBad, b]] as const) {
    show(node, !!r);
    if (r) set(node, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6 });
  }
  // Where the builds agree, one rectangle is enough.
  if (!on) show(panelBad, false);
  set(fanGood, { d: fan(goodLine, t) });
  set(fanBad, { d: on || t >= jump.t ? fan(badLine, t) : '' });
  const focus = focusAt(goodLine, t);
  const focused = focus && data.targets.find((x) => x.id === focus.traceId);
  const box = focused ? rectAt(goodLine, focused.name, t) : null;
  show(focusRing, !!box);
  if (box) set(focusRing, { x: box.x - 3, y: box.y - 3, width: box.w + 6, height: box.h + 6, rx: 6 });
}

/* The film strip: one cell for each recorded frame, moving under a fixed needle */
let pitch = 88;
let thumbs: { canvas: HTMLCanvasElement; drawn: string }[] = [];
/** The corner of the window where the panel opens, which is all a small frame can show. */
const THUMB = { x: 568, y: 0, w: 432, h: 270 };
const THUMB_PX = { w: 208, h: 130 };

function buildReel(): void {
  reel.replaceChildren();
  thumbs = cells.map((cell, i) => {
    const node = el('div', 'cell');
    node.style.setProperty('--i', String(i));
    if (cell.differs) node.classList.add('differs');
    if (cell.first) {
      node.classList.add('first');
      const step = el('span', 'cell-step');
      step.append(el('b', '', String(cell.step + 1)), steps[cell.step]!.label);
      if (cell.step === jump.step) step.classList.add('bad');
      // A label may run on over the frames of its own step, and no further.
      node.style.setProperty('--span', String(cells.filter((c) => c.step === cell.step).length));
      node.append(step);
    }
    const canvas = el('canvas');
    canvas.width = THUMB_PX.w;
    canvas.height = THUMB_PX.h;
    node.append(canvas, el('span', 'cell-ms', String(cell.t)));
    reel.append(node);
    return { canvas, drawn: '' };
  });
  cells.forEach((_, i) => thumb(i));
}

function thumb(i: number): void {
  const cell = cells[i];
  const slot = thumbs[i];
  if (!cell || !slot || slot.drawn === cell.bad || !loaded.has(cell.bad)) return;
  const c = slot.canvas.getContext('2d')!;
  const s = frame.scale;
  c.clearRect(0, 0, THUMB_PX.w, THUMB_PX.h);
  c.imageSmoothingQuality = 'high';
  c.drawImage(images.get(cell.bad)!, THUMB.x * s, THUMB.y * s, THUMB.w * s, THUMB.h * s, 0, 0, THUMB_PX.w, THUMB_PX.h);
  slot.drawn = cell.bad;
  slot.canvas.parentElement!.classList.add('ready');
}

function arrived(name: string): void {
  cells.forEach((cell, i) => {
    if (cell.bad === name) thumb(i);
  });
  const cell = cells[index];
  if (cell && (cell.good === name || cell.bad === name)) {
    dirty = true;
    schedule();
  }
}

function measureFilm(): void {
  pitch = parseFloat(getComputedStyle(film).getPropertyValue('--pitch')) || 88;
  placeReel();
}

/**
 * During playback the film moves a frame at a time: it rests with a whole frame
 * in the gate, then slides to the next, so the picture and the film change together.
 */
function settle(p: number): number {
  const whole = Math.floor(p);
  const e = clamp((p - whole - 0.5) / 0.5, 0, 1);
  return whole + e * e * (3 - 2 * e);
}
const stepped = () => (playing || idle) && !dragging && target === null;

function placeReel(): void {
  reel.style.transform = `translate3d(${(-(stepped() ? settle(pos) : pos) * pitch).toFixed(2)}px,0,0)`;
}

/* The lane: the whole recording on one line, with how far apart the builds are */
const scope = $<SVGSVGElement>('scope');
set(scope, { viewBox: '0 0 1000 40' });
const scopeBase = shape('line', 's-base', scope);
set(scopeBase, { x1: 0, y1: 30, x2: 1000, y2: 30 });
const scopeDone = shape('line', 's-done', scope);
const scopeTicks = steps.map((step, i) => {
  const x = (step.at / axisEnd) * 1000;
  const tick = shape('line', i === jump.step ? 's-tick jump' : 's-tick', scope);
  set(tick, { x1: x, y1: 25, x2: x, y2: 35 });
  return tick;
});
const scopeTrace = shape('path', 's-trace', scope);
const peak = el('span', 'peak', `${jump.px} px`);
peak.style.setProperty('--at', String(jump.t / axisEnd));
$('lane').append(peak);

function drawScope(): void {
  // One sample per recorded tick, so the line is the recording and nothing between.
  const times = [...new Set([...good.events, ...bad.events].flatMap((e) => (e.k === 'geometry' ? [e.t] : [])))].sort((a, b) => a - b);
  let d = 'M0 30';
  let was = 0;
  for (const t of times) {
    const off = Math.abs(offsetAt(t));
    const x = ((t / axisEnd) * 1000).toFixed(1);
    // The builds part on one tick, so the line rises straight up there.
    if (off && !was) d += `M${x} 30`;
    if (off || was) d += `L${x} ${(30 - (off / jump.px) * 24).toFixed(1)}`;
    was = off;
  }
  set(scopeTrace, { d });
  set(scopeBase, { x2: (cells.at(-1)!.t / axisEnd) * 1000 });
  scopeTicks.forEach((tick, i) => tick.classList.toggle('dropped', !session.kept.includes(i)));
}

/* Steps, and every attempt of the reduction */
const matrix = $('matrix');
const attemptRange = $<HTMLInputElement>('attempt');
const attemptsSvg = $<SVGSVGElement>('attempts');
const stepButtons = steps.map((step, i) => {
  const row = el('li');
  const button = el('button', i === jump.step ? 'step is-jump' : 'step');
  button.type = 'button';
  button.append(el('i', '', String(i + 1)), el('span', '', step.label));
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    poster = false;
    seek(step.at, true);
  });
  row.append(button);
  $('steps').append(row);
  return button;
});
attemptRange.max = String(attempts.length);
attemptRange.value = attemptRange.max;
let shownAttempt = attempts.length;
let reducing = 0;
let lifelines: SVGElement[] = [];
let columns: SVGElement[] = [];
let cursor: SVGElement | null = null;
let colPitch = 8;

function buildMatrix(): void {
  const box = attemptsSvg.getBoundingClientRect();
  if (!box.width || !box.height) return;
  attemptsSvg.replaceChildren();
  set(attemptsSvg, { viewBox: `0 0 ${box.width} ${box.height}` });
  const row = box.height / steps.length;
  colPitch = box.width / (attempts.length + 1);
  const cell = { w: Math.max(3, Math.min(7, colPitch - 2.5)), h: Math.max(6, Math.min(12, row - 8)) };
  const x = (c: number) => (c + 0.5) * colPitch;
  cursor = shape('rect', 'a-cursor', attemptsSvg);
  set(cursor, { y: 0, width: colPitch, height: box.height, rx: 3 });
  // A line for each step, for as long as the reducer still had it in play.
  lifelines = steps.map((_, r) => {
    const end = diedAt(attempts, r);
    const line = shape('line', end === null ? 'a-life kept' : 'a-life', attemptsSvg) as SVGElement;
    set(line, { x1: 0, y1: (r + 0.5) * row, x2: 0, y2: (r + 0.5) * row });
    line.dataset.end = String(end ?? attempts.length + 1);
    if (end === null) set(shape('circle', 'a-end', attemptsSvg), { cx: box.width - 3.5, cy: (r + 0.5) * row, r: 3.5 });
    return line;
  });
  columns = attempts.map((attempt, c) => {
    const column = shape('g', `a-column a-${attempt.outcome}`, attemptsSvg) as SVGElement;
    for (const r of attempt.kept) set(shape('rect', 'a-cell', column), { x: x(c) - cell.w / 2, y: (r + 0.5) * row - cell.h / 2, width: cell.w, height: cell.h, rx: 1.5 });
    return column;
  });
  showAttempt(shownAttempt);
}

function showAttempt(n: number): void {
  shownAttempt = n;
  const alive = new Set(aliveAfter(attempts, steps.length, n));
  columns.forEach((column, c) => column.classList.toggle('on', c < n));
  const width = attemptsSvg.viewBox.baseVal.width;
  lifelines.forEach((line) => {
    // A line is drawn up to the attempt on screen, and stops where its step was dropped.
    const end = Number(line.dataset.end);
    const survives = end > attempts.length;
    set(line, { x2: survives && n === attempts.length ? width - 3.5 : Math.min(end, n) * colPitch });
  });
  attemptsSvg.classList.toggle('done', n === attempts.length);
  if (cursor) {
    show(cursor, n > 0 && n < attempts.length);
    set(cursor, { x: (n - 1) * colPitch });
  }
  stepButtons.forEach((button, i) => button.classList.toggle('gone', !alive.has(i)));
  $('attempt-note').textContent = attemptNote(attempts, steps.length, n);
  $('axis-count').textContent = n === attempts.length ? `${attempts.length} attempts` : `Attempt ${n} of ${attempts.length}`;
  attemptRange.value = String(n);
  attemptRange.setAttribute('aria-valuetext', `${n === 0 ? 'Before the first attempt' : `Attempt ${n} of ${attempts.length}`}, ${alive.size} steps left`);
  matrix.style.setProperty('--attempt', String(n / attempts.length));
}

/** Plays the attempts in order. Any touch of the scrubber takes over. */
function playReduction(): void {
  cancelAnimationFrame(reducing);
  if (calm()) return showAttempt(attempts.length);
  const start = performance.now();
  showAttempt(0);
  const step = (now: number) => {
    // A slow start, so the first halvings can be read as they happen.
    const elapsed = (now - start - 350) / 1000;
    const n = clamp(Math.floor(elapsed < 1.6 ? elapsed * 5 : 8 + (elapsed - 1.6) * 9), 0, attempts.length);
    if (n !== shownAttempt) showAttempt(n);
    if (n < attempts.length) reducing = requestAnimationFrame(step);
  };
  reducing = requestAnimationFrame(step);
}

/* The verdict lines all share one grid cell, so the stage never changes height */
const lines = new Map<string, HTMLElement>();
for (const s of data.sessions) {
  for (const phase of ['before', 'jump', 'after'] as const) {
    const line = el('p', phase === 'jump' ? 'bad' : '', s.verdict[phase]);
    lines.set(`${s.id}.${phase}`, line);
    $('verdict').append(line);
  }
}

/* Drawing */
function schedule(): void {
  if (!raf) raf = requestAnimationFrame(tick);
}

function setLabel(which: 'replay' | 'play' | 'pause'): void {
  for (const node of playButton.querySelectorAll<HTMLElement>('span')) node.classList.toggle('on', node.dataset.label === which);
}
const idleLabel = () => setLabel(poster || index >= cells.length - 1 ? 'replay' : 'play');

const SOURCE: Record<View, string> = {
  overlay: 'Recorded screenshots',
  swipe: 'Recorded screenshots',
  difference: 'Recorded screenshots',
  geometry: 'Recorded geometry',
};

let spoken = '';
function render(): void {
  const cell = cells[index]!;
  const t = cell.t;
  const phase = phaseAt(t);
  const key = `${session.id}.${phase}`;
  if (spoken !== key) {
    for (const [k, line] of lines) line.classList.toggle('on', k === key);
    spoken = key;
  }
  const off = Math.round(Math.abs(offsetAt(t)));
  const readout = view === 'geometry' ? 'Rectangles from the report, with the path each panel took'
    : view === 'difference' ? (cell.differs ? 'Lit where the two frames differ' : 'No pixel differs in this frame')
    : view === 'overlay' ? (cell.differs ? 'Both builds, one over the other' : 'The two frames are the same')
    : '';
  $('readout').textContent = readout;
  $('source').textContent = SOURCE[view];
  screen.setAttribute('aria-label', `${t} ms, step ${cell.step + 1} of ${steps.length}, ${steps[cell.step]!.label}. ${off ? `The broken build is ${off} px to the right of the last good build.` : session.verdict[phase]}`);
  range.value = String(t);
  range.setAttribute('aria-valuetext', `${t} ms, step ${cell.step + 1}: ${steps[cell.step]!.label}, frame ${index + 1} of ${cells.length}`);
  set(scopeDone, { x1: 0, y1: 30, x2: (t / axisEnd) * 1000, y2: 30 });
  $('clock').textContent = `${t} ms`;
  stepButtons.forEach((button, i) => (i === cell.step ? button.setAttribute('aria-current', 'true') : button.removeAttribute('aria-current')));
  jumpButton.setAttribute('aria-disabled', String(t === jump.t));
  reel.querySelector('.cell.current')?.classList.remove('current');
  reel.children[index]?.classList.add('current');
  stage.classList.toggle('in-jump', phase === 'jump');
}

function setIndex(next: number): void {
  next = clamp(next, 0, cells.length - 1);
  if (next === index) return;
  const from = index < 0 ? 'jump' : phaseAt(time());
  index = next;
  // Walking into the failure draws the ruler. Moving about inside it does not redraw it.
  if (phaseAt(time()) === 'jump' && from === 'before' && !calm()) {
    grow = 0;
    growFrom = performance.now() + 60;
  } else if (!growFrom) grow = 1;
  dirty = true;
  render();
  if (!playing) idleLabel();
  saveUrl();
}

/** How long a frame stays up during playback, in seconds. */
function dwell(i: number): number {
  if (i >= jumpIndex && i < settledIndex) return 0.2;
  return 1 / 24 + (cells[i]?.first ? 0.16 : 0);
}

function tick(now: number): void {
  raf = 0;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  let moving = false;

  if (idle && onScreen && !dragging) {
    moving = true;
    if (idleWait > 0) idleWait -= dt;
    else if (target !== null) {
      // Rolling back to the start of the failure.
      const a = -90 * (pos - target) - 19 * velocity;
      velocity += a * dt;
      pos += velocity * dt;
      if (Math.abs(pos - target) < 0.01 && Math.abs(velocity) < 0.1) {
        pos = target;
        velocity = 0;
        target = null;
        idleWait = 2.4;
        grow = 0;
        growFrom = now + 200;
      }
      setIndex(Math.round(pos));
    } else if (index >= settledIndex) {
      target = jumpIndex;
    } else {
      const next = cells[index + 1]!;
      if (loaded.has(next.good) && loaded.has(next.bad)) pos = Math.min(pos + dt / 0.3, settledIndex);
      setIndex(Math.round(settle(pos)));
      if (pos >= settledIndex) idleWait = 2;
    }
  } else if (playing && !holding && !calm()) {
    const next = cells[Math.min(index + 1, cells.length - 1)]!;
    // A frame still on its way holds the film, so the picture never falls behind the clock.
    if (loaded.has(next.good) && loaded.has(next.bad)) {
      const before = index;
      pos = Math.min(pos + dt / dwell(index), cells.length - 1);
      const reached = Math.round(settle(pos));
      if (before < jumpIndex && reached >= jumpIndex) {
        pos = jumpIndex;
        holding = true;
        setIndex(jumpIndex);
        status.textContent = session.verdict.jump;
        hold = window.setTimeout(() => {
          holding = false;
          last = performance.now();
          schedule();
        }, 1100);
      } else {
        setIndex(reached);
        if (pos >= cells.length - 1) finish();
      }
      want(cells.slice(index, index + 8).flatMap((c) => [c.good, c.bad]));
    } else {
      want([next.good, next.bad]);
    }
    moving = playing;
  } else if (!playing && !dragging) {
    if (target !== null) {
      // A spring to the frame asked for. It starts from whatever speed the film already has.
      const a = -210 * (pos - target) - 29 * velocity;
      velocity += a * dt;
      pos += velocity * dt;
      if (Math.abs(pos - target) < 0.004 && Math.abs(velocity) < 0.05) {
        pos = target;
        velocity = 0;
        target = null;
      } else moving = true;
    } else if (velocity) {
      velocity *= Math.exp(-4.2 * dt);
      pos += velocity * dt;
      if (pos < 0 || pos > cells.length - 1 || Math.abs(velocity) < 3) target = clamp(Math.round(pos + velocity * 0.06), 0, cells.length - 1);
      moving = true;
    }
    setIndex(Math.round(pos));
  }

  if (growFrom) {
    const p = clamp((now - growFrom) / 520, 0, 1);
    grow = 1 - (1 - p) ** 3;
    dirty = true;
    if (p >= 1) growFrom = 0;
    else moving = true;
  }

  placeReel();
  if (dirty) {
    dirty = false;
    paint();
    drawMarks();
  }
  if (moving || playing && !holding) schedule();
}

/* Transport */
function stop(): void {
  idle = false;
  playing = false;
  holding = false;
  clearTimeout(hold);
  clearTimeout(cut);
}

function pause(): void {
  stop();
  target = index;
  idleLabel();
  saveUrl();
  schedule();
}

function finish(): void {
  stop();
  pos = cells.length - 1;
  velocity = 0;
  target = null;
  setIndex(cells.length - 1);
  idleLabel();
  saveUrl();
  status.textContent = 'Replay finished';
}

/** With reduced motion the replay cuts between the steps, and ends on the jump. */
function playCuts(): void {
  const stops = [...session.kept.map((i) => steps[i]!.at).filter((t) => t < jump.t), jump.t];
  let i = 0;
  const next = () => {
    place(lastAt(cells, stops[i]!));
    i += 1;
    if (i < stops.length) cut = window.setTimeout(next, 1000);
    else {
      playing = false;
      poster = true;
      idleLabel();
      status.textContent = session.verdict.jump;
    }
  };
  next();
}

function play(): void {
  idle = false;
  if (poster || index >= cells.length - 1) place(0);
  poster = false;
  playing = true;
  target = null;
  velocity = 0;
  pos = index;
  setLabel('pause');
  if (calm()) return playCuts();
  last = performance.now();
  schedule();
}

/** Puts a frame under the needle at once. */
function place(i: number): void {
  pos = clamp(i, 0, cells.length - 1);
  velocity = 0;
  target = null;
  setIndex(pos);
  const cell = cells[index]!;
  want([cell.good, cell.bad]);
  dirty = true;
  last = performance.now();
  schedule();
}

/** Moves to the frame showing at `t`. With `glide` the film rolls there instead of cutting. */
function seek(t: number, glide = false): void {
  stop();
  const to = clamp(lastAt(cells, t), 0, cells.length - 1);
  if (glide && !calm()) {
    // A long way off, the film cuts most of the distance and rolls the rest.
    if (Math.abs(to - pos) > 9) pos = to - Math.sign(to - pos) * 9;
    target = to;
    const cell = cells[to]!;
    want([cell.good, cell.bad]);
    last = performance.now();
    schedule();
  } else place(to);
  idleLabel();
}

const stepBy = (n: number) => {
  poster = false;
  seek(cells[clamp((target ?? index) + n, 0, cells.length - 1)]!.t, true);
};
function stepTo(direction: 1 | -1): void {
  const here = target ?? index;
  const stops = session.kept.map((i) => lastAt(cells, steps[i]!.at));
  const to = direction > 0 ? stops.find((i) => i > here) ?? cells.length - 1 : stops.findLast((i) => i < here) ?? 0;
  poster = false;
  seek(cells[to]!.t, true);
}
function toJump(): void {
  seek(jump.t, true);
  poster = true;
  idleLabel();
}

/* Sessions and views */
function setSession(next: Session, at = time()): void {
  session = next;
  good = data.runs[next.good]!;
  bad = data.runs[next.bad]!;
  goodLine = timelines(good.events);
  badLine = timelines(bad.events);
  // A cell wherever the picture changed, and one where each step begins even if it changed nothing.
  const times = [...new Set([...[...good.frames, ...bad.frames].map((f) => f.t), ...next.kept.map((i) => steps[i]!.at)])].sort((a, b) => a - b);
  const stepAt = (t: number) => next.kept.findLast((i) => steps[i]!.at <= t) ?? next.kept[0]!;
  cells = times.map((t, i) => {
    const g = good.frames[Math.max(0, lastAt(good.frames, t))]!.f;
    const b = bad.frames[Math.max(0, lastAt(bad.frames, t))]!.f;
    const step = stepAt(t);
    return { t, good: g, bad: b, step, first: i === 0 || stepAt(times[i - 1]!) !== step, differs: g !== b };
  });
  jumpIndex = lastAt(cells, jump.t);
  settledIndex = lastAt(cells, jump.settled);
  for (const button of $('sessions').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.session === next.id));
  steps.forEach((_, i) => stepButtons[i]!.setAttribute('aria-disabled', String(!next.kept.includes(i))));
  stage.dataset.session = next.id;
  buildReel();
  drawScope();
  index = -1;
  spoken = '';
  drawn = '';
  pos = clamp(lastAt(cells, at), 0, cells.length - 1);
  velocity = 0;
  target = null;
  setIndex(pos);
  want(cells.slice(Math.max(0, index - 6), index + 8).flatMap((c) => [c.good, c.bad]));
  wantLater(cells.flatMap((c) => [c.bad, c.good]));
  if (!playing) idleLabel();
  schedule();
}

function setView(next: View): void {
  view = next;
  stage.dataset.view = next;
  for (const button of $('views').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === next));
  divider.tabIndex = next === 'swipe' ? 0 : -1;
  drawn = '';
  dirty = true;
  if (index >= 0) render();
  saveUrl();
  schedule();
}

function setSplit(next: number): void {
  split = clamp(next, 0.04, 0.96);
  viewer.style.setProperty('--split', String(split));
  divider.setAttribute('aria-valuenow', String(Math.round(split * 100)));
  divider.setAttribute('aria-valuetext', `${Math.round(split * 100)} percent last good build`);
  dirty = true;
  schedule();
}

/* A link that opens on the same frame, view and session */
let urlTimer = 0;
let urlReady = false;
function saveUrl(): void {
  if (!urlReady || idle || playing) return;
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const q = new URLSearchParams();
    if (time() !== jump.t) q.set('t', String(time()));
    if (view !== 'overlay') q.set('view', view);
    if (session.id !== 'original') q.set('steps', String(session.kept.length));
    const text = q.toString();
    try {
      history.replaceState(null, '', `${location.pathname}${text ? `?${text}` : ''}${location.hash}`);
    } catch { /* A file opened from disk may refuse, and the page works without it. */ }
  }, 200);
}

/* Copying */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* Nothing else to try. */ }
    area.remove();
    return ok;
  }
}

function copyButton(button: HTMLElement, text: () => string, said: string): void {
  let timer = 0;
  button.addEventListener('click', async () => {
    const ok = await copyText(text());
    for (const node of button.querySelectorAll<HTMLElement>('span[data-label]')) node.classList.toggle('on', node.dataset.label === (ok ? 'done' : 'failed'));
    status.textContent = ok ? said : 'Copying did not work in this browser';
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      for (const node of button.querySelectorAll<HTMLElement>('span[data-label]')) node.classList.toggle('on', node.dataset.label === 'idle');
    }, 1800);
  });
}

/* Wiring */
for (const button of $('sessions').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    const next = data.sessions.find((s) => s.id === button.dataset.session)!;
    if (next === session) return;
    const wasPlaying = playing;
    if (wasPlaying) stop();
    setSession(next);
    saveUrl();
    status.textContent = `${next.count}. ${next.verdict[phaseAt(time())]}`;
  });
}
for (const button of $('views').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    setView(button.dataset.view as View);
    status.textContent = `${button.textContent}. ${$('readout').textContent}`;
  });
}
playButton.addEventListener('click', () => (playing ? pause() : play()));
jumpButton.addEventListener('click', () => {
  if (jumpButton.getAttribute('aria-disabled') !== 'true') toJump();
});
range.max = String(axisEnd);
range.addEventListener('input', () => {
  poster = false;
  seek(Number(range.value));
});
range.addEventListener('keydown', (e) => {
  // The native steps are in ms and most of them land between frames, so the keys move by frame.
  const move: Record<string, () => void> = {
    ArrowRight: () => stepBy(1), ArrowUp: () => stepBy(1), ArrowLeft: () => stepBy(-1), ArrowDown: () => stepBy(-1),
    PageUp: () => stepTo(1), PageDown: () => stepTo(-1), Home: () => seek(0, true), End: () => seek(cells.at(-1)!.t, true),
  };
  const action = move[e.key];
  if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Home' || e.key === 'End') poster = false;
  action();
});
stage.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const on = e.target as HTMLElement;
  const slider = on === divider || on === attemptRange;
  const press = on.tagName === 'BUTTON' || on.tagName === 'A';
  if (e.key === 'Escape' && playing) pause();
  else if (e.key === '[') stepTo(-1);
  else if (e.key === ']') stepTo(1);
  else if (e.key === 'f' || e.key === 'F') toJump();
  else if (e.key === ' ' && !press) (playing ? pause() : play());
  else if (e.key === 'ArrowLeft' && !slider) stepBy(-1);
  else if (e.key === 'ArrowRight' && !slider) stepBy(1);
  else return;
  e.preventDefault();
});

/* Dragging the film, with the speed of the hand carried into the release */
{
  let startX = 0;
  let startPos = 0;
  let moved = 0;
  let trail: { x: number; t: number }[] = [];
  film.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    stop();
    idleLabel();
    poster = false;
    dragging = true;
    startX = e.clientX;
    startPos = pos;
    moved = 0;
    velocity = 0;
    target = null;
    trail = [{ x: e.clientX, t: e.timeStamp }];
    film.setPointerCapture(e.pointerId);
    film.classList.add('is-dragging');
  });
  film.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    let next = startPos - dx / pitch;
    // Past either end the film gives a little and no more.
    const end = cells.length - 1;
    if (next < 0) next = -Math.sqrt(-next) * 0.35;
    if (next > end) next = end + Math.sqrt(next - end) * 0.35;
    pos = next;
    trail.push({ x: e.clientX, t: e.timeStamp });
    while (trail.length > 2 && e.timeStamp - trail[0]!.t > 90) trail.shift();
    setIndex(Math.round(pos));
    const cell = cells[index]!;
    want([cell.good, cell.bad]);
    schedule();
  });
  const release = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    film.classList.remove('is-dragging');
    if (moved < 4) {
      // A press without a drag goes to the frame under the pointer.
      const box = film.getBoundingClientRect();
      target = clamp(Math.round(pos + (e.clientX - (box.left + box.width / 2)) / pitch), 0, cells.length - 1);
    } else {
      const first = trail[0]!;
      const span = e.timeStamp - first.t;
      // A hand that stopped before letting go leaves the film where it is.
      const moving = e.timeStamp - trail.at(-1)!.t < 70;
      velocity = moving && span > 8 && e.type === 'pointerup' && !calm() ? -((e.clientX - first.x) / span) * 1000 / pitch : 0;
      if (Math.abs(velocity) < 3) {
        velocity = 0;
        target = clamp(Math.round(pos), 0, cells.length - 1);
      }
    }
    if (calm() && target !== null) return place(target);
    last = performance.now();
    schedule();
  };
  film.addEventListener('pointerup', release);
  film.addEventListener('pointercancel', release);
  let wheelEnd = 0;
  film.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!dx) return;
    e.preventDefault();
    stop();
    idleLabel();
    poster = false;
    velocity = 0;
    target = null;
    pos = clamp(pos + dx / pitch, 0, cells.length - 1);
    setIndex(Math.round(pos));
    placeReel();
    clearTimeout(wheelEnd);
    wheelEnd = window.setTimeout(() => {
      target = index;
      last = performance.now();
      schedule();
    }, 140);
    schedule();
  }, { passive: false });
}

/* The swipe divider */
{
  let grabbed = false;
  const at = (e: PointerEvent) => {
    const box = viewer.getBoundingClientRect();
    setSplit((e.clientX - box.left) / box.width);
  };
  divider.addEventListener('pointerdown', (e) => {
    grabbed = true;
    divider.setPointerCapture(e.pointerId);
    at(e);
  });
  divider.addEventListener('pointermove', (e) => grabbed && at(e));
  for (const type of ['pointerup', 'pointercancel'] as const) divider.addEventListener(type, () => (grabbed = false));
  divider.addEventListener('keydown', (e) => {
    const by = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') setSplit(split - by);
    else if (e.key === 'ArrowRight') setSplit(split + by);
    else if (e.key === 'Home') setSplit(0);
    else if (e.key === 'End') setSplit(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

/* The reduction scrubber */
attemptRange.addEventListener('input', () => {
  cancelAnimationFrame(reducing);
  showAttempt(Number(attemptRange.value));
});
$('reduce-play').addEventListener('click', () => {
  playReduction();
  status.textContent = `Replaying ${attempts.length} attempts`;
});
copyButton($('copy'), () => data.scenario, 'The four steps are on the clipboard as a Trace scenario');
for (const button of document.querySelectorAll<HTMLElement>('[data-copy]')) copyButton(button, () => $(button.dataset.copy!).textContent ?? '', 'Copied');

/* Start */
const query = new URLSearchParams(location.search);
const startView = VIEWS.find((v) => v === query.get('view')) ?? 'overlay';
const startSession = query.get('steps') === String(data.sessions[1]!.kept.length) ? data.sessions[1]! : data.sessions[0]!;
const startTime = query.has('t') ? clamp(Number(query.get('t')) || 0, 0, axisEnd) : jump.t;
poster = startTime === jump.t;

new ResizeObserver(() => {
  layout();
  schedule();
}).observe(viewer);
new ResizeObserver(() => {
  measureFilm();
  schedule();
}).observe(film);
new ResizeObserver(buildMatrix).observe(attemptsSvg);
layout();
measureFilm();
setSplit(split);
view = startView;
setSession(startSession, startTime);
setView(startView);
buildMatrix();
status.textContent = '';
urlReady = true;

// Left alone on the opening frame, the stage replays the quarter second that went wrong.
if (!calm() && poster && !location.search) {
  idle = true;
  idleWait = 2.6;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      last = performance.now();
      if (onScreen) schedule();
    }).observe(viewer);
  }
  schedule();
}

// The reduction plays once, the first time it is on screen.
if (!calm() && 'IntersectionObserver' in window) {
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    seen.disconnect();
    playReduction();
  }, { threshold: 0.6 });
  seen.observe(matrix);
}
