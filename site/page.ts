import type { TraceEvent } from '../src/trace/types.ts';
import { focusAt, lastAt, rectAt, timelines, trailAt, viewportAt, type Timelines } from '../viewer/src/model.ts';

/**
 * The public project page. Two panes play recorded screenshots on one clock, and
 * every mode shares that clock, so switching runs never moves the playhead. All
 * numbers and sentences arrive in the data block, written from the saved runs.
 */
interface Rect { x: number; y: number; w: number; h: number }
interface Run { frames: { t: number; f: string }[]; events: TraceEvent[] }
interface Pane { label: string; run: string; bad: boolean; started: string }
type Phase = 'before' | 'jump' | 'after';
interface Mode {
  id: string;
  title: string;
  count: string;
  end: number;
  kept: number[];
  top: Pane;
  bottom: Pane;
  verdict: Record<Phase, string>;
}
interface Data {
  frame: { width: number; height: number; scale: number };
  axisEnd: number;
  jump: { t: number; settled: number; px: number; trigger: Rect; broken: Rect };
  steps: { at: number; label: string }[];
  jumpStep: number;
  attempts: { kept: number[]; outcome: string }[];
  targets: { name: string; id: string; label: string }[];
  modes: Mode[];
  runs: Record<string, Run>;
}

const data: Data = JSON.parse(document.getElementById('trace-data')!.textContent!);
const SVG = 'http://www.w3.org/2000/svg';
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const shape = (tag: string, cls: string, parent: Element) => {
  const node = document.createElementNS(SVG, tag);
  node.setAttribute('class', cls);
  parent.append(node);
  return node;
};
const set = (node: Element, attrs: Record<string, number | string>) => {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
};
const show = (node: Element, on: boolean) => node.setAttribute('visibility', on ? 'visible' : 'hidden');
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = $('stage');
const range = $<HTMLInputElement>('time');
const playButton = $('play');
const jumpButton = $('jump');
const status = $('status');

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
      if (frameName(top, time) === name || frameName(bottom, time) === name) dirty = true, schedule();
    }, () => images.delete(name)).finally(() => {
      active -= 1;
      pump();
    });
  }
}

function want(names: string[]): void {
  const fresh = names.filter((n) => !images.has(n));
  queue = [...new Set([...fresh, ...queue])];
  pump();
}

/** Everything else, behind what the current run needs, so a switch never waits. */
function wantLater(names: string[]): void {
  queue = [...new Set([...queue, ...names.filter((n) => !images.has(n))])];
  pump();
}

/* One pane: a canvas of screenshots, and marks drawn in the same coordinates. */
interface View { x: number; y: number; w: number; h: number; scale: number }
class Stage {
  root: HTMLElement;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  svg: SVGSVGElement;
  view: View = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
  run!: Run;
  other!: Timelines;
  line!: Timelines;
  bad = false;
  drawn = '';
  edge: Element;
  world: Element;
  worldRect: Element;
  nodes = new Map<string, { rect: Element; name: Element }>();
  ghost: Element;
  panel: Element;
  trail: Element;
  focus: Element;
  guide: Element;
  start: Element;
  span: Element;
  label: Element;

  constructor(id: string) {
    this.root = $(id);
    this.host = this.root.querySelector('.view')!;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.svg = this.root.querySelector('svg')!;
    this.world = shape('g', '', this.svg);
    this.worldRect = shape('rect', 'g-view', this.world);
    for (const t of data.targets) this.nodes.set(t.name, { rect: shape('rect', 'g-node', this.world), name: shape('text', 'g-name', this.world) });
    for (const t of data.targets) this.nodes.get(t.name)!.name.textContent = t.label;
    this.ghost = shape('rect', 'g-ghost', this.world);
    this.panel = shape('rect', 'g-panel', this.world);
    this.trail = shape('polyline', 'g-trail', this.world);
    this.focus = shape('rect', 'g-focus', this.world);
    this.edge = shape('line', 'm-edge', this.svg);
    this.guide = shape('line', 'm-guide', this.svg);
    this.start = shape('rect', 'm-start', this.svg);
    this.span = shape('path', 'm-span', this.svg);
    this.label = shape('text', 'm-label', this.svg);
    this.label.textContent = `${data.jump.px} px`;
  }

  /** Fills the pane from the top right of the frame, where the failure happens. */
  layout(): void {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    const { frame } = data;
    // The whole window when its text stays readable, otherwise the part that matters.
    const whole = width / frame.width;
    const scale = Math.max(whole >= 0.66 ? whole : Math.min(0.8, width / 835), height / frame.height, width < 480 ? 0.72 : 0);
    const w = width / scale;
    const h = height / scale;
    this.view = { x: frame.width - w, y: 0, w, h, scale };
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.imageSmoothingQuality = 'high';
    set(this.svg, { viewBox: `${this.view.x} ${this.view.y} ${w} ${h}` });
    const type = 12 / scale;
    set(this.label, { 'font-size': type, 'stroke-width': 4 / scale });
    for (const n of this.nodes.values()) set(n.name, { 'font-size': 11 / scale });
    set(this.world, { 'stroke-width': 1 / scale });
    this.drawn = '';
  }

  frame(time: number): void {
    const list = this.run.frames;
    const name = list[Math.max(0, lastAt(list, time))]!.f;
    const img = images.get(name);
    if (!img || !loaded.has(name) || this.drawn === name) return;
    const { frame } = data;
    const { x, y, w, h } = this.view;
    const s = frame.scale;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, x * s, y * s, w * s, h * s, 0, 0, this.canvas.width, this.canvas.height);
    this.drawn = name;
  }

  marks(time: number, geometry: boolean): void {
    const { jump } = data;
    const unit = 1 / this.view.scale;
    const vp = viewportAt(this.line, time, { width: data.frame.width, height: data.frame.height });
    const narrow = vp.width < data.frame.width;
    show(this.edge, narrow);
    if (narrow) set(this.edge, { x1: vp.width, y1: 0, x2: vp.width, y2: data.frame.height });

    const on = time >= jump.t && time < jump.settled;
    const start = this.bad ? jump.broken : jump.trigger;
    for (const node of [this.guide, this.start]) show(node, on);
    // The bracket marks the first frames only, before the panel grows across it.
    const bracket = on && this.bad && time < jump.t + 48;
    show(this.span, bracket);
    show(this.label, bracket);
    if (on) {
      const left = jump.trigger.x;
      const below = jump.trigger.y + jump.trigger.h + 7 * unit;
      set(this.guide, { x1: left, y1: 0, x2: left, y2: this.view.h });
      set(this.start, { x: start.x - 1, y: start.y - 1, width: start.w + 2, height: start.h + 2, rx: 3 });
      if (bracket) {
        const cap = 4 * unit;
        set(this.span, { d: `M${left} ${below - cap}V${below + cap}M${left} ${below}H${start.x}M${start.x} ${below - cap}V${below + cap}` });
        set(this.label, { x: (left + start.x) / 2, y: below + 16 * unit });
      }
    }

    show(this.world, geometry);
    if (!geometry) return;
    set(this.worldRect, { x: 0.5, y: 0.5, width: vp.width - 1, height: vp.height - 1 });
    for (const [name, node] of this.nodes) {
      const r = rectAt(this.line, name, time);
      show(node.rect, !!r);
      show(node.name, !!r && r.w >= 60);
      if (!r) continue;
      set(node.rect, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4 });
      set(node.name, { x: r.x + r.w / 2, y: r.y + r.h / 2 + 4 * unit });
    }
    const r = rectAt(this.line, 'panel', time);
    show(this.panel, !!r);
    if (r) set(this.panel, { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6 });
    const g = rectAt(this.other, 'panel', time);
    const moved = !!r && !!g && Math.hypot(r.x - g.x, r.y - g.y) > 2;
    show(this.ghost, moved);
    if (g) set(this.ghost, { x: g.x, y: g.y, width: g.w, height: g.h, rx: 6 });
    const trail = trailAt(this.line, 'panel', time);
    show(this.trail, trail.length > 1);
    this.trail.setAttribute('points', trail.map((p) => `${p.x},${p.y}`).join(' '));
    const focus = focusAt(this.line, time);
    const target = focus && data.targets.find((t) => t.id === focus.traceId);
    const box = target ? rectAt(this.line, target.name, time) : null;
    show(this.focus, !!box);
    if (box) set(this.focus, { x: box.x - 3, y: box.y - 3, width: box.w + 6, height: box.h + 6, rx: 6 });
  }
}

const top = new Stage('pane-top');
const bottom = new Stage('pane-bottom');
const frameName = (stage: Stage, t: number) => {
  const list = stage.run.frames;
  return list[Math.max(0, lastAt(list, t))]!.f;
};

/* Steps, ticks and the recorded attempts */
const { steps, jump, attempts, axisEnd } = data;
const stepButtons = steps.map((step, i) => {
  const row = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = i === data.jumpStep ? 'step is-jump' : 'step';
  const number = document.createElement('i');
  number.textContent = String(i + 1);
  const label = document.createElement('span');
  label.textContent = step.label;
  button.append(number, label);
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    seek(step.at);
  });
  row.append(button);
  $('steps').append(row);
  return button;
});
const ticks = steps.map((step, i) => {
  const tick = document.createElement('i');
  tick.className = i === data.jumpStep ? 'tick jump' : 'tick';
  tick.style.left = `${(step.at / axisEnd) * 100}%`;
  $('ticks').append(tick);
  return tick;
});
const columns = attempts.map((attempt, c) => {
  const column = shape('g', `a-column a-${attempt.outcome}`, $('attempts'));
  for (const row of attempt.kept) set(shape('rect', 'a-cell', column), { x: c + 0.14, y: row + 0.2, width: 0.72, height: 0.6 });
  return column;
});

function setKept(kept: Set<number>): void {
  steps.forEach((_, i) => {
    const gone = !kept.has(i);
    stepButtons[i]!.setAttribute('aria-disabled', String(gone));
    ticks[i]!.classList.toggle('dropped', gone);
  });
}

let reveal = 0;
function revealAttempts(): void {
  clearTimeout(reveal);
  const all = new Set(steps.map((_, i) => i));
  if (mode.id !== 'reduced') {
    columns.forEach((c) => c.classList.remove('on'));
    setKept(new Set(mode.kept.length ? mode.kept : all));
    return;
  }
  const final = new Set(mode.kept);
  if (calm()) {
    columns.forEach((c) => c.classList.add('on'));
    setKept(final);
    return;
  }
  columns.forEach((c) => c.classList.remove('on'));
  let kept = all;
  setKept(kept);
  let i = 0;
  const next = () => {
    const column = columns[i]!;
    const attempt = attempts[i]!;
    column.classList.add('on');
    if (attempt.outcome === 'fails') {
      kept = new Set(attempt.kept);
      setKept(kept);
    }
    i += 1;
    if (i < columns.length) reveal = window.setTimeout(next, 60);
    else setKept(final);
  };
  next();
}

const keys = {
  attempts: [['k-fails', 'Failure kept'], ['k-passes', 'Failure lost'], ['k-invalid', 'Could not run'], ['k-other', 'A different failure']],
  geometry: [['k-panel', 'Panel'], ['k-ghost', 'Other build'], ['k-trail', 'Its path']],
};
function drawKey(): void {
  const rows = [...(geometry ? keys.geometry : []), ...(mode.id === 'reduced' ? keys.attempts : [])];
  $('rail-key').replaceChildren(...rows.map(([cls, text]) => {
    const row = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = cls!;
    row.append(swatch, text!);
    return row;
  }));
}

/* The verdict lines all share one grid cell, so the stage never changes height */
const lines = new Map<string, HTMLElement>();
for (const m of data.modes) {
  for (const phase of ['before', 'jump', 'after'] as const) {
    const key = `${m.id}.${phase}`;
    const line = document.createElement('p');
    const title = document.createElement('b');
    title.textContent = `${m.title}, ${m.count}`;
    line.append(title, m.verdict[phase]);
    if (phase === 'jump') line.classList.add(m.id === 'fixed' ? 'good' : 'bad');
    if (m.id === 'fixed' && phase === 'after') line.classList.add('good');
    lines.set(key, line);
    $('verdict').append(line);
  }
}

/* The clock */
let mode = data.modes[0]!;
let geometry = false;
let time = jump.t;
let playing = false;
let last = 0;
let raf = 0;
let hold = 0;
let held = false;
let cut = 0;
let dirty = true;
let scheduled = 0;
/** The opening still sits on the jump. The first press starts from the top. */
let poster = true;

const phaseAt = (t: number): Phase => (t < jump.t ? 'before' : t < jump.settled ? 'jump' : 'after');

function schedule(): void {
  if (scheduled || playing) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    draw();
  });
}

function setLabel(which: 'replay' | 'play' | 'pause'): void {
  for (const span of playButton.querySelectorAll<HTMLElement>('span')) span.classList.toggle('on', span.dataset.label === which);
}

function idleLabel(): void {
  setLabel(poster || time >= mode.end ? 'replay' : 'play');
}

let spoken = '';
function draw(): void {
  dirty = false;
  top.frame(time);
  bottom.frame(time);
  top.marks(time, geometry);
  bottom.marks(time, geometry);
  const phase = phaseAt(time);
  const shown = `${mode.id}.${phase}`;
  if (spoken !== shown) {
    for (const [key, line] of lines) line.classList.toggle('on', key === shown);
    spoken = shown;
    const panes: [Stage, Pane, string][] = [[top, mode.top, 'note-top'], [bottom, mode.bottom, 'note-bottom']];
    for (const [view, pane, id] of panes) {
      const note = $(id);
      note.textContent = phase === 'jump' ? pane.started : '';
      note.classList.toggle('bad', pane.bad);
      view.canvas.setAttribute('aria-label', `${pane.label}. ${phase === 'jump' ? pane.started : mode.verdict[phase]}`);
    }
  }
  range.value = String(time);
  range.setAttribute('aria-valuetext', `${Math.round(time)} ms, step ${Math.max(1, lastAt(steps.map((s) => ({ t: s.at })), time) + 1)}: ${currentLabel()}`);
  $('done').style.setProperty('--progress', String(time / axisEnd));
  $('clock').textContent = `${Math.round(time)} ms`;
  const current = currentStep();
  stepButtons.forEach((button, i) => (i === current ? button.setAttribute('aria-current', 'true') : button.removeAttribute('aria-current')));
  jumpButton.setAttribute('aria-disabled', String(time === jump.t));
}

function currentStep(): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.at <= time && mode.kept.includes(i)) return i;
  }
  return -1;
}
const currentLabel = () => steps[currentStep()]?.label ?? 'start';

function stop(): void {
  playing = false;
  held = false;
  cancelAnimationFrame(raf);
  clearTimeout(hold);
  clearTimeout(cut);
}

function pause(): void {
  stop();
  idleLabel();
  schedule();
}

function finish(): void {
  stop();
  time = mode.end;
  idleLabel();
  draw();
  status.textContent = 'Replay finished';
}

/** Near the jump the clock slows down, because the whole failure lasts a quarter second. */
const rate = (t: number) => (t >= jump.t - 32 && t < jump.settled ? 0.16 : 1.1);

function tick(now: number): void {
  if (!playing) return;
  const dt = Math.min(now - last, 80);
  last = now;
  if (!held) {
    const a = frameName(top, time);
    const b = frameName(bottom, time);
    // A frame still on its way holds the clock, so the two panes never disagree.
    if (loaded.has(a) && loaded.has(b)) {
      const before = time;
      let next = time + dt * rate(time);
      const run = top.run.frames;
      const here = lastAt(run, next);
      const after = run[here + 1]?.t;
      // A long quiet stretch would only be waiting, so the clock skips most of it.
      if (after !== undefined && after - next > 300 && after > before) next = after - 200;
      if (before < jump.t && next >= jump.t) {
        time = jump.t;
        held = true;
        draw();
        status.textContent = mode.verdict.jump;
        hold = window.setTimeout(() => {
          held = false;
          last = performance.now();
        }, 1100);
        raf = requestAnimationFrame(tick);
        return;
      }
      time = next;
      if (time >= mode.end) return finish();
      want(upcoming());
    } else {
      want([a, b]);
    }
  }
  draw();
  raf = requestAnimationFrame(tick);
}

const upcoming = () => [top, bottom].flatMap((s) => s.run.frames.slice(Math.max(0, lastAt(s.run.frames, time)), lastAt(s.run.frames, time) + 8).map((f) => f.f));

/** With reduced motion the replay cuts between the steps, and ends on the jump. */
function playCuts(): void {
  const stops = [...mode.kept.map((i) => steps[i]!.at).filter((t) => t < jump.t), jump.t];
  let i = 0;
  const next = () => {
    time = stops[i]!;
    i += 1;
    want([frameName(top, time), frameName(bottom, time)]);
    draw();
    if (i < stops.length) cut = window.setTimeout(next, 1000);
    else {
      playing = false;
      poster = true;
      idleLabel();
      status.textContent = mode.verdict.jump;
    }
  };
  next();
}

function play(): void {
  if (poster || time >= mode.end) time = 0;
  poster = false;
  playing = true;
  setLabel('pause');
  if (calm()) return playCuts();
  last = performance.now();
  want(upcoming());
  draw();
  raf = requestAnimationFrame(tick);
}

function seek(t: number): void {
  stop();
  poster = false;
  time = Math.max(0, Math.min(mode.end, t));
  want([frameName(top, time), frameName(bottom, time)]);
  idleLabel();
  draw();
}

function setMode(next: Mode): void {
  mode = next;
  top.run = data.runs[next.top.run]!;
  bottom.run = data.runs[next.bottom.run]!;
  const a = timelines(top.run.events);
  const b = timelines(bottom.run.events);
  top.line = a;
  top.other = b;
  bottom.line = b;
  bottom.other = a;
  top.bad = next.top.bad;
  bottom.bad = next.bottom.bad;
  top.drawn = '';
  bottom.drawn = '';
  top.root.classList.toggle('is-bad', next.top.bad);
  top.root.classList.toggle('is-good', !next.top.bad);
  bottom.root.classList.toggle('is-bad', next.bottom.bad);
  bottom.root.classList.toggle('is-good', !next.bottom.bad);
  $('label-top').textContent = next.top.label;
  $('label-bottom').textContent = next.bottom.label;
  $('rail-title').textContent = next.title;
  $('rail-count').textContent = next.count;
  for (const button of $('modes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === next.id));
  const fixed = next.id === 'fixed';
  stepButtons[data.jumpStep]!.classList.toggle('is-good', fixed);
  ticks[data.jumpStep]!.classList.toggle('good', fixed);
  // The steps have no frames past the end of a shorter run.
  if (time > next.end) time = next.end;
  spoken = '';
  revealAttempts();
  drawKey();
  const list = [...new Set([...top.run.frames, ...bottom.run.frames].map((f) => f.f))];
  want(list);
  draw();
  if (!playing) idleLabel();
  status.textContent = `${next.title}, ${next.count}. ${next.verdict[phaseAt(time)]}`;
}

for (const button of $('modes').querySelectorAll<HTMLButtonElement>('button')) {
  button.addEventListener('click', () => {
    const next = data.modes.find((m) => m.id === button.dataset.mode)!;
    if (next !== mode) setMode(next);
  });
}
$('geometry').addEventListener('click', () => {
  geometry = !geometry;
  $('geometry').setAttribute('aria-pressed', String(geometry));
  stage.classList.toggle('is-geometry', geometry);
  drawKey();
  draw();
});
playButton.addEventListener('click', () => (playing ? pause() : play()));
jumpButton.addEventListener('click', () => {
  if (jumpButton.getAttribute('aria-disabled') === 'true') return;
  seek(jump.t);
  poster = true;
  idleLabel();
});
range.addEventListener('input', () => seek(Number(range.value)));
stage.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && playing) pause();
});

range.max = String(axisEnd);
new ResizeObserver(() => {
  top.layout();
  bottom.layout();
  if (!playing) draw();
}).observe($('panes'));
top.layout();
bottom.layout();
setMode(mode);
status.textContent = '';
wantLater(Object.values(data.runs).flatMap((run) => run.frames.map((f) => f.f)));
