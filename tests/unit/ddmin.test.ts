import { describe, expect, it } from 'vitest';
import { ddmin, type Outcome } from '../../src/reduce/ddmin.ts';

const all = { maxAttempts: 10_000, maxMs: 60_000 };
const none = new Set<number>();

/** Fails while every index in `culprits` is present. */
const needs = (culprits: number[]) => async (kept: number[]): Promise<Outcome> =>
  culprits.every((c) => kept.includes(c)) ? 'fails' : 'passes';

describe('ddmin', () => {
  it('finds a single culprit', async () => {
    const r = await ddmin({ count: 32, required: none, test: needs([17]), budget: all });
    expect(r.kept).toEqual([17]);
    expect(r.stopped).toBe('minimal');
  });

  it('finds interacting culprits that span chunk boundaries', async () => {
    const r = await ddmin({ count: 40, required: none, test: needs([1, 20, 21, 39]), budget: all });
    expect(r.kept).toEqual([1, 20, 21, 39]);
  });

  it('never tests a sequence without required actions', async () => {
    const seen: number[][] = [];
    const r = await ddmin({
      count: 10,
      required: new Set([0, 1]),
      budget: all,
      test: async (kept) => {
        seen.push(kept);
        return kept.includes(5) ? 'fails' : 'passes';
      },
    });
    expect(r.kept).toEqual([0, 1, 5]);
    expect(seen.every((k) => k.includes(0) && k.includes(1))).toBe(true);
  });

  it('treats invalid, unstable and other failures as not reduced', async () => {
    for (const outcome of ['invalid', 'unstable', 'other-failure'] as const) {
      const r = await ddmin({
        count: 6,
        required: none,
        budget: all,
        test: async (kept) => (kept.length === 6 ? 'fails' : outcome),
      });
      expect(r.kept).toHaveLength(6);
    }
  });

  it('is 1-minimal: removing any kept item loses the failure', async () => {
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 50; round++) {
      const count = 5 + (next() % 40);
      const culprits = [...new Set(Array.from({ length: 1 + (next() % 5) }, () => next() % count))];
      const test = needs(culprits);
      const r = await ddmin({ count, required: none, test, budget: all });
      expect(r.stopped).toBe('minimal');
      for (const drop of r.kept) {
        expect(await test(r.kept.filter((i) => i !== drop))).toBe('passes');
      }
    }
  });

  it('stops at the attempt budget and reports it', async () => {
    const r = await ddmin({ count: 200, required: none, test: async () => 'passes', budget: { maxAttempts: 5, maxMs: 60_000 } });
    expect(r.stopped).toBe('attempts');
    expect(r.attempts).toHaveLength(5);
  });

  it('stops at the time budget', async () => {
    let t = 0;
    const r = await ddmin({
      count: 200,
      required: none,
      clock: () => (t += 10),
      test: async () => 'passes',
      budget: { maxAttempts: 1000, maxMs: 25 },
    });
    expect(r.stopped).toBe('time');
  });

  it('stops when cancelled and keeps what it had', async () => {
    const controller = new AbortController();
    const r = await ddmin({
      count: 16,
      required: none,
      signal: controller.signal,
      budget: all,
      test: async (kept) => {
        controller.abort();
        return kept.includes(3) ? 'fails' : 'passes';
      },
    });
    expect(r.stopped).toBe('cancelled');
    expect(r.kept).toContain(3);
  });

  it('resumes from saved progress with no repeated tests', async () => {
    const controller = new AbortController();
    let saved: Parameters<NonNullable<Parameters<typeof ddmin>[0]['onProgress']>>[0] | null = null;
    let calls = 0;
    const test = async (kept: number[]): Promise<Outcome> => {
      calls += 1;
      if (calls === 3) controller.abort();
      return kept.includes(9) ? 'fails' : 'passes';
    };
    await ddmin({
      count: 32,
      required: none,
      test,
      budget: all,
      signal: controller.signal,
      onProgress: (s) => (saved = JSON.parse(JSON.stringify(s))),
    });
    const tested = new Set((saved!.attempts as { kept: number[] }[]).map((a) => a.kept.join(',')));
    const r = await ddmin({
      count: 32,
      required: none,
      resume: saved!,
      budget: all,
      test: async (kept) => {
        expect(tested.has(kept.join(','))).toBe(false);
        return kept.includes(9) ? 'fails' : 'passes';
      },
    });
    expect(r.kept).toEqual([9]);
  });

  it('never repeats a sequence it already tested', async () => {
    const seen = new Set<string>();
    await ddmin({
      count: 24,
      required: none,
      budget: all,
      test: async (kept) => {
        const key = kept.join(',');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        return kept.includes(4) && kept.includes(19) ? 'fails' : 'passes';
      },
    });
  });
});
