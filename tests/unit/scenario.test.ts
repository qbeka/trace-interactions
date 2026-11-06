import { describe, expect, it } from 'vitest';
import { InvalidScenario, parseScenario, sequenceProblem } from '../../src/scenario/validate.ts';
import { scenario } from './helpers.ts';

describe('scenario contract', () => {
  it('accepts a well formed scenario', () => {
    expect(parseScenario(scenario()).id).toBe('unit');
  });

  it('rejects an unsupported command as invalid, not as a failure', () => {
    const bad = { ...scenario(), actions: [{ type: 'teleport', at: 0 }] };
    expect(() => parseScenario(bad)).toThrow(InvalidScenario);
  });

  it('rejects unknown fields, so a typo cannot silently do nothing', () => {
    const bad = { ...scenario(), actions: [{ type: 'activate', target: 'trigger', at: 0, atMs: 5 }] };
    expect(() => parseScenario(bad)).toThrow(InvalidScenario);
  });

  it('rejects a coordinate with no coordinate space', () => {
    const bad = { ...scenario(), actions: [{ type: 'pointerDown', at: 0, point: { x: 1, y: 2 } }] };
    expect(() => parseScenario(bad)).toThrow(InvalidScenario);
  });

  it('rejects an action on an unknown target', () => {
    expect(() => parseScenario(scenario({ actions: [{ type: 'activate', target: 'nope', at: 0 }] }))).toThrow(/unknown target/);
  });

  it('rejects a requirement that observes a target with no traceId', () => {
    const s = scenario({
      targets: { trigger: { role: 'button' } },
      requirements: [{ kind: 'single-interactive', target: 'trigger' }],
    });
    expect(() => parseScenario(s)).toThrow(/needs a traceId/);
  });

  it('rejects a pointer up with no pointer down', () => {
    const problem = sequenceProblem([{ type: 'pointerUp', at: 0 }], {});
    expect(problem?.reason).toMatch(/no pointer down/);
  });

  it('rejects time running backwards', () => {
    const s = scenario({ actions: [{ type: 'activate', target: 'trigger', at: 10 }, { type: 'activate', target: 'trigger', at: 5 }] });
    expect(() => parseScenario(s)).toThrow(/backwards/);
  });

  it('allows two actions at the same time, ordered by the list', () => {
    const s = scenario({ actions: [{ type: 'activate', target: 'trigger', at: 10 }, { type: 'activate', target: 'trigger', at: 10 }] });
    expect(parseScenario(s).actions).toHaveLength(2);
  });

  it('counts cleanup time from zero, not from the last main action', () => {
    const s = scenario({
      actions: [{ type: 'activate', target: 'trigger', at: 900 }],
      cleanup: [{ type: 'requestState', state: { mounted: false }, at: 0 }],
    });
    expect(parseScenario(s).cleanup).toHaveLength(1);
  });
});
