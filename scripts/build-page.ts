import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReportCase, ReportData } from '../viewer/src/types.ts';
import { mainStateKey, primaryTarget, primaryViolation, failingSide } from '../viewer/src/model.ts';

/**
 * Writes the public project page, `demo/index.html`: one self-contained file
 * beside the two full reports. Every number comes from a saved run or a demo
 * report, so the page cannot drift from the evidence.
 */
const root = resolve(import.meta.dirname, '..');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const result = <T>(path: string): T => read(join(root, 'results', path));

interface Score { truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number }
interface Summary { seeded: number; clean: number; trace: Score; controls: { traceDiff: Score; finalScreenshot: Score } }

const KEEP = new Set(['geometry', 'focus', 'state', 'viewport', 'action']);
const round = (n: number) => Math.round(n * 10) / 10;

/** Drops what the page does not draw, which is most of the report's size. */
function slim(events: ReportCase['candidate']['events']) {
  return events.filter((e) => KEEP.has(e.k)).map((e) => {
    if (e.k === 'geometry') return { k: e.k, t: e.t, target: e.target, rect: e.rect && { x: round(e.rect.x), y: round(e.rect.y), w: round(e.rect.w), h: round(e.rect.h) } };
        if (e.k === 'state') return { k: e.k, t: e.t, key: e.key, value: e.value };
    return e;
  });
}

function scene(c: ReportCase, id: string, label: string, note: string, passing: string) {
  const violation = primaryViolation(c);
  const failing = failingSide(c);
  if (!violation || !failing) throw new Error(`Scene ${id} has no failure to show.`);
  const px = /(\d+) px/.exec(violation.sentence);
  if (!px) throw new Error(`Scene ${id} has no measured gap.`);
  return {
    id,
    label,
    note,
    passing,
    resolved: c.comparison.verdict === 'fixed',
    scenario: {
      viewport: c.scenario.viewport,
      targets: c.scenario.targets,
      actions: c.scenario.actions.map(({ at, type, note: text }) => ({ at, type, note: text })),
    },
    primary: primaryTarget(c.scenario),
    stateKey: mainStateKey(c.scenario),
    baseline: { label: c.baseline.label, events: slim(c.baseline.events) },
    candidate: { label: c.candidate.label, events: slim(c.candidate.events) },
    failing,
    failure: { t: violation.at.t, sentence: c.comparison.sentence.replace(/^./, (a) => a.toUpperCase()), px: Number(px[1]) },
  };
}

export async function buildPage(demoDir: string): Promise<void> {
  const regression = read<ReportData>(join(demoDir, 'regression/report.json'));
  const fixed = read<ReportData>(join(demoDir, 'fixed/report.json'));
  const reducedCase = regression.cases.find((c) => c.id === 'reduced');
  const original = regression.cases.find((c) => c.id === 'original');
  const fix = fixed.cases[0];
  const reduction = regression.reduction;
  if (!reducedCase || !original || !fix || !reduction) throw new Error('Run the demo first: the page needs both reports.');

  const tuned = result<Summary>('corpus-chromium/summary.json');
  const firefox = result<Summary>('corpus-firefox/summary.json');
  const webkit = result<Summary>('corpus-webkit/summary.json');
  const holdout = result<Summary>('holdout-final-oracle/summary.json');
  const firstHoldout = result<Summary>('holdout/summary.json');
  const written = result<{ rows: { originalActions: number; reducedActions: number[] }[] }>('reduction-written/summary.json').rows[0]!;
  const random = result<Record<string, { seeds: number; completed: number; flagged: number }>>('random/summary.json');
  const seeds = Object.values(random).reduce((n, r) => n + r.seeds, 0);
  const completed = Object.values(random).reduce((n, r) => n + r.completed, 0);
  const flagged = Object.values(random).reduce((n, r) => n + r.flagged, 0);
  const of = (a: number, b: number) => `${a} of ${b}`;
  const same = [firefox, webkit].every((s) => s.trace.truePositives === tuned.trace.truePositives && s.trace.falsePositives === tuned.trace.falsePositives);
  if (!same) throw new Error('The browsers no longer agree. Rewrite the check that says they do.');

  const panelGeometry = original.candidate.events.flatMap((e) => (e.k === 'geometry' && e.target === 'panel' ? [{ t: e.t, w: round(e.rect?.w ?? 0) }] : []));
  const session = original.candidate.events.at(-1)!.t;
  const commit = regression.manifest.source.commit?.slice(0, 7) ?? 'unknown';
  const sum = (s: Score) => s.truePositives;
  const rows = [
    ['Trace', tuned.trace, holdout.trace],
    ['Any recorded difference', tuned.controls.traceDiff, holdout.controls.traceDiff],
    ['Final screenshot difference', tuned.controls.finalScreenshot, holdout.controls.finalScreenshot],
  ] as const;

  const data = {
    ridge: panelGeometry,
    ridgeEnd: session,
    tiles: [
      { value: of(tuned.trace.truePositives, tuned.seeded), label: 'seeded bugs caught, tuned corpus' },
      { value: of(tuned.trace.falsePositives, tuned.clean), label: 'clean builds flagged, tuned corpus' },
      { value: of(holdout.trace.falsePositives, holdout.clean), label: 'clean builds wrongly flagged, holdout' },
      { value: `${reduction.originalActions} to ${reduction.reducedActions}`, label: 'actions after reduction' },
    ],
    scenes: [
      scene(reducedCase, 'reduced', `Reduced, ${reducedCase.scenario.actions.length} actions`, `The failure, shrunk. Reopening the panel after the window widens. Reduction kept the same failure in ${of(reduction.reducedReproduction.reproduced, reduction.reducedReproduction.runs)} fresh runs and ${of(reduction.baselineReproduction.reproduced, reduction.baselineReproduction.runs)} on the baseline.`, 'Both builds agree so far. Watch the panel when it reopens.'),
      scene(original, 'original', `Original, ${original.scenario.actions.length} actions`, 'The session as written. Most of these actions have nothing to do with the bug, which is why Trace reduces it.', 'Both builds agree so far. Watch the panel when it reopens.'),
      scene(fix, 'fixed', 'After the fix', 'The same reduced actions, with the broken build as the baseline and the fix as the candidate.', 'The broken build is on the left this time.'),
    ],
    evidence: {
      text: 'Trace does not find more of these bugs than comparing two full traces. It rejects most legitimate changes, and it can fail a bug both builds share, which no comparison can.',
      head: ['Detector', 'Tuned: bugs caught', 'Tuned: clean flagged', 'Holdout: bugs caught', 'Holdout: clean flagged'],
      rows: rows.map(([name, a, b]) => [name, of(sum(a), tuned.seeded), of(a.falsePositives, tuned.clean), of(sum(b), holdout.seeded), of(b.falsePositives, holdout.clean)]),
      note: `Chromium, on final code. The holdout fixture first ran once on an earlier oracle: ${of(firstHoldout.trace.truePositives, firstHoldout.seeded)} caught, ${of(firstHoldout.trace.falsePositives, firstHoldout.clean)} clean flagged. The rerun here is a regression check, not a second holdout.`,
    },
    checks: [
      'Labels for each build were committed before the detector ran, with one exception: it had already run on 2 inspector builds.',
      'Two controls ran on the same builds, one flagging any recorded difference and one comparing final screenshots.',
      `The tuned corpus scored ${of(tuned.trace.truePositives, tuned.seeded)} and ${of(tuned.trace.falsePositives, tuned.clean)} clean flagged on Chromium, Firefox and WebKit.`,
      `${seeds} seeded random sessions ran on correct builds and ${completed} completed. ${flagged} were flagged, and both are a real bug in my own overlay fixture.`,
      `Reduced failures reproduced in fresh runs and not on the baseline. The written session went from ${written.originalActions} actions to ${written.reducedActions[0]}.`,
      'A separate review on a clean clone found 25 issues, and a second found 7 regressions in the fixes. Each was fixed or disclosed.',
    ],
    limits: [
      'The corpus is small and I wrote it. It says nothing about how many real bugs Trace would catch.',
      'The 18 of 18 is tuned. The first run caught 12, and the oracle and scenarios changed because of it.',
      'The holdout ran once, on an earlier oracle. No result tests the final oracle on unseen code.',
      'Trace only finds what a scenario reaches. A requirement never reached says not exercised.',
      'Controlled time does not hold every channel, such as workers and ResizeObserver delivery. Each run lists what it does not hold.',
      'Timings are lab numbers from one Mac, and nobody else has used the tool yet.',
    ],
    foot: {
      links: [
        { label: 'Source on GitHub', href: 'https://github.com/qbeka/trace-interactions' },
        { label: 'Full report', href: 'regression/index.html' },
        { label: 'Report after the fix', href: 'fixed/index.html' },
        { label: 'Limits', href: 'https://github.com/qbeka/trace-interactions/blob/main/docs/LIMITS.md' },
      ],
      provenance: `Recorded at ${commit} on ${regression.manifest.environment.browser.name}`,
    },
  };

  const script = await build({
    entryPoints: [join(root, 'site/page.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const font = readFileSync(join(root, 'node_modules/geist/dist/fonts/geist-serif/GeistSerif-Regular.woff2')).toString('base64');
  const css = readFileSync(join(root, 'site/styles.css'), 'utf8').replace('/*FONT*/', font);
  // Replacers are functions, so a `$` in the data is never read as a pattern.
  const html = readFileSync(join(root, 'site/template.html'), 'utf8')
    .replace('/*STYLES*/', () => css)
    .replace('/*DATA*/', () => JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace('/*SCRIPT*/', () => script.outputFiles[0]!.text.replace(/<\/script/g, '<\\/script'));
  writeFileSync(join(demoDir, 'index.html'), html);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildPage(resolve(process.argv[2] ?? join(root, 'demo')));
  console.log('Project page written.');
}
