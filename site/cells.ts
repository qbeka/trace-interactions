import type { TraceEvent } from '../src/trace/types.ts';
import { lastAt } from '../viewer/src/model.ts';

/** The shapes the page's data block arrives in, and the one list both the stage and the figures read. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Run { frames: { t: number; f: string }[]; events: TraceEvent[] }
export type Phase = 'before' | 'jump' | 'after';
export interface Session {
  id: 'original' | 'reduced';
  count: string;
  kept: number[];
  good: string;
  bad: string;
  verdict: Record<Phase, string>;
}
export interface Data {
  frame: { width: number; height: number; scale: number };
  crop: Rect;
  scanY: number;
  axisEnd: number;
  jump: { t: number; settled: number; px: number; step: number };
  steps: { at: number; label: string }[];
  attempts: { kept: number[]; outcome: string }[];
  targets: { name: string; id: string; label: string }[];
  sessions: Session[];
  runs: Record<string, Run>;
  scenario: string;
}
export interface Cell { t: number; good: string; bad: string; step: number; first: boolean; differs: boolean }

/**
 * One cell wherever the picture changed in either build, and one where each step
 * begins even if it changed nothing. A cell names the frame each build held then.
 */
export function cellsOf(good: Run, bad: Run, steps: { at: number }[], kept: number[]): Cell[] {
  const times = [...new Set([...[...good.frames, ...bad.frames].map((f) => f.t), ...kept.map((i) => steps[i]!.at)])].sort((a, b) => a - b);
  const stepAt = (t: number) => kept.findLast((i) => steps[i]!.at <= t) ?? kept[0]!;
  return times.map((t, i) => {
    const g = good.frames[Math.max(0, lastAt(good.frames, t))]!.f;
    const b = bad.frames[Math.max(0, lastAt(bad.frames, t))]!.f;
    const step = stepAt(t);
    return { t, good: g, bad: b, step, first: i === 0 || stepAt(times[i - 1]!) !== step, differs: g !== b };
  });
}
