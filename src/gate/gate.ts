import * as fs from "node:fs";
import * as path from "node:path";
import { analyze } from "../repo/extract";
import { RepoGraph } from "../repo/graph";
import { languageOf } from "../repo/languages";
import { RepoIndex } from "../repo/repo-index";
import { ensureRiaDir } from "../repo/ria-dir";
import { ImpactResult, impact } from "../tools/impact";
import { pct, plural, testsFor } from "../tools/shared";
import { CommandDiff, Structural, Verdict, compareCommand, confidenceOf, judge } from "./compare";
import { CommandSpec, DEFAULT_TIMEOUT_SECONDS, detectCommands, loadGateConfig } from "./detect";
import { parseOutput } from "./parse";
import { runCommand } from "./runner";
import { Change, GateError, diffSnapshots, readAt, requireGit, restoreChanges, snapshotExists, takeSnapshot } from "./snapshot";
import { KEEP_RUNS, loadRun, newId, pruneRuns, refFor, runDir, saveRun } from "./store";
import { CommandResult, RunState, Status } from "./types";

export { GateError } from "./snapshot";

export interface GateEnv {
  index: RepoIndex;
  /** Progress messages while commands run; the MCP server turns them into progress notifications. */
  progress?: (message: string) => void;
}

const LIST = 8;
const TAIL_LINES = 15;

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const list = (items: string[], n = LIST) => (items.length > n ? `${items.slice(0, n).join(", ")} and ${items.length - n} more` : items.join(", "));
const word = (r: CommandResult) =>
  r.status === "pass" ? "passed" : r.status === "fail" ? "FAILED" : r.status === "timeout" ? "TIMED OUT" : "COULD NOT RUN";

function assertGate(index: RepoIndex): void {
  if (!index.persists) {
    throw new GateError("The change gate stores its snapshots under .ria/ and in git, so it cannot run with --no-cache or RIA_NO_CACHE.");
  }
  requireGit(index.root);
  // before any snapshot, so RIA's own logs and scratch files are never part of one
  ensureRiaDir(index.root);
}

function selectCommands(specs: CommandSpec[], names: string[] | undefined): CommandSpec[] {
  if (!names?.length) return specs;
  const unknown = names.filter((n) => !specs.some((s) => s.name === n));
  if (unknown.length) {
    const available = specs.map((s) => s.name).join(", ") || "none found";
    throw new GateError(`Unknown command name(s): ${unknown.join(", ")}. Available: ${available}. Commands come from the project's own files or ria.config.json.`);
  }
  return specs.filter((s) => names.includes(s.name));
}

async function runSpecs(env: GateEnv, specs: CommandSpec[], dir: string, prefix: string, timeoutSeconds: number): Promise<CommandResult[]> {
  const root = env.index.root;
  const results: CommandResult[] = [];
  for (const spec of specs) {
    env.progress?.(`running ${spec.name}: ${spec.command}`);
    const started = Date.now();
    const raw = await runCommand(spec.command, {
      cwd: root,
      timeoutMs: timeoutSeconds * 1000,
      onHeartbeat: () => env.progress?.(`${spec.name} is still running (${Math.round((Date.now() - started) / 1000)}s)`),
    });
    const parsed = parseOutput(raw.output, root);
    const notInstalled =
      raw.exitCode !== 0 && !parsed.parsed && /is not recognized as an internal or external command|: command not found|: not found\b|ENOENT/i.test(raw.output);
    const status: Status = raw.error || notInstalled ? "error" : raw.timedOut ? "timeout" : raw.exitCode === 0 ? "pass" : "fail";
    const note = raw.error
      ? raw.error
      : notInstalled
        ? "the command is not installed or not on PATH"
        : raw.timedOut
          ? `stopped after ${timeoutSeconds}s`
          : raw.truncated
            ? "output was longer than the limit, only the end was kept"
            : undefined;
    const logFile = path.join(dir, `${prefix}-${spec.name}.log`);
    try {
      fs.writeFileSync(logFile, `$ ${spec.command}\nexit code: ${raw.exitCode}\n\n${raw.output}`);
    } catch {
      // the report still has the tail
    }
    results.push({
      name: spec.name,
      command: spec.command,
      status,
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      tests: parsed.tests,
      failedTests: parsed.failedTests,
      diagnostics: parsed.diagnostics,
      parsed: parsed.parsed,
      outputTail: raw.output.split(/\r?\n/).slice(-TAIL_LINES * 3).join("\n").slice(-4000),
      logFile,
      note,
    });
  }
  return results;
}

const testsText = (r: CommandResult) => {
  const t = r.tests;
  if (!t) return "";
  return ` (${t.passed} passed, ${t.failed} failed${t.skipped ? `, ${t.skipped} skipped` : ""})`;
};

const unresolvedKeys = (graph: RepoGraph): string[] => [...new Set([...graph.unresolved].flatMap(([file, specs]) => specs.map((s) => `${file}|${s}`)))];

// ---------------------------------------------------------------- begin

export async function gateBegin(env: GateEnv, opts: { label?: string; commands?: string[] } = {}): Promise<{ id: string; text: string }> {
  const { index } = env;
  const root = index.root;
  assertGate(index);

  const config = loadGateConfig(root);
  const detected = detectCommands(root, config);
  const specs = selectCommands(detected, opts.commands);
  const timeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  pruneRuns(root, KEEP_RUNS - 1);
  const id = newId();
  const dir = runDir(root, id);
  fs.mkdirSync(dir, { recursive: true });

  const results = await runSpecs(env, specs, dir, "baseline", timeout);

  // Snapshot after the checks: whatever they touched is the state edits start from,
  // so it is never mistaken for the editor's work.
  const baseline = takeSnapshot(root, dir, `RIA gate baseline ${id}`, refFor(id));
  index.refresh();
  const run: RunState = {
    id,
    label: opts.label ?? "",
    createdAt: new Date().toISOString(),
    head: null,
    baseline,
    commands: specs,
    baselineResults: results,
    baselineUnresolved: unresolvedKeys(index.graph()),
  };
  saveRun(root, run);
  return { id, text: formatBegin(run, detected.length === 0) };
}

function formatBegin(run: RunState, noneDetected: boolean): string {
  const out = [`Gate started: run ${run.id}${run.label ? ` (${run.label})` : ""}`, "The working tree is recorded. Make your changes now, then call gate_check."];
  if (run.baselineResults.length === 0) {
    out.push(
      "",
      noneDetected
        ? "No build, typecheck, lint or test command was found, so the later check can only look at imports and exports."
        : "No commands were selected, so the later check can only look at imports and exports.",
      'To add commands, create ria.config.json: { "gate": { "commands": { "test": "your test command" } } }',
    );
  } else {
    out.push("", "Baseline (before your change):");
    for (const r of run.baselineResults) {
      out.push(`  ${r.name.padEnd(10)} ${word(r)}${testsText(r)}  ${fmtMs(r.durationMs)}  [${r.command}]`);
      if (r.status !== "pass") {
        const errors = r.diagnostics.filter((d) => d.severity === "error").length;
        out.push(`             already ${r.status === "fail" ? "failing" : "not working"}${errors ? ` with ${plural(errors, "error")}` : ""}${r.note ? `; ${r.note}` : ""}. Only new problems will count against your change.`);
      }
    }
  }
  const unresolved = run.baselineUnresolved.length;
  if (unresolved) out.push("", `Note: ${plural(unresolved, "relative import")} already did not resolve before your change; those are not held against it.`);
  return out.join("\n");
}

// ---------------------------------------------------------------- check

export async function gateCheck(
  env: GateEnv,
  opts: { id?: string; commands?: string[] } = {},
): Promise<{ text: string; verdict: Verdict }> {
  const { index } = env;
  const root = index.root;
  assertGate(index);

  const run = loadRun(root, opts.id);
  if (!run) throw new GateError(opts.id ? `No gate run "${opts.id}" found.` : "No gate run found. Call gate_begin before making changes.");
  if (!snapshotExists(root, run.baseline)) throw new GateError("The baseline snapshot no longer exists (it was pruned or garbage collected). Start a new run with gate_begin.");
  const dir = runDir(root, run.id);

  const edited = takeSnapshot(root, dir, `RIA gate edit ${run.id}`);
  const changes = diffSnapshots(root, run.baseline, edited);
  if (changes.length === 0) {
    return { verdict: "unchanged", text: `Gate check for run ${run.id}: no files differ from the baseline, so there is nothing to check.` };
  }

  index.refresh();
  const graph = index.graph();
  const specs = selectCommands(run.commands, opts.commands);
  const timeout = loadGateConfig(root).timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const results = await runSpecs(env, specs, dir, `check-${Date.now()}`, timeout);

  const after = takeSnapshot(root, dir, `RIA gate after-checks ${run.id}`);
  const sideEffects = diffSnapshots(root, edited, after);

  const structural = analyseStructure(index, run, changes);
  const diffs = results.map((r) => compareCommand(run.baselineResults.find((b) => b.name === r.name), r));
  const { verdict, reasons } = judge(diffs, structural);

  const changedPaths = new Set(changes.map((c) => c.path));
  const indexed = changes.filter((c) => c.status !== "D" && index.files.has(c.path)).map((c) => c.path).slice(0, 50);
  const imp = indexed.length ? impact(index, { files: indexed }) : undefined;
  const blast = imp && !("error" in imp) ? imp : undefined;
  const conf = confidenceOf(diffs, blast?.testCoverage);

  run.lastCheck = { at: new Date().toISOString(), changes, results, verdict };
  saveRun(root, run);

  return { verdict, text: formatCheck({ root, run, changes, diffs, structural, verdict, reasons, blast, graph, changedPaths, sideEffects, conf }) };
}

function analyseStructure(index: RepoIndex, run: RunState, changes: Change[]): Structural {
  const graph = index.graph();
  const base = new Set(run.baselineUnresolved);
  const newBrokenImports = unresolvedKeys(graph).filter((k) => !base.has(k));

  const removedExports: Structural["removedExports"] = [];
  for (const c of changes) {
    if (c.status === "A") continue;
    const rec = graph.files.get(c.path);
    if ((rec?.language ?? languageOf(c.path)) === "other") continue;
    const text = readAt(index.root, run.baseline, c.path);
    if (text === null) continue;
    const before = analyze(c.path, text).symbols.filter((s) => s.exported).map((s) => s.name);
    const now = new Set((rec?.symbols ?? []).filter((s) => s.exported).map((s) => s.name));
    const removed = c.status === "D" ? before : before.filter((n) => !now.has(n));
    if (removed.length === 0) continue;
    removedExports.push(
      c.status === "D"
        ? { file: c.path, symbols: removed.slice(0, 15), deleted: true }
        : { file: c.path, symbols: removed.slice(0, 15), importers: graph.inn.get(c.path)?.size ?? 0 },
    );
  }
  return { newBrokenImports, removedExports };
}

const EXPLAIN: Record<Verdict, string> = {
  regressed: "Something that worked before is broken now.",
  mixed: "Some things got better and some got worse.",
  improved: "Things got better and nothing got worse.",
  unchanged: "The checks give the same results as before.",
  unverified: "Nothing could be compared with the baseline, so this change is not verified.",
};

const NEXT: Record<Verdict, string> = {
  regressed: "Fix the problems above and call gate_check again, or call gate_rollback to undo everything since the baseline.",
  mixed: "Fix what got worse and call gate_check again, or call gate_rollback to undo everything since the baseline.",
  improved: "Look through the 'may be affected' list, then you can stop.",
  unchanged: "Look through the 'may be affected' list, then you can stop.",
  unverified: "Review the change by hand, or add commands in ria.config.json so the next check can verify it.",
};

interface CheckView {
  root: string;
  run: RunState;
  changes: Change[];
  diffs: CommandDiff[];
  structural: Structural;
  verdict: Verdict;
  reasons: string[];
  blast?: ImpactResult;
  graph: RepoGraph;
  changedPaths: Set<string>;
  sideEffects: Change[];
  conf: { level: string; caveats: string[] };
}

function formatCheck(v: CheckView): string {
  const out: string[] = [];
  out.push(`Gate check for run ${v.run.id}: ${v.verdict.toUpperCase()}`, EXPLAIN[v.verdict]);
  for (const r of v.reasons) out.push(`  - ${r}`);

  const by = (s: Change["status"]) => v.changes.filter((c) => c.status === s).map((c) => c.path);
  const parts = [
    ["modified", by("M")],
    ["added", by("A")],
    ["deleted", by("D")],
  ].filter(([, paths]) => paths.length > 0).map(([label, paths]) => `${label} ${list(paths as string[])}`);
  out.push("", `Changed since the baseline (${plural(v.changes.length, "file")}): ${parts.join("; ")}`);

  if (v.diffs.length) {
    out.push("", "Checks, compared with the baseline:");
    for (const d of v.diffs) {
      const before = d.before ? word(d.before) : "(new)";
      out.push(`  ${d.name.padEnd(10)} ${before} -> ${word(d.after)}${testsText(d.after)}  ${fmtMs(d.after.durationMs)}  [${d.command}]`);
      const errors = d.newDiagnostics.filter((x) => x.severity === "error");
      const warnings = d.newDiagnostics.filter((x) => x.severity === "warning");
      if (d.newFailedTests.length) out.push(`             new failing tests: ${list(d.newFailedTests)}`);
      if (d.fixedTests.length) out.push(`             fixed tests: ${list(d.fixedTests)}`);
      for (const e of errors.slice(0, LIST)) out.push(`             new error: ${e.text}`);
      if (errors.length > LIST) out.push(`             ... and ${errors.length - LIST} more new errors`);
      if (warnings.length) out.push(`             ${plural(warnings.length, "new warning")}${warnings.length <= 3 ? `: ${warnings.map((w) => w.text).join("; ")}` : ""}`);
      const fixed = d.fixedDiagnostics.filter((x) => x.severity === "error").length;
      if (fixed) out.push(`             ${plural(fixed, "error")} fixed`);
      for (const n of d.notes) if (!/^(\S+) (passed|failed|timed out|could not run) before/.test(n)) out.push(`             ${n}`);
      if (d.after.note) out.push(`             ${d.after.note}`);
      const showTail = d.after.status !== "pass" && d.outcome !== "improved" && d.newFailedTests.length === 0 && d.newDiagnostics.length === 0;
      if (showTail) {
        out.push("             last output:");
        for (const line of d.after.outputTail.split("\n").slice(-TAIL_LINES)) out.push(`               ${line}`);
      }
      if (d.after.logFile) out.push(`             full log: ${path.relative(v.root, d.after.logFile).replace(/\\/g, "/")}`);
    }
  }

  const s = v.structural;
  if (s.newBrokenImports.length || s.removedExports.length) {
    out.push("", "Structure:");
    if (s.newBrokenImports.length) {
      out.push(`  Imports that no longer resolve (${s.newBrokenImports.length}): ${list(s.newBrokenImports.map((k) => k.replace("|", " -> ")))}`);
    }
    for (const e of s.removedExports.slice(0, LIST)) {
      const who = e.deleted ? "file deleted" : e.importers ? `imported by ${plural(e.importers, "file")}` : "no importers";
      out.push(`  Exports gone from ${e.file}: ${list(e.symbols)} (${who})`);
    }
  }

  const more = mayBeAffected(v);
  if (more.length) out.push("", "May be affected:", ...more.map((l) => `  ${l}`));

  if (v.sideEffects.length) {
    out.push("", `Note: running the checks itself changed ${plural(v.sideEffects.length, "file")} (${list(v.sideEffects.map((c) => c.path), 5)}).`);
  }

  out.push("", `Confidence: ${v.conf.level}`);
  for (const c of v.conf.caveats) out.push(`  - ${c}`);
  out.push("", `Next: ${NEXT[v.verdict]}`);
  return out.join("\n");
}

function mayBeAffected(v: CheckView): string[] {
  const lines: string[] = [];
  const b = v.blast;
  if (b) {
    const deps = b.dependents.filter((d) => !d.isTest && !v.changedPaths.has(d.path));
    if (deps.length) lines.push(`Not changed, but depend on the changed code (${deps.length}): ${list(deps.map((d) => d.path))}`);
    const tests = b.tests.filter((t) => !v.changedPaths.has(t.path));
    if (tests.length) lines.push(`Tests tied to the changed code (${tests.length}): ${list(tests.map((t) => t.path))}`);
    const hidden = b.hiddenCoupling.filter((h) => !v.changedPaths.has(h.path));
    if (hidden.length) lines.push(`Usually change together with these but were not touched: ${list(hidden.map((h) => `${h.path} (${pct(h.confidence)})`))}`);
  }
  const untested = v.changes
    .filter((c) => c.status !== "D")
    .filter((c) => {
      const rec = v.graph.files.get(c.path);
      return rec && !rec.isTest && rec.language !== "other" && testsFor(v.graph, c.path).length === 0;
    })
    .map((c) => c.path);
  if (untested.length) lines.push(`No test is tied (by name or import) to: ${list(untested)}`);
  return lines;
}

// ---------------------------------------------------------------- rollback

export async function gateRollback(env: GateEnv, opts: { id?: string; apply?: boolean } = {}): Promise<string> {
  const { index } = env;
  const root = index.root;
  assertGate(index);

  const run = loadRun(root, opts.id);
  if (!run) throw new GateError(opts.id ? `No gate run "${opts.id}" found.` : "No gate run found, so there is nothing to roll back to.");
  if (!snapshotExists(root, run.baseline)) throw new GateError("The baseline snapshot no longer exists, so a rollback is not possible.");
  const dir = runDir(root, run.id);

  const now = takeSnapshot(root, dir, `RIA gate rollback ${run.id}`);
  const changes = diffSnapshots(root, run.baseline, now);
  if (changes.length === 0) return `Run ${run.id}: the working tree already matches the baseline, nothing to roll back.`;

  const restore = changes.filter((c) => c.status !== "A").map((c) => `${c.status === "D" ? "bring back" : "restore"} ${c.path}`);
  const remove = changes.filter((c) => c.status === "A").map((c) => `delete ${c.path}`);
  const plan = [...restore, ...remove];

  if (!opts.apply) {
    return [
      `Rollback preview for run ${run.id}: ${plural(changes.length, "file")} would change.`,
      ...plan.slice(0, 40).map((l) => `  ${l}`),
      ...(plan.length > 40 ? [`  ... and ${plan.length - 40} more`] : []),
      "",
      "Nothing was changed. Call gate_rollback again with apply set to true to do this.",
      "Work that was already uncommitted when gate_begin ran is kept as it was; only changes made since then are undone.",
    ].join("\n");
  }

  restoreChanges(root, run.baseline, changes);
  const check = takeSnapshot(root, dir, `RIA gate rollback verify ${run.id}`);
  const left = diffSnapshots(root, run.baseline, check);
  index.refresh();
  const out = [`Rolled back run ${run.id}: ${plural(changes.length, "file")} put back as they were at gate_begin.`];
  if (left.length) out.push(`Warning: ${plural(left.length, "file")} still differ from the baseline: ${list(left.map((c) => c.path))}`);
  else out.push("Verified: the working tree matches the baseline again.");
  return out.join("\n");
}
