import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Scenario } from '../src/scenario/schema.ts';
import { parseScenario } from '../src/scenario/validate.ts';
import type { ReportCase, ReportData } from '../viewer/src/types.ts';
import { primaryViolation } from '../viewer/src/model.ts';

/**
 * Writes the public project page, `demo/index.html`, beside the two full reports.
 * Every number comes from a saved run or a demo report, and the checks here stop
 * the build when a sentence on the page would no longer be true.
 */
const root = resolve(import.meta.dirname, '..');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const result = <T>(path: string): T => read(join(root, 'results', path));

interface Score { truePositives: number; falsePositives: number }
interface Summary { seeded: number; clean: number; trace: Score; controls: { traceDiff: Score } }
interface Frames { width: number; height: number; scale: number; runs: Record<string, { t: number; f: string }[]> }

const KEEP = new Set(['geometry', 'focus', 'viewport']);
/** The recorder keeps 0.01 px, and the page measures from these, so nothing coarser will do. */
const round = (n: number) => Math.round(n * 100) / 100;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Drops what the page does not draw, which is most of the report's size. */
function slim(events: ReportCase['candidate']['events']) {
  return events.filter((e) => KEEP.has(e.k)).map((e) => {
    if (e.k === 'geometry') return { k: e.k, t: e.t, target: e.target, rect: e.rect && { x: round(e.rect.x), y: round(e.rect.y), w: round(e.rect.w), h: round(e.rect.h) } };
    if (e.k === 'focus') return { k: e.k, t: e.t, ref: e.ref && { traceId: e.ref.traceId, tag: e.ref.tag } };
    return e;
  });
}

const atOrBefore = (list: { t: number; f: string }[], t: number) => list.filter((e) => e.t <= t).at(-1)!.f;

/** A resize note says which way the window moved in its own session, so the page names the width. */
function stepLabel(a: { type: string; note?: string; width?: number }): string {
  if (a.type === 'resize') return `Resize to ${a.width} px`;
  const note = a.note ?? a.type;
  return note[0]!.toUpperCase() + note.slice(1);
}

/**
 * The reduced scenario a visitor copies. A note is a label carried over from the
 * session it was written for, so a resize note is rewritten to say the width,
 * the same way the page labels the step. Nothing that runs is changed.
 */
export function scenarioToCopy(saved: Scenario): string {
  const actions = saved.actions.map((a) => (a.type === 'resize' ? { ...a, note: stepLabel(a).toLowerCase() } : a));
  return JSON.stringify({ ...saved, actions }, null, 2) + '\n';
}

export async function buildPage(demoDir: string): Promise<void> {
  const regression = read<ReportData>(join(demoDir, 'regression/report.json'));
  const fixed = read<ReportData>(join(demoDir, 'fixed/report.json'));
  const frames = read<Frames>(join(demoDir, 'frames/index.json'));
  const progress = read<{ fingerprint: string; state: { attempts: { kept: number[]; outcome: string }[] } }>(join(demoDir, 'reduction.attempts.json'));
  const reduced = regression.cases.find((c) => c.id === 'reduced');
  const original = regression.cases.find((c) => c.id === 'original');
  const fix = fixed.cases[0];
  const reduction = regression.reduction;
  if (!reduced || !original || !fix || !reduction) throw new Error('Run the demo first: the page needs both reports.');

  // Each claim the page makes about the runs, tested against the runs.
  const violation = primaryViolation(original);
  const px = violation ? Number(/(\d+) px/.exec(violation.sentence)?.[1]) : NaN;
  if (!violation || !px) throw new Error('The original run has no measured gap.');
  if (primaryViolation(reduced)?.fingerprint !== violation.fingerprint) throw new Error('Reduction changed the failure.');
  if (primaryViolation(reduced)?.at.t !== violation.at.t) throw new Error('The failure is at a different time after reduction, so the shared clock no longer holds.');
  if (fix.comparison.verdict !== 'fixed') throw new Error('The fix report no longer reports a fix.');
  if (progress.fingerprint !== reduction.fingerprint) throw new Error('The saved attempts belong to a different failure.');
  if (progress.state.attempts.length !== reduction.attempts) throw new Error('The saved attempts do not match the reduction.');
  for (const [outcome, count] of Object.entries(reduction.outcomes)) {
    if (progress.state.attempts.filter((a) => a.outcome === outcome).length !== count) throw new Error(`The saved attempts disagree on ${outcome}.`);
  }
  const jumpT = violation.at.t;
  const panelRects = (events: ReportCase['candidate']['events']) => events.flatMap((e) => (e.k === 'geometry' && e.target === 'panel' && e.rect && e.t >= jumpT ? [{ t: e.t, rect: e.rect }] : []));
  const broken = panelRects(original.candidate.events)[0]!.rect;
  const good = panelRects(original.baseline.events)[0]!.rect;
  const settled = panelRects(original.candidate.events).find((p, i, all) => p.rect.w === all.at(-1)!.rect.w)!.t;
  const trigger = original.baseline.events.flatMap((e) => (e.k === 'geometry' && e.target === 'trigger' && e.rect && e.t <= jumpT ? [e.rect] : [])).at(-1)!;
  if (Math.abs(good.x - trigger.x) > 1) throw new Error('The last good build no longer starts on Inspect.');
  if (Math.round(broken.x - trigger.x) !== px) throw new Error('The gap on the page is no longer to the right of Inspect.');
  for (const id of ['original', 'reduced']) {
    const a = frames.runs[`${id}-baseline`]!;
    const b = frames.runs[`${id}-candidate`]!;
    for (let t = 0; t < jumpT; t += 16) {
      if (atOrBefore(a, t) !== atOrBefore(b, t)) throw new Error(`${id}: the builds differ at ${t} ms, before the jump.`);
    }
    if (atOrBefore(a, Infinity) !== atOrBefore(b, Infinity)) throw new Error(`${id}: the final screenshots differ, so a final screenshot would not miss this.`);
  }

  const tuned = result<Summary>('corpus-chromium/summary.json');
  const holdout = result<Summary>('holdout/summary.json');
  const written = result<{ rows: { originalActions: number; reducedActions: number[] }[] }>('reduction-written/summary.json').rows[0]!;
  const generated = result<{ rows: { originalActions: number; reducedActions: number[] }[] }>('reduction/summary.json');
  const random = result<Record<string, { seeds: number; completed: number; flagged: number }>>('random/summary.json');
  const completed = Object.values(random).reduce((n, r) => n + r.completed, 0);
  const flagged = Object.values(random).reduce((n, r) => n + r.flagged, 0);
  const of = (a: number, b: number) => `${a} of ${b}`;
  const longest = generated.rows.find((r) => r.originalActions === 18);
  if (!longest?.reducedActions.includes(2)) throw new Error('The generated reduction changed.');

  const allSteps = original.scenario.actions;
  const steps = allSteps.map((a) => ({ at: a.at, label: stepLabel(a) }));
  const kept = reduction.keptIndices;
  const jumpStep = allSteps.findIndex((a) => a.at === jumpT);
  if (jumpStep < 0 || !kept.includes(jumpStep)) throw new Error('The jump is not on a kept step.');
  // The broken build keeps where Inspect sat the first time the panel opened.
  const firstTrigger = original.baseline.events.flatMap((e) => (e.k === 'geometry' && e.target === 'trigger' && e.rect ? [e.rect] : []))[0]!;
  if (Math.abs(firstTrigger.x - broken.x) > 1) throw new Error('The broken build no longer starts where Inspect first sat.');

  // The reducer's own bookkeeping, replayed: which steps were still in play after each attempt.
  const attempts = progress.state.attempts;
  let alive = allSteps.map((_, i) => i);
  for (const attempt of attempts) if (attempt.outcome === 'fails') alive = attempt.kept;
  if (alive.join() !== kept.join()) throw new Error('The saved attempts do not end on the kept steps.');
  const lastAccepted = attempts.findLastIndex((a) => a.outcome === 'fails');
  const proof = attempts.slice(lastAccepted + 1);
  if (!reduction.oneMinimal || proof.length !== kept.length || proof.some((a) => a.kept.length !== kept.length - 1)) throw new Error('The last attempts no longer remove one kept step each.');

  // The scenario a visitor copies must be the saved one, with only a resize label changed.
  const savedReduced = read<Scenario>(join(demoDir, 'reduced.scenario.json'));
  const copy = scenarioToCopy(savedReduced);
  const copied = parseScenario(JSON.parse(copy));
  const strip = (s: Scenario) => JSON.stringify({ ...s, actions: s.actions.map((a) => ({ ...a, note: undefined })) });
  if (strip(copied) !== strip(parseScenario(savedReduced))) throw new Error('The scenario to copy differs from the saved one in more than a label.');
  if (copied.actions.map(stepLabel).join() !== kept.map((i) => steps[i]!.label).join()) throw new Error('The scenario to copy is not the kept steps.');

  // The command on the page has to be one the README gives.
  const command = 'pnpm trace run my.scenario.json --baseline tabs@main --candidate tabs@branch';
  const register = 'pnpm trace fixtures add path/to/fixture.json';
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const line of [command, register]) if (!readme.includes(line)) throw new Error(`The README no longer gives: ${line}`);

  const axisEnd = Math.ceil(Math.max(...[original, reduced].map((c) => c.candidate.events.at(-1)!.t)) / 16) * 16;
  const before = 'The two builds match so far, so watch where the panel starts when Inspect reopens it.';
  const after = 'Both builds end on the same frame, so a final screenshot would miss this.';
  const where = 'where Inspect sat when the panel first opened';
  const data = {
    frame: { width: frames.width, height: frames.height, scale: frames.scale },
    axisEnd,
    jump: { t: jumpT, settled, px, step: jumpStep },
    steps,
    attempts,
    targets: Object.entries(original.scenario.targets).flatMap(([name, t]) => (t.traceId && name !== 'panel' ? [{ name, id: t.traceId, label: t.name ?? name }] : [])),
    sessions: [
      {
        id: 'original', count: `${allSteps.length} steps`, kept: allSteps.map((_, i) => i),
        good: 'original-baseline', bad: 'original-candidate',
        verdict: { before, jump: `The panel should open from Inspect, but here it starts ${px} px to the right, ${where}.`, after },
      },
      {
        id: 'reduced', count: `${kept.length} of ${allSteps.length} steps`, kept,
        good: 'reduced-baseline', bad: 'reduced-candidate',
        verdict: { before, jump: `Trace deleted the other ${allSteps.length - kept.length} steps and the panel still starts ${px} px to the right of Inspect.`, after },
      },
    ],
    runs: Object.fromEntries(['original-baseline', 'original-candidate', 'reduced-baseline', 'reduced-candidate'].map((key) => {
      const [id, side] = key.split('-') as ['original' | 'reduced', 'baseline' | 'candidate'];
      const c = id === 'original' ? original : reduced;
      return [key, { frames: frames.runs[key], events: slim(c[side].events) }];
    })),
    scenario: copy,
  };

  const rows: [string, string, string][] = [
    ['Held-out fixtures', `${of(holdout.trace.truePositives, holdout.seeded)} seeded bugs caught`, `One fixture family held out of a corpus I wrote, with ${of(holdout.trace.falsePositives, holdout.clean)} clean builds wrongly flagged. It ran once, on an earlier oracle.`],
    ['Tuned corpus', `${of(tuned.trace.truePositives, tuned.seeded)} seeded bugs caught`, `This corpus is tuned and I wrote it, and a control that compares two traces also finds all ${tuned.controls.traceDiff.truePositives}, so the score says little by itself.`],
    ['Against comparison', 'Finds no more bugs', 'Trace rejects most legitimate changes and can fail a bug both builds share, which a comparison cannot do.'],
    ['Reduction', `${longest.originalActions} actions to 2, and ${written.originalActions} to ${written.reducedActions[0]}`, `The failure on this page is the ${written.originalActions} to ${written.reducedActions[0]} session. Reduced failures reproduced in ${of(reduction.reducedReproduction.reproduced, reduction.reducedReproduction.runs)} fresh runs and ${of(reduction.baselineReproduction.reproduced, reduction.baselineReproduction.runs)} baseline runs.`],
    ['Random sessions', `${of(flagged, completed)} sessions flagged`, 'Both are a real bug in a fixture I had labeled correct, found on a reduced requirement list by the stricter final oracle.'],
  ];
  const limits = [
    'The corpus is small and I wrote it, so it says nothing about how many real bugs Trace would catch.',
    'The holdout ran once on an earlier oracle, and no result tests the final oracle on unseen code.',
    'Trace only finds what a scenario reaches, and a requirement it never reaches reads as not exercised.',
    'Controlled time does not hold every channel, such as workers and ResizeObserver delivery.',
    'Timings are lab numbers from one machine, and they are not INP.',
    'Nobody outside this project has used it yet.',
  ];
  const outcomes = reduction.outcomes;
  const code = (id: string, text: string, label: string) => `<div class="code"><pre><code id="${id}">${escapeHtml(text)}</code></pre><button class="control outline swap" type="button" data-copy="${id}"><span class="on" data-label="idle">Copy</span><span data-label="done">Copied</span><span data-label="failed">Failed</span><span class="sr-only"> ${escapeHtml(label)}</span></button></div>`;
  const details = [
    '<p class="prose">Trace replays one list of user actions on two builds of a React component under a controlled clock, and judges each build against written requirements that never look at the other build. When a build fails, Trace deletes actions until only the cause is left.</p>',
    '<p class="prose">The bug on this page is one of the seeded bugs, in a small inspector fixture on a corpus I wrote. The broken build keeps the position of the Inspect button from the first time it opens, so after the window changes size the panel grows from the old spot for about a quarter of a second, and then both builds show the same frame.</p>',
    `<p class="prose">The grid of steps and attempts is the whole reduction. Each column is one of the ${reduction.attempts} attempts, and a mark means that step was in it. ${outcomes.fails} attempts kept the failure, ${outcomes.passes} lost it, ${outcomes.invalid} could not run and ${outcomes['other-failure']} failed in a different way. The last ${proof.length} each remove one of the ${kept.length} remaining steps, and none of them keeps the failure, which is why Trace stops at ${kept.length}.</p>`,
    '<h3>Run it on your own component</h3>',
    '<p class="prose">Mark the elements you care about with <code>data-trace-id</code>, write a scenario that says what the user does and what must stay true, and register both builds in a fixture manifest. Then one command replays the scenario on the two builds and writes a report like the one behind this page.</p>',
    code('cmd-register', register, 'the command that registers a fixture'),
    code('cmd-run', command, 'the command that runs a scenario'),
    '<p class="prose">The <a href="https://github.com/qbeka/trace-interactions#use-it-on-your-component">README</a> has the setup, and <a href="https://github.com/qbeka/trace-interactions/blob/main/docs/SCENARIOS.md">the scenario guide</a> lists every action and requirement.</p>',
    '<h3>Results</h3>',
    `<dl class="results">${rows.map(([name, value, scope]) => `<div><dt>${escapeHtml(name)}</dt><dd><b>${escapeHtml(value)}</b>${escapeHtml(scope)}</dd></div>`).join('')}</dl>`,
    '<h3>Limits</h3>',
    `<ul class="limits">${limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    '<h3>Method</h3>',
    '<p class="prose">The frames are screenshots of the real fixture, taken by Trace on a rerun of the saved scenarios and kept only because the rerun recorded the same geometry as the saved report. Overlay, Swipe and Difference blend those screenshots in the browser and change nothing in them. The dashed outlines, the ruler and everything in Geometry are drawn from the rectangles in that report. Playback slows down at the failure and skips the quiet stretches, and the clock always shows the recorded time. The <a href="regression/">full report</a>, the <a href="fixed/">report after the fix</a> and the <a href="https://github.com/qbeka/trace-interactions/blob/main/docs/LIMITS.md">limits</a> have the rest.</p>',
  ].join('\n      ');

  const script = await build({
    entryPoints: [join(root, 'site/page.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const fonts = join(demoDir, 'fonts');
  mkdirSync(fonts, { recursive: true });
  const geist = join(root, 'node_modules/geist/dist/fonts');
  copyFileSync(join(geist, 'geist-serif/GeistSerif-Regular.woff2'), join(fonts, 'GeistSerif-Regular.woff2'));
  copyFileSync(join(geist, 'geist-sans/Geist-Regular.woff2'), join(fonts, 'Geist-Regular.woff2'));
  copyFileSync(join(geist, 'geist-sans/Geist-Medium.woff2'), join(fonts, 'Geist-Medium.woff2'));
  copyFileSync(join(root, 'licenses/Geist-OFL-1.1.txt'), join(fonts, 'Geist-OFL-1.1.txt'));

  const css = readFileSync(join(root, 'site/foundation.css'), 'utf8') + readFileSync(join(root, 'site/styles.css'), 'utf8');
  const first = [frames.runs['original-baseline']!, frames.runs['original-candidate']!].map((list) => atOrBefore(list, jumpT));
  const preload = first.map((f) => `<link rel="preload" href="./frames/${f}.webp" as="image" type="image/webp">`).join('\n');
  // Replacers are functions, so a `$` in the data is never read as a pattern.
  const html = readFileSync(join(root, 'site/template.html'), 'utf8')
    .replace('<!--PRELOAD-->', () => preload)
    .replace('<!--DETAILS-->', () => details)
    .replace('/*STYLES*/', () => css)
    .replace('/*DATA*/', () => JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace('/*SCRIPT*/', () => script.outputFiles[0]!.text.replace(/<\/script/g, '<\\/script'));
  writeFileSync(join(demoDir, 'index.html'), html);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildPage(resolve(process.argv[2] ?? join(root, 'demo')));
  console.log('Project page written.');
}
