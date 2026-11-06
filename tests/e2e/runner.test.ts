import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, firefox, webkit, type Browser } from 'playwright';
import { behaviorHash } from '../../src/case.ts';
import { compare } from '../../src/compare.ts';
import { assertLoopback } from '../../src/runner/registry.ts';
import { runScenario, type RunOutput } from '../../src/runner/run.ts';
import type { TraceEvent } from '../../src/trace/types.ts';
import { ADAPTER, ALLOW, plainScenario, scenario, servePage, serveVariant } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser.close());

const states = (r: RunOutput) => r.events.filter((e): e is Extract<TraceEvent, { k: 'state' }> => e.k === 'state').map((e) => `${e.key}=${e.value}`);
const button = `<button data-trace-id="go">Go</button>`;

describe('determinism', () => {
  it('produces the same behavior on repeat runs', async () => {
    const server = await serveVariant('inspector', 'stale-completion');
    const s = scenario('inspector', 'reopen-during-close');
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      hashes.add(behaviorHash(await runScenario({ browser, url: server.url, scenario: s, stateAllowlist: ALLOW.inspector })));
    }
    await server.close();
    expect(hashes.size).toBe(1);
  });

  it('gets the same answer with and without the idle jump', async () => {
    const server = await serveVariant('inspector', 'stale-origin');
    const s = scenario('inspector', 'long-session');
    const fast = await runScenario({ browser, url: server.url, scenario: s, stateAllowlist: ALLOW.inspector });
    const slow = await runScenario({ browser, url: server.url, scenario: s, stateAllowlist: ALLOW.inspector, everyTick: true });
    await server.close();
    expect(states(fast)).toEqual(states(slow));
    expect(fast.violations.map((v) => v.fingerprint)).toEqual(slow.violations.map((v) => v.fingerprint));
    expect(fast.violations.map((v) => v.at.t)).toEqual(slow.violations.map((v) => v.at.t));
  });

  it('keeps list order for actions at the same time', async () => {
    const server = await servePage(`${ADAPTER}${button}`);
    const s = plainScenario({ actions: [{ at: 50, type: 'activate', target: 'go', note: 'first' }, { at: 50, type: 'activate', target: 'go', note: 'second' }] });
    const r = await runScenario({ browser, url: server.url, scenario: s, stateAllowlist: [] });
    await server.close();
    const starts = r.events.filter((e): e is Extract<TraceEvent, { k: 'action' }> => e.k === 'action' && e.phase === 'start');
    expect(starts.map((a) => a.label)).toEqual(['first', 'second']);
    expect(starts[0]!.t).toBe(starts[1]!.t);
    expect(starts[0]!.seq).toBeLessThan(starts[1]!.seq);
  });

  it('gives a page the seeded Math.random', async () => {
    const page = (id: string) => servePage(`${ADAPTER.replace("phase: 'idle'", 'phase: String(window.__r)').replace('<script>', '<script>window.__r = Math.random();')}${button}<!-- ${id} -->`);
    const a = await page('a');
    const b = await page('b');
    const s = plainScenario();
    const [x, y] = await Promise.all([a, b].map((srv) => runScenario({ browser, url: srv.url, scenario: s, stateAllowlist: ['phase'] })));
    await a.close();
    await b.close();
    expect(states(x!)[0]).toEqual(states(y!)[0]);
    expect(states(x!)[0]).toMatch(/^phase=0\.\d+/);
  });
});

describe('invalid scenarios are not regressions', () => {
  it('reports a failed selector as invalid', async () => {
    const server = await serveVariant('inspector', 'correct');
    const s = scenario('inspector', 'reopen-during-close');
    const broken = { ...s, targets: { ...s.targets, close: { role: 'button', name: 'No such button', traceId: 'close' } } };
    const r = await runScenario({ browser, url: server.url, scenario: broken, stateAllowlist: ALLOW.inspector });
    await server.close();
    expect(r.status).toBe('invalid');
    expect(r.invalid?.actionIndex).toBe(1);
    expect(compare(r, r).verdict).toBe('invalid');
  });

  it('separates a replay the candidate cannot finish from a regression', async () => {
    const good = await serveVariant('inspector', 'correct');
    const bad = await serveVariant('inspector', 'escape-ignored');
    const s = scenario('inspector', 'long-session');
    const [a, b] = await Promise.all([good, bad].map((x) => runScenario({ browser, url: x.url, scenario: s, stateAllowlist: ALLOW.inspector })));
    await good.close();
    await bad.close();
    expect(compare(a!, b!).verdict).toBe('diverged');
  });

  it('rejects a page with no adapter', async () => {
    const server = await servePage('<h1>No adapter here</h1>');
    const r = await runScenario({ browser, url: server.url, scenario: plainScenario(), stateAllowlist: [] });
    await server.close();
    expect(r.status).toBe('invalid');
    expect(r.invalid?.reason).toMatch(/adapter/);
  });

  it('rejects a fixture version the scenario did not ask for', async () => {
    const server = await servePage(`${ADAPTER.replace("version: '1'", "version: '2'")}${button}`);
    const r = await runScenario({ browser, url: server.url, scenario: plainScenario(), stateAllowlist: [] });
    await server.close();
    expect(r.invalid?.reason).toMatch(/v1, the page is plain v2/);
  });

  it('refuses a build that is not on this machine', () => {
    expect(() => assertLoopback('https://example.com/')).toThrow(/refusing/);
    expect(() => assertLoopback('http://127.0.0.1:4000/')).not.toThrow();
  });
});

describe('oracle needs no baseline', () => {
  it('reports a bug both builds share', async () => {
    const server = await serveVariant('inspector', 'stale-completion');
    const s = scenario('inspector', 'reopen-during-close');
    const run = () => runScenario({ browser, url: server.url, scenario: s, stateAllowlist: ALLOW.inspector });
    const c = compare(await run(), await run());
    await server.close();
    expect(c.verdict).toBe('shared-failure');
  });

  it('does not flag a final screenshot match as a pass', async () => {
    // The stale build ends with the panel open, same as the correct build.
    const server = await serveVariant('inspector', 'stale-completion');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('inspector', 'reopen-during-close'), stateAllowlist: ALLOW.inspector });
    await server.close();
    expect(states(r).at(-1)).toBe('panel=open');
    expect(r.violations.some((v) => v.category === 'stale-final-state')).toBe(true);
  });
});

describe('clock contract', () => {
  it('verifies every channel on a normal fixture', async () => {
    const server = await serveVariant('overlay', 'correct');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('overlay', 'escape-dismisses'), stateAllowlist: ALLOW.overlay });
    await server.close();
    expect(r.clock.verified).toEqual({ timers: true, frames: true, performance: true, date: true, animations: true });
    expect(r.clock.uncontrolled.join()).toMatch(/Rasterization/);
  });

  it('fails the run when a page breaks the clock', async () => {
    const server = await servePage(`${ADAPTER}<script>performance.now = () => 0;</script>${button}`);
    const r = await runScenario({ browser, url: server.url, scenario: plainScenario(), stateAllowlist: [] });
    await server.close();
    expect(r.status).toBe('invalid');
    expect(r.invalid?.reason).toMatch(/clock contract failed for: .*performance/);
  });

  it('reports an uncontrolled channel the page used', async () => {
    const worker = `new Worker(URL.createObjectURL(new Blob(['1'])));`;
    const server = await servePage(`${ADAPTER}${button}<script>document.querySelector('button').onclick = () => { ${worker} document.body.scrollTo({ top: 1, behavior: 'smooth' }); };</script>`);
    const r = await runScenario({ browser, url: server.url, scenario: plainScenario(), stateAllowlist: [] });
    await server.close();
    expect(r.clock.used.sort()).toEqual(['smooth-scroll', 'worker']);
  });
});

describe('privacy', () => {
  it('never records typed text or a value outside the allowlist', async () => {
    const server = await serveVariant('overlay', 'correct');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('overlay', 'open-and-cancel'), stateAllowlist: ALLOW.overlay });
    await server.close();
    const saved = JSON.stringify(r);
    expect(saved).not.toContain('synthetic-pw-1');
    expect(states(r)).toContain('passwordLength=14');
  });

  it('drops state keys the fixture did not allowlist', async () => {
    const server = await servePage(`${ADAPTER}${button}`);
    const r = await runScenario({ browser, url: server.url, scenario: plainScenario(), stateAllowlist: ['phase'] });
    await server.close();
    expect(JSON.stringify(r)).not.toContain('do-not-record');
  });

  it('keeps printable keys out of the trace', async () => {
    const server = await serveVariant('inspector', 'correct');
    const s = scenario('inspector', 'resize-while-editing');
    const r = await runScenario({ browser, url: server.url, scenario: s, stateAllowlist: ALLOW.inspector });
    await server.close();
    const keys = r.events.flatMap((e) => (e.k === 'event' && e.key ? [e.key] : []));
    expect(keys.every((k) => k.length > 1)).toBe(true);
  });
});

describe('pointer cancel', () => {
  it('sends a real browser cancel on Chromium and releases capture', async () => {
    const server = await serveVariant('timeline', 'correct');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('timeline', 'cancel-drag'), stateAllowlist: ALLOW.timeline });
    await server.close();
    const names = r.events.flatMap((e) => (e.k === 'event' ? [e.name] : []));
    expect(names).toContain('pointercancel');
    expect(names).toContain('lostpointercapture');
    expect(r.clock.used).not.toContain('synthetic-pointer-cancel');
    expect(r.violations).toEqual([]);
  });

  it('treats a move after the finger lifts as invalid, not a crash', async () => {
    const server = await serveVariant('timeline', 'correct');
    const s = scenario('timeline', 'cancel-drag');
    const point = { space: 'target-fraction', target: 'track', x: 0.5, y: 0.5 } as const;
    const bad = { ...s, requirements: [], actions: [...s.actions, { at: 800, type: 'pointerMove', point } as const] };
    const r = await runScenario({ browser, url: server.url, scenario: bad, stateAllowlist: ALLOW.timeline });
    await server.close();
    expect(r.status).toBe('invalid');
    expect(r.invalid?.actionIndex).toBe(4);
  });

  it.each([['firefox', firefox], ['webkit', webkit]] as const)('falls back to a labelled synthetic cancel on %s', async (_name, type) => {
    const other = await type.launch();
    const good = await serveVariant('timeline', 'correct');
    const bad = await serveVariant('timeline', 'drag-stuck-on-cancel');
    const s = scenario('timeline', 'cancel-drag');
    const a = await runScenario({ browser: other, url: good.url, scenario: s, stateAllowlist: ALLOW.timeline });
    const b = await runScenario({ browser: other, url: bad.url, scenario: s, stateAllowlist: ALLOW.timeline });
    await good.close();
    await bad.close();
    await other.close();
    expect(a.clock.used).toContain('synthetic-pointer-cancel');
    expect(a.violations).toEqual([]);
    expect(b.violations[0]?.category).toBe('incomplete-cleanup');
  });
});

describe('wall clock mode', () => {
  it('runs on real time and still finds the stale completion', async () => {
    const server = await serveVariant('inspector', 'stale-completion');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('inspector', 'reopen-during-close'), stateAllowlist: ALLOW.inspector, mode: 'wall' });
    await server.close();
    expect(r.clock.mode).toBe('wall');
    expect(r.clock.verified).toEqual({});
    expect(r.violations.some((v) => v.category === 'stale-final-state')).toBe(true);
  });

  it('stays clean on the correct build', async () => {
    const server = await serveVariant('inspector', 'correct');
    const r = await runScenario({ browser, url: server.url, scenario: scenario('inspector', 'reopen-during-close'), stateAllowlist: ALLOW.inspector, mode: 'wall' });
    await server.close();
    expect(r.violations).toEqual([]);
  });
});
