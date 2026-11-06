import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { runScenario } from '../src/runner/run.ts';
import { serveDirectory } from '../src/runner/static.ts';
import type { Scenario } from '../src/scenario/schema.ts';
import type { TraceEvent } from '../src/trace/types.ts';
import type { ReportData } from '../viewer/src/types.ts';

/**
 * Takes the screenshots the project page plays: Trace's own diagnostic pass,
 * asked for every tick, on the same scenarios and builds as the saved reports.
 * A rerun only counts if it recorded the same geometry as the saved run, so the
 * script stops here when the two disagree.
 */
const root = resolve(import.meta.dirname, '..');
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));

const SCALE = 2;
const HEIGHT = 260;
const WIDTH = 1000;
const QUALITY = 0.86;

interface Rect { x: number; y: number; w: number; h: number }
type Geometry = { t: number; target: string; rect: Rect | null };

const geometry = (events: TraceEvent[]): Geometry[] =>
  events.flatMap((e) => (e.k === 'geometry' ? [{ t: e.t, target: e.target, rect: e.rect ? { x: e.rect.x, y: e.rect.y, w: e.rect.w, h: e.rect.h } : null }] : []));

function sameGeometry(a: Geometry[], b: Geometry[]): string | null {
  if (a.length !== b.length) return `${a.length} samples against ${b.length}`;
  const close = (x: number, y: number) => Math.abs(x - y) < 0.01;
  for (const [i, g] of a.entries()) {
    const h = b[i]!;
    const same = g.t === h.t && g.target === h.target && (g.rect === null ? h.rect === null : !!h.rect && close(g.rect.x, h.rect.x) && close(g.rect.y, h.rect.y) && close(g.rect.w, h.rect.w) && close(g.rect.h, h.rect.h));
    if (!same) return `sample ${i} at ${g.t} ms on ${g.target}`;
  }
  return null;
}

/** Keeps the top of the window. A window narrower than the frame leaves the rest empty. */
function crop(file: string): PNG {
  const shot = PNG.sync.read(readFileSync(file));
  const out = new PNG({ width: WIDTH * SCALE, height: HEIGHT * SCALE });
  PNG.bitblt(shot, out, 0, 0, Math.min(shot.width, out.width), Math.min(shot.height, out.height), 0, 0);
  return out;
}

async function encode(page: Page, png: Buffer): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ data, quality }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    const out = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const b of out) text += String.fromCharCode(b);
    return btoa(text);
  }, { data: png.toString('base64'), quality: QUALITY });
  return Buffer.from(base64, 'base64');
}

export async function captureFrames(demoDir: string): Promise<void> {
  const regression = read<ReportData>(join(demoDir, 'regression/report.json'));
  const fixed = read<ReportData>(join(demoDir, 'fixed/report.json'));
  const fixture = read<{ stateAllowlist: string[] }>(join(root, 'fixtures/inspector/fixture.json'));
  const frames = join(demoDir, 'frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'trace-frames-'));

  const browser = await chromium.launch();
  const encoder = await browser.newPage();
  const builds = {
    correct: await serveDirectory(join(root, '.build/fixtures/inspector/correct')),
    broken: await serveDirectory(join(root, '.build/fixtures/inspector/stale-origin')),
  };

  const cases = [
    { id: 'original', saved: regression.cases.find((c) => c.id === 'original')! },
    { id: 'reduced', saved: regression.cases.find((c) => c.id === 'reduced')! },
  ];
  const runs: Record<string, { t: number; f: string }[]> = {};
  const written = new Set<string>();
  const bytes = { total: 0 };

  for (const { id, saved } of cases) {
    const scenario: Scenario = { ...saved.scenario, viewport: { ...saved.scenario.viewport, deviceScaleFactor: SCALE } };
    const step = scenario.timing.stepMs;
    const last = saved.candidate.events.at(-1)!.t;
    const times = Array.from({ length: Math.ceil(last / step) + 1 }, (_, i) => i * step);
    for (const [side, url, events] of [['baseline', builds.correct.url, saved.baseline.events], ['candidate', builds.broken.url, saved.candidate.events]] as const) {
      const prefix = `${id}-${side}`;
      const run = await runScenario({ browser, url, scenario, stateAllowlist: fixture.stateAllowlist, screenshots: { dir: work, prefix, times } });
      if (run.status !== 'completed') throw new Error(`${prefix}: ${run.invalid?.reason}`);
      const problem = sameGeometry(geometry(run.events), geometry(events));
      if (problem) throw new Error(`${prefix} no longer matches the saved run: ${problem}`);
      const list: { t: number; f: string }[] = [];
      for (const shot of run.screenshots) {
        const png = crop(join(work, shot.path));
        const hash = createHash('sha256').update(png.data).digest('hex').slice(0, 12);
        if (!written.has(hash)) {
          const webp = await encode(encoder, PNG.sync.write(png));
          writeFileSync(join(frames, `${hash}.webp`), webp);
          written.add(hash);
          bytes.total += webp.length;
        }
        // Two shots can share a time. The later one is what the page held at that moment.
        if (list.at(-1)?.t === shot.t) list.pop();
        if (list.at(-1)?.f !== hash) list.push({ t: shot.t, f: hash });
      }
      runs[prefix] = list;
      console.log(`${prefix}: ${run.screenshots.length} screenshots, ${list.length} distinct in a row`);
    }
  }

  // The fix report is the same four steps on the same two builds, so its runs
  // must match the reduced runs already captured, with the sides swapped.
  const fix = fixed.cases[0]!;
  const reduced = cases[1]!.saved;
  for (const [name, a, b] of [['fix baseline', fix.baseline.events, reduced.candidate.events], ['fix candidate', fix.candidate.events, reduced.baseline.events]] as const) {
    const problem = sameGeometry(geometry(a), geometry(b));
    if (problem) throw new Error(`${name} differs from the reduced run: ${problem}`);
  }

  writeFileSync(join(frames, 'index.json'), JSON.stringify({ width: WIDTH, height: HEIGHT, scale: SCALE, runs }) + '\n');
  await browser.close();
  await builds.correct.close();
  await builds.broken.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${written.size} frames, ${Math.round(bytes.total / 1024)} KB`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await captureFrames(resolve(process.argv[2] ?? join(root, 'demo')));
}
