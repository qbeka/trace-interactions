import type { TraceEvent } from '../src/trace/types.ts';
import { focusAt, focusName, frameOf, formatMs, lastAt, rectAt, skipIdle, stateAt, timelines, trailAt, viewportAt, type Frame, type Timelines } from '../viewer/src/model.ts';

/**
 * The public project page. It reads the recorded traces through the same model
 * as the full report. Every number arrives in the data block, written from the
 * saved runs when the page is built, and none is typed here.
 */
interface Scene {
  id: string;
  label: string;
  note: string;
  scenario: { viewport: { width: number; height: number }; targets: Record<string, { traceId?: string; name?: string }>; actions: { at: number; type: string; note?: string }[] };
  primary: string;
  stateKey: string;
  baseline: { label: string; events: TraceEvent[] };
  candidate: { label: string; events: TraceEvent[] };
  failing: 'baseline' | 'candidate';
  failure: { t: number; sentence: string; px: number } ;
  passing: string;
  resolved: boolean;
}
interface Data {
  ridge: { t: number; w: number }[];
  ridgeEnd: number;
  tiles: { value: string; label: string }[];
  scenes: Scene[];
  evidence: { text: string; head: string[]; rows: string[][]; note: string };
  checks: string[];
  limits: string[];
  foot: { links: { label: string; href: string }[]; provenance: string };
}

const data: Data = JSON.parse(document.getElementById('trace-data')!.textContent!);
const SVG = 'http://www.w3.org/2000/svg';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, props: Record<string, string> = {}, text?: string) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};
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

/** Works at `/projects/trace`, `/projects/trace/` and `/index.html` alike. */
const base = location.pathname.replace(/index\.html$/, '').replace(/\/?$/, '/');
const relative = (href: string) => (/^(https?:|#)/.test(href) ? href : location.protocol === 'file:' ? href : base + href);

// The hairline: the panel's recorded width across the whole session.
{
  const ridge = $('ridge') as unknown as SVGSVGElement;
  const width = 1000;
  const height = 300;
  ridge.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const peak = Math.max(...data.ridge.map((p) => p.w));
  const y = (w: number) => height - 8 - (w / peak) * (height - 40);
  const x = (t: number) => (t / data.ridgeEnd) * width;
  const d = data.ridge.map((p, i) => {
    const next = data.ridge[i + 1];
    const gap = next && next.t - p.t > 200;
    return `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.w).toFixed(1)}${gap ? `L${x(p.t + 100).toFixed(1)} ${y(0)}L${x(next.t).toFixed(1)} ${y(0)}` : ''}`;
  }).join('');
  shape('path', '', ridge).setAttribute('d', `M0 ${y(0)}${d.replace('M', 'L')}L${width} ${y(0)}`);
}

for (const t of data.tiles) {
  const tile = el('div', { class: 'tile' });
  tile.append(el('b', {}, t.value), el('span', {}, t.label));
  $('tiles').append(tile);
}

interface Stage {
  root: HTMLElement;
  svg: SVGSVGElement;
  line: Timelines;
  other: Timelines;
  view: Element;
  nodes: Map<string, { rect: Element; name: Element }>;
  ghost: Element;
  panel: Element;
  trail: Element;
  focus: Element;
  gap: Element;
  gapLabel: Element;
  state: HTMLElement;
  focusValue: HTMLElement;
}

let scene = data.scenes[0]!;
let stages: Stage[] = [];
let frame: Frame = { x: 0, y: 0, w: 1, h: 1 };
let busy: { t: number }[] = [];
let time = 0;
let end = 1;
let playing = false;
let last = 0;
let raf = 0;
/** The opening still sits on the failure. The first play starts from the top. */
let poster = false;

function buildStage(title: string, side: Scene['baseline'], line: Timelines, other: Timelines, failing: boolean): Stage {
  const root = el('figure', { class: failing ? 'stage is-failing' : 'stage' });
  const caption = el('figcaption');
  caption.append(el('b', {}, title), el('span', {}, side.label));
  const svg = document.createElementNS(SVG, 'svg');
  set(svg, { viewBox: `${frame.x} ${frame.y} ${frame.w} ${frame.h}`, role: 'img', preserveAspectRatio: 'xMidYMid meet' });
  const unit = Math.max(frame.w, frame.h) / 100;
  const view = shape('rect', 's-view', svg);
  const nodes: Stage['nodes'] = new Map();
  for (const name of Object.keys(scene.scenario.targets)) {
    if (name === scene.primary || !scene.scenario.targets[name]!.traceId) continue;
    const rect = shape('rect', 's-node', svg);
    set(rect, { rx: unit * 0.5 });
    const label = shape('text', 's-name', svg);
    label.textContent = scene.scenario.targets[name]!.name ?? name;
    set(label, { 'font-size': unit * 2.6 });
    nodes.set(name, { rect, name: label });
  }
  const ghost = shape('rect', 's-ghost', svg);
  const panel = shape('rect', 's-panel', svg);
  set(ghost, { rx: unit * 0.7 });
  set(panel, { rx: unit * 0.7 });
  const trail = shape('polyline', 's-trail', svg);
  const gap = shape('line', 's-gap', svg);
  const gapLabel = shape('text', 's-gap-label', svg);
  set(gapLabel, { 'font-size': unit * 3.2 });
  const focus = shape('rect', 's-focus', svg);
  set(focus, { rx: unit * 1 });
  const readout = el('dl', { class: 'readout' });
  const state = el('dd');
  const focusValue = el('dd');
  const a = el('div');
  a.append(el('dt', {}, scene.stateKey), state);
  const b = el('div');
  b.append(el('dt', {}, 'focus'), focusValue);
  readout.append(a, b);
  root.append(caption, svg, readout);
  return { root, svg, line, other, view, nodes, ghost, panel, trail, focus, gap, gapLabel, state, focusValue };
}

function drawStage(stage: Stage, title: string, failing: boolean): void {
  const { line } = stage;
  const vp = viewportAt(line, time, scene.scenario.viewport);
  set(stage.view, { x: 0.5, y: 0.5, width: vp.width - 1, height: vp.height - 1 });
  const unit = Math.max(frame.w, frame.h) / 100;
  for (const [name, node] of stage.nodes) {
    const r = rectAt(line, name, time);
    show(node.rect, !!r);
    show(node.name, !!r);
    if (!r) continue;
    set(node.rect, { x: r.x, y: r.y, width: r.w, height: r.h });
    set(node.name, { x: r.x + r.w / 2, y: r.y + r.h + unit * 3 });
  }
  const r = rectAt(line, scene.primary, time);
  show(stage.panel, !!r);
  if (r) set(stage.panel, { x: r.x, y: r.y, width: r.w, height: r.h });
  const g = rectAt(stage.other, scene.primary, time);
  const moved = !!r && !!g && Math.hypot(r.x - g.x, r.y - g.y) > 2;
  show(stage.ghost, moved);
  if (g) set(stage.ghost, { x: g.x, y: g.y, width: g.w, height: g.h });
  const trail = trailAt(line, scene.primary, time);
  show(stage.trail, trail.length > 1);
  stage.trail.setAttribute('points', trail.map((p) => `${p.x},${p.y}`).join(' '));

  // The gap the requirement measured, shown once the failure has happened.
  const fail = failing && time >= scene.failure.t && time <= scene.failure.t + 900 && trail.length > 0;
  const trigger = rectAt(line, 'trigger', time);
  show(stage.gap, fail && !!trigger);
  show(stage.gapLabel, fail && !!trigger);
  if (fail && trigger) {
    const start = trail[0]!;
    const tx = trigger.x + trigger.w / 2;
    const ty = trigger.y + trigger.h / 2;
    set(stage.gap, { x1: start.x, y1: start.y, x2: tx, y2: ty });
    set(stage.gapLabel, { x: (start.x + tx) / 2, y: (start.y + ty) / 2 - unit * 1.2 });
    stage.gapLabel.textContent = `${scene.failure.px} px`;
  }

  const focus = focusAt(line, time);
  const name = focus ? Object.keys(scene.scenario.targets).find((n) => scene.scenario.targets[n]?.traceId === focus.traceId) : undefined;
  const fr = name ? rectAt(line, name, time) : null;
  show(stage.focus, !!fr);
  if (fr) set(stage.focus, { x: fr.x - unit * 0.7, y: fr.y - unit * 0.7, width: fr.w + unit * 1.4, height: fr.h + unit * 1.4 });
  const state = stateAt(line, scene.stateKey, time) ?? 'none';
  stage.state.textContent = state;
  stage.focusValue.textContent = name ? scene.scenario.targets[name]!.name ?? name : focusName(focus);
  stage.svg.setAttribute('aria-label', `${title} at ${Math.round(time)} ms. ${scene.stateKey} is ${state}. Focus is on ${focusName(focus)}.`);
}

function draw(): void {
  drawStage(stages[0]!, 'Baseline', scene.failing === 'baseline');
  drawStage(stages[1]!, 'Candidate', scene.failing === 'candidate');
  ($('time') as HTMLInputElement).value = String(Math.round((time / end) * 1000));
  $('clock').textContent = `${formatMs(time)} of ${formatMs(end)}`;
  const failed = time >= scene.failure.t;
  const verdict = $('verdict');
  const text = failed ? scene.failure.sentence : scene.passing;
  if (verdict.textContent !== text) verdict.textContent = text;
  verdict.className = failed ? (scene.resolved ? 'verdict good' : 'verdict bad') : 'verdict';
  const current = lastAt(scene.scenario.actions.map((a) => ({ t: a.at })), time);
  [...$('steps').querySelectorAll('button')].forEach((b, i) => (i === current ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
}

function pause(): void {
  playing = false;
  cancelAnimationFrame(raf);
  $('play').textContent = time >= end ? 'Replay' : 'Play';
}

function tick(now: number): void {
  if (!playing) return;
  const speed = Number(($('speed') as HTMLSelectElement).value);
  time = skipIdle(busy, Math.min(end, time + (now - last) * speed));
  last = now;
  draw();
  if (time >= end) return pause();
  raf = requestAnimationFrame(tick);
}

function play(): void {
  if (time >= end || poster) time = 0;
  poster = false;
  playing = true;
  last = performance.now();
  $('play').textContent = 'Pause';
  raf = requestAnimationFrame(tick);
}

function seek(t: number): void {
  pause();
  poster = false;
  time = Math.max(0, Math.min(end, t));
  $('play').textContent = time >= end ? 'Replay' : 'Play';
  draw();
}

function load(next: Scene): void {
  pause();
  scene = next;
  const base = timelines(scene.baseline.events);
  const candidate = timelines(scene.candidate.events);
  frame = frameOf([base, candidate], scene.scenario.viewport);
  end = Math.max(base.end, candidate.end);
  busy = [...new Set([...scene.baseline.events, ...scene.candidate.events].map((e) => e.t))].sort((a, b) => a - b).map((t) => ({ t }));
  stages = [
    buildStage('Baseline', scene.baseline, base, candidate, scene.failing === 'baseline'),
    buildStage('Candidate', scene.candidate, candidate, base, scene.failing === 'candidate'),
  ];
  $('stages').replaceChildren(...stages.map((s) => s.root));
  $('scene-note').textContent = scene.note;
  const steps = $('steps');
  steps.replaceChildren(...scene.scenario.actions.map((a) => {
    const row = el('li');
    const button = el('button', { type: 'button' });
    button.append(el('span', {}, formatMs(a.at)), el('span', {}, a.note ?? a.type));
    button.addEventListener('click', () => seek(a.at));
    row.append(button);
    return row;
  }));
  [...$('scenes').querySelectorAll('button')].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === scene.id)));
  time = Math.min(end, scene.failure.t + 48);
  poster = true;
  $('play').textContent = 'Play';
  draw();
}

for (const s of data.scenes) {
  const button = el('button', { class: 'pill ghost small', type: 'button', 'data-id': s.id, 'aria-pressed': 'false' }, s.label);
  button.addEventListener('click', () => load(s));
  $('scenes').append(button);
}

$('play').addEventListener('click', () => (playing ? pause() : play()));
$('hero-play').addEventListener('click', () => {
  document.getElementById('replay')!.scrollIntoView();
  poster = true;
  play();
});
$('time').addEventListener('input', (e) => seek((Number((e.target as HTMLInputElement).value) / 1000) * end));
$('jump').addEventListener('click', () => seek(scene.failure.t + 48));

$('evidence-text').textContent = data.evidence.text;
{
  const head = el('thead');
  const row = el('tr');
  data.evidence.head.forEach((h) => row.append(el('th', { scope: 'col' }, h)));
  head.append(row);
  const body = el('tbody');
  for (const r of data.evidence.rows) {
    const tr = el('tr');
    r.forEach((cell, i) => tr.append(el(i ? 'td' : 'th', i ? {} : { scope: 'row' }, cell)));
    body.append(tr);
  }
  $('table').append(head, body);
}
$('table-note').textContent = data.evidence.note;
for (const c of data.checks) $('checks').append(el('li', {}, c));
for (const l of data.limits) $('limits').append(el('li', {}, l));
for (const link of data.foot.links) $('foot').append(el('a', { href: relative(link.href) }, link.label));
$('foot').append(el('span', {}, data.foot.provenance));

load(data.scenes[0]!);
