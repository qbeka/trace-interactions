import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveDirectory, type StaticServer } from '../../src/runner/static.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import { parseScenario } from '../../src/scenario/validate.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ALLOW = {
  inspector: ['panel', 'narrow', 'titleLength', 'mounted'],
  overlay: ['dialog', 'passwordLength', 'mounted'],
  timeline: ['value', 'dragging', 'settling', 'mounted'],
};

export function scenario(fixture: string, id: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(join(ROOT, 'fixtures', fixture, 'scenarios', `${id}.json`), 'utf8')));
}

export const serveVariant = (fixture: string, variant: string): Promise<StaticServer> =>
  serveDirectory(join(ROOT, '.build/fixtures', fixture, variant));

/** A one-file page for the cases a React fixture cannot express. */
export async function servePage(html: string): Promise<StaticServer> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-page-'));
  writeFileSync(join(dir, 'index.html'), html);
  return serveDirectory(dir);
}

export const ADAPTER = `<script>
window.__traceFixture = { id: 'plain', version: '1', getState: () => ({ phase: 'idle', secret: 'do-not-record' }), subscribe: () => () => {}, request() {} };
</script>`;

export function plainScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    schema: 'trace.scenario/1',
    id: 'plain',
    fixture: { id: 'plain', version: '1' },
    seed: 1,
    initialState: {},
    viewport: { width: 400, height: 300, deviceScaleFactor: 1 },
    timing: { mode: 'controlled', stepMs: 16, settleMs: 100 },
    targets: { go: { role: 'button', name: 'Go', traceId: 'go' } },
    requirements: [],
    actions: [{ at: 0, type: 'activate', target: 'go' }],
    cleanup: [],
    ...over,
  };
}
