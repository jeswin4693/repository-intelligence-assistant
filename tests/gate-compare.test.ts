import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCommand, confidenceOf, judge } from "../src/gate/compare";
import { CommandResult, Diagnostic } from "../src/gate/types";

const result = (over: Partial<CommandResult> & { name: string }): CommandResult => ({
  command: over.name,
  status: "pass",
  exitCode: 0,
  durationMs: 10,
  failedTests: [],
  diagnostics: [],
  parsed: true,
  outputTail: "",
  ...over,
});
const err = (text: string): Diagnostic => ({ severity: "error", text });
const warn = (text: string): Diagnostic => ({ severity: "warning", text });
const none = { newBrokenImports: [], removedExports: [] };

describe("compareCommand", () => {
  it("pass to fail is a regression", () => {
    const d = compareCommand(result({ name: "test" }), result({ name: "test", status: "fail", exitCode: 1 }));
    assert.equal(d.outcome, "regressed");
    assert.match(d.notes[0], /test passed before and now failed/);
  });

  it("fail to pass is an improvement", () => {
    assert.equal(compareCommand(result({ name: "build", status: "fail" }), result({ name: "build" })).outcome, "improved");
  });

  it("only new failing tests count against a command that was already failing", () => {
    const before = result({ name: "test", status: "fail", failedTests: ["a", "b"] });
    const same = compareCommand(before, result({ name: "test", status: "fail", failedTests: ["a", "b"] }));
    assert.equal(same.outcome, "unchanged");
    const worse = compareCommand(before, result({ name: "test", status: "fail", failedTests: ["a", "b", "c"] }));
    assert.equal(worse.outcome, "regressed");
    assert.deepEqual(worse.newFailedTests, ["c"]);
    const better = compareCommand(before, result({ name: "test", status: "fail", failedTests: ["a"] }));
    assert.equal(better.outcome, "improved");
    assert.deepEqual(better.fixedTests, ["b"]);
  });

  it("uses failure counts when test names were not recognised", () => {
    const before = result({ name: "test", status: "fail", tests: { passed: 9, failed: 1, skipped: 0, total: 10 } });
    const after = result({ name: "test", status: "fail", tests: { passed: 7, failed: 3, skipped: 0, total: 10 } });
    const d = compareCommand(before, after);
    assert.equal(d.outcome, "regressed");
    assert.match(d.notes.join(), /failing tests went from 1 to 3/);
  });

  it("new errors regress, new warnings are only reported", () => {
    const before = result({ name: "lint", diagnostics: [err("a: x")] });
    const warnOnly = compareCommand(before, result({ name: "lint", diagnostics: [err("a: x"), warn("b: y")] }));
    assert.equal(warnOnly.outcome, "unchanged");
    assert.equal(warnOnly.newDiagnostics.length, 1);
    const worse = compareCommand(before, result({ name: "lint", diagnostics: [err("a: x"), err("c: z")] }));
    assert.equal(worse.outcome, "regressed");
  });

  it("fixing errors is an improvement", () => {
    const d = compareCommand(result({ name: "typecheck", status: "fail", diagnostics: [err("a: x")] }), result({ name: "typecheck", status: "fail", diagnostics: [] }));
    assert.equal(d.outcome, "improved");
  });

  it("flags a shrinking test count without calling it a regression", () => {
    const d = compareCommand(
      result({ name: "test", tests: { passed: 72, failed: 0, skipped: 0, total: 72 } }),
      result({ name: "test", tests: { passed: 60, failed: 0, skipped: 0, total: 60 } }),
    );
    assert.equal(d.outcome, "unchanged");
    assert.match(d.notes.join(), /fewer tests ran \(72 -> 60\)/);
  });

  it("a timeout where there was a pass is a regression", () => {
    assert.equal(compareCommand(result({ name: "test" }), result({ name: "test", status: "timeout", exitCode: null })).outcome, "regressed");
  });

  it("a command missing from the baseline has nothing to compare with", () => {
    assert.equal(compareCommand(undefined, result({ name: "lint" })).outcome, "new");
  });
});

describe("judge", () => {
  const pass = (name: string) => compareCommand(result({ name }), result({ name }));
  const fail = (name: string) => compareCommand(result({ name }), result({ name, status: "fail" }));
  const fixed = (name: string) => compareCommand(result({ name, status: "fail" }), result({ name }));

  it("covers every verdict", () => {
    assert.equal(judge([pass("test")], none).verdict, "unchanged");
    assert.equal(judge([fail("test")], none).verdict, "regressed");
    assert.equal(judge([fixed("test")], none).verdict, "improved");
    assert.equal(judge([fixed("build"), fail("test")], none).verdict, "mixed");
    assert.equal(judge([], none).verdict, "unverified");
    assert.equal(judge([compareCommand(undefined, result({ name: "x" }))], none).verdict, "unverified");
  });

  it("an import that stopped resolving regresses even when every command passes", () => {
    const j = judge([pass("test")], { newBrokenImports: ["a.ts|./gone"], removedExports: [] });
    assert.equal(j.verdict, "regressed");
    assert.match(j.reasons.join(), /1 import\(s\) no longer resolve/);
  });

  it("broken imports with nothing else to go on are still a regression", () => {
    assert.equal(judge([], { newBrokenImports: ["a.ts|./gone"], removedExports: [] }).verdict, "regressed");
  });
});

describe("confidenceOf", () => {
  const pass = (name: string) => compareCommand(result({ name }), result({ name }));

  it("is low without any command or without a test command", () => {
    assert.equal(confidenceOf([], undefined).level, "low");
    assert.equal(confidenceOf([pass("build")], "direct").level, "low");
  });

  it("is high when tests ran, were understood, and cover the change", () => {
    assert.deepEqual(confidenceOf([pass("build"), pass("test")], "direct"), { level: "high", caveats: [] });
  });

  it("explains each reason for doubt", () => {
    const failing = compareCommand(result({ name: "test", status: "fail" }), result({ name: "test", status: "fail", parsed: false }));
    const c = confidenceOf([failing], "none");
    assert.equal(c.level, "medium");
    const text = c.caveats.join("\n");
    assert.match(text, /already failing/);
    assert.match(text, /output format not recognised/);
    assert.match(text, /none of the changed files has a test/);
  });
});
