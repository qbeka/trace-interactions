import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { runCase, writeJson } from '../src/case.ts';
import { exportReport } from '../src/report/export.ts';
import { loadRegistry, serveBuild } from '../src/runner/registry.ts';
import { parseScenario } from '../src/scenario/validate.ts';

/**
 * Smoke suite: one good pair and one seeded failure, through the report.
 * Target: under 60 s after install. It checks that the harness works. It is not
 * a measurement, and nothing in it is quoted as a result.
 */
const TARGET_MS = 60_000;
const started = performance.now();
const root = resolve(import.meta.dirname, '..');
const fixture = loadRegistry(join(root, 'trace.fixtures.json')).get('inspector')!;
const scenario = parseScenario(JSON.parse(readFileSync(join(root, 'fixtures/inspector/scenarios/reopen-during-close.json'), 'utf8')));
const allow = fixture.manifest.stateAllowlist;
const browser = await chromium.launch();
const correct = await serveBuild(fixture, 'correct');
const stale = await serveBuild(fixture, 'stale-completion');
const out = mkdtempSync(join(tmpdir(), 'trace-smoke-'));

const good = await runCase({ browser, scenario, stateAllowlist: allow, baseline: correct, candidate: correct, out: join(out, 'good') });
const bad = await runCase({ browser, scenario, stateAllowlist: allow, baseline: correct, candidate: stale, out: join(out, 'bad') });
writeJson(join(out, 'bad', 'manifest.json'), { baseline: { ref: 'correct' }, candidate: { ref: 'stale-completion' } });
await exportReport(join(out, 'bad'));

await correct.stop();
await stale.stop();
await browser.close();

const elapsed = performance.now() - started;
const failures: string[] = [];
if (good.comparison.verdict !== 'pass') failures.push(`the good pair should pass, got ${good.comparison.verdict}`);
if (bad.comparison.verdict !== 'regression') failures.push(`the seeded failure should regress, got ${bad.comparison.verdict}`);
if (!bad.comparison.introduced.some((v) => v.category === 'stale-final-state')) failures.push('the seeded failure lost its category');
if (elapsed > TARGET_MS) failures.push(`took ${Math.round(elapsed / 1000)} s, over the ${TARGET_MS / 1000} s target`);
console.log(`good pair: ${good.comparison.verdict}`);
console.log(`seeded failure: ${bad.comparison.verdict}: ${bad.comparison.sentence}`);
console.log(`smoke took ${(elapsed / 1000).toFixed(1)} s (target ${TARGET_MS / 1000} s)`);
for (const f of failures) console.error(`FAIL: ${f}`);
process.exitCode = failures.length ? 1 : 0;
