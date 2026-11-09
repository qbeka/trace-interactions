import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioToCopy } from '../../scripts/build-page.ts';
import { aliveAfter, attemptNote, diedAt, type Attempt } from '../../site/reduction.ts';
import { parseScenario } from '../../src/scenario/validate.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const attempts: Attempt[] = read('demo/reduction.attempts.json').state.attempts;
const reduction = read('demo/regression/report.json').reduction;

describe('the reduction as the page replays it', () => {
  it('ends on the steps the reducer kept', () => {
    expect(aliveAfter(attempts, 14, attempts.length)).toEqual(reduction.keptIndices);
    expect(aliveAfter(attempts, 14, 0)).toHaveLength(14);
  });

  it('only shrinks the list on an attempt that kept the failure', () => {
    let size = 14;
    attempts.forEach((attempt, i) => {
      const next = aliveAfter(attempts, 14, i + 1).length;
      if (attempt.outcome === 'fails') expect(next).toBeLessThan(size);
      else expect(next).toBe(size);
      size = next;
    });
  });

  it('ends a step on the attempt that dropped it, and never ends a kept step', () => {
    for (const step of reduction.keptIndices) expect(diedAt(attempts, step)).toBeNull();
    for (let step = 0; step < 14; step++) {
      const at = diedAt(attempts, step);
      if (at === null) continue;
      expect(aliveAfter(attempts, 14, at)).toContain(step);
      expect(aliveAfter(attempts, 14, at + 1)).not.toContain(step);
    }
  });

  it('describes every attempt with its own count and outcome', () => {
    expect(attemptNote(attempts, 14, 0)).toContain('All 14 steps');
    expect(attemptNote(attempts, 14, 1)).toBe('Attempt 1 could not run with these 7 steps, so it says nothing either way.');
    expect(attemptNote(attempts, 14, 4)).toBe('Attempt 4 ran 10 steps and the panel still jumped, so the 4 steps it left out are gone for good.');
    expect(attemptNote(attempts, 14, 12)).toContain('the one step it left out is gone for good');
    expect(attemptNote(attempts, 14, 18)).toContain('but not as this bug');
    expect(attemptNote(attempts, 14, 26)).toBe('26 attempts left 4 steps, and taking any one of them away loses the jump.');
  });

  it('claims a minimal result only when single removals were all tried', () => {
    const cut = attempts.slice(0, -1);
    expect(attemptNote(cut, 14, cut.length)).toBe('25 attempts left 4 steps.');
    const unstable: Attempt[] = [{ kept: [0, 1], outcome: 'unstable' }, { kept: [0], outcome: 'passes' }];
    expect(attemptNote(unstable, 3, 1)).toContain('failed only some of the time');
  });
});

describe('the scenario a visitor copies', () => {
  const saved = read('demo/reduced.scenario.json');
  const copied = JSON.parse(scenarioToCopy(saved));

  it('is a valid scenario with the same four actions', () => {
    expect(() => parseScenario(copied)).not.toThrow();
    const bare = (s: typeof saved) => s.actions.map(({ note: _note, ...rest }: { note?: string }) => rest);
    expect(bare(copied)).toEqual(bare(saved));
    expect({ ...copied, actions: [] }).toEqual({ ...saved, actions: [] });
  });

  it('names the width on a resize, since the saved label describes another session', () => {
    expect(saved.actions[2].note).toBe('widen');
    expect(copied.actions.map((a: { note: string }) => a.note)).toEqual(['open', 'close with Escape', 'resize to 920 px', 'reopen']);
  });
});
