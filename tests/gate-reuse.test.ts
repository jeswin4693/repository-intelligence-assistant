import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { gateBegin, gateCheck, gateRollback } from "../src/gate/gate";
import { MAX_REUSE_MINUTES, findReusable, reuseWindowMs } from "../src/gate/reuse";
import { newId, saveRun } from "../src/gate/store";
import { CommandResult, RunState } from "../src/gate/types";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, commit, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ria-reuse-"));
const counter = path.join(scratch, "count.txt");

before(() => {
  process.env.RIA_COUNT_FILE = counter;
});
after(() => {
  delete process.env.RIA_COUNT_FILE;
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const d of dirs) cleanup(d);
});

// Each command appends its name to a file outside the repository, so the tests can tell a run from a reuse
// without the counting itself changing the files the gate compares.
const COUNT = `const fs = require("node:fs");
fs.appendFileSync(process.env.RIA_COUNT_FILE, process.argv[2] + "\\n");
process.exit(Number(process.argv[3] || 0));
`;
// a check that passes or fails by what src/math.js says, so a test can break it without a test framework
const VERIFY = `const fs = require("node:fs");
process.exit(fs.readFileSync("src/math.js", "utf8").includes("a - b") ? 1 : 0);
`;
const MATH_OK = `exports.add = (a, b) => a + b;\n`;
const MATH_BAD = `exports.add = (a, b) => a - b;\n`;

const runs = (name: string): number => {
  try {
    return fs.readFileSync(counter, "utf8").split("\n").filter((l) => l === name).length;
  } catch {
    return 0;
  }
};

function project(gate: Record<string, unknown> = {}, commands: Record<string, string> = { test: "node count.js test", lint: "node count.js lint" }) {
  fs.rmSync(counter, { force: true });
  const dir = makeRepo({
    "src/math.js": MATH_OK,
    "verify.js": VERIFY,
    "count.js": COUNT,
    "ria.config.json": JSON.stringify({ gate: { commands, ...gate } }),
  });
  dirs.push(dir);
  gitInit(dir);
  commit(dir, "initial");
  return { dir, env: { index: new RepoIndex(dir) } };
}

const runFile = (dir: string, id: string) => path.join(dir, ".ria", "gate", id, "run.json");
const readRun = (dir: string, id: string): RunState => JSON.parse(fs.readFileSync(runFile(dir, id), "utf8"));
function editRun(dir: string, id: string, change: (run: RunState) => void): void {
  const run = readRun(dir, id);
  change(run);
  fs.writeFileSync(runFile(dir, id), JSON.stringify(run, null, 2));
}
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("a result that already passed on the same files is not produced again", () => {
  it("skips the commands when nothing changed since they passed", async () => {
    const { dir, env } = project();
    const first = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [1, 1]);
    assert.doesNotMatch(first.text, /not run again|Nothing was run/);

    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [1, 1], "neither command ran a second time");
    assert.match(second.text, /test\s+passed\s+not run again, it passed less than a minute ago\s+\[node count\.js test\]/);
    assert.match(second.text, /Nothing was run: they passed in full on exactly these files within the last 30 minutes/);
    assert.match(second.text, /gate_begin with fresh set to true/);

    const run = readRun(dir, second.id);
    assert.equal(run.baselineResults.length, 2);
    for (const r of run.baselineResults) assert.equal(r.reused?.run, first.id);
  });

  it("runs the commands again when a file changed", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": `${MATH_OK}// edited\n` });
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 2]);
    assert.doesNotMatch(second.text, /not run again|Nothing was run/);
  });

  it("takes the result of the last full check, which is the usual next task", async () => {
    const { dir, env } = project();
    const first = await gateBegin(env);
    writeFiles(dir, { "src/extra.js": "exports.x = 1;\n" });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "unchanged");
    assert.deepEqual([runs("test"), runs("lint")], [2, 2]);

    const next = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 2], "the check had just run both on these files");
    assert.match(next.text, /Nothing was run/);
    const reused = readRun(dir, next.id).baselineResults;
    assert.deepEqual(reused.map((r) => r.reused?.run), [first.id, first.id]);
    assert.ok(Date.parse(reused[0].reused!.at) >= Date.parse(readRun(dir, first.id).createdAt), "the time is when the check ran, not when the first baseline did");
  });

  it("runs only what is missing when some commands were not part of the earlier run", async () => {
    const { env } = project();
    await gateBegin(env, { commands: ["lint"] });
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [1, 1], "lint was reused, test had never run");
    assert.match(second.text, /lint\s+passed\s+not run again/);
    assert.doesNotMatch(second.text, /test\s+passed\s+not run again/);
    assert.match(second.text, /1 command not run: it passed in full/);
  });

  it("never reuses a failure", async () => {
    const { env } = project({}, { test: "node count.js test 1", lint: "node count.js lint" });
    await gateBegin(env);
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 1], "the failing command ran again, the passing one did not");
    assert.match(second.text, /test\s+FAILED/);
    assert.match(second.text, /already failing/);
    assert.match(second.text, /1 command not run/);
  });

  it("runs everything when asked to", async () => {
    const { env } = project();
    await gateBegin(env);
    const second = await gateBegin(env, { fresh: true });
    assert.deepEqual([runs("test"), runs("lint")], [2, 2]);
    assert.doesNotMatch(second.text, /not run again|Nothing was run/);
  });

  it("can be switched off in ria.config.json", async () => {
    const { env } = project({ reuseMinutes: 0 });
    await gateBegin(env);
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 2]);
    assert.doesNotMatch(second.text, /not run again/);
  });

  it("lets a result expire", async () => {
    const { dir, env } = project();
    const first = await gateBegin(env);
    editRun(dir, first.id, (run) => (run.createdAt = minutesAgo(40)));
    await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 2], "40 minutes is past the default 30");
  });

  it("keeps a result for as long as the project says", async () => {
    const { dir, env } = project({ reuseMinutes: 120 });
    const first = await gateBegin(env);
    editRun(dir, first.id, (run) => (run.createdAt = minutesAgo(40)));
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [1, 1]);
    assert.match(second.text, /within the last 120 minutes/);
  });

  it("does not keep a result alive by reusing it again and again", async () => {
    const { dir, env } = project();
    const first = await gateBegin(env);
    const second = await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [1, 1]);
    // 40 minutes after the commands really ran, the second run (which only copied their result) is a minute old
    editRun(dir, first.id, (run) => (run.createdAt = minutesAgo(40)));
    editRun(dir, second.id, (run) => {
      run.createdAt = minutesAgo(1);
      for (const r of run.baselineResults) r.reused = { run: first.id, at: minutesAgo(40) };
    });
    await gateBegin(env);
    assert.deepEqual([runs("test"), runs("lint")], [2, 2], "the commands ran again");
  });

  it("still compares, and rolls back, from a baseline that was reused", async () => {
    const { dir, env } = project({}, { test: "node verify.js" });
    await gateBegin(env);
    const second = await gateBegin(env);
    assert.match(second.text, /Nothing was run/);

    writeFiles(dir, { "src/math.js": MATH_BAD });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "regressed");
    assert.match(check.text, /test\s+passed -> FAILED/);

    const applied = await gateRollback(env, { apply: true });
    assert.match(applied, /Verified: the working tree matches the baseline again/);
    assert.equal(fs.readFileSync(path.join(dir, "src/math.js"), "utf8"), MATH_OK);
  });
});

describe("which results findReusable accepts", () => {
  const NOW = Date.parse("2026-11-02T12:00:00.000Z");
  const TREE = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const SPECS = [{ name: "test", command: "npm test", source: "package.json" }];
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const WINDOW = 30 * 60_000;

  const result = (over: Partial<CommandResult> = {}): CommandResult => ({
    name: "test",
    command: "npm test",
    status: "pass",
    exitCode: 0,
    durationMs: 5,
    failedTests: [],
    diagnostics: [],
    parsed: true,
    outputTail: "",
    ...over,
  });

  let root: string;
  let seq = 0;
  const store = (over: Partial<RunState> & { results?: CommandResult[] } = {}): string => {
    const { results = [result()], ...rest } = over;
    const id = newId(new Date(2026, 10, 2, 11, 0, seq++));
    saveRun(root, {
      id,
      label: "",
      createdAt: ago(5),
      head: null,
      ranOn: TREE,
      baseline: { commit: "c".repeat(40), tree: TREE },
      commands: SPECS,
      baselineResults: results,
      baselineUnresolved: [],
      ...rest,
    });
    return id;
  };
  const find = (tree = TREE, windowMs = WINDOW) => findReusable(root, SPECS, tree, windowMs, NOW);

  const freshRoot = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ria-reuse-store-"));
    dirs.push(root);
    seq = 0;
  };

  it("takes a full pass on the same tree, with the same command, inside the window", () => {
    freshRoot();
    const id = store();
    const found = find().get("test");
    assert.equal(found?.at, ago(5));
    assert.deepEqual(found?.result.reused, { run: id, at: ago(5) });
    assert.equal(found?.result.status, "pass");
  });

  it("takes a result from a check as well as from a baseline", () => {
    freshRoot();
    const id = store({ ranOn: OTHER, lastCheck: { at: ago(2), ranOn: TREE, changes: [], results: [result({ durationMs: 77 })], verdict: "unchanged" } });
    const found = find().get("test");
    assert.equal(found?.result.durationMs, 77);
    assert.equal(found?.result.reused?.run, id);
    assert.equal(found?.at, ago(2));
  });

  it("prefers the newest of several", () => {
    freshRoot();
    store({ createdAt: ago(20) });
    const newest = store({ createdAt: ago(3) });
    store({ createdAt: ago(10) });
    assert.equal(find().get("test")?.result.reused?.run, newest);
  });

  it("leaves out a result that would not stand for the whole command", () => {
    const cases: [string, Partial<CommandResult>][] = [
      ["a failure", { status: "fail", exitCode: 1 }],
      ["a timeout", { status: "timeout", exitCode: null }],
      ["a command that could not run", { status: "error", exitCode: null }],
      ["part of a suite", { partial: "only 2 of 9 test files ran" }],
      ["a different command", { command: "npm test -- --only a" }],
      ["another command", { name: "lint" }],
    ];
    for (const [what, over] of cases) {
      freshRoot();
      store({ results: [result(over)] });
      assert.equal(find().size, 0, what);
    }
  });

  it("leaves out results from other files, from too long ago, from the future, and from a record that cannot be trusted", () => {
    const cases: [string, Partial<RunState>][] = [
      ["another tree", { ranOn: OTHER }],
      ["a run from before trees were recorded", { ranOn: undefined }],
      ["a tree that is not a hash", { ranOn: "../../etc/passwd" }],
      ["older than the window", { createdAt: ago(31) }],
      ["dated tomorrow", { createdAt: new Date(NOW + 24 * 3_600_000).toISOString() }],
      ["not a date", { createdAt: "yesterday-ish" }],
    ];
    for (const [what, over] of cases) {
      freshRoot();
      store(over);
      assert.equal(find().size, 0, what);
    }
  });

  it("forgives a clock a few seconds fast, but not a result that was reused after it expired", () => {
    freshRoot();
    store({ createdAt: new Date(NOW + 10_000).toISOString() });
    assert.equal(find().size, 1);

    freshRoot();
    store({ createdAt: ago(1), results: [result({ reused: { run: "20261102-100000000-abcd", at: ago(45) } })] });
    assert.equal(find().size, 0, "it was reused a minute ago, but the command ran 45 minutes ago");
  });

  it("finds nothing when the window is zero or there is nothing to look for", () => {
    freshRoot();
    store();
    assert.equal(find(TREE, 0).size, 0);
    assert.equal(findReusable(root, [], TREE, WINDOW, NOW).size, 0);
    assert.equal(find("not-a-tree").size, 0);
  });

  it("reads the window from the project's config", () => {
    assert.equal(reuseWindowMs({}), 30 * 60_000);
    assert.equal(reuseWindowMs({ reuseMinutes: 5 }), 5 * 60_000);
    assert.equal(reuseWindowMs({ reuseMinutes: 0 }), 0);
    assert.equal(reuseWindowMs({ reuseMinutes: 10 ** 6 }), MAX_REUSE_MINUTES * 60_000);
    for (const bad of [-1, Number.NaN, "10", null, {}]) assert.equal(reuseWindowMs({ reuseMinutes: bad as never }), 30 * 60_000, String(bad));
  });
});
