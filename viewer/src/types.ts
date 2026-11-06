import type { Comparison } from '../../src/compare.ts';
import type { ReductionReport } from '../../src/reduce/reduce.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import type { ClockReport, InvalidInfo, RunStatus, Screenshot, TraceEvent, Violation } from '../../src/trace/types.ts';

export const REPORT_SCHEMA = 'trace.report/1';

export interface RunSide {
  label: string;
  status: RunStatus;
  invalid: InvalidInfo | null;
  events: TraceEvent[];
  violations: Violation[];
  clock: ClockReport;
  screenshots: Screenshot[];
}

export interface ReportCase {
  id: 'original' | 'reduced';
  scenario: Scenario;
  comparison: Comparison;
  baseline: RunSide;
  candidate: RunSide;
}

export interface ReportManifest {
  command: string[];
  source: { commit: string | null; dirty: boolean | null };
  environment: {
    os: { platform: string; release: string; arch: string };
    hardware: { cpu: string; cores: number; memoryGb: number };
    power: string | null;
    node: string;
    browser: { name: string; version: string };
  };
  mode: string;
}

export interface ReportData {
  schema: typeof REPORT_SCHEMA;
  manifest: ReportManifest;
  reduction: ReductionReport | null;
  cases: ReportCase[];
}
