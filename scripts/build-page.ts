import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Scenario } from '../src/scenario/schema.ts';
import { parseScenario } from '../src/scenario/validate.ts';
import type { ReportCase, ReportData } from '../viewer/src/types.ts';
import { describeRequirement, primaryViolation, requirementStatus } from '../viewer/src/model.ts';
import { cellsOf } from '../site/cells.ts';
import { coreNote, endsLine, frameLabel, lineProblem, OUTCOMES, readout, SAID, SOURCE, VIEWS } from '../site/lines.ts';
import { attemptNote } from '../site/reduction.ts';

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

/** The text a visitor can read in a piece of markup: what sits between tags, and what a label attribute says. */
export function markupLines(html: string): string[] {
  // A key cap is a key, not a sentence, and a passage of prose or a line of code is checked by eye.
  const bare = html.replace(/<(script|style|kbd|pre)\b[\s\S]*?<\/\1>/g, '').replace(/<p class="prose[^"]*"[\s\S]*?<\/p>/g, '').replace(/<code\b[\s\S]*?<\/code>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const text = [...bare.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim());
  const labels = [...bare.matchAll(/\b(?:aria-label|title|alt|content)="([^"]*)"/g)].map((m) => m[1]!);
  return [...text, ...labels].filter(Boolean);
}

/**
 * Every one-line status, hint, caption, heading and label on the page is one sentence
 * with no closing period. Passages of prose are ordinary writing and are not checked here.
 */
export function stageLines(data: { steps: { label: string }[]; attempts: { kept: number[]; outcome: string }[]; sessions: { verdict: Record<string, string> }[] }, template: string, css: string, story = ''): string[] {
  return [
    ...data.sessions.flatMap((s) => Object.values(s.verdict)),
    ...data.attempts.map((_, n) => attemptNote(data.attempts, data.steps.length, n)),
    attemptNote(data.attempts, data.steps.length, data.attempts.length),
    ...data.steps.map((s) => s.label),
    ...Object.values(SOURCE),
    ...Object.values(OUTCOMES),
    ...VIEWS.flatMap((v) => [readout(v, true), readout(v, false), coreNote(v)]),
    SAID.finished, SAID.scenario, SAID.command, SAID.copyFailed, SAID.replaying(data.attempts.length), ...VIEWS.map((v) => SAID.view(v)),
    SAID.scan(96), SAID.scanShort(96), SAID.whole(true), SAID.whole(false), SAID.wholeLabel(true), SAID.wholeLabel(false), SAID.act(true), SAID.act(false),
    SAID.duration(240), SAID.inPlay(4, 14, true), SAID.inPlay(8, 14, false), SAID.goodAt(4000),
    endsLine(true, 58, false), endsLine(true, 0, false), endsLine(false, 0, true), endsLine(false, 0, false),
    ...[[true, 80], [true, 0], [false, 0]].map(([differs, px]) => frameLabel(4000, 12, data.steps.length, 'Reopen', differs as boolean, px as number)),
    ...markupLines(template),
    ...markupLines(story),
    ...[...css.matchAll(/content:\s*'([^']*)'/g)].map((m) => m[1]!),
  ].filter(Boolean);
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
  const before = 'The two builds match so far, so watch where the panel starts when Inspect reopens it';
  const after = 'Both builds end on the same frame, so a final screenshot would miss this';
  const where = 'where Inspect sat when the panel first opened';
  // The part of the frame the stage shows: where the panel is from the reopen onward, on either build.
  const panels = [original, reduced].flatMap((c) => [c.baseline, c.candidate]).flatMap((side) => panelRects(side.events).map((p) => p.rect));
  const leftmost = Math.min(...panels.map((r) => r.x));
  const lowest = Math.max(...panels.map((r) => r.y + r.h));
  const crop = { x: Math.floor((leftmost - 12) / 8) * 8, y: 0, w: 0, h: 0 };
  crop.w = frames.width - crop.x;
  crop.h = Math.ceil((lowest + 18) / 4) * 4;
  if (crop.h > frames.height || crop.w < 400) throw new Error('The panel no longer fits the part of the frame the page shows.');
  // The scan line opens on a row the panel covers from its second frame to its last.
  const scanY = 96;
  const during = panelRects(original.candidate.events).filter((p) => p.t > jumpT && p.t <= settled);
  if (during.some((p) => scanY < p.rect.y || scanY > p.rect.y + p.rect.h)) throw new Error('The opening scan line no longer crosses the panel during the jump.');

  const data = {
    frame: { width: frames.width, height: frames.height, scale: frames.scale },
    crop,
    scanY,
    axisEnd,
    jump: { t: jumpT, settled, px, step: jumpStep },
    steps,
    attempts,
    targets: Object.entries(original.scenario.targets).flatMap(([name, t]) => (t.traceId && name !== 'panel' ? [{ name, id: t.traceId, label: t.name ?? name }] : [])),
    sessions: [
      {
        id: 'original', count: `${allSteps.length} steps`, kept: allSteps.map((_, i) => i),
        good: 'original-baseline', bad: 'original-candidate',
        verdict: { before, jump: `The panel should open from Inspect, but here it starts ${px} px to the right, ${where}`, after },
      },
      {
        id: 'reduced', count: `${kept.length} of ${allSteps.length} steps`, kept,
        good: 'reduced-baseline', bad: 'reduced-candidate',
        verdict: { before, jump: `Trace deleted the other ${allSteps.length - kept.length} steps and the panel still starts ${px} px to the right of Inspect`, after },
      },
    ],
    runs: Object.fromEntries(['original-baseline', 'original-candidate', 'reduced-baseline', 'reduced-candidate'].map((key) => {
      const [id, side] = key.split('-') as ['original' | 'reduced', 'baseline' | 'candidate'];
      const c = id === 'original' ? original : reduced;
      return [key, { frames: frames.runs[key], events: slim(c[side].events) }];
    })),
    scenario: copy,
  };

  // What the story under the stage says about the recording, counted from the recording.
  const cells = cellsOf({ frames: frames.runs['original-baseline']!, events: [] }, { frames: frames.runs['original-candidate']!, events: [] }, steps, data.sessions[0]!.kept);
  const differing = cells.filter((c) => c.differs);
  if (!differing.length || differing[0]!.t !== jumpT || differing.at(-1)!.t >= settled) throw new Error('The frames that differ are no longer the frames of the jump.');
  if (cells.at(-1)!.differs) throw new Error('The last frames differ.');
  const jumpMs = settled - jumpT;

  const limits = [
    'The corpus is small and I wrote it, so it says nothing about how many real bugs Trace would catch',
    'The holdout ran once on an earlier oracle, and no result tests the final oracle on unseen code',
    'Trace only finds what a scenario reaches, and a requirement it never reaches reads as not exercised',
    'Controlled time does not hold every channel, such as workers and ResizeObserver delivery',
    'Timings are lab numbers from one machine, and they are not INP',
    'Nobody outside this project has used it yet',
  ];
  const outcomes = reduction.outcomes;
  const code = (id: string, text: string, label: string) => `<div class="code"><pre><code id="${id}">${escapeHtml(text)}</code></pre><button class="control outline swap" type="button" data-copy="${id}"><span class="on" data-label="idle">Copy</span><span data-label="done">Copied</span><span data-label="failed">Failed</span><span class="sr-only"> ${escapeHtml(label)}</span></button></div>`;
  const dots = (n: number, cls = '') => `<i class="dot${cls ? ` ${cls}` : ''}"></i>`.repeat(n);
  const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);
  const arrow = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Each requirement as the scenario states it, with what each build did against it.
  const STATUS: Record<string, [string, string]> = { held: ['held', 'Held'], broken: ['broken', 'Broken'], 'not exercised': ['idle', 'Not reached'], 'not run': ['idle', 'Not run'] };
  const mark = (status: string, extra = '') => `<span class="mark ${STATUS[status]![0]}">${STATUS[status]![1]}${extra}</span>`;
  const ruleRows = original.scenario.requirements.map((r, i) => {
    const b = requirementStatus(i, original.baseline);
    const c = requirementStatus(i, original.candidate);
    const broke = i === violation.index;
    return `<tr${broke ? ' class="broke"' : ''}><td>${escapeHtml(capital(describeRequirement(r)))}<code>${escapeHtml(JSON.stringify(r).replace(/([,:])/g, '$1 '))}</code></td><td>${mark(b)}</td><td>${mark(c, broke ? `, ${px} px off at ${jumpT} ms` : '')}</td></tr>`;
  }).join('');
  if (violation.index === undefined || requirementStatus(violation.index, original.candidate) !== 'broken' || requirementStatus(violation.index, original.baseline) !== 'held') throw new Error('The failed requirement is no longer broken on one build and held on the other.');
  const verdictCell = (name: string, before: string, after: string, note: string, href = '', here = false) => {
    const inner = `<b>${name}</b><span class="pair">${mark(before)}${mark(after)}</span><small>${note}</small>`;
    return href ? `<a href="${href}">${inner}</a>` : `<div${here ? ' class="here"' : ''}>${inner}</div>`;
  };

  const writtenKept = new Set(kept);
  const story = [
    '<section class="chapter reveal">',
    '<h2 class="display" id="details-title">Both builds end on the same frame</h2>',
    `<p class="prose">A test that compares final screenshots passes this change. The last frame of the broken build is the last frame of the good build, pixel for pixel. The bug is in the ${jumpMs} ms after Inspect reopens the panel, where ${differing.length} recorded frames differ and then stop differing.</p>`,
    `<p class="prose">The broken build keeps the position of the Inspect button from the first time the panel opens. After the window changes size, the panel grows from that old spot, ${px} px to the right, and slides home. It is one of the seeded bugs, in a small inspector fixture on a corpus I wrote.</p>`,
    '<figure class="figure">',
    '<div class="sheet ends" id="ends">',
    '<div class="ends-pair">',
    '<div class="ends-shot"><canvas id="ends-good" role="img" aria-label="Last good build, last frame"></canvas><span class="chip good"><i></i>Last good build</span></div>',
    `<p class="ends-sign"><b id="ends-sign">=</b><small id="ends-time">${cells.at(-1)!.t} ms</small><span id="ends-say">${endsLine(false, 0, true)}</span></p>`,
    '<div class="ends-shot"><canvas id="ends-bad" role="img" aria-label="Broken build, last frame"></canvas><span class="chip bad"><i></i>Broken build</span></div>',
    '</div>',
    '<div class="ends-strip" id="ends-strip"><input id="ends-range" type="range" min="0" step="1" aria-label="Frame of the reopen to compare"></div>',
    '</div>',
    '<figcaption>The last recorded frame of each build, above every frame from the reopen onward, so move across them to find where the two builds part</figcaption>',
    '</figure>',
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">One row of pixels, from every frame</h2>',
    '<p class="prose">The two tall pictures on the stage are slit scans. Each one takes the same single row of pixels out of every recorded frame and stacks the rows in time order, oldest at the top, so a whole session is one image. A panel that opens draws a funnel. A window that narrows draws a step. A frame that was held draws a seam.</p>',
    '<p class="prose">The good build draws the same funnel every time the panel opens. The broken build draws it once more at the bottom, pushed to the right and flat against the edge of the window, and the dashed line beside it is where the recorded rectangles say it should have been. Move the scan line up to the row through Inspect, and the broken panel starts in line with where Inspect stood at the top of the picture, before the window changed size.</p>',
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">Each build is judged on its own</h2>',
    '<p class="prose">Trace does not diff the two builds. A scenario states what must stay true, and each build is replayed under the same controlled clock and judged against that list alone. Here the broken build breaks one requirement and the good build breaks none, and that pair of results is the verdict.</p>',
    '<figure class="figure">',
    `<div class="sheet"><table class="rules"><thead><tr><th scope="col">Requirement, as the scenario states it</th><th scope="col">Last good build</th><th scope="col">Broken build</th></tr></thead><tbody>${ruleRows}</tbody></table></div>`,
    '<div class="sheet verdicts">',
    verdictCell('Pass', 'held', 'held', 'Neither build breaks anything'),
    verdictCell('Regression', 'held', 'broken', 'The report on this page', '', true),
    verdictCell('Fixed', 'broken', 'held', 'The report after the fix', 'fixed/'),
    verdictCell('Shared failure', 'broken', 'broken', 'A comparison would see no difference'),
    '</div>',
    '<figcaption>The five requirements of this session with what each build did against them, and the four verdicts a pair of results can give, old build first</figcaption>',
    '</figure>',
    '<p class="prose" style="margin-top:28px">On the corpus I tuned, comparing two full traces also finds every seeded bug, so requirements catch nothing extra there. What they do is stay quiet: a comparison flags most legitimate changes, because a change is a difference, and it has nothing to say when both builds share a bug.</p>',
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">What was measured</h2>',
    '<p class="prose">Every number here comes from a saved run in the repository, on fixtures and seeded bugs I wrote myself. The corpus is small, so these show that the tool does what it says on code it was built beside, and little about code it has never seen.</p>',
    '<div class="measures">',
    '<figure class="measure">',
    '<h3>Held-out fixtures</h3>',
    `<p class="big"><span><b>${of(holdout.trace.truePositives, holdout.seeded)}</b>seeded bugs caught</span><span class="warn"><b>${of(holdout.trace.falsePositives, holdout.clean)}</b>clean builds wrongly flagged</span></p>`,
    `<dl class="tally"><div><dt>Seeded bugs</dt><dd>${dots(holdout.trace.truePositives)}${dots(holdout.seeded - holdout.trace.truePositives, 'none')}</dd></div><div><dt>Clean builds</dt><dd>${dots(holdout.clean - holdout.trace.falsePositives, 'none')}${dots(holdout.trace.falsePositives, 'wrong')}</dd></div></dl>`,
    '<figcaption class="cap">One fixture family held out of a corpus I wrote, run once on an earlier oracle</figcaption>',
    '</figure>',
    '<figure class="measure">',
    '<h3>Tuned corpus</h3>',
    `<p class="big"><span><b>${of(tuned.trace.truePositives, tuned.seeded)}</b>for Trace, and for a plain comparison</span></p>`,
    `<dl class="tally"><div><dt>Trace</dt><dd>${dots(tuned.trace.truePositives)}</dd></div><div><dt>Comparing two traces</dt><dd>${dots(tuned.controls.traceDiff.truePositives)}</dd></div></dl>`,
    `<figcaption class="cap">This corpus is tuned and I wrote it, and a control that compares two traces also finds all ${tuned.controls.traceDiff.truePositives}, so the score says little by itself</figcaption>`,
    '</figure>',
    '<figure class="measure">',
    '<h3>Reduction</h3>',
    `<p class="big"><span><b>${written.originalActions} to ${written.reducedActions[0]}</b>actions, written by hand</span><span><b>${longest.originalActions} to 2</b>generated</span></p>`,
    `<dl class="tally"><div><dt>The session on this page</dt><dd>${allSteps.map((_, i) => `<i class="dot sq${writtenKept.has(i) ? '' : ' none'}"></i>`).join('')}</dd></div><div><dt>A generated session</dt><dd>${dots(longest.originalActions - 2, 'sq none')}<span class="arrow">${arrow}</span>${dots(2, 'sq')}</dd></div><div><dt>Fresh runs</dt><dd>${dots(reduction.reducedReproduction.reproduced)}${dots(reduction.reducedReproduction.runs - reduction.reducedReproduction.reproduced, 'none')}</dd></div><div><dt>Baseline runs</dt><dd>${dots(reduction.baselineReproduction.reproduced)}${dots(reduction.baselineReproduction.runs - reduction.baselineReproduction.reproduced, 'none')}</dd></div></dl>`,
    `<figcaption class="cap">The reduced failure reproduced in ${of(reduction.reducedReproduction.reproduced, reduction.reducedReproduction.runs)} fresh runs and ${of(reduction.baselineReproduction.reproduced, reduction.baselineReproduction.runs)} baseline runs, after ${reduction.attempts} attempts of which ${outcomes.fails} kept the failure</figcaption>`,
    '</figure>',
    '<figure class="measure">',
    '<h3>Random sessions</h3>',
    `<p class="big"><span><b>${of(flagged, completed)}</b>sessions on correct builds flagged</span></p>`,
    `<div class="field" role="img" aria-label="${completed} sessions, ${flagged} of them flagged">${'<i class="wrong"></i>'.repeat(flagged)}${'<i></i>'.repeat(completed - flagged)}</div>`,
    '<figcaption class="cap">Both are a real bug in a fixture I had labeled correct, found on a reduced requirement list by the stricter final oracle</figcaption>',
    '</figure>',
    '</div>',
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">Run it on your own component</h2>',
    '<p class="prose">Mark the elements you care about with <code>data-trace-id</code>, write a scenario that says what the user does and what must stay true, and register both builds in a fixture manifest. Then one command replays the scenario on the two builds and writes a report like the one behind this page.</p>',
    code('cmd-register', register, 'the command that registers a fixture'),
    code('cmd-run', command, 'the command that runs a scenario'),
    '<p class="prose">The <a href="https://github.com/qbeka/trace-interactions#use-it-on-your-component">README</a> has the setup, and <a href="https://github.com/qbeka/trace-interactions/blob/main/docs/SCENARIOS.md">the scenario guide</a> lists every action and requirement.</p>',
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">Limits</h2>',
    '<p class="prose">These are the things this page does not show, in the order they matter. The <a href="https://github.com/qbeka/trace-interactions/blob/main/docs/LIMITS.md">longer list</a> is in the repository.</p>',
    `<ol class="limits-list">${limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ol>`,
    '</section>',

    '<section class="chapter reveal">',
    '<h2 class="display">Read the report Trace wrote</h2>',
    '<p class="prose">The frames are screenshots of the real fixture, taken by Trace on a rerun of the saved scenarios and kept only because the rerun recorded the same geometry as the saved report. The frames and the slit scans show those screenshots and change nothing in them, and Difference lights the pixels where the two builds disagree. The dashed outlines, the ruler, the bracket and everything in Geometry are drawn from the rectangles in that report. Playback slows down at the failure and skips the quiet stretches, and the clock always shows the recorded time.</p>',
    '<nav class="next" aria-label="What to open next">',
    `<a href="regression/"><b>The full report${arrow}</b><span>What Trace writes for every run, with each requirement, action and sample</span></a>`,
    `<a href="fixed/"><b>After the fix${arrow}</b><span>The same four steps on the repaired build, reported as fixed</span></a>`,
    `<a href="https://github.com/qbeka/trace-interactions"><b>The source${arrow}</b><span>The runner, the oracle, the reducer and every saved result</span></a>`,
    '</nav>',
    '</section>',
  ].join('\n      ');

  const bundle = (entry: string, format: 'iife' | 'esm') => build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format,
    target: 'es2022',
    minify: !process.env.TRACE_PAGE_DEBUG,
    write: false,
    logLevel: 'warning',
  });
  const script = await bundle('site/page.ts', 'iife');
  // The slit scans are read in a worker, which the site's policy allows only as a file of its own.
  const worker = await bundle('site/scan-worker.ts', 'iife');
  writeFileSync(join(demoDir, 'scan.js'), worker.outputFiles[0]!.text);
  copyFileSync(join(root, 'site/favicon.svg'), join(demoDir, 'favicon.svg'));
  const fonts = join(demoDir, 'fonts');
  mkdirSync(fonts, { recursive: true });
  const geist = join(root, 'node_modules/geist/dist/fonts');
  copyFileSync(join(geist, 'geist-serif/GeistSerif-Regular.woff2'), join(fonts, 'GeistSerif-Regular.woff2'));
  copyFileSync(join(geist, 'geist-sans/Geist-Regular.woff2'), join(fonts, 'Geist-Regular.woff2'));
  copyFileSync(join(geist, 'geist-sans/Geist-Medium.woff2'), join(fonts, 'Geist-Medium.woff2'));
  copyFileSync(join(root, 'licenses/Geist-OFL-1.1.txt'), join(fonts, 'Geist-OFL-1.1.txt'));

  const css = readFileSync(join(root, 'site/foundation.css'), 'utf8') + readFileSync(join(root, 'site/styles.css'), 'utf8');
  const template = readFileSync(join(root, 'site/template.html'), 'utf8');
  const wrong = stageLines(data, template, css, story).flatMap((line) => {
    const problem = lineProblem(line);
    return problem ? [`"${line}" ${problem}`] : [];
  });
  if (wrong.length) throw new Error(`A status line, hint, caption, heading or label must be one sentence with no closing period:\n${wrong.join('\n')}`);
  if (/[–—]/.test(story + template)) throw new Error('The page must not use an em dash or an en dash.');
  const first = [frames.runs['original-baseline']!, frames.runs['original-candidate']!].map((list) => atOrBefore(list, jumpT));
  const preload = first.map((f) => `<link rel="preload" href="./frames/${f}.webp" as="image" type="image/webp">`).join('\n');
  // Replacers are functions, so a `$` in the data is never read as a pattern.
  const html = template
    .replace('<!--PRELOAD-->', () => preload)
    .replace('<!--DETAILS-->', () => story)
    .replace('/*STYLES*/', () => css)
    .replace('/*CROP*/', () => `${crop.w} / ${crop.h}`)
    .replace('/*DATA*/', () => JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace('/*SCRIPT*/', () => script.outputFiles[0]!.text.replace(/<\/script/g, '<\\/script'));
  writeFileSync(join(demoDir, 'index.html'), html);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildPage(resolve(process.argv[2] ?? join(root, 'demo')));
  console.log('Project page written.');
}
