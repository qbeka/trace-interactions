import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium, firefox, webkit, type Browser } from 'playwright';
import { writeJson } from '../src/case.ts';
import { compare, type Verdict } from '../src/compare.ts';
import { hashDirectory, sha256 } from '../src/runner/environment.ts';
import { loadRegistry, serveBuild, type LoadedFixture } from '../src/runner/registry.ts';
import { runScenario, type RunOutput } from '../src/runner/run.ts';
import type { Category, Scenario } from '../src/scenario/schema.ts';
import { parseScenario } from '../src/scenario/validate.ts';
import { manifestFor } from './manifest.ts';

/**
 * Detector evaluation over the controlled corpus.
 *
 * The labels in `corpus/labels.json` were committed before the detector first
 * ran on two of the three fixtures. A variant is scored over every scenario of
 * its fixture. Three controls bracket the result:
 *   never            flags nothing, so it finds no seeded bug
 *   trace-diff       flags any difference in the recorded trace
 *   final-screenshot flags a pixel difference in the settled screenshot
 * These are not rival products. They show the corpus can separate approaches.
 */

interface Label {
  fixture: string;
  build: string;
  expected: 'clean' | Category;
  mechanism: string;
}

interface Row {
  fixture: string;
  build: string;
  scenario: string;
  verdict: Verdict;
  categories: Category[];
  sentence: string;
  ms: number;
  traceDiff: boolean;
  screenshotDiffPixels: number | null;
}

const BROWSERS = { chromium, firefox, webkit };

export function scenariosOf(root: string, fixture: string): Scenario[] {
  const dir = join(root, 'fixtures', fixture, 'scenarios');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseScenario(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/**
 * Every recorded channel, sorted inside each ms. Two events at one ms can swap
 * order between runs, and that is not a behavior difference.
 */
function shape(run: RunOutput): string {
  return run.events
    .flatMap((e) => {
      if (e.k === 'action' || e.k === 'unsupported') return [];
      const { seq: _seq, tick: _tick, ...rest } = e;
      // A browser's running counter, not behavior. Firefox raises it between runs.
      if (e.k === 'event') return [JSON.stringify({ ...rest, pointerId: 0 })];
      if (e.k === 'focus' && e.ref) return [JSON.stringify({ ...rest, ref: { ...e.ref, node: 0 } })];
      if (e.k === 'geometry') return [JSON.stringify({ ...rest, node: 0 })];
      return [JSON.stringify(rest)];
    })
    .sort()
    .join('\n');
}

function pixelDiff(a: string, b: string): number {
  const x = PNG.sync.read(readFileSync(a));
  const y = PNG.sync.read(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height) return x.width * x.height;
  return pixelmatch(x.data, y.data, undefined, x.width, x.height, { threshold: 0.1 });
}

export interface CorpusOptions {
  browser: Browser;
  root: string;
  out: string;
  labels: Label[];
  /** Skip the screenshot control. Used on non-reference browsers. */
  controls: boolean;
}

export async function runCorpus(o: CorpusOptions): Promise<Row[]> {
  const registry = loadRegistry(join(o.root, 'trace.fixtures.json'));
  const rows: Row[] = [];
  const fixtures = [...new Set(o.labels.map((l) => l.fixture))];
  for (const id of fixtures) {
    const fixture = registry.get(id) as LoadedFixture;
    const allow = fixture.manifest.stateAllowlist;
    const scenarios = scenariosOf(o.root, id);
    const correct = await serveBuild(fixture, 'correct');
    const baseRuns = new Map<string, RunOutput>();
    const shots = join(o.out, 'screenshots', id);
    for (const s of scenarios) {
      const dir = join(shots, s.id);
      if (o.controls) mkdirSync(dir, { recursive: true });
      baseRuns.set(s.id, await runScenario({
        browser: o.browser,
        url: correct.url,
        scenario: s,
        stateAllowlist: allow,
        screenshots: o.controls ? { dir, prefix: 'baseline' } : undefined,
      }));
    }
    for (const label of o.labels.filter((l) => l.fixture === id)) {
      const build = await serveBuild(fixture, label.build);
      for (const s of scenarios) {
        const dir = join(shots, s.id);
        const baseline = baseRuns.get(s.id)!;
        const started = performance.now();
        const candidate = await runScenario({
          browser: o.browser,
          url: build.url,
          scenario: s,
          stateAllowlist: allow,
          screenshots: o.controls ? { dir, prefix: label.build } : undefined,
        });
        const c = compare(baseline, candidate);
        const settled = (r: RunOutput) => r.screenshots.find((x) => x.label === 'settled');
        const sa = settled(baseline);
        const sb = settled(candidate);
        rows.push({
          fixture: id,
          build: label.build,
          scenario: s.id,
          verdict: c.verdict,
          categories: [...new Set(c.introduced.map((v) => v.category))],
          sentence: c.sentence,
          ms: Math.round(performance.now() - started),
          traceDiff: shape(baseline) !== shape(candidate),
          screenshotDiffPixels: sa && sb ? pixelDiff(join(dir, sa.path), join(dir, sb.path)) : null,
        });
      }
      await build.stop();
    }
    await correct.stop();
  }
  return rows;
}

export interface VariantScore {
  fixture: string;
  build: string;
  expected: string;
  mechanism: string;
  detected: Category[];
  flagged: boolean;
  outcome: 'tp' | 'fn' | 'wrong-category' | 'tn' | 'fp';
  scenarios: number;
  invalid: number;
  traceDiffFlag: boolean;
  screenshotFlag: boolean;
}

/** One verdict per variant. Scenario rows are saved alongside for inspection. */
export function score(labels: Label[], rows: Row[], pixelLimit: number): VariantScore[] {
  return labels.map((l) => {
    const own = rows.filter((r) => r.fixture === l.fixture && r.build === l.build);
    const detected = [...new Set(own.flatMap((r) => r.categories))];
    const flagged = own.some((r) => r.verdict === 'regression');
    let outcome: VariantScore['outcome'];
    if (l.expected === 'clean') outcome = flagged ? 'fp' : 'tn';
    else if (detected.includes(l.expected)) outcome = 'tp';
    else outcome = flagged ? 'wrong-category' : 'fn';
    return {
      fixture: l.fixture,
      build: l.build,
      expected: l.expected,
      mechanism: l.mechanism,
      detected,
      flagged,
      outcome,
      scenarios: own.length,
      invalid: own.filter((r) => r.verdict === 'invalid' || r.verdict === 'diverged').length,
      traceDiffFlag: own.some((r) => r.traceDiff),
      screenshotFlag: own.some((r) => (r.screenshotDiffPixels ?? 0) > pixelLimit),
    };
  });
}

export function summarize(scores: VariantScore[]) {
  const seeded = scores.filter((s) => s.expected !== 'clean');
  const clean = scores.filter((s) => s.expected === 'clean');
  const control = (flag: (s: VariantScore) => boolean) => ({
    truePositives: seeded.filter(flag).length,
    falseNegatives: seeded.filter((s) => !flag(s)).length,
    falsePositives: clean.filter(flag).length,
    trueNegatives: clean.filter((s) => !flag(s)).length,
  });
  return {
    seeded: seeded.length,
    clean: clean.length,
    trace: {
      truePositives: seeded.filter((s) => s.outcome === 'tp').length,
      wrongCategory: seeded.filter((s) => s.outcome === 'wrong-category').length,
      falseNegatives: seeded.filter((s) => s.outcome === 'fn').length,
      falsePositives: clean.filter((s) => s.outcome === 'fp').length,
      trueNegatives: clean.filter((s) => s.outcome === 'tn').length,
    },
    controls: {
      never: control(() => false),
      traceDiff: control((s) => s.traceDiffFlag),
      finalScreenshot: control((s) => s.screenshotFlag),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'results/corpus' },
      browser: { type: 'string', default: 'chromium' },
      fixture: { type: 'string' },
      labels: { type: 'string', default: 'corpus/labels.json' },
    },
  });
  const root = resolve(import.meta.dirname, '..');
  const out = resolve(values.out!);
  const raw = readFileSync(join(root, values.labels!), 'utf8');
  const all: Label[] = JSON.parse(raw).variants;
  const labels = values.fixture ? all.filter((l) => l.fixture === values.fixture) : all;
  const browser = await BROWSERS[values.browser as keyof typeof BROWSERS].launch();
  const started = performance.now();
  const controls = values.browser === 'chromium';
  const rows = await runCorpus({ browser, root, out, labels, controls });
  // 0.1 percent of a 900 x 640 screenshot, about a word of text. See docs/REPORT.md.
  const scores = score(labels, rows, 576);
  const summary = summarize(scores);
  writeJson(join(out, 'rows.json'), rows);
  writeJson(join(out, 'scores.json'), scores);
  writeJson(join(out, 'summary.json'), summary);
  writeJson(join(out, 'manifest.json'), {
    ...manifestFor(browser, root, 'bench/corpus.ts'),
    labelsSha256: sha256(raw),
    fixtureBuildHashes: Object.fromEntries([...new Set(labels.map((l) => l.fixture))].map((f) => [f, hashDirectory(join(root, '.build/fixtures', f))])),
    pixelLimit: 576,
    wallSeconds: Math.round((performance.now() - started) / 1000),
    repetitions: 1,
    warmup: 0,
    exclusions: [],
  });
  await browser.close();
  console.log(JSON.stringify(summary, null, 2));
  for (const s of scores) {
    const mark = s.outcome === 'tp' || s.outcome === 'tn' ? 'ok ' : 'BAD';
    console.log(`${mark} ${s.outcome.padEnd(14)} ${s.fixture}@${s.build} expected=${s.expected} detected=${s.detected.join(',') || '-'} invalid=${s.invalid}/${s.scenarios}`);
  }
  console.log(`${Math.round((performance.now() - started) / 1000)} s`);
}
