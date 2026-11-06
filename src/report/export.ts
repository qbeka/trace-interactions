import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportCase, ReportData, RunSide } from '../../viewer/src/types.ts';
import type { RunOutput } from '../runner/run.ts';

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const side = (run: RunOutput, label: string): RunSide => ({
  label,
  status: run.status,
  invalid: run.invalid,
  events: run.events,
  violations: run.violations,
  clock: run.clock,
  screenshots: run.screenshots,
});

async function loadCase(dir: string, id: ReportCase['id'], manifest: { baseline: { ref: string }; candidate: { ref: string } }): Promise<ReportCase | null> {
  const prefix = join(dir, 'raw', id);
  if (!(await exists(`${prefix}.comparison.json`))) return null;
  return {
    id,
    scenario: await json(`${prefix}.scenario.json`),
    comparison: await json(`${prefix}.comparison.json`),
    baseline: side(await json(`${prefix}.baseline.json`), manifest.baseline.ref),
    candidate: side(await json(`${prefix}.candidate.json`), manifest.candidate.ref),
  };
}

function viewerDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, '..', '..', 'dist', 'viewer'), join(here, 'viewer')].find((p) => p) as string;
}

/**
 * Builds the portable report from raw files only, so it can be regenerated at
 * any time with `trace report <run-dir>`. The output is a plain folder: static
 * HTML, one classic script, JSON and images, with no server or account needed.
 */
export async function exportReport(dir: string): Promise<string> {
  const run = resolve(dir);
  const manifest = await json<ReportData['manifest'] & { baseline: { ref: string }; candidate: { ref: string } }>(join(run, 'manifest.json'));
  const cases = (await Promise.all((['reduced', 'original'] as const).map((id) => loadCase(run, id, manifest)))).filter((c): c is ReportCase => c !== null);
  const reductionPath = join(run, 'reduction.json');
  const data: ReportData = {
    schema: 'trace.report/1',
    manifest,
    reduction: (await exists(reductionPath)) ? await json(reductionPath) : null,
    cases,
  };

  const out = join(run, 'report');
  const viewer = viewerDir();
  if (!(await exists(viewer))) throw new Error('The viewer is not built. Run: pnpm build');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(viewer, out, { recursive: true });
  if (await exists(join(run, 'screenshots'))) await cp(join(run, 'screenshots'), join(out, 'screenshots'), { recursive: true });
  const body = JSON.stringify(data);
  await writeFile(join(out, 'report.json'), body);
  // `<` is escaped so nothing in a trace can close a script tag.
  await writeFile(join(out, 'report.data.js'), `window.__TRACE_REPORT__=${body.replace(/</g, '\\u003c')};\n`);
  return join(out, 'index.html');
}
