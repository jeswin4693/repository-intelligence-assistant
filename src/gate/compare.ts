import { CommandResult, Diagnostic } from "./types";

export interface CommandDiff {
  name: string;
  command: string;
  before?: CommandResult;
  after: CommandResult;
  outcome: "regressed" | "improved" | "unchanged" | "new";
  notes: string[];
  newFailedTests: string[];
  fixedTests: string[];
  newDiagnostics: Diagnostic[];
  fixedDiagnostics: Diagnostic[];
}

export interface Structural {
  /** `file|specifier` pairs that resolved at the baseline and no longer do. */
  newBrokenImports: string[];
  /** `importers` is unknown for a deleted file, which is no longer in the graph. */
  removedExports: { file: string; symbols: string[]; importers?: number; deleted?: boolean }[];
}

export type Verdict = "regressed" | "mixed" | "improved" | "unchanged" | "unverified";

const failing = (r: CommandResult) => r.status !== "pass";

const describe = (r: CommandResult) =>
  r.status === "pass" ? "passed" : r.status === "timeout" ? "timed out" : r.status === "error" ? "could not run" : "failed";

const minus = (a: string[], b: string[]) => {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
};
const diagKey = (d: Diagnostic) => `${d.severity}|${d.text}`;

export function compareCommand(before: CommandResult | undefined, after: CommandResult): CommandDiff {
  const diff: CommandDiff = {
    name: after.name,
    command: after.command,
    before,
    after,
    outcome: "unchanged",
    notes: [],
    newFailedTests: [],
    fixedTests: [],
    newDiagnostics: [],
    fixedDiagnostics: [],
  };
  if (!before) {
    diff.outcome = "new";
    diff.notes.push("it was not part of the baseline, so there is nothing to compare it with");
    return diff;
  }

  let regressed = false;
  let improved = false;

  if (!failing(before) && failing(after)) {
    regressed = true;
    diff.notes.push(`${after.name} ${describe(before)} before and now ${describe(after)}`);
  } else if (failing(before) && !failing(after)) {
    improved = true;
    diff.notes.push(`${after.name} ${describe(before)} before and now passes`);
  }

  diff.newFailedTests = minus(after.failedTests, before.failedTests);
  diff.fixedTests = minus(before.failedTests, after.failedTests);
  if (diff.newFailedTests.length) regressed = true;
  if (diff.fixedTests.length) improved = true;

  const beforeKeys = before.diagnostics.map(diagKey);
  const afterKeys = after.diagnostics.map(diagKey);
  diff.newDiagnostics = after.diagnostics.filter((d) => !beforeKeys.includes(diagKey(d)));
  diff.fixedDiagnostics = before.diagnostics.filter((d) => !afterKeys.includes(diagKey(d)));
  if (diff.newDiagnostics.some((d) => d.severity === "error")) regressed = true;
  if (diff.fixedDiagnostics.some((d) => d.severity === "error")) improved = true;

  if (before.tests && after.tests) {
    const b = before.tests;
    const a = after.tests;
    if (a.failed > b.failed && diff.newFailedTests.length === 0) {
      regressed = true;
      diff.notes.push(`failing tests went from ${b.failed} to ${a.failed}`);
    }
    if (a.failed < b.failed && diff.fixedTests.length === 0) improved = true;
    // a partial run (only the tied tests) is expected to run fewer, so the totals say nothing
    if (!after.partial) {
      if (a.total < b.total) diff.notes.push(`fewer tests ran (${b.total} -> ${a.total}); check that no tests were deleted or switched off by accident`);
      if (a.total > b.total) diff.notes.push(`${a.total - b.total} more test(s) ran`);
    }
  }

  diff.outcome = regressed ? "regressed" : improved ? "improved" : "unchanged";
  return diff;
}

export function judge(diffs: CommandDiff[], structural: Structural): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const regressed = diffs.filter((d) => d.outcome === "regressed");
  const improved = diffs.filter((d) => d.outcome === "improved");
  for (const d of regressed) reasons.push(`${d.name}: ${summarize(d)}`);
  if (structural.newBrokenImports.length) {
    reasons.push(`${structural.newBrokenImports.length} import(s) no longer resolve to a file`);
  }
  for (const d of improved) reasons.push(`${d.name}: ${summarize(d)}`);

  const regress = regressed.length > 0 || structural.newBrokenImports.length > 0;
  const comparable = diffs.filter((d) => d.before).length;
  let verdict: Verdict;
  if (regress && improved.length) verdict = "mixed";
  else if (regress) verdict = "regressed";
  else if (improved.length) verdict = "improved";
  else if (comparable === 0) verdict = "unverified";
  else verdict = "unchanged";
  return { verdict, reasons };
}

function summarize(d: CommandDiff): string {
  const parts: string[] = [];
  if (d.before && failing(d.before) !== failing(d.after)) parts.push(failing(d.after) ? `now ${describe(d.after)}` : "now passes");
  const errors = d.newDiagnostics.filter((x) => x.severity === "error").length;
  if (errors) parts.push(`${errors} new error(s)`);
  const fixedErrors = d.fixedDiagnostics.filter((x) => x.severity === "error").length;
  if (fixedErrors) parts.push(`${fixedErrors} error(s) fixed`);
  if (d.newFailedTests.length) parts.push(`${d.newFailedTests.length} new failing test(s)`);
  if (d.fixedTests.length) parts.push(`${d.fixedTests.length} test(s) fixed`);
  for (const n of d.notes) if (/^failing tests went/.test(n)) parts.push(n);
  return parts.join(", ") || d.notes[0] || "changed";
}

export function confidenceOf(
  diffs: CommandDiff[],
  testCoverage: "direct" | "transitive" | "none" | undefined,
): { level: "high" | "medium" | "low"; caveats: string[] } {
  const caveats: string[] = [];
  if (diffs.length === 0) caveats.push("no build, typecheck, lint or test command ran; only the import checks apply");
  else if (!diffs.some((d) => d.name === "test")) caveats.push("no test command ran, so behaviour changes are not checked");
  for (const d of diffs) {
    if (d.after.status === "timeout") caveats.push(`${d.name} timed out, so its result says nothing`);
    if (d.after.status === "error") caveats.push(`${d.name} could not run: ${d.after.note ?? "see its log"}`);
    if (failing(d.after) && d.after.status === "fail" && !d.after.parsed) caveats.push(`${d.name}: output format not recognised, only the exit code was compared`);
    if (d.before && failing(d.before)) caveats.push(`${d.name} was already failing before the change, so only new problems count`);
    if (d.after.tests && d.after.tests.total === 0) caveats.push(`${d.name} ran zero tests`);
    if (d.after.partial) caveats.push(`${d.name}: ${d.after.partial}, so the rest of the suite was not checked: finish with a gate_check without a scope before calling the change done`);
  }
  if (testCoverage === "none") caveats.push("none of the changed files has a test tied to it");
  const level = diffs.length === 0 || !diffs.some((d) => d.name === "test") ? "low" : caveats.length ? "medium" : "high";
  return { level, caveats };
}
