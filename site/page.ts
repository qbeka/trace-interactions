import { cellsOf, type Cell, type Data, type Phase, type Rect, type Run, type Session } from './cells.ts';
import { focusAt, lastAt, rectAt, timelines, viewportAt, type Timelines } from '../viewer/src/model.ts';
import { initFigures } from './figures.ts';
import { coreNote, frameLabel, OUTCOMES, readout, SAID, SOURCE, VIEWS, type View } from './lines.ts';
import { aliveAfter, attemptNote, diedAt } from './reduction.ts';
import type { ScanRequest, ScanResult } from './scan.ts';

/**
 * The public project page. Each build is shown as the frame on the clock, with a
 * slit scan of every recorded frame under it, and one needle runs through both.
 * A second act replays every attempt of the reduction. All numbers and sentences
 * arrive in the data block, written from the saved runs.
 */
type Act = 'jump' | 'search';
type Side = 'good' | 'bad';

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

const stage = $('stage');
const bench = $('bench');
const panes: Record<Side, HTMLElement> = { good: $('pane-good'), bad: $('pane-bad') };
const shots: Record<Side, HTMLCanvasElement> = { good: $<HTMLCanvasElement>('shot-good'), bad: $<HTMLCanvasElement>('shot-bad') };
const cores: Record<Side, HTMLElement> = { good: $('core-good'), bad: $('core-bad') };
const scans: Record<Side, HTMLCanvasElement> = { good: $<HTMLCanvasElement>('scan-good'), bad: $<HTMLCanvasElement>('scan-bad') };
const scanline = $('scanline');
const needle = $('needle');
const range = $<HTMLInputElement>('time');
const playButton = $('play');
const jumpButton = $('jump');
const wholeButton = $('whole');
const status = $('status');
const { steps, jump, attempts, frame, axisEnd } = data;

/* Screenshots. They load behind the first paint, nearest the playhead first. */
const images = new Map<string, HTMLImageElement>();
const loaded = new Set<string>();
const failed = new Set<string>();
const watchers: ((name: string) => void)[] = [];
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
    }, () => {
      // Forgotten, so the next time the frame is wanted it is asked for again.
      images.delete(name);
      failed.add(name);
      arrived(name);
    }).finally(() => {
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
let view: View = 'shots';
let act: Act = 'jump';
let whole = false;
let scanY = data.scanY;
/** Where the needle sits, in frames. The frame on screen is the nearest one. */
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
const lineOf = (side: Side) => (side === 'good' ? goodLine : badLine);
const offsetAt = (t: number): number => {
  const a = rectAt(goodLine, 'panel', t);
  const b = rectAt(badLine, 'panel', t);
  return a && b ? b.x - a.x : 0;
};

/* The two frames: a canvas of the screenshot, and marks drawn in the same coordinates */
interface Camera { x: number; y: number; w: number; h: number; scale: number }
/** What the two frames show now. It closes in on the start of the failure and opens out again as the panel grows. */
let cam: Camera = { ...data.crop, scale: 1 };
/** Where the camera is heading. */
let camTo: Rect = data.crop;
/** The part of the frame the cores are cut from, which is also what the frames show away from the failure. */
let field: Rect = data.crop;
/** Where the two frames differ, kept as its own layer so the browser blends and scales it off the main thread. */
const glow = $<HTMLCanvasElement>('glow');
const scratch = document.createElement('canvas');
let drawn = '';

interface Marks {
  svg: SVGSVGElement;
  outside: Element; edge: Element; world: Element; view: Element;
  nodes: Map<string, { rect: Element; name: Element }>;
  fan: Element; ghost: Element; panel: Element; focus: Element;
  path: Element; ruler: Element; outlineGood: Element; outlineBad: Element; extend: Element; span: Element; pill: Element; label: Element;
}
function makeMarks(side: Side): Marks {
  const svg = $<SVGSVGElement>(`marks-${side}`);
  // Past the edge of the window there is no page, and the hatching says so.
  const defs = shape('defs', '', svg);
  const hatch = shape('pattern', '', defs);
  set(hatch, { id: `hatch-${side}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  set(shape('line', 'm-hatch', hatch), { x1: 0, y1: 0, x2: 0, y2: 6 });
  const outside = shape('rect', 'm-outside', svg);
  set(outside, { fill: `url(#hatch-${side})` });
  const edge = shape('line', 'm-edge', svg);
  const world = shape('g', 'world', svg);
  const view = shape('rect', 'g-view', world);
  const nodes = new Map(data.targets.map((t) => [t.name, { rect: shape('rect', 'g-node', world), name: shape('text', 'g-name', world) }]));
  for (const t of data.targets) nodes.get(t.name)!.name.textContent = t.label;
  const fan = shape('path', `g-fan ${side}`, world);
  const ghost = shape('rect', 'g-ghost', world);
  const panel = shape('rect', `g-panel ${side}`, world);
  const focus = shape('rect', 'g-focus', world);
  const path = shape('path', `m-path ${side}`, svg);
  const ruler = shape('g', 'ruler', svg);
  const outlineGood = shape('rect', 'm-outline good', ruler);
  const outlineBad = shape('rect', 'm-outline bad', ruler);
  const extend = shape('path', 'm-extend', ruler);
  const span = shape('path', 'm-span', ruler);
  const pill = shape('rect', 'm-pill', ruler);
  const label = shape('text', 'm-label', ruler);
  return { svg, outside, edge, world, view, nodes, fan, ghost, panel, focus, path, ruler, outlineGood, outlineBad, extend, span, pill, label };
}
const marks: Record<Side, Marks> = { good: makeMarks('good'), bad: makeMarks('bad') };

/* Sizes, read once per layout so that nothing else has to measure */
let paneW = 0;
let paneH = 0;
let coreW = 0;
let coreH = 0;
let coreTop = 0;
let rowH = 4;
let wide = false;

function layout(): void {
  const box = panes.bad.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const core = cores.bad.getBoundingClientRect();
  const outer = bench.getBoundingClientRect();
  paneW = box.width;
  paneH = box.height;
  coreW = core.width;
  coreH = core.height;
  coreTop = core.top - outer.top;
  // The needle is drawn over each core and leaves the names between them clear.
  const first = cores.good.getBoundingClientRect();
  for (const [name, at] of [['--n0', first.left], ['--n1', first.right], ['--n2', core.left], ['--n3', core.right]] as const) bench.style.setProperty(name, `${(at - outer.left).toFixed(1)}px`);
  wide = $('spine').getBoundingClientRect().width > 0;
  if (whole) {
    const h = paneH / (paneW / frame.width);
    field = { x: 0, y: -(h - frame.height) / 2, w: frame.width, h };
  } else field = data.crop;
  // A canvas is as large as its frame on the screen, and the screenshot is scaled into it.
  const ratio = Math.min(2, devicePixelRatio || 1);
  for (const canvas of [shots.good, shots.bad, glow, scratch]) {
    canvas.width = Math.round(paneW * ratio);
    canvas.height = Math.round(paneH * ratio);
  }
  rowH = coreH / Math.max(1, cells.length);
  aim(true);
  placeSteps();
  drawCoreMarks();
  scanDirty = true;
  if (index >= 0) render();
}

const boundsOf = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

/**
 * The close view of the failure: Inspect, and every rectangle the panel has recorded
 * on either build since it reopened, with room under them for the ruler. It grows
 * with the panel, and gives way to the usual view once the panel no longer fits.
 */
function closeAt(t: number): Rect | null {
  if (whole || !paneW || t < jump.t || t >= jump.settled) return null;
  const rects: Rect[] = [];
  const button = rectAt(goodLine, 'trigger', jump.t);
  if (button) rects.push(button);
  for (const line of [goodLine, badLine]) {
    for (const g of line.rects.get('panel') ?? []) if (g.rect && g.t >= jump.t && g.t <= t) rects.push(g.rect);
  }
  if (rects.length < 2) return null;
  const box = boundsOf(rects);
  const aspect = paneW / paneH;
  // The rectangles, and under them the ruler and its label.
  const content = { top: Math.max(0, box.y - 20), bottom: box.y + box.h + 46 };
  let w = box.w + 2 * Math.max(40, box.w * 0.15);
  let h = content.bottom - content.top;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  if (w > field.w || h > field.h) return null;
  const x = clamp(box.x + box.w / 2 - w / 2, field.x, field.x + field.w - w);
  // Centred on what it shows, and never more than a little above the top of the page.
  const y = clamp((content.top + content.bottom) / 2 - h / 2, field.y - h * 0.14, field.y + field.h - h);
  return { x, y, w, h };
}

/** Points the camera at what the frame on show calls for, at once if asked or if motion is reduced. */
function aim(snap = false): void {
  camTo = closeAt(time()) ?? field;
  if (!paneW) return;
  if (snap || calm()) {
    cam = { ...camTo, scale: paneW / camTo.w };
    applyCam();
  } else schedule();
}

function applyCam(): void {
  const unit = 1 / cam.scale;
  for (const m of Object.values(marks)) {
    set(m.svg, { viewBox: `${cam.x.toFixed(2)} ${cam.y.toFixed(2)} ${cam.w.toFixed(2)} ${cam.h.toFixed(2)}` });
    set(m.label, { 'font-size': 14 * unit });
    for (const n of m.nodes.values()) set(n.name, { 'font-size': 11 * unit });
  }
  drawn = '';
  dirty = true;
  placeScan();
}

/** Moves the camera a part of the way to where it is heading. Returns whether it is still moving. */
function easeCam(dt: number): boolean {
  const keys = ['x', 'y', 'w', 'h'] as const;
  const far = keys.some((k) => Math.abs(cam[k] - camTo[k]) > 0.05);
  if (!far) return false;
  const p = 1 - Math.exp(-dt * 12);
  const next = { ...cam };
  for (const k of keys) next[k] = Math.abs(cam[k] - camTo[k]) < 0.5 ? camTo[k] : cam[k] + (camTo[k] - cam[k]) * p;
  cam = { ...next, scale: paneW / next.w };
  applyCam();
  return true;
}

function blit(to: CanvasRenderingContext2D, name: string): void {
  const s = frame.scale;
  const k = to.canvas.width / cam.w;
  // Only the part of the camera that the frame covers is drawn, at the place it belongs.
  const left = Math.max(0, cam.x);
  const right = Math.min(frame.width, cam.x + cam.w);
  const top = Math.max(0, cam.y);
  const bottom = Math.min(frame.height, cam.y + cam.h);
  to.imageSmoothingQuality = 'high';
  to.drawImage(images.get(name)!, left * s, top * s, (right - left) * s, (bottom - top) * s, (left - cam.x) * k, (top - cam.y) * k, (right - left) * k, (bottom - top) * k);
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

const ctxGood = shots.good.getContext('2d')!;
const ctxBad = shots.bad.getContext('2d')!;

function paint(): void {
  const cell = cells[index];
  if (!cell) return;
  const key = `${view}|${cell.good}|${cell.bad}|${cam.x.toFixed(1)}|${cam.y.toFixed(1)}|${cam.w.toFixed(1)}`;
  if (key === drawn) return;
  const { width: W, height: H } = shots.bad;
  if (view === 'geometry') {
    ctxGood.clearRect(0, 0, W, H);
    ctxBad.clearRect(0, 0, W, H);
    drawn = key;
    return;
  }
  // A frame still on its way leaves the last one up, so nothing flashes empty.
  if (!loaded.has(cell.good) || !loaded.has(cell.bad)) {
    const lost = failed.has(cell.good) || failed.has(cell.bad);
    panes.bad.classList.toggle('is-failed', lost);
    waiting(!lost);
    // A frame that failed is tried again when the needle next comes to it, not in a loop.
    if (!lost) want([cell.good, cell.bad]);
    return;
  }
  panes.bad.classList.remove('is-failed');
  waiting(false);
  ctxGood.clearRect(0, 0, W, H);
  blit(ctxGood, cell.good);
  ctxBad.clearRect(0, 0, W, H);
  if (view === 'shots') {
    blit(ctxBad, cell.bad);
  } else {
    // Difference: black where the two frames agree, lit where they do not. The last
    // good build sits underneath, dimmed by the stylesheet, to show where things are.
    blit(ctxBad, cell.good);
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
    panes.bad.classList.remove('is-waiting');
  } else if (!waitTimer) {
    waitTimer = window.setTimeout(() => panes.bad.classList.add('is-waiting'), 180);
  }
}

const rectPath = (r: Rect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`;
/**
 * The rectangles a panel recorded from the reopen until the two builds agree again:
 * all of them for Geometry, and only the first and the last over a screenshot.
 */
function opening(line: Timelines, all: boolean): string {
  const rects = (line.rects.get('panel') ?? []).flatMap((g) => (g.rect && g.t >= jump.t && g.t <= jump.settled ? [g.rect] : []));
  return (all ? rects : [rects[0], rects.at(-1)]).flatMap((r) => (r ? [rectPath(r)] : [])).join('');
}
const setPaths = () => {
  for (const side of ['good', 'bad'] as const) set(marks[side].path, { d: opening(lineOf(side), view === 'geometry') });
};
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
  const a = rectAt(goodLine, 'panel', t);
  const b = rectAt(badLine, 'panel', t);
  const gap = a && b ? b.x - a.x : 0;
  const on = !!a && !!b && Math.abs(gap) >= 0.5;

  for (const side of ['good', 'bad'] as const) {
    const m = marks[side];
    const line = lineOf(side);
    show(m.edge, narrow && !geometry);
    show(m.outside, narrow);
    if (narrow) {
      set(m.edge, { x1: vp.width, y1: 0, x2: vp.width, y2: frame.height });
      set(m.outside, { x: vp.width, y: 0, width: frame.width - vp.width, height: frame.height });
    }
    // Through the jump, where the panel started and where it ends, and in Geometry every rectangle between.
    // Close on the start there is no room for the end, so it waits until the frame has opened out.
    show(m.path, t >= jump.t && t < jump.settled && (geometry || camTo === field));
    show(m.world, geometry);
    if (!geometry) continue;
    set(m.view, { x: 0.5, y: 0.5, width: vp.width - 1, height: frame.height - 0.5 });
    for (const [name, node] of m.nodes) {
      const r = rectAt(line, name, t);
      show(node.rect, !!r);
      show(node.name, !!r && r.w >= 60);
      if (!r) continue;
      set(node.rect, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 });
      set(node.name, { x: r.x + r.w / 2, y: r.y + r.h / 2 + 4 * unit });
    }
    const own = side === 'good' ? a : b;
    show(m.panel, !!own);
    if (own) set(m.panel, { x: own.x, y: own.y, width: own.w, height: own.h, rx: 6 });
    // The broken build's drawing also shows where the last good build has its panel.
    show(m.ghost, side === 'bad' && on);
    if (side === 'bad' && on && a) set(m.ghost, { x: a.x, y: a.y, width: a.w, height: a.h, rx: 6 });
    set(m.fan, { d: side === 'good' || on || t >= jump.t ? fan(line, t) : fan(goodLine, t) });
    const focus = focusAt(line, t);
    const focused = focus && data.targets.find((x) => x.id === focus.traceId);
    const box = focused ? rectAt(line, focused.name, t) : null;
    show(m.focus, !!box);
    if (box) set(m.focus, { x: box.x - 3, y: box.y - 3, width: box.w + 6, height: box.h + 6, rx: 6 });
  }

  // Each frame outlines its own panel through the failure, so the eye finds it at any size.
  show(marks.good.ruler, on);
  if (on && a) {
    set(marks.good.outlineGood, { x: a.x, y: a.y, width: a.w, height: a.h, rx: 5 });
    show(marks.good.outlineGood, !geometry);
    for (const node of [marks.good.outlineBad, marks.good.extend, marks.good.span, marks.good.pill, marks.good.label]) show(node, false);
  }
  // The ruler lives on the broken build, between where the panel is and where it should be.
  const m = marks.bad;
  show(m.ruler, on);
  if (!on || !a || !b) return;
  for (const [node, r] of [[m.outlineGood, a], [m.outlineBad, b]] as const) set(node, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 5 });
  show(m.outlineGood, !geometry);
  show(m.outlineBad, !geometry);
  // A dimension line under the panels, the way a drawing marks a distance.
  const y = Math.min(cam.y + cam.h - 32 * unit, Math.max(a.y + a.h, b.y + b.h) + 14 * unit);
  const from = a.x;
  const to = a.x + gap * grow;
  const foot = Math.min(a.y + a.h, b.y + b.h) + 5 * unit;
  set(m.extend, { d: `M${a.x} ${foot}V${y + 6 * unit}M${b.x} ${foot}V${y + 6 * unit}` });
  let d = `M${from} ${y}H${to}`;
  for (let x = 0; x <= Math.abs(to - from) + 0.01; x += 10) d += `M${from + Math.sign(gap) * x} ${y - (x % 50 === 0 ? 5 : 3) * unit}V${y}`;
  set(m.span, { d });
  const text = `${Math.round(Math.abs(gap))} px`;
  if (m.label.textContent !== text) m.label.textContent = text;
  const pillW = (text.length * 7.9 + 18) * unit;
  const fits = Math.abs(gap) > pillW + 6 * unit;
  // Under the line when it is long enough, and beside it on whichever side still has room when it is not.
  const right = Math.max(a.x, b.x) + 8 * unit + pillW / 2;
  const cx = fits ? (a.x + b.x) / 2 : right + pillW / 2 < cam.x + cam.w - 4 * unit ? right : Math.min(a.x, b.x) - 8 * unit - pillW / 2;
  const cy = fits ? y + 16 * unit : y - 1 * unit;
  set(m.pill, { x: cx - pillW / 2, y: cy - 11 * unit, width: pillW, height: 22 * unit, rx: 11 * unit });
  set(m.label, { x: cx, y: cy + 5 * unit });
  const done = grow > 0.85;
  show(m.pill, done);
  show(m.label, done);
}

/* The scan line */
const scanRange = (): [number, number] => [Math.max(2, Math.ceil(field.y) + 2), Math.min(frame.height - 2, Math.floor(field.y + field.h) - 2)];

function placeScan(): void {
  const [lo, hi] = scanRange();
  const y = clamp(scanY, lo, hi);
  scanline.style.setProperty('--y', `${((y - cam.y) * cam.scale).toFixed(2)}px`);
  // Close on the failure, a line further down the page is out of the picture.
  scanline.classList.toggle('is-out', y < cam.y + 2 || y > cam.y + cam.h - 2);
  set(scanline, { 'aria-valuemin': lo, 'aria-valuemax': hi, 'aria-valuenow': y, 'aria-valuetext': SAID.scan(y) });
  const text = SAID.scanShort(y);
  if ($('scan-y').textContent !== text) $('scan-y').textContent = text;
}

function setScan(y: number): void {
  const [lo, hi] = scanRange();
  const next = clamp(Math.round(y), lo, hi);
  if (next === scanY) return;
  scanY = next;
  placeScan();
  drawCoreMarks();
  scanDirty = true;
  saveUrl();
  schedule();
}

/* The cores. The pictures come from a worker, and the rectangles are drawn here. */
let scanDirty = true;
let scanBusy = false;
let scanId = 0;
let worker: Worker | null = null;
/**
 * Without a worker, as when the page is opened from a file, the rows are copied
 * straight from the frames here, a few each tick. A page opened from a file may
 * draw its own images but not read them back, so nothing here reads a pixel.
 */
let plain = false;
let plainKey = '';
let plainDone: boolean[] = [];

function startScans(): void {
  const fall = () => {
    worker = null;
    scanBusy = false;
    plain = true;
    stage.classList.add('is-plain');
    scanDirty = true;
    schedule();
  };
  try {
    worker = new Worker(new URL('scan.js', location.href));
    worker.onmessage = (e: MessageEvent<{ type: 'frame' } | ({ type: 'scan' } & ScanResult)>) => {
      if (e.data.type === 'scan') showScan(e.data);
      else {
        scanDirty = true;
        schedule();
      }
    };
    worker.onerror = fall;
    worker.postMessage({ type: 'setup', scale: frame.scale, step: frame.scale, base: new URL('.', location.href).href });
    worker.postMessage({ type: 'have', names: [...loaded] });
  } catch {
    fall();
  }
}

function drawPlain(): void {
  const width = Math.min(1400, Math.max(64, Math.round(coreW * Math.min(2, devicePixelRatio || 1))));
  const x0 = Math.max(0, field.x);
  const x1 = Math.min(frame.width, field.x + field.w);
  const key = `${session.id}|${scanY}|${x0}|${x1}|${width}|${view}`;
  if (key !== plainKey) {
    plainKey = key;
    plainDone = cells.map(() => false);
    for (const canvas of [scans.good, scans.bad]) {
      canvas.width = width;
      canvas.height = cells.length;
    }
  }
  const s = frame.scale;
  const row = (c: CanvasRenderingContext2D, name: string, r: number) => c.drawImage(images.get(name)!, x0 * s, scanY * s, (x1 - x0) * s, s, 0, r, width, 1);
  const good = scans.good.getContext('2d')!;
  const bad = scans.bad.getContext('2d')!;
  let budget = 6;
  let more = false;
  for (let r = 0; r < cells.length; r++) {
    const cell = cells[r]!;
    // A row whose frame is still on its way is copied when the frame arrives.
    if (plainDone[r] || !loaded.has(cell.good) || !loaded.has(cell.bad)) continue;
    if (!budget) {
      more = true;
      break;
    }
    good.clearRect(0, r, width, 1);
    row(good, cell.good, r);
    bad.globalCompositeOperation = 'source-over';
    bad.clearRect(0, r, width, 1);
    if (view === 'difference') {
      // Both lines on white, one subtracted from the other, so that equal pixels come out black.
      bad.fillStyle = '#fff';
      bad.fillRect(0, r, width, 1);
      row(bad, cell.good, r);
      scratchRow.width = width;
      const t = scratchRow.getContext('2d')!;
      t.fillStyle = '#fff';
      t.fillRect(0, 0, width, 1);
      row(t, cell.bad, 0);
      bad.globalCompositeOperation = 'difference';
      bad.drawImage(scratchRow, 0, r);
      bad.globalCompositeOperation = 'source-over';
    } else row(bad, cell.bad, r);
    plainDone[r] = true;
    budget -= 1;
  }
  stage.dataset.rows = String(plainDone.filter(Boolean).length);
  if (more) {
    scanDirty = true;
    schedule();
  }
}
const scratchRow = document.createElement('canvas');
scratchRow.height = 1;

function requestScan(): void {
  if (view === 'geometry') {
    scanDirty = false;
    drawGeometryCores();
    return;
  }
  if (scanBusy || !coreW || !started) return;
  scanDirty = false;
  if (plain) return drawPlain();
  const width = Math.min(1400, Math.max(64, Math.round(coreW * Math.min(2, devicePixelRatio || 1))));
  const request: ScanRequest = {
    id: ++scanId, good: cells.map((c) => c.good), bad: cells.map((c) => c.bad), y: scanY,
    x0: Math.max(0, field.x), x1: Math.min(frame.width, field.x + field.w), width, mode: view === 'difference' ? 'difference' : 'shots',
  };
  if (!worker) return;
  scanBusy = true;
  worker.postMessage({ type: 'scan', ...request });
}

function showScan(result: ScanResult): void {
  scanBusy = false;
  // A picture for an older line or session is dropped, and the newest one is on its way.
  if (result.id === scanId && view !== 'geometry' && result.rows) {
    for (const side of ['good', 'bad'] as const) {
      const canvas = scans[side];
      if (canvas.width !== result.width || canvas.height !== result.rows) {
        canvas.width = result.width;
        canvas.height = result.rows;
      }
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result[side]), result.width, result.rows), 0, 0);
    }
    stage.dataset.rows = String(result.rows - result.missing);
  }
  if (scanDirty) schedule();
}

/** Geometry: each row shows where the window, Inspect and the panel cross the scan line. */
function drawGeometryCores(): void {
  const W = Math.max(64, Math.round(coreW));
  const x0 = Math.max(0, field.x);
  const k = W / (Math.min(frame.width, field.x + field.w) - x0);
  for (const side of ['good', 'bad'] as const) {
    const canvas = scans[side];
    canvas.width = W;
    canvas.height = cells.length;
    const c = canvas.getContext('2d')!;
    const line = lineOf(side);
    cells.forEach((cell, row) => {
      const vp = viewportAt(goodLine, cell.t, { width: frame.width, height: frame.height });
      c.fillStyle = '#fbf8f4';
      c.fillRect(0, row, (vp.width - x0) * k, 1);
      const band = (name: string, fill: string) => {
        const r = rectAt(line, name, cell.t);
        if (!r || scanY < r.y || scanY > r.y + r.h) return;
        c.fillStyle = fill;
        c.fillRect((r.x - x0) * k, row, r.w * k, 1);
      };
      for (const t of data.targets) band(t.name, '#e9e2d8');
      const differs = side === 'bad' && Math.abs(offsetAt(cell.t)) >= 0.5;
      band('panel', differs ? '#e3b08e' : '#b9c7bd');
    });
  }
  stage.dataset.rows = String(cells.length);
}

const coreMarks = $<SVGSVGElement>('core-marks');
const coreMarksGood = shape('svg', 'core-marks', cores.good) as SVGSVGElement;
/**
 * What is drawn over the two cores, all of it from the recorded rectangles. Wherever
 * the scan line crosses the panel, its band is toned and everything outside it is
 * muted, so the shape the panel makes over time can be read. On the broken build the
 * rows where it is out of place are toned as a failure, the place it should have been
 * is hatched, and one note says how far off it was and for how long.
 */
function drawCoreMarks(): void {
  if (!coreW || !cells.length) return;
  const x0 = Math.max(0, field.x);
  const x1 = Math.min(frame.width, field.x + field.w);
  const x = (px: number) => clamp(((px - x0) / (x1 - x0)) * coreW, 0, coreW);
  const crosses = (r: Rect | null): r is Rect => !!r && scanY >= r.y && scanY <= r.y + r.h;
  const f = (n: number) => n.toFixed(1);
  for (const side of ['good', 'bad'] as const) {
    const svg = side === 'good' ? coreMarksGood : coreMarks;
    svg.replaceChildren();
    set(svg, { viewBox: `0 0 ${coreW} ${coreH}` });
    let veil = `M0 0H${f(coreW)}V${f(coreH)}H0Z`;
    let band = '';
    let off = '';
    let wedge = '';
    let ghost = '';
    let seams = '';
    let drawing = false;
    let first: { x: number; y: number } | null = null;
    cells.forEach((cell, i) => {
      const top = i * rowH;
      // A seam wherever the recording held one frame for longer than a tick.
      if (i && cell.t - cells[i - 1]!.t > 16) seams += `M0 ${top.toFixed(2)}H${f(coreW)}`;
      const own = rectAt(lineOf(side), 'panel', cell.t);
      const other = rectAt(goodLine, 'panel', cell.t);
      const apart = side === 'bad' && !!own && !!other && Math.abs(own.x - other.x) >= 0.5;
      if (!apart || !crosses(other)) drawing = false;
      if (!crosses(own)) return;
      // The band stops at the edge of the window, as the panel does in the screenshot.
      const edge = viewportAt(goodLine, cell.t, { width: frame.width, height: frame.height }).width;
      const l = x(own.x);
      const r = x(Math.min(own.x + own.w, edge));
      if (r - l < 0.5) return;
      const row = `M${f(l)} ${f(top)}H${f(r)}V${f(top + rowH)}H${f(l)}Z`;
      veil += row;
      if (apart) off += row;
      else band += row;
      if (!apart || !crosses(other)) return;
      // Where the last good build has the panel's edge on this row, and the gap between that and where it is.
      const g = x(other.x);
      ghost += `${drawing ? 'L' : 'M'}${f(g)} ${f(top)}V${f(top + rowH)}`;
      drawing = true;
      if (l - g >= 0.5) wedge += `M${f(g)} ${f(top)}H${f(l)}V${f(top + rowH)}H${f(g)}Z`;
      first ??= { x: (g + l) / 2, y: top };
    });
    set(shape('path', 'c-veil', svg), { d: veil, 'fill-rule': 'evenodd' });
    set(shape('path', 'c-band', svg), { d: band });
    set(shape('path', 'c-seam', svg), { d: seams });
    if (side === 'good') {
      // Which way time runs, in two words and an arrow.
      const start = shape('text', 'c-axis', svg);
      set(start, { x: 9, y: 16 });
      start.textContent = SAID.axisStart;
      const end = shape('text', 'c-axis', svg);
      set(end, { x: 9, y: coreH - 8 });
      end.textContent = SAID.axisEnd;
      set(shape('path', 'c-arrow', svg), { d: `M14.5 24V${f(coreH - 26)}m-3.5 -5l3.5 5l3.5 -5` });
      continue;
    }
    const defs = shape('defs', '', svg);
    const hatch = shape('pattern', '', defs);
    set(hatch, { id: 'gap-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    set(shape('line', 'c-hatch', hatch), { x1: 0, y1: 0, x2: 0, y2: 5 });
    set(shape('path', 'c-band off', svg), { d: off });
    set(shape('path', 'c-wedge', svg), { d: wedge });
    set(shape('path', 'c-ghost', svg), { d: ghost });
    // One note for the break: how far off the panel opened, for how long, and on which step.
    const lines = [SAID.breakHow(jump.px), SAID.breakWhen(jump.settled - jump.t, steps[jump.step]!.label)];
    const w = Math.min(coreW - 12, Math.max(...lines.map((line) => line.length)) * 6.1 + 22);
    const h = 40;
    const jumpTop = jumpIndex * rowH;
    const bx = coreW - w - 6;
    const by = clamp(jumpTop - h - 12, 6, coreH - h - 6);
    const aimAt = first ?? { x: coreW * 0.5, y: jumpTop };
    const from = { x: clamp(aimAt.x + 26, bx + 12, bx + w - 12), y: by + h };
    set(shape('path', 'c-lead', svg), { d: `M${f(from.x)} ${f(from.y)}L${f(aimAt.x)} ${f(aimAt.y + Math.min(rowH * 1.5, 6))}` });
    set(shape('circle', 'c-dot', svg), { cx: f(aimAt.x), cy: f(aimAt.y + Math.min(rowH * 1.5, 6)), r: 2.5 });
    set(shape('rect', 'c-call', svg), { x: f(bx), y: f(by), width: f(w), height: h, rx: 7 });
    lines.forEach((line, k) => {
      const text = shape('text', k ? 'c-call-text' : 'c-call-text strong', svg);
      set(text, { x: f(bx + 11), y: f(by + 16 + k * 15) });
      text.textContent = line;
    });
  }
}

/* The spine: a name for each step, tied to the row where it starts */
const stepList = $('steps');
const leaders = $<SVGSVGElement>('leaders');
const stepButtons = steps.map((step, i) => {
  const row = el('li');
  const button = el('button', i === jump.step ? 'step is-jump' : 'step');
  button.type = 'button';
  button.append(el('i', '', String(i + 1)), el('span', '', step.label));
  button.addEventListener('click', () => {
    poster = false;
    seek(step.at, true);
  });
  row.append(button);
  return { row, button, leader: null as Element | null };
});

function placeSteps(): void {
  if (!wide || !coreH) return;
  const spineW = $('spine').getBoundingClientRect().width;
  const kept = session.kept;
  const rows = kept.map((s) => Math.max(0, cells.findIndex((c) => c.step === s && c.first)));
  const truth = rows.map((r) => (r + 0.5) * rowH);
  // Labels keep to their rows where they can, and move apart where steps start close together.
  const gap = Math.min(16, (coreH - 12) / Math.max(1, kept.length - 1));
  const at = truth.map((y) => clamp(y, 8, coreH - 8));
  for (let i = 1; i < at.length; i++) at[i] = Math.max(at[i]!, at[i - 1]! + gap);
  if (at.length && at.at(-1)! > coreH - 8) {
    at[at.length - 1] = coreH - 8;
    for (let i = at.length - 2; i >= 0; i--) at[i] = Math.min(at[i]!, at[i + 1]! - gap);
  }
  // Where the names have to sit closer than a line apart, they are set a little smaller.
  stepList.classList.toggle('is-tight', gap < 14);
  set(leaders, { viewBox: `0 0 ${spineW} ${coreH}` });
  leaders.replaceChildren();
  stepList.replaceChildren(...kept.map((s, i) => {
    const item = stepButtons[s]!;
    item.row.style.setProperty('--at', `${at[i]!.toFixed(2)}px`);
    item.leader = shape('path', s === jump.step ? 'is-jump' : '', leaders);
    const [from, to] = [truth[i]!.toFixed(1), at[i]!.toFixed(1)];
    set(item.leader, { d: `M0 ${from}h3L11 ${to}h3M${spineW} ${from}h-3L${spineW - 11} ${to}h-3` });
    return item.row;
  }));
  nowStep = -1;
}

/**
 * During playback the needle moves a frame at a time: it rests on a whole frame,
 * then slides to the next, so the picture and the needle change together.
 */
function settle(p: number): number {
  const full = Math.floor(p);
  const e = clamp((p - full - 0.5) / 0.5, 0, 1);
  return full + e * e * (3 - 2 * e);
}
const stepped = () => (playing || idle) && !dragging && target === null;

function placeNeedle(): void {
  const at = clamp(stepped() ? settle(pos) : pos, 0, cells.length - 1);
  needle.style.setProperty('--y', `${(coreTop + (at + 0.5) * rowH).toFixed(2)}px`);
}

/* The search: steps down the side, and every attempt of the reduction across */
const attemptRange = $<HTMLInputElement>('attempt');
const attemptsSvg = $<SVGSVGElement>('attempts');
const finalKept = aliveAfter(attempts, steps.length, attempts.length);
const rowItems = steps.map((step, i) => {
  const row = el('li', `${i === jump.step ? 'is-jump' : ''}${finalKept.includes(i) ? ' kept' : ''}`.trim());
  row.append(el('i', '', String(i + 1)), el('span', '', step.label));
  $('rows').append(row);
  return row;
});
for (const i of finalKept) {
  const row = el('li', i === jump.step ? 'is-jump' : '');
  row.append(el('i', '', String(i + 1)), el('span', '', steps[i]!.label));
  $('result-steps').append(row);
}
for (const [outcome, label] of Object.entries(OUTCOMES)) {
  const row = el('li');
  row.append(el('i', `k-${outcome}`), el('b', '', String(attempts.filter((a) => a.outcome === outcome).length)), el('span', '', label));
  $('keys').append(row);
}
attemptRange.max = String(attempts.length);
attemptRange.value = attemptRange.max;
let shownAttempt = attempts.length;
let reducing = 0;
let bands: SVGElement[] = [];
let columns: SVGElement[] = [];
let cursor: SVGElement | null = null;
let colPitch = 8;
let searched = false;

function buildMatrix(): void {
  const box = attemptsSvg.getBoundingClientRect();
  if (!box.width || !box.height) return;
  attemptsSvg.replaceChildren();
  set(attemptsSvg, { viewBox: `0 0 ${box.width} ${box.height}` });
  const row = box.height / steps.length;
  colPitch = box.width / (attempts.length + 1);
  const cell = { w: Math.max(3, Math.min(11, colPitch - 5)), h: Math.max(6, Math.min(16, row - 9)) };
  const x = (c: number) => (c + 0.5) * colPitch;
  set(shape('rect', 'a-ground', attemptsSvg), { x: 0, y: 0, width: box.width, height: box.height, rx: 6 });
  // A band for each step, as long as the reducer still had it in play. Together they are the search closing in.
  bands = steps.map((_, r) => {
    const band = shape('rect', 'a-alive', attemptsSvg) as SVGElement;
    set(band, { x: 0, y: r * row, width: 0, height: row });
    band.dataset.end = String(diedAt(attempts, r) ?? attempts.length + 1);
    return band;
  });
  for (let r = 1; r < steps.length; r++) set(shape('line', 'a-rule', attemptsSvg), { x1: 0, y1: r * row, x2: box.width, y2: r * row });
  cursor = shape('rect', 'a-cursor', attemptsSvg);
  set(cursor, { y: 0, width: colPitch, height: box.height });
  columns = attempts.map((attempt, c) => {
    const column = shape('g', `a-column a-${attempt.outcome}`, attemptsSvg) as SVGElement;
    for (const r of attempt.kept) set(shape('rect', 'a-cell', column), { x: x(c) - cell.w / 2, y: (r + 0.5) * row - cell.h / 2, width: cell.w, height: cell.h, rx: 2 });
    return column;
  });
  // The last column is the answer: the steps that are left.
  for (const r of finalKept) set(shape('rect', 'a-end', attemptsSvg), { x: x(attempts.length) - cell.w / 2, y: (r + 0.5) * row - cell.h / 2, width: cell.w, height: cell.h, rx: 2 });
  showAttempt(shownAttempt);
}

function showAttempt(n: number): void {
  shownAttempt = n;
  const total = attempts.length;
  const alive = new Set(aliveAfter(attempts, steps.length, n));
  columns.forEach((column, c) => column.classList.toggle('on', c < n));
  bands.forEach((band) => {
    // A band runs up to the attempt on show, and stops at the attempt that dropped its step.
    const end = Number(band.dataset.end);
    set(band, { width: Math.max(0, (end > total && n === total ? total + 1 : Math.min(end, n)) * colPitch) });
  });
  attemptsSvg.classList.toggle('done', n === total);
  if (cursor) {
    show(cursor, n > 0 && n < total);
    set(cursor, { x: (n - 1) * colPitch });
  }
  rowItems.forEach((row, i) => row.classList.toggle('gone', !alive.has(i)));
  $('attempt-note').textContent = attemptNote(attempts, steps.length, n);
  $('axis-count').textContent = n === total ? `${total} attempts` : `Attempt ${n} of ${total}`;
  const count = $('result-count');
  (count.firstElementChild as HTMLElement).textContent = String(alive.size);
  (count.lastElementChild as HTMLElement).textContent = SAID.inPlay(steps.length, n === total);
  attemptRange.value = String(n);
  attemptRange.setAttribute('aria-valuetext', `${n === 0 ? 'Before the first attempt' : `Attempt ${n} of ${total}`}, ${alive.size} steps left`);
}

/** Plays the attempts in order. Any touch of the scrubber takes over. */
function playReduction(): void {
  cancelAnimationFrame(reducing);
  if (calm()) return showAttempt(attempts.length);
  const start = performance.now();
  attemptsSvg.classList.add('playing');
  showAttempt(0);
  const step = (now: number) => {
    // A slow start, so the first halvings can be read as they happen.
    const elapsed = (now - start - 350) / 1000;
    const n = clamp(Math.floor(elapsed < 1.6 ? elapsed * 5 : 8 + (elapsed - 1.6) * 9), 0, attempts.length);
    if (n !== shownAttempt) showAttempt(n);
    if (n < attempts.length) reducing = requestAnimationFrame(step);
    else attemptsSvg.classList.remove('playing');
  };
  reducing = requestAnimationFrame(step);
}

function stopReduction(): void {
  cancelAnimationFrame(reducing);
  attemptsSvg.classList.remove('playing');
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

let spoken = '';
let nowStep = -1;
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
  $('readout').textContent = readout(view, cell.differs);
  shots.bad.setAttribute('aria-label', frameLabel(t, cell.step + 1, steps.length, steps[cell.step]!.label, cell.differs, off));
  shots.good.setAttribute('aria-label', SAID.goodAt(t));
  range.value = String(t);
  range.setAttribute('aria-valuetext', `${t} ms, step ${cell.step + 1}: ${steps[cell.step]!.label}, frame ${index + 1} of ${cells.length}`);
  $('clock').textContent = `${t} ms`;
  jumpButton.setAttribute('aria-disabled', String(t === jump.t));
  // The step under the needle is named in the transport, and marked on the spine.
  if (nowStep !== cell.step) {
    nowStep = cell.step;
    const now = $('now');
    now.replaceChildren(el('b', '', String(cell.step + 1)), steps[cell.step]!.label);
    now.classList.toggle('bad', cell.step === jump.step);
    stepButtons.forEach((item, i) => {
      if (i === cell.step) item.button.setAttribute('aria-current', 'true');
      else item.button.removeAttribute('aria-current');
      item.leader?.classList.toggle('now', i === cell.step);
    });
  }
  stage.classList.toggle('in-jump', phase === 'jump');
  stage.dataset.frame = String(index);
}

function setIndex(next: number): void {
  next = clamp(next, 0, cells.length - 1);
  if (next === index) return;
  failed.clear();
  const from = index < 0 ? 'jump' : phaseAt(time());
  index = next;
  // Walking into the failure draws the ruler. Moving about inside it does not redraw it.
  if (phaseAt(time()) === 'jump' && from === 'before' && !calm()) {
    grow = 0;
    growFrom = performance.now() + 60;
  } else if (!growFrom) grow = 1;
  dirty = true;
  render();
  aim();
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
    // A frame still on its way holds the needle, so the picture never falls behind the clock.
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
      // A spring to the frame asked for. It starts from whatever speed the needle already has.
      const a = -210 * (pos - target) - 29 * velocity;
      velocity += a * dt;
      pos += velocity * dt;
      if (Math.abs(pos - target) < 0.004 && Math.abs(velocity) < 0.05) {
        pos = target;
        velocity = 0;
        target = null;
      } else moving = true;
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

  if (paneW && easeCam(dt)) moving = true;
  placeNeedle();
  // Nothing is painted until the stage has been measured once.
  if (dirty && paneW) {
    dirty = false;
    paint();
    drawMarks();
  }
  if (scanDirty) requestScan();
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
  status.textContent = SAID.finished;
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

/** Moves to the frame showing at `t`. With `glide` the needle rolls there instead of cutting. */
function seek(t: number, glide = false): void {
  stop();
  const to = clamp(lastAt(cells, t), 0, cells.length - 1);
  if (glide && !calm()) {
    // A long way off, the needle cuts most of the distance and rolls the rest.
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

/* Sessions, views and acts */
function setSession(next: Session, at = time()): void {
  session = next;
  good = data.runs[next.good]!;
  bad = data.runs[next.bad]!;
  goodLine = timelines(good.events);
  badLine = timelines(bad.events);
  cells = cellsOf(good, bad, steps, next.kept);
  jumpIndex = lastAt(cells, jump.t);
  settledIndex = lastAt(cells, jump.settled);
  for (const button of $('sessions').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.session === next.id));
  stage.dataset.session = next.id;
  stage.dataset.cells = String(cells.length);
  rowH = coreH / Math.max(1, cells.length);
  setPaths();
  placeSteps();
  drawCoreMarks();
  scanDirty = true;
  index = -1;
  spoken = '';
  nowStep = -1;
  drawn = '';
  pos = clamp(lastAt(cells, at), 0, cells.length - 1);
  velocity = 0;
  target = null;
  setIndex(pos);
  // The frame on show first, then the ones the needle will reach next, then the ones behind it.
  want([...cells.slice(index, index + 8), ...cells.slice(Math.max(0, index - 6), index).reverse()].flatMap((c) => [c.good, c.bad]));
  wantLater(cells.flatMap((c) => [c.bad, c.good]));
  if (!playing) idleLabel();
  schedule();
}

function setView(next: View): void {
  view = next;
  stage.dataset.view = next;
  for (const button of $('views').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.view === next));
  $('source').textContent = SOURCE[next];
  $('core-note').textContent = coreNote(next);
  if (goodLine) setPaths();
  drawn = '';
  dirty = true;
  scanDirty = true;
  if (index >= 0) render();
  saveUrl();
  schedule();
}

function setWhole(next: boolean): void {
  whole = next;
  wholeButton.setAttribute('aria-pressed', String(next));
  wholeButton.setAttribute('aria-label', SAID.wholeLabel(next));
  wholeButton.title = SAID.wholeLabel(next);
  stage.classList.toggle('is-whole', next);
  layout();
  saveUrl();
  schedule();
}

function setAct(next: Act): void {
  act = next;
  stage.dataset.act = next;
  for (const button of $('acts').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.act === next));
  if (next === 'search') {
    stop();
    idleLabel();
    // The search plays once, the first time it is opened.
    if (!searched && !calm()) requestAnimationFrame(() => requestAnimationFrame(playReduction));
    searched = true;
  } else {
    stopReduction();
    showAttempt(attempts.length);
    layout();
  }
  saveUrl();
  schedule();
}

/* A link that opens on the same frame, view, session and scan line */
let urlTimer = 0;
let urlReady = false;
function saveUrl(): void {
  if (!urlReady || idle || playing) return;
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const q = new URLSearchParams();
    if (time() !== jump.t) q.set('t', String(time()));
    if (view !== 'shots') q.set('view', view);
    if (session.id !== 'original') q.set('steps', String(session.kept.length));
    if (scanY !== data.scanY) q.set('row', String(scanY));
    if (whole) q.set('frame', 'whole');
    if (act === 'search') q.set('act', 'search');
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
    status.textContent = ok ? said : SAID.copyFailed;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      for (const node of button.querySelectorAll<HTMLElement>('span[data-label]')) node.classList.toggle('on', node.dataset.label === 'idle');
    }, 1800);
  });
}

function arrived(name: string): void {
  const cell = cells[index];
  if (cell && (cell.good === name || cell.bad === name)) {
    dirty = true;
    schedule();
  }
  if (!loaded.has(name)) return;
  if (worker) worker.postMessage({ type: 'have', names: [name] });
  else if (plain) {
    scanDirty = true;
    schedule();
  }
  for (const watch of watchers) watch(name);
}

/* Wiring */
for (const button of $('sessions').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    const next = data.sessions.find((s) => s.id === button.dataset.session)!;
    if (next === session) return;
    if (playing) stop();
    setSession(next);
    saveUrl();
    // The pressed button names the session, so the status only has to say what is on screen.
    status.textContent = next.verdict[phaseAt(time())];
  });
}
for (const button of $('views').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    setView(button.dataset.view as View);
    status.textContent = $('readout').textContent || SAID.view(button.textContent ?? '');
  });
}
for (const button of $('acts').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    if (button.dataset.act === act) return;
    setAct(button.dataset.act as Act);
    status.textContent = SAID.act(act === 'search');
  });
}
wholeButton.addEventListener('click', () => {
  setWhole(!whole);
  status.textContent = SAID.whole(whole);
});
playButton.addEventListener('click', () => (playing ? pause() : play()));
jumpButton.addEventListener('click', () => {
  if (jumpButton.getAttribute('aria-disabled') !== 'true') toJump();
});
$('play-kept').addEventListener('click', () => {
  setAct('jump');
  setSession(data.sessions[1]!, 0);
  poster = true;
  play();
  playButton.focus({ preventScroll: true });
});
range.max = String(axisEnd);
range.addEventListener('input', () => {
  poster = false;
  seek(Number(range.value));
});
range.addEventListener('keydown', (e) => {
  // The native steps are in ms and most of them land between frames, so the keys move by frame.
  const move: Record<string, () => void> = {
    ArrowRight: () => stepBy(1), ArrowDown: () => stepBy(1), ArrowLeft: () => stepBy(-1), ArrowUp: () => stepBy(-1),
    PageDown: () => stepTo(1), PageUp: () => stepTo(-1), Home: () => seek(0, true), End: () => seek(cells.at(-1)!.t, true),
  };
  const action = move[e.key];
  if (!action || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Home' || e.key === 'End') poster = false;
  action();
});

const help = $<HTMLDialogElement>('help');
const openHelp = () => {
  if (!help.open) help.showModal();
};
$('help-open').addEventListener('click', openHelp);
help.addEventListener('click', (e) => {
  if (e.target === help) help.close();
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || help.open) return;
  const on = e.target as HTMLElement;
  if (on.tagName === 'INPUT' && on !== range && on !== attemptRange || on.tagName === 'TEXTAREA') return;
  if (e.key === '?') {
    e.preventDefault();
    openHelp();
  }
});
stage.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const on = e.target as HTMLElement;
  const slider = on === scanline || on === attemptRange;
  const press = on.tagName === 'BUTTON' || on.tagName === 'A';
  if (e.key === '1') setAct('jump');
  else if (e.key === '2') setAct('search');
  else if (act === 'search') return;
  else if (e.key === 'Escape' && playing) pause();
  else if (e.key === '[') stepTo(-1);
  else if (e.key === ']') stepTo(1);
  else if (e.key === 'f' || e.key === 'F') toJump();
  else if (e.key === 'w' || e.key === 'W') setWhole(!whole);
  else if (e.key === ' ' && !press) (playing ? pause() : play());
  else if (e.key === 'ArrowLeft' && !slider) stepBy(-1);
  else if (e.key === 'ArrowRight' && !slider) stepBy(1);
  else if (e.key === 'ArrowUp' && !slider) setScan(scanY - (e.shiftKey ? 16 : 4));
  else if (e.key === 'ArrowDown' && !slider) setScan(scanY + (e.shiftKey ? 16 : 4));
  else return;
  e.preventDefault();
});

/* Scrubbing time from the cores. A mouse drags anywhere, and a finger taps or drags the needle, so the page still scrolls. */
{
  const rowAt = (e: PointerEvent) => clamp(Math.floor((e.clientY - cores.bad.getBoundingClientRect().top) / rowH), 0, cells.length - 1);
  const grab = (e: PointerEvent, node: HTMLElement) => {
    if (e.button) return;
    stop();
    poster = false;
    dragging = true;
    node.setPointerCapture(e.pointerId);
    stage.classList.add('is-scrubbing');
    place(rowAt(e));
    idleLabel();
  };
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    const row = rowAt(e);
    if (row !== index) place(row);
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('is-scrubbing');
    saveUrl();
  };
  for (const node of [cores.good, cores.bad, needle]) {
    node.addEventListener('pointerdown', (e) => {
      if (node === needle || e.pointerType === 'mouse') grab(e, node);
    });
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
  }
  for (const node of [cores.good, cores.bad]) {
    node.addEventListener('click', (e) => {
      // A tap goes to the row under the finger. A mouse has already been there on the way down.
      if ((e as PointerEvent).pointerType === 'mouse') return;
      stop();
      poster = false;
      place(rowAt(e as PointerEvent));
      idleLabel();
    });
  }
}

/* Moving the scan line, from its grip or from either frame */
{
  let grabbed = false;
  const at = (e: PointerEvent) => setScan(cam.y + (e.clientY - panes.bad.getBoundingClientRect().top) / cam.scale);
  for (const node of [scanline, panes.good, panes.bad]) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button || node !== scanline && e.pointerType !== 'mouse') return;
      grabbed = true;
      node.setPointerCapture(e.pointerId);
      at(e);
    });
    node.addEventListener('pointermove', (e) => grabbed && at(e));
    for (const type of ['pointerup', 'pointercancel'] as const) node.addEventListener(type, () => (grabbed = false));
  }
  for (const node of [panes.good, panes.bad]) node.addEventListener('click', (e) => (e as PointerEvent).pointerType !== 'mouse' && at(e as PointerEvent));
  scanline.addEventListener('keydown', (e) => {
    const by = e.shiftKey ? 16 : 2;
    const [lo, hi] = scanRange();
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setScan(scanY - by);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setScan(scanY + by);
    else if (e.key === 'Home') setScan(lo);
    else if (e.key === 'End') setScan(hi);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

/* The search scrubber, and the grid itself */
attemptRange.addEventListener('input', () => {
  stopReduction();
  showAttempt(Number(attemptRange.value));
});
{
  let grabbed = false;
  const at = (e: PointerEvent) => {
    stopReduction();
    showAttempt(clamp(Math.ceil((e.clientX - attemptsSvg.getBoundingClientRect().left) / colPitch), 0, attempts.length));
  };
  attemptsSvg.addEventListener('pointerdown', (e) => {
    if (e.button || e.pointerType !== 'mouse') return;
    grabbed = true;
    attemptsSvg.setPointerCapture(e.pointerId);
    at(e);
  });
  attemptsSvg.addEventListener('pointermove', (e) => grabbed && at(e));
  for (const type of ['pointerup', 'pointercancel'] as const) attemptsSvg.addEventListener(type, () => (grabbed = false));
  attemptsSvg.addEventListener('click', (e) => (e as PointerEvent).pointerType !== 'mouse' && at(e as PointerEvent));
}
$('reduce-play').addEventListener('click', () => {
  playReduction();
  status.textContent = SAID.replaying(attempts.length);
});
copyButton($('copy'), () => data.scenario, SAID.scenario);
for (const button of document.querySelectorAll<HTMLElement>('[data-copy]')) copyButton(button, () => $(button.dataset.copy!).textContent ?? '', SAID.command);

/* Start */
const query = new URLSearchParams(location.search);
const startView = VIEWS.find((v) => v === query.get('view')) ?? 'shots';
const startSession = query.get('steps') === String(data.sessions[1]!.kept.length) ? data.sessions[1]! : data.sessions[0]!;
const startTime = query.has('t') ? clamp(Number(query.get('t')) || 0, 0, axisEnd) : jump.t;
let started = false;
poster = startTime === jump.t;
whole = query.get('frame') === 'whole';
if (query.has('row')) scanY = clamp(Number(query.get('row')) || data.scanY, 2, frame.height - 2);

new ResizeObserver(() => {
  layout();
  schedule();
}).observe(bench);
new ResizeObserver(buildMatrix).observe(attemptsSvg);
view = startView;
setSession(startSession, startTime);
setView(startView);
// The first measurement is left to the observer above, which reports after the browser's own first layout.
if (whole) {
  wholeButton.setAttribute('aria-pressed', 'true');
  wholeButton.setAttribute('aria-label', SAID.wholeLabel(true));
  wholeButton.title = SAID.wholeLabel(true);
  stage.classList.add('is-whole');
}
if (query.get('act') === 'search') {
  searched = true;
  setAct('search');
}
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
    }).observe(bench);
  }
  schedule();
}

// The cores and the figures further down wait until the first frame is on screen.
const later = (run: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 600 }) : setTimeout(run, 120));
requestAnimationFrame(() => later(() => {
  started = true;
  startScans();
  scanDirty = true;
  schedule();
  later(() => initFigures({
    data, images, loaded, want,
    watch: (fn) => watchers.push(fn),
  }));
}));
