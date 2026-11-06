import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { serveDirectory } from '../../src/runner/static.ts';
import { ROOT } from './helpers.ts';

const exec = promisify(execFile);
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const CLI = join(ROOT, 'src/cli.ts');

async function cli(args: string[], cwd = ROOT): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec(TSX, [CLI, ...args], { cwd });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, out: err.stdout + err.stderr };
  }
}

const temp = () => mkdtempSync(join(tmpdir(), 'trace-run-'));
const scenarioPath = (fixture: string, id: string) => join(ROOT, 'fixtures', fixture, 'scenarios', `${id}.json`);

describe('cli verdicts and exit codes', () => {
  it('exits 0 on a pass', async () => {
    const r = await cli(['run', scenarioPath('inspector', 'escape-closes'), '--baseline', 'inspector@correct', '--candidate', 'inspector@legit-restyle', '--out', temp()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PASS/);
  });

  it('exits 1 on a regression and names it', async () => {
    const r = await cli(['run', scenarioPath('overlay', 'escape-dismisses'), '--baseline', 'overlay@correct', '--candidate', 'overlay@no-restore', '--out', temp()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REGRESSION: Focus should return to trigger/);
  });

  it('exits 0 and says fixed when the candidate fixes the baseline', async () => {
    const r = await cli(['run', scenarioPath('overlay', 'escape-dismisses'), '--baseline', 'overlay@no-restore', '--candidate', 'overlay@correct', '--out', temp()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FIXED/);
  });

  it('exits 2 on a malformed scenario', async () => {
    const dir = temp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schema: 'trace.scenario/1', id: 'x' }));
    const r = await cli(['validate', bad]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/INVALID/);
  });

  it('refuses a remote URL before opening a browser page', async () => {
    const r = await cli(['run', scenarioPath('inspector', 'escape-closes'), '--baseline-url', 'https://example.com/', '--candidate', 'inspector@correct', '--out', temp()]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/refusing example.com/);
  });
});

describe('reduce, replay, regenerate', () => {
  it('reduces a real failure, replays it, and regenerates the same report from raw files', async () => {
    const out = temp();
    const run = await cli(['run', scenarioPath('inspector', 'long-session'), '--baseline', 'inspector@correct', '--candidate', 'inspector@stale-origin', '--out', out]);
    expect(run.code).toBe(1);
    const reduce = await cli(['reduce', out]);
    expect(reduce.code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'reduction.json'), 'utf8'));
    expect(report.reducedActions).toBeLessThan(report.originalActions);
    expect(report.oneMinimal).toBe(true);
    expect(report.reducedReproduction.reproduced).toBe(report.reducedReproduction.runs);
    expect(report.baselineReproduction.reproduced).toBe(0);
    const replay = await cli(['replay', out]);
    expect(replay.code).toBe(1);
    expect(replay.out).toMatch(/REGRESSION: panel appeared/);
    const before = readFileSync(join(out, 'report', 'report.json'));
    await cli(['report', out]);
    expect(readFileSync(join(out, 'report', 'report.json')).equals(before)).toBe(true);
  });

  it('cancels on SIGINT, keeps progress, and resumes to the same result', async () => {
    const out = temp();
    await cli(['run', scenarioPath('inspector', 'long-session'), '--baseline', 'inspector@correct', '--candidate', 'inspector@stale-origin', '--out', out, '--no-screenshots']);
    const child = spawn(TSX, [CLI, 'reduce', out, '--confirm-runs', '1', '--reproduction-runs', '1'], { cwd: ROOT, stdio: 'ignore' });
    const progress = join(out, 'reduction.progress.json');
    while (!existsSync(progress)) await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
    const partial = JSON.parse(readFileSync(join(out, 'reduction.json'), 'utf8'));
    expect(partial.stopped).toBe('cancelled');
    expect(partial.oneMinimal).toBe(false);
    const resumed = await cli(['reduce', out, '--resume', '--confirm-runs', '1', '--reproduction-runs', '1']);
    expect(resumed.code).toBe(0);
    const final = JSON.parse(readFileSync(join(out, 'reduction.json'), 'utf8'));
    expect(final.stopped).toBe('minimal');
    expect(final.reducedActions).toBe(4);
  });

  it('labels a failure it cannot reproduce instead of reducing it', async () => {
    const out = temp();
    await cli(['run', scenarioPath('overlay', 'escape-dismisses'), '--baseline', 'overlay@correct', '--candidate', 'overlay@no-restore', '--out', out, '--no-screenshots']);
    // Point the saved run at a build that does not have the bug.
    const path = join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.candidate.ref = 'overlay@correct';
    writeFileSync(path, JSON.stringify(manifest));
    const r = await cli(['reduce', out]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NOT REPRODUCED/);
    expect(existsSync(join(out, 'reduced.scenario.json'))).toBe(false);
    expect(existsSync(join(out, 'raw', 'original.candidate.json'))).toBe(true);
  });
});

describe('other ways to supply a build', () => {
  it('runs against local URLs the user started', async () => {
    const a = await serveDirectory(join(ROOT, '.build/fixtures/overlay/correct'));
    const b = await serveDirectory(join(ROOT, '.build/fixtures/overlay/no-restore'));
    const r = await cli(['run', scenarioPath('overlay', 'escape-dismisses'), '--baseline-url', a.url, '--candidate-url', b.url, '--allowlist', 'dialog', '--out', temp(), '--registry', 'none.json']);
    await a.close();
    await b.close();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REGRESSION/);
  });

  it('launches a build from the command in a registered manifest, and stops it', async () => {
    const dir = temp();
    const server = join(dir, 'server.mjs');
    writeFileSync(server, `import { createServer } from 'node:http';
createServer((_, res) => { res.setHeader('content-type', 'text/html');
res.end(\`<button data-trace-id="go">Go</button><script>window.__traceFixture = { id: 'launched', version: '1', getState: () => ({}), subscribe: () => () => {} };</script>\`); }).listen(47123, '127.0.0.1');`);
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({
      schema: 'trace.fixture/1', id: 'launched', version: '1', stateAllowlist: [], clock: { channels: [] },
      builds: { only: { command: [process.execPath, server], url: 'http://127.0.0.1:47123/' } },
    }));
    const scenario = join(dir, 's.json');
    writeFileSync(scenario, JSON.stringify({
      schema: 'trace.scenario/1', id: 's', fixture: { id: 'launched', version: '1' }, seed: 1, initialState: {},
      viewport: { width: 400, height: 300, deviceScaleFactor: 1 }, timing: { mode: 'controlled', stepMs: 16, settleMs: 50 },
      targets: { go: { role: 'button', name: 'Go', traceId: 'go' } }, requirements: [],
      actions: [{ at: 0, type: 'activate', target: 'go' }], cleanup: [],
    }));
    await cli(['fixtures', 'add', join(dir, 'fixture.json')], dir);
    // Each side launches its own copy, so one port would clash. Baseline only, against a URL for the candidate.
    const other = await serveDirectory(join(ROOT, '.build/fixtures/overlay/correct'));
    await other.close();
    const r = await cli(['run', scenario, '--baseline', 'launched@only', '--candidate-url', 'http://127.0.0.1:47123/', '--out', join(dir, 'out')], dir);
    expect(r.out).toMatch(/PASS/);
    await expect(fetch('http://127.0.0.1:47123/').then(() => 'up', () => 'down')).resolves.toBe('down');
  });
});

describe('a page with no change to its source', () => {
  it('runs with an injected test-only adapter', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'index.html'), '<a href="#a">One</a><a href="#b">Two</a>');
    const page = await serveDirectory(dir);
    writeFileSync(join(dir, 'adapter.js'), "window.__traceFixture = { id: 'page', version: '1', getState: () => ({}), subscribe: () => () => {} };");
    const scenario = join(dir, 's.json');
    writeFileSync(scenario, JSON.stringify({
      schema: 'trace.scenario/1', id: 's', fixture: { id: 'page', version: '1' }, seed: 1, initialState: {},
      viewport: { width: 400, height: 300, deviceScaleFactor: 1 }, timing: { mode: 'controlled', stepMs: 16, settleMs: 50 },
      targets: {}, requirements: [{ kind: 'focus-valid' }], actions: [{ at: 0, type: 'press', key: 'Tab' }, { at: 50, type: 'press', key: 'Tab' }], cleanup: [],
    }));
    const r = await cli(['run', scenario, '--baseline-url', page.url, '--candidate-url', page.url, '--allowlist', 'none', '--adapter', join(dir, 'adapter.js'), '--out', join(dir, 'out'), '--registry', 'none.json']);
    await page.close();
    expect(r.out).toMatch(/PASS/);
    expect(r.code).toBe(0);
  });
});

describe('a newly registered fixture', () => {
  it('works through the public contract with nothing from this repository', async () => {
    const dir = temp();
    const fixture = join(dir, 'tabs');
    mkdirSync(join(fixture, 'good'), { recursive: true });
    mkdirSync(join(fixture, 'bad'), { recursive: true });
    const page = (restore: boolean) => `<!doctype html><title>Tabs</title>
<button data-trace-id="a">Alpha</button><button data-trace-id="b">Beta</button>
<script>
let tab = 'a';
const subscribers = new Set();
window.__traceFixture = { id: 'tabs', version: '1', getState: () => ({ tab }), subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); } };
const set = (t) => { tab = t; subscribers.forEach((f) => f()); };
document.querySelector('[data-trace-id=b]').onclick = (e) => { set('b'); ${restore ? '' : 'setTimeout(() => e.target.remove(), 30);'} };
</script>`;
    writeFileSync(join(fixture, 'good', 'index.html'), page(true));
    writeFileSync(join(fixture, 'bad', 'index.html'), page(false));
    writeFileSync(join(fixture, 'fixture.json'), JSON.stringify({
      schema: 'trace.fixture/1', id: 'tabs', version: '1', stateAllowlist: ['tab'], clock: { channels: ['timers'] },
      builds: { good: { dir: 'good' }, bad: { dir: 'bad' } },
    }));
    const scenario = join(fixture, 'switch.json');
    writeFileSync(scenario, JSON.stringify({
      schema: 'trace.scenario/1', id: 'switch', fixture: { id: 'tabs', version: '1' }, seed: 1, initialState: {},
      viewport: { width: 400, height: 300, deviceScaleFactor: 1 }, timing: { mode: 'controlled', stepMs: 16, settleMs: 100 },
      targets: { beta: { role: 'button', name: 'Beta', traceId: 'b' } },
      requirements: [{ kind: 'focus-stays-on', target: 'beta', whileState: { tab: 'b' } }],
      actions: [{ at: 0, type: 'activate', target: 'beta' }, { at: 100, type: 'press', key: 'Shift' }], cleanup: [],
    }));
    expect((await cli(['fixtures', 'add', join(fixture, 'fixture.json')], dir)).code).toBe(0);
    expect((await cli(['fixtures', 'list'], dir)).out).toMatch(/tabs v1: good, bad/);
    const r = await cli(['run', scenario, '--baseline', 'tabs@good', '--candidate', 'tabs@bad', '--out', join(dir, 'out')], dir);
    expect(r.out).toMatch(/REGRESSION/);
    expect(r.code).toBe(1);
  });
});

