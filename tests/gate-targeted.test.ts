import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { compareCommand, confidenceOf } from "../src/gate/compare";
import { gateBegin, gateCheck } from "../src/gate/gate";
import { planTargeted } from "../src/gate/targeted";
import { CommandResult } from "../src/gate/types";
import { RepoIndex } from "../src/repo/repo-index";
import { createServer } from "../src/server";
import { ImpactResult } from "../src/tools/impact";
import { cleanup, commit, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

// the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
const requireModule = (spec: string) => `require("${spec}")`;
const nodeTest = `const test = require("node:test");\nconst assert = require("node:assert/strict");\n`;
const MATH = `exports.add = (a, b) => a + b;\n`;
const MATH_BAD = `exports.add = (a, b) => a - b;\n`;
const MATH_TEST = `${nodeTest}const { add } = ${requireModule("../src/math")};\ntest("adds", () => assert.equal(add(1, 2), 3));\ntest("adds again", () => assert.equal(add(2, 2), 4));\n`;
const OTHER_TEST = `${nodeTest}const { mul } = ${requireModule("../src/other")};\ntest("multiplies", () => assert.equal(mul(2, 3), 6));\n`;
const CONFIG = JSON.stringify({ gate: { commands: { test: "node --test" }, targeted: { test: "node --test {files}" } } });

function project(extra: Record<string, string> = {}, config = CONFIG) {
  const dir = makeRepo({
    "src/math.js": MATH,
    "src/other.js": `exports.mul = (a, b) => a * b;\n`,
    "src/lonely.js": `exports.x = 1;\n`,
    "test/math.test.js": MATH_TEST,
    "test/other.test.js": OTHER_TEST,
    "ria.config.json": config,
    ...extra,
  });
  dirs.push(dir);
  gitInit(dir);
  commit(dir, "initial");
  return { dir, env: { index: new RepoIndex(dir) } };
}

describe("gate_check with scope tied", () => {
  it("says at the start that faster checks are available, only when the project defined them", async () => {
    const withIt = await gateBegin(project().env);
    assert.match(withIt.text, /Faster checks while you iterate: gate_check with scope "tied"/);
    const without = await gateBegin(project({}, JSON.stringify({ gate: { commands: { test: "node --test" } } })).env);
    assert.doesNotMatch(without.text, /Faster checks/);
  });

  it("runs only the tests tied to the changed files, says so, and keeps the verdict honest about it", async () => {
    const { dir, env } = project();
    const begin = await gateBegin(env);
    assert.match(begin.text, /test\s+passed \(3 passed, 0 failed\)/, "the baseline ran everything");
    writeFiles(dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });

    const r = await gateCheck(env, { scope: "tied" });
    assert.equal(r.verdict, "unchanged");
    assert.match(r.text, /\[node --test test\/math\.test\.js\]/, "only the tied file was run");
    assert.match(r.text, /test\s+passed -> passed \(2 passed, 0 failed\)/);
    assert.match(r.text, /PARTIAL: only the 1 test file \(of 2\) tied to the changed files ran\. The rest of the suite was not run\./);
    assert.doesNotMatch(r.text, /fewer tests ran/, "fewer tests is expected, not suspicious");
    assert.match(r.text, /Confidence: medium/);
    assert.match(r.text, /finish with a gate_check without a scope before calling the change done/);
  });

  it("still catches a regression in a tied test", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": MATH_BAD });
    const r = await gateCheck(env, { scope: "tied" });
    assert.equal(r.verdict, "regressed");
    assert.match(r.text, /new failing tests: adds, adds again/);
    assert.match(r.text, /PARTIAL/);
  });

  it("runs everything when no scope is given, as before", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    for (const scope of [undefined, "full" as const]) {
      const r = await gateCheck(env, { scope });
      assert.match(r.text, /test\s+passed -> passed \(3 passed, 0 failed\).*\[node --test\]/);
      assert.doesNotMatch(r.text, /PARTIAL|Scope "tied"/);
      assert.match(r.text, /Confidence: high/);
    }
  });

  it("falls back to the whole command, and says why, whenever narrowing would not be sound", async () => {
    const note = (text: string) => /Note: Scope "tied" ran the whole test command: (.*)\./.exec(text)?.[1];

    // the tests were already failing: only a full run tells a new failure from an old one
    const red = project({ "src/math.js": MATH_BAD });
    await gateBegin(red.env);
    writeFiles(red.dir, { "src/math.js": `exports.add = (a, b) => a - b - 0;\n` });
    const redCheck = await gateCheck(red.env, { scope: "tied" });
    assert.match(note(redCheck.text)!, /already failing at the baseline/);
    assert.match(redCheck.text, /\[node --test\]/);
    assert.doesNotMatch(redCheck.text, /PARTIAL/);

    // no targeted command defined
    const bare = project({}, JSON.stringify({ gate: { commands: { test: "node --test" } } }));
    await gateBegin(bare.env);
    writeFiles(bare.dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    assert.match(note((await gateCheck(bare.env, { scope: "tied" })).text)!, /no targeted test command is configured/);

    // a placeholder is missing
    const noSlot = project({}, JSON.stringify({ gate: { commands: { test: "node --test" }, targeted: { test: "node --test" } } }));
    await gateBegin(noSlot.env);
    writeFiles(noSlot.dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    assert.match(note((await gateCheck(noSlot.env, { scope: "tied" })).text)!, /has no \{files\} placeholder/);

    // nothing is tied to the changed file
    const lone = project();
    await gateBegin(lone.env);
    writeFiles(lone.dir, { "src/lonely.js": `exports.x = 2;\n` });
    assert.match(note((await gateCheck(lone.env, { scope: "tied" })).text)!, /no test is tied to the changed files/);

    // the tied tests are most of the suite: nothing to save
    const wide = project();
    await gateBegin(wide.env);
    writeFiles(wide.dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n`, "src/other.js": `exports.mul = (a, b) => a * b * 1;\n` });
    const wideCheck = await gateCheck(wide.env, { scope: "tied" });
    assert.match(note(wideCheck.text)!, /the tied tests are 2 of 2 test files, so a full run costs about the same/);
    assert.match(wideCheck.text, /\[node --test\]/);
  });

  it("never puts a file name it cannot trust into a command", async () => {
    const { dir, env } = project({ "test/we ird.test.js": MATH_TEST, "test/third.test.js": OTHER_TEST, "test/fourth.test.js": OTHER_TEST });
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    const r = await gateCheck(env, { scope: "tied" });
    assert.match(r.text, /Scope "tied" ran the whole test command: a tied test has a path with characters that are not safe to put in a command/);
    assert.match(r.text, /\[node --test\]/, "the project's own full command ran, with no file name in it");
    assert.doesNotMatch(r.text, /PARTIAL/);
  });

  it("only appears on a check that runs a test command", async () => {
    const { dir, env } = project({}, JSON.stringify({ gate: { commands: { test: null }, targeted: { test: "node --test {files}" } } }));
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    const r = await gateCheck(env, { scope: "tied" });
    assert.match(r.text, /Scope "tied" had no effect: this check does not run a test command/);
  });
});

describe("what a partial result means", () => {
  const result = (over: Partial<CommandResult> = {}): CommandResult => ({
    name: "test", command: "node --test", status: "pass", exitCode: 0, durationMs: 1, failedTests: [], diagnostics: [], parsed: true, outputTail: "",
    tests: { passed: 10, failed: 0, skipped: 0, total: 10 }, ...over,
  });

  it("does not read fewer tests as tests that were deleted, but still reads new failures as regressions", () => {
    const before = result();
    const partial = result({ partial: "only the 1 test file (of 4) tied to the changed files ran", tests: { passed: 3, failed: 0, skipped: 0, total: 3 } });
    assert.deepEqual(compareCommand(before, partial).notes, []);
    assert.equal(compareCommand(before, partial).outcome, "unchanged");
    const full = result({ tests: { passed: 3, failed: 0, skipped: 0, total: 3 } });
    assert.match(compareCommand(before, full).notes.join(" "), /fewer tests ran \(10 -> 3\)/, "a full run with fewer tests is still suspicious");

    const broke = result({ partial: "x", status: "fail", exitCode: 1, failedTests: ["adds"], tests: { passed: 2, failed: 1, skipped: 0, total: 3 } });
    assert.equal(compareCommand(before, broke).outcome, "regressed");
  });

  it("lowers the confidence and says what to do", () => {
    const diff = compareCommand(result(), result({ partial: "only the 1 test file (of 4) tied to the changed files ran" }));
    const conf = confidenceOf([diff], "direct");
    assert.equal(conf.level, "medium");
    assert.match(conf.caveats.join(" "), /finish with a gate_check without a scope/);
    assert.equal(confidenceOf([compareCommand(result(), result())], "direct").level, "high");
  });
});

describe("planTargeted", () => {
  it("builds the command from the project's template and only the tied tests, sorted, counting a changed test too", () => {
    const index = new RepoIndex(project({ "test/third.test.js": OTHER_TEST, "test/fourth.test.js": OTHER_TEST }).dir, { cache: false });
    index.refresh();
    const blast = { tests: [{ path: "test/other.test.js", why: "imports it" }, { path: "src/math.js", why: "not a test: ignored" }] } as unknown as ImpactResult;
    const plan = planTargeted({
      template: "runner --quiet {files} --reporter dot",
      index,
      changes: [{ path: "test/math.test.js", status: "M" }, { path: "test/gone.test.js", status: "D" }],
      blast,
      baseline: { name: "test", status: "pass" } as CommandResult,
    });
    assert.ok(!("reason" in plan), "reason" in plan ? plan.reason : "");
    assert.deepEqual(plan.files, ["test/math.test.js", "test/other.test.js"]);
    assert.equal(plan.of, 4);
    assert.equal(plan.command, "runner --quiet test/math.test.js test/other.test.js --reporter dot");
  });

  it("explains each refusal in words", () => {
    const index = new RepoIndex(project().dir, { cache: false });
    index.refresh();
    const base = { index, changes: [], blast: undefined };
    const pass = { name: "test", status: "pass" } as CommandResult;
    const reason = (p: ReturnType<typeof planTargeted>) => ("reason" in p ? p.reason : "(a plan)");
    assert.match(reason(planTargeted({ ...base, template: undefined, baseline: pass })), /no targeted test command is configured/);
    assert.match(reason(planTargeted({ ...base, template: "x", baseline: pass })), /no \{files\} placeholder/);
    assert.match(reason(planTargeted({ ...base, template: "x {files}", baseline: undefined })), /no test command was run at the baseline/);
    assert.match(reason(planTargeted({ ...base, template: "x {files}", baseline: { name: "test", status: "fail" } as CommandResult })), /already failing at the baseline/);
    assert.match(reason(planTargeted({ ...base, template: "x {files}", baseline: pass })), /no test is tied to the changed files/);
  });
});

describe("who chooses the scope", () => {
  it("is a choice between two words in the tool, never a command", async () => {
    const server = createServer(new RepoIndex(project().dir, { cache: false }));
    const client = new Client({ name: "scope-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "gate_check")!;
      const scope = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).scope;
      assert.deepEqual(scope.enum, ["full", "tied"]);

      let refused = false;
      try {
        const r = await client.callTool({ name: "gate_check", arguments: { scope: "node --test; rm -rf /" } });
        refused = r.isError === true;
      } catch {
        refused = true;
      }
      assert.ok(refused, "a scope that is not full or tied is refused");
    } finally {
      await client.close();
    }
  });

  it("is checked on the command line too", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    dirs.push(dir);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const cli = path.join(path.resolve(__dirname, ".."), "src", "index.ts");
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "gate", "check", "--scope", "everything", "--root", dir], { env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--scope must be full or tied/);
  });
});
