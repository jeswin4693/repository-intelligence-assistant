import { CommandSpec } from "./detect";
import { Change, Snapshot } from "./snapshot";

export type Status = "pass" | "fail" | "timeout" | "error";

export interface Diagnostic {
  severity: "error" | "warning";
  /** Position-free text (`src/a.ts: error TS2322: ...`), so an edit that shifts lines does not make old problems look new. */
  text: string;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface CommandResult {
  name: string;
  command: string;
  status: Status;
  exitCode: number | null;
  durationMs: number;
  tests?: TestCounts;
  failedTests: string[];
  diagnostics: Diagnostic[];
  /** True when the output was recognised (counts, failures or diagnostics found). */
  parsed: boolean;
  outputTail: string;
  logFile?: string;
  note?: string;
  /**
   * Set when only part of the command's usual work was done (the tests tied to the changed files, not the whole
   * suite). It is shown wherever the result is, because a pass here says less than a pass of everything.
   */
  partial?: string;
}

export interface CheckRecord {
  at: string;
  changes: Change[];
  results: CommandResult[];
  verdict: string;
}

export interface RunState {
  id: string;
  label: string;
  createdAt: string;
  head: string | null;
  baseline: Snapshot;
  commands: CommandSpec[];
  baselineResults: CommandResult[];
  /** `file|specifier` for every relative import that did not resolve when the run began. */
  baselineUnresolved: string[];
  lastCheck?: CheckRecord;
}
