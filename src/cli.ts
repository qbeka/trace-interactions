#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit, type Browser } from 'playwright';
import { runCase, writeJson } from './case.ts';
import { exitCode, type Comparison } from './compare.ts';
import { perfRun, summarize, type PerfRun } from './perf.ts';
import { reduceScenario, type ReductionReport } from './reduce/reduce.ts';
import { exportReport } from './report/export.ts';
import { dependencyVersions, environment, hashDirectory, sha256, sourceState } from './runner/environment.ts';
import {
  REGISTRY_FILE,
  Registry,
  assertLoopback,
  loadFixture,
  loadRegistry,
  parseBuildRef,
  serveBuild,
  type LoadedFixture,
  type ServedBuild,
} from './runner/registry.ts';
import { serveDirectory } from './runner/static.ts';
import type { Scenario } from './scenario/schema.ts';
import { InvalidScenario, parseScenario } from './scenario/validate.ts';

const USAGE = `trace: replay an interaction on two builds and explain what broke.

  trace validate <scenario.json>
  trace run <scenario.json> --baseline <fixture@build> --candidate <fixture@build> [options]
  trace reduce <run-dir> [--max-attempts N] [--max-seconds N] [--resume]
  trace replay <run-dir>
  trace report <run-dir>
  trace perf <scenario.json> --baseline <fixture@build> --candidate <fixture@build> [--runs 5] [--warmup 1]
  trace serve <dir> [--port 5175]
  trace fixtures list
  trace fixtures add <fixture.json>

Options for run:
  --baseline-url <url>    use a local URL instead of a registered build
  --candidate-url <url>   same, for the candidate. Needs --allowlist.
  --allowlist a,b         state keys to record when no manifest is registered
  --browser <name>        chromium, firefox or webkit. Default chromium.
  --mode <mode>           controlled or wall. Default comes from the scenario.
  --out <dir>             where to save the run. Default .trace/<scenario id>.
  --no-screenshots        skip the diagnostic screenshot pass
  --registry <file>       fixture registry. Default ${REGISTRY_FILE}.

Exit codes: 0 pass or fixed, 1 regression or shared failure, 2 invalid scenario.
`;

const BROWSERS = { chromium, firefox, webkit };

function launch(name: string): Promise<Browser> {
  const type = BROWSERS[name as keyof typeof BROWSERS];
  if (!type) throw new InvalidScenario(`unknown browser "${name}"`);
  return type.launch();
}

function readScenario(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, 'utf8')));
}

const fromUrl = (label: string, url: string): ServedBuild => {
  assertLoopback(url);
  return { label, url, stop: async () => {} };
};

interface RunManifest {
  schema: 'trace.run/1';
  command: string[];
  source: ReturnType<typeof sourceState>;
  dependencies: Record<string, string>;
  environment: ReturnType<typeof environment>;
  scenario: { id: string; path: string; sha256: string; seed: number; viewport: Scenario['viewport'] };
  fixture: { id: string; version: string; stateAllowlist: string[]; registry: string | null };
  baseline: { ref: string; url: string | null; sha256: string | null };
  candidate: { ref: string; url: string | null; sha256: string | null };
  mode: string;
  warmup: number;
  repetitions: number;
  exclusions: string[];
  recorderSha256: string | null;
}

const repoRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..');

function recorderHash(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, '..', 'dist', 'recorder.js'), join(here, 'recorder.js')]) {
    if (existsSync(path)) return sha256(readFileSync(path));
  }
  return null;
}

function buildHash(fixture: LoadedFixture | undefined, ref: string): string | null {
  if (!fixture) return null;
  const { build } = parseBuildRef(ref);
  const entry = fixture.manifest.builds[build];
  return entry && 'dir' in entry ? hashDirectory(resolve(fixture.root, entry.dir)) : null;
}

function resolveBuildRef(fixtures: Map<string, LoadedFixture>, ref: string): { fixture: LoadedFixture; build: string } {
  const { fixture: id, build } = parseBuildRef(ref);
  const fixture = fixtures.get(id);
  if (!fixture) throw new InvalidScenario(`fixture "${id}" is not registered. Run: trace fixtures add <fixture.json>`);
  return { fixture, build };
}

function print(c: Comparison): void {
  console.log(`${c.verdict.toUpperCase()}: ${c.sentence}`);
  for (const v of c.introduced.slice(1)) console.log(`  also ${v.category}: ${v.sentence}`);
}

async function cmdRun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      'baseline-url': { type: 'string' },
      'candidate-url': { type: 'string' },
      allowlist: { type: 'string' },
      browser: { type: 'string', default: 'chromium' },
      mode: { type: 'string' },
      out: { type: 'string' },
      registry: { type: 'string', default: REGISTRY_FILE },
      'no-screenshots': { type: 'boolean', default: false },
    },
  });
  const path = positionals[0];
  if (!path) throw new InvalidScenario('run needs a scenario file');
  const scenario = readScenario(path);
  const fixtures = loadRegistry(values.registry!);
  const fixture = fixtures.get(scenario.fixture.id);
  if (fixture && fixture.manifest.version !== scenario.fixture.version) {
    throw new InvalidScenario(`scenario needs ${scenario.fixture.id} v${scenario.fixture.version}, registered v${fixture.manifest.version}`);
  }
  const allow = values.allowlist?.split(',') ?? fixture?.manifest.stateAllowlist;
  if (!allow) throw new InvalidScenario(`fixture ${scenario.fixture.id} is not registered. Pass --allowlist or register it.`);

  const serve = async (ref: string | undefined, url: string | undefined, label: string): Promise<ServedBuild> => {
    if (url) return fromUrl(label, url);
    if (!ref) throw new InvalidScenario(`pass --${label} fixture@build or --${label}-url`);
    const r = resolveBuildRef(fixtures, ref);
    return serveBuild(r.fixture, r.build);
  };

  const out = resolve(values.out ?? join('.trace', scenario.id));
  const browser = await launch(values.browser!);
  const baseline = await serve(values.baseline, values['baseline-url'], 'baseline');
  const candidate = await serve(values.candidate, values['candidate-url'], 'candidate');
  try {
    const manifest: RunManifest = {
      schema: 'trace.run/1',
      command: ['trace', 'run', ...args],
      source: sourceState(),
      dependencies: dependencyVersions(join(repoRoot(), 'package.json')),
      environment: environment(browser),
      scenario: {
        id: scenario.id,
        path,
        sha256: sha256(readFileSync(path)),
        seed: scenario.seed,
        viewport: scenario.viewport,
      },
      fixture: { ...scenario.fixture, stateAllowlist: allow, registry: values.registry! },
      baseline: { ref: baseline.label, url: values['baseline-url'] ?? null, sha256: values.baseline ? buildHash(fixture, values.baseline) : null },
      candidate: { ref: candidate.label, url: values['candidate-url'] ?? null, sha256: values.candidate ? buildHash(fixture, values.candidate) : null },
      mode: values.mode ?? scenario.timing.mode,
      warmup: 0,
      repetitions: 1,
      exclusions: [],
      recorderSha256: recorderHash(),
    };
    writeJson(join(out, 'manifest.json'), manifest);
    const { comparison } = await runCase({
      browser,
      scenario,
      stateAllowlist: allow,
      baseline,
      candidate,
      out,
      mode: values.mode as 'controlled' | 'wall' | undefined,
      screenshots: !values['no-screenshots'],
    });
    await exportReport(out);
    print(comparison);
    console.log(`Report: ${relative(process.cwd(), join(out, 'report', 'index.html'))}`);
    return exitCode(comparison.verdict);
  } finally {
    await baseline.stop();
    await candidate.stop();
    await browser.close();
  }
}

function loadRun(dir: string) {
  const out = resolve(dir);
  const manifest: RunManifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const comparison: Comparison = JSON.parse(readFileSync(join(out, 'raw', 'original.comparison.json'), 'utf8'));
  const scenario = parseScenario(JSON.parse(readFileSync(join(out, 'raw', 'original.scenario.json'), 'utf8')));
  return { out, manifest, comparison, scenario };
}

async function serveFromManifest(m: RunManifest): Promise<{ baseline: ServedBuild; candidate: ServedBuild }> {
  const fixtures = m.fixture.registry ? loadRegistry(m.fixture.registry) : new Map<string, LoadedFixture>();
  const serve = async (side: RunManifest['baseline'], label: string) => {
    if (side.url) return fromUrl(label, side.url);
    const r = resolveBuildRef(fixtures, side.ref);
    return serveBuild(r.fixture, r.build);
  };
  return { baseline: await serve(m.baseline, 'baseline'), candidate: await serve(m.candidate, 'candidate') };
}

async function cmdReduce(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'max-attempts': { type: 'string', default: '60' },
      'max-seconds': { type: 'string', default: '120' },
      'confirm-runs': { type: 'string', default: '3' },
      'reproduction-runs': { type: 'string', default: '10' },
      resume: { type: 'boolean', default: false },
    },
  });
  const { out, manifest, comparison, scenario } = loadRun(positionals[0] ?? '');
  const target = comparison.introduced[0];
  if (!target) {
    console.log(`Nothing to reduce: the verdict is ${comparison.verdict}.`);
    return 0;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nStopping after the current attempt. Progress is saved.');
    controller.abort();
  });
  const browser = await launch(manifest.environment.browser.name);
  const { baseline, candidate } = await serveFromManifest(manifest);
  try {
    const report = await reduceScenario({
      browser,
      scenario,
      stateAllowlist: manifest.fixture.stateAllowlist,
      baselineUrl: baseline.url,
      candidateUrl: candidate.url,
      fingerprint: target.fingerprint,
      out,
      budget: { maxAttempts: Number(values['max-attempts']), maxMs: Number(values['max-seconds']) * 1000 },
      confirmRuns: Number(values['confirm-runs']),
      reproductionRuns: Number(values['reproduction-runs']),
      mode: manifest.mode as 'controlled' | 'wall',
      signal: controller.signal,
      resume: values.resume,
    });
    printReduction(report);
    if (report.status !== 'not-reproduced' && existsSync(join(out, 'reduced.scenario.json'))) {
      const reduced = parseScenario(JSON.parse(readFileSync(join(out, 'reduced.scenario.json'), 'utf8')));
      await runCase({ browser, scenario: reduced, stateAllowlist: manifest.fixture.stateAllowlist, baseline, candidate, out, mode: manifest.mode as 'controlled' | 'wall', screenshots: true, label: 'reduced' });
    }
    await exportReport(out);
    return report.status === 'reduced' ? 0 : 1;
  } finally {
    await baseline.stop();
    await candidate.stop();
    await browser.close();
  }
}

function printReduction(r: ReductionReport): void {
  if (r.status === 'not-reproduced') {
    console.log(`NOT REPRODUCED: the failure appeared in ${r.originalReproduction.reproduced} of ${r.originalReproduction.runs} runs. The original trace is kept.`);
    return;
  }
  if (r.status === 'unstable' && r.reducedActions === r.originalActions) {
    console.log(`UNSTABLE: the failure appeared in ${r.originalReproduction.reproduced} of ${r.originalReproduction.runs} runs, so it was not reduced. The original trace is kept.`);
    return;
  }
  console.log(`${r.status.toUpperCase()}: ${r.originalActions} actions to ${r.reducedActions}, in ${r.attempts} attempts and ${(r.elapsedMs / 1000).toFixed(1)} s.`);
  console.log(`Reproduced in ${r.reducedReproduction.reproduced} of ${r.reducedReproduction.runs} runs. Baseline showed it in ${r.baselineReproduction.reproduced} of ${r.baselineReproduction.runs}.`);
  console.log(`Attempts: ${Object.entries(r.outcomes).map(([k, v]) => `${v} ${k}`).join(', ')}. Stopped: ${r.stopped}.`);
}

async function cmdReplay(args: string[]): Promise<number> {
  const { out, manifest } = loadRun(args[0] ?? '');
  const path = join(out, 'reduced.scenario.json');
  if (!existsSync(path)) throw new InvalidScenario('this run has no reduced scenario. Run: trace reduce <run-dir>');
  const scenario = readScenario(path);
  const browser = await launch(manifest.environment.browser.name);
  const { baseline, candidate } = await serveFromManifest(manifest);
  try {
    const { comparison } = await runCase({ browser, scenario, stateAllowlist: manifest.fixture.stateAllowlist, baseline, candidate, out, mode: manifest.mode as 'controlled' | 'wall', screenshots: true, label: 'reduced' });
    await exportReport(out);
    print(comparison);
    return exitCode(comparison.verdict);
  } finally {
    await baseline.stop();
    await candidate.stop();
    await browser.close();
  }
}

/**
 * Real time, a new browser for each run, and the low-overhead recording level.
 * No screenshots or video. Builds alternate so drift hits both the same way.
 */
async function cmdPerf(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      browser: { type: 'string', default: 'chromium' },
      runs: { type: 'string', default: '5' },
      warmup: { type: 'string', default: '1' },
      out: { type: 'string' },
      registry: { type: 'string', default: REGISTRY_FILE },
    },
  });
  const scenario = readScenario(positionals[0] ?? '');
  const runs = Number(values.runs);
  const warmup = Number(values.warmup);
  if (runs < 5) console.log('Fewer than 5 runs. Treat these numbers as a smoke check, not a result.');
  const fixtures = loadRegistry(values.registry!);
  const fixture = fixtures.get(scenario.fixture.id);
  if (!fixture) throw new InvalidScenario(`fixture ${scenario.fixture.id} is not registered`);
  const type = BROWSERS[values.browser as keyof typeof BROWSERS];
  if (!type) throw new InvalidScenario(`unknown browser "${values.browser}"`);
  const a = resolveBuildRef(fixtures, values.baseline ?? '');
  const b = resolveBuildRef(fixtures, values.candidate ?? '');
  const baseline = await serveBuild(a.fixture, a.build);
  const candidate = await serveBuild(b.fixture, b.build);
  const out = resolve(values.out ?? join('.trace', `${scenario.id}-perf`));
  const opts = { type, scenario, stateAllowlist: fixture.manifest.stateAllowlist, recording: 'stamps' as const };
  const results: Record<'baseline' | 'candidate', PerfRun[]> = { baseline: [], candidate: [] };
  try {
    for (let n = 0; n < warmup + runs; n++) {
      const order = n % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const);
      for (const side of order) {
        const r = await perfRun({ ...opts, url: (side === 'baseline' ? baseline : candidate).url }, n);
        if (n >= warmup) results[side].push(r);
      }
    }
  } finally {
    await baseline.stop();
    await candidate.stop();
  }
  const summary = { baseline: summarize(results.baseline, warmup), candidate: summarize(results.candidate, warmup) };
  writeJson(join(out, 'perf.raw.json'), results);
  writeJson(join(out, 'perf.summary.json'), summary);
  console.log(`${runs} runs after ${warmup} warmup. Median across runs, with the range. Wall clock, not INP.`);
  for (const name of Object.keys(summary.baseline.metrics)) {
    const x = summary.baseline.metrics[name]!;
    const y = summary.candidate.metrics[name];
    console.log(`  ${name.padEnd(18)} baseline ${x.median} (${x.min} to ${x.max})   candidate ${y?.median} (${y?.min} to ${y?.max})`);
  }
  return 0;
}

function cmdFixtures(args: string[], registryPath = REGISTRY_FILE): number {
  const [sub, path] = args;
  if (sub === 'list') {
    for (const [id, f] of loadRegistry(registryPath)) {
      console.log(`${id} v${f.manifest.version}: ${Object.keys(f.manifest.builds).join(', ')}`);
    }
    return 0;
  }
  if (sub === 'add' && path) {
    const { manifest } = loadFixture(path);
    const current = existsSync(registryPath)
      ? Registry.parse(JSON.parse(readFileSync(registryPath, 'utf8')))
      : { schema: 'trace.registry/1' as const, fixtures: [] };
    const fixtures = current.fixtures.filter((f) => f.id !== manifest.id);
    fixtures.push({ id: manifest.id, manifest: relative(dirname(resolve(registryPath)), resolve(path)) });
    writeFileSync(registryPath, JSON.stringify({ ...current, fixtures }, null, 2) + '\n');
    console.log(`Registered ${manifest.id} with ${Object.keys(manifest.builds).length} build(s).`);
    return 0;
  }
  console.log(USAGE);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'validate': {
      const s = readScenario(rest[0] ?? '');
      console.log(`Valid: ${s.id}, ${s.actions.length} actions, ${s.requirements.length} requirements.`);
      return 0;
    }
    case 'run':
      return cmdRun(rest);
    case 'reduce':
      return cmdReduce(rest);
    case 'replay':
      return cmdReplay(rest);
    case 'perf':
      return cmdPerf(rest);
    case 'report':
      await exportReport(resolve(rest[0] ?? ''));
      console.log(`Report: ${join(rest[0] ?? '', 'report', 'index.html')}`);
      return 0;
    case 'serve': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { port: { type: 'string', default: '5175' } } });
      const server = await serveDirectory(positionals[0] ?? '.', Number(values.port));
      console.log(`Serving ${positionals[0] ?? '.'} at ${server.url}`);
      await new Promise(() => {});
      return 0;
    }
    case 'fixtures':
      return cmdFixtures(rest);
    default:
      console.log(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof InvalidScenario) {
      console.error(`INVALID: ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(error);
      process.exitCode = 3;
    }
  },
);
