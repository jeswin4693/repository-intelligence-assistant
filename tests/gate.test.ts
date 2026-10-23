import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { GateError, gateBegin, gateCheck, gateRollback } from "../src/gate/gate";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, commit, git, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const MATH_OK = `exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n`;
const MATH_BAD = `exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n`;
const MATH_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { add, sub } = require("../src/math");
test("adds", () => assert.equal(add(1, 2), 3));
test("subtracts", () => assert.equal(sub(3, 1), 2));
`;
// a tiny linter: reports every TODO in gcc style
const LINT = `const fs = require("node:fs");
let bad = 0;
fs.readFileSync("src/math.js", "utf8").split("\\n").forEach((line, i) => {
  if (line.includes("TODO")) { console.log("src/math.js:" + (i + 1) + ":1: error: TODO left in code"); bad++; }
});
process.exit(bad ? 1 : 0);
`;
const CONFIG = JSON.stringify({ gate: { commands: { test: "node --test test/math.test.js", lint: "node lint.js" } } });

function project(extra: Record<string, string> = {}, math = MATH_OK): { dir: string; env: { index: RepoIndex } } {
  const dir = makeRepo({ "src/math.js": math, "test/math.test.js": MATH_TEST, "lint.js": LINT, "ria.config.json": CONFIG, ...extra });
  dirs.push(dir);
  gitInit(dir);
  commit(dir, "initial");
  return { dir, env: { index: new RepoIndex(dir) } };
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

describe("the change gate", () => {
  it("catches a regression, names the failing test, and rolls it back", async () => {
    const { dir, env } = project();
    const begin = await gateBegin(env, { label: "fix subtraction" });
    assert.match(begin.text, /Gate started: run \d{8}-\d{9}-[0-9a-f]{4} \(fix subtraction\)/);
    assert.match(begin.text, /test\s+passed \(2 passed, 0 failed\)/);
    assert.match(begin.text, /lint\s+passed/);

    writeFiles(dir, { "src/math.js": MATH_BAD });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "regressed");
    assert.match(check.text, /REGRESSED/);
    assert.match(check.text, /modified src\/math\.js/);
    assert.match(check.text, /test\s+passed -> FAILED \(1 passed, 1 failed\)/);
    assert.match(check.text, /new failing tests: adds/);
    assert.match(check.text, /lint\s+passed -> passed/);
    assert.match(check.text, /Tests tied to the changed code \(1\): test\/math\.test\.js/);
    assert.match(check.text, /call gate_rollback/);

    const preview = await gateRollback(env, {});
    assert.match(preview, /Rollback preview/);
    assert.match(preview, /restore src\/math\.js/);
    assert.equal(read(dir, "src/math.js"), MATH_BAD, "a preview changes nothing");

    const applied = await gateRollback(env, { apply: true });
    assert.match(applied, /Verified: the working tree matches the baseline again/);
    assert.equal(read(dir, "src/math.js"), MATH_OK);

    const again = await gateCheck(env);
    assert.match(again.text, /no files differ from the baseline/);
  });

  it("recognises a fix to something that was already broken", async () => {
    const { dir, env } = project({}, MATH_BAD);
    const begin = await gateBegin(env);
    assert.match(begin.text, /test\s+FAILED \(1 passed, 1 failed\)/);
    assert.match(begin.text, /already failing/);

    writeFiles(dir, { "src/math.js": MATH_OK });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "improved");
    assert.match(check.text, /test\s+FAILED -> passed/);
    assert.match(check.text, /fixed tests: adds/);
  });

  it("does not blame the change for what was already failing", async () => {
    const { dir, env } = project({}, MATH_BAD);
    await gateBegin(env);
    writeFiles(dir, { "src/other.js": "exports.x = 1;\n" });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "unchanged");
    assert.match(check.text, /already failing before the change/);
  });

  it("reports new linter errors in plain terms", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": `${MATH_OK}// TODO remove\n` });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "regressed");
    assert.match(check.text, /lint\s+passed -> FAILED/);
    assert.match(check.text, /new error: src\/math\.js: error: TODO left in code/);
  });

  it("can run a chosen subset of the commands", async () => {
    const { dir, env } = project();
    const begin = await gateBegin(env, { commands: ["lint"] });
    assert.doesNotMatch(begin.text, /test\s+passed/);
    writeFiles(dir, { "src/math.js": MATH_BAD });
    const check = await gateCheck(env);
    assert.equal(check.verdict, "unchanged", "the test command was not part of this run");
    assert.match(check.text, /no test command ran/);
    await assert.rejects(gateCheck(env, { commands: ["test"] }), /Unknown command name\(s\): test\. Available: lint/);
  });

  it("falls back to import and export checks when the project has no commands", async () => {
    const dir = makeRepo({ "a.js": `exports.foo = () => 1;\nexports.bar = () => 2;\n`, "b.js": `const { foo } = require("./a");\nfoo();\n` });
    dirs.push(dir);
    gitInit(dir);
    commit(dir, "initial");
    const env = { index: new RepoIndex(dir) };
    const begin = await gateBegin(env);
    assert.match(begin.text, /No build, typecheck, lint or test command was found/);

    fs.rmSync(path.join(dir, "a.js"));
    const check = await gateCheck(env);
    assert.equal(check.verdict, "regressed");
    assert.match(check.text, /Imports that no longer resolve \(1\): b\.js -> \.\/a/);
    assert.match(check.text, /Confidence: low/);
  });

  it("warns when exports disappear from a file that others import", async () => {
    const dir = makeRepo({
      "lib.ts": `export function keep() {}\nexport function drop() {}\n`,
      "use.ts": `import { keep } from "./lib";\nkeep();\n`,
    });
    dirs.push(dir);
    gitInit(dir);
    commit(dir, "initial");
    const env = { index: new RepoIndex(dir) };
    await gateBegin(env);
    writeFiles(dir, { "lib.ts": `export function keep() {}\n` });
    const check = await gateCheck(env);
    assert.match(check.text, /Exports gone from lib\.ts: drop \(imported by 1 file\)/);
    assert.match(check.text, /Not changed, but depend on the changed code \(1\): use\.ts/);
  });

  it("keeps uncommitted work that existed before gate_begin when rolling back", async () => {
    const { dir, env } = project();
    writeFiles(dir, { "notes.txt": "my unfinished notes\n" });
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": MATH_BAD, "src/extra.js": "exports.y = 1;\n" });
    await gateRollback(env, { apply: true });
    assert.equal(read(dir, "notes.txt"), "my unfinished notes\n");
    assert.equal(read(dir, "src/math.js"), MATH_OK);
    assert.equal(fs.existsSync(path.join(dir, "src", "extra.js")), false);
  });

  it("leaves the repository clean of its own files", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": MATH_BAD });
    await gateCheck(env);
    const status = git(dir, "status", "--porcelain");
    assert.doesNotMatch(status, /\.ria/);
    assert.equal(git(dir, "stash", "list").trim(), "");
  });

  it("mentions files that running the checks itself changed", async () => {
    const config = JSON.stringify({ gate: { commands: { build: "node -e \"require('fs').writeFileSync('generated.txt', String(Date.now()))\"" } } });
    const { dir, env } = project({ "ria.config.json": config });
    await gateBegin(env);
    writeFiles(dir, { "src/math.js": MATH_BAD });
    const check = await gateCheck(env);
    assert.match(check.text, /running the checks itself changed 1 file/);
  });

  it("stops a command that runs too long", async () => {
    const config = JSON.stringify({ gate: { timeoutSeconds: 1, commands: { test: "node -e \"setInterval(() => {}, 1000)\"" } } });
    const { env } = project({ "ria.config.json": config });
    const started = Date.now();
    const begin = await gateBegin(env);
    assert.ok(Date.now() - started < 15_000, "the process tree was killed");
    assert.match(begin.text, /test\s+TIMED OUT/);
    assert.match(begin.text, /stopped after 1s/);
  });

  it("says when a command is not installed instead of calling it a failure of the code", async () => {
    const config = JSON.stringify({ gate: { commands: { build: "ria-no-such-command-xyz --go" } } });
    const { env } = project({ "ria.config.json": config });
    const begin = await gateBegin(env);
    assert.match(begin.text, /build\s+COULD NOT RUN/);
    assert.match(begin.text, /not installed or not on PATH/);
  });

  it("uses the project's own scripts when there is no config", async () => {
    const pkg = JSON.stringify({ name: "fx", scripts: { test: "node --test test/math.test.js" } });
    const { dir, env } = project({ "package.json": pkg, "ria.config.json": "{}" });
    const begin = await gateBegin(env);
    assert.match(begin.text, /test\s+passed \(2 passed, 0 failed\).*\[npm run test\]/);
    writeFiles(dir, { "src/math.js": MATH_BAD });
    assert.equal((await gateCheck(env)).verdict, "regressed");
  });

  it("keeps only the most recent runs", async () => {
    const { dir, env } = project({ "ria.config.json": "{}" });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await gateBegin(env)).id);
    const left = fs.readdirSync(path.join(dir, ".ria", "gate")).sort();
    assert.equal(left.length, 5);
    assert.deepEqual(left, ids.slice(-5).sort());
    assert.doesNotMatch(git(dir, "for-each-ref", "refs/ria"), new RegExp(ids[0]));
  });

  describe("refuses safely", () => {
    it("outside a git repository", async () => {
      const dir = makeRepo({ "a.js": "x" });
      dirs.push(dir);
      await assert.rejects(gateBegin({ index: new RepoIndex(dir) }), (e: Error) => e instanceof GateError && /needs a git repository/.test(e.message));
    });

    it("when nothing may be written into the repository", async () => {
      const { dir } = project();
      await assert.rejects(gateBegin({ index: new RepoIndex(dir, { cache: false }) }), /cannot run with --no-cache/);
    });

    it("before a run exists, and for ids that are not run ids", async () => {
      const { env } = project();
      await assert.rejects(gateCheck(env), /Call gate_begin before making changes/);
      await assert.rejects(gateRollback(env, {}), /nothing to roll back to/);
      await assert.rejects(gateCheck(env, { id: "../../etc/passwd" }), /No gate run/);
    });

    it("when the baseline snapshot has been removed", async () => {
      const { dir, env } = project({ "ria.config.json": "{}" });
      const { id } = await gateBegin(env);
      git(dir, "update-ref", "-d", `refs/ria/gate/${id}`);
      git(dir, "reflog", "expire", "--expire=now", "--all");
      git(dir, "gc", "--prune=now", "-q");
      await assert.rejects(gateCheck(env), /baseline snapshot no longer exists/);
    });
  });
});
