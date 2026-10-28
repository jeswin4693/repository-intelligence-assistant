import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { detectCommands } from "../src/gate/detect";
import { gateBegin, gateCheck } from "../src/gate/gate";
import { planTargeted, targetedSetup } from "../src/gate/targeted";
import { CommandResult } from "../src/gate/types";
import { RepoIndex } from "../src/repo/repo-index";
import { ImpactResult } from "../src/tools/impact";
import { cleanup, commit, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const pass = { name: "test", status: "pass" } as CommandResult;

/** The template RIA works out for a project whose package.json has this test script (and these other files). */
function templateFor(script: string, extra: Record<string, string> = {}): string | undefined {
  const dir = makeRepo({ "package.json": JSON.stringify({ scripts: { test: script } }), ...extra });
  dirs.push(dir);
  const spec = detectCommands(dir).find((s) => s.name === "test");
  return targetedSetup(dir, {}, spec)?.template;
}

describe("targetedSetup: the test commands RIA knows how to narrow", () => {
  it("narrows node --test, keeping the options the project put before it", () => {
    assert.equal(templateFor("node --test"), "node --test {files}");
    assert.equal(templateFor("node --import tsx --test"), "node --import tsx --test {files}");
  });

  it("narrows a bare jest or vitest, keeping only options that change how it prints, not what it counts", () => {
    assert.equal(templateFor("jest"), "npx --no-install jest --runTestsByPath {files}");
    assert.equal(templateFor("jest --ci --runInBand"), "npx --no-install jest --runTestsByPath --ci --runInBand {files}");
    assert.equal(templateFor("vitest"), "npx --no-install vitest run {files}");
    assert.equal(templateFor("vitest run --silent"), "npx --no-install vitest run --silent {files}");
    assert.equal(templateFor("vitest --run"), "npx --no-install vitest run {files}");
  });

  it("leaves everything else to the whole command", () => {
    for (const script of [
      "node --test tests/", // a path is already there
      'node --test "tests/**/*.test.ts"', // a glob
      "jest --coverage", // a coverage threshold means nothing on a partial run
      "jest --config jest.ci.config.js",
      "jest -t slow", // a filter
      "vitest --coverage",
      "tsc && jest", // a chain: the files would go to the wrong command
      "cross-env CI=1 jest",
      "mocha", // mocha merges .mocharc's spec with the command line, so a subset is not a subset
      "ava",
      "npm run unit && npm run e2e",
    ]) {
      assert.equal(templateFor(script), undefined, script);
    }
  });

  it("does not guess for a package manager it has not been checked with", () => {
    assert.equal(templateFor("jest", { "pnpm-lock.yaml": "lockfileVersion: 9\n" }), undefined);
    assert.equal(templateFor("jest", { "yarn.lock": "\n" }), undefined);
    assert.equal(templateFor("jest", { "bun.lockb": "\n" }), undefined);
  });

  it("narrows pytest only when RIA found pytest itself", () => {
    const dir = makeRepo({ "app.py": "x = 1\n", "pytest.ini": "[pytest]\n", "test_app.py": "def test_x():\n    assert True\n" });
    dirs.push(dir);
    const spec = detectCommands(dir).find((s) => s.name === "test");
    assert.equal(spec?.command, "python -m pytest -q");
    const setup = targetedSetup(dir, {}, spec);
    assert.equal(setup?.template, "python -m pytest -q {files}");
    assert.ok(setup?.runnable?.test("tests/test_app.py") && setup.runnable.test("pkg/app_test.py"));
    assert.ok(!setup?.runnable?.test("tests/conftest.py") && !setup?.runnable?.test("tests/helpers.py"));

    const own = detectCommands(dir, { commands: { test: "python -m pytest -q" } }).find((s) => s.name === "test");
    assert.equal(own?.source, "ria.config.json");
    assert.equal(targetedSetup(dir, {}, own), undefined, "a command the project wrote itself is its own business");
  });

  it("lets the project's own targeted command win, and never guesses over a test command the project wrote", () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
    dirs.push(dir);
    const spec = detectCommands(dir).find((s) => s.name === "test");
    assert.equal(targetedSetup(dir, { targeted: { test: "my-runner {files}" } }, spec)?.template, "my-runner {files}");

    const custom = detectCommands(dir, { commands: { test: "jest" } }).find((s) => s.name === "test");
    assert.equal(targetedSetup(dir, {}, custom), undefined);
    assert.equal(targetedSetup(dir, {}, undefined), undefined);
  });

  it("does nothing when there is no test script", () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    dirs.push(dir);
    assert.equal(targetedSetup(dir, {}, { name: "test", command: "npm run test", source: "package.json scripts.test" }), undefined);
  });
});

describe("planTargeted with a runner's own idea of a test file", () => {
  const index = (files: Record<string, string>) => {
    const dir = makeRepo(files);
    dirs.push(dir);
    const i = new RepoIndex(dir, { cache: false });
    i.refresh();
    return i;
  };
  const tests = (...paths: string[]) => ({ tests: paths.map((path) => ({ path, why: "x" })) }) as unknown as ImpactResult;
  const runnable = /\.(test|spec)\.ts$/;
  const files = {
    "src/a.ts": "export const a = 1;\n",
    "tests/a.test.ts": "x\n",
    "tests/b.test.ts": "x\n",
    "tests/c.test.ts": "x\n",
    "tests/d.test.ts": "x\n",
    "tests/helpers.ts": "export const h = 1;\n",
  };

  it("passes on test files only, not the helpers the runner would reject as 'no tests found'", () => {
    const plan = planTargeted({
      template: "runner {files}",
      runnable,
      index: index(files),
      changes: [{ path: "src/a.ts", status: "M" }],
      blast: tests("tests/helpers.ts", "tests/a.test.ts"),
      baseline: pass,
    });
    assert.ok(!("reason" in plan), "reason" in plan ? plan.reason : "");
    assert.deepEqual(plan.files, ["tests/a.test.ts"]);
    assert.equal(plan.of, 4, "the helper is not counted as a test file either");
  });

  it("falls back when only a helper is tied", () => {
    const plan = planTargeted({ template: "runner {files}", runnable, index: index(files), changes: [], blast: tests("tests/helpers.ts"), baseline: pass });
    assert.match("reason" in plan ? plan.reason : "", /no test is tied/);
  });

  it("falls back to the whole run when a configuration or setup file changed, whatever else is tied", () => {
    for (const changed of ["package.json", "jest.config.js", "tsconfig.base.json", "pyproject.toml", "tests/conftest.py", "pytest.ini", "ria.config.json", "packages/x/vitest.config.ts"]) {
      const plan = planTargeted({
        template: "runner {files}",
        runnable,
        index: index(files),
        changes: [{ path: changed, status: "M" }, { path: "tests/a.test.ts", status: "M" }],
        blast: tests("tests/a.test.ts"),
        baseline: pass,
      });
      assert.match("reason" in plan ? plan.reason : "(a plan)", new RegExp(`${changed.replace(/[.]/g, "\\.")} changed, which can change what every test does`), changed);
    }
  });
});

describe("scope tied without a ria.config.json, on a project whose test script RIA knows", () => {
  const MATH = `exports.add = (a, b) => a + b;\n`;
  // the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
  const req = (spec: string) => `require("${spec}")`;
  const nodeTest = `const test = require("node:test");\nconst assert = require("node:assert/strict");\n`;

  function project() {
    const dir = makeRepo({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/math.js": MATH,
      "src/other.js": `exports.mul = (a, b) => a * b;\n`,
      "test/math.test.js": `${nodeTest}const { add } = ${req("../src/math")};\ntest("adds", () => assert.equal(add(1, 2), 3));\n`,
      "test/other.test.js": `${nodeTest}const { mul } = ${req("../src/other")};\ntest("multiplies", () => assert.equal(mul(2, 3), 6));\n`,
      "test/helpers.js": `exports.h = 1;\n`,
    });
    dirs.push(dir);
    gitInit(dir);
    commit(dir, "initial");
    return { dir, env: { index: new RepoIndex(dir) } };
  }

  it("offers faster checks at the start and runs just the tied test file", async () => {
    const { dir, env } = project();
    const begin = await gateBegin(env);
    assert.match(begin.text, /Faster checks while you iterate: gate_check with scope "tied"/);
    // node counts the helper file as a (test-less) file of its own, which is why it is 3 and not 2
    assert.match(begin.text, /test\s+passed \(3 passed, 0 failed\).*\[npm run test\]/, "the baseline ran the project's own command");

    writeFiles(dir, { "src/math.js": `exports.add = (a, b) => a + b + 0;\n` });
    const r = await gateCheck(env, { scope: "tied" });
    assert.equal(r.verdict, "unchanged");
    assert.match(r.text, /\[node --test test\/math\.test\.js\]/);
    assert.match(r.text, /test\s+passed -> passed \(1 passed, 0 failed\)/);
    assert.match(r.text, /PARTIAL: only the 1 test file \(of 3\) tied to the changed files ran/, "node runs any file it is given, so the helper counts");
  });

  it("runs everything when package.json changed along with the code", async () => {
    const { dir, env } = project();
    await gateBegin(env);
    writeFiles(dir, {
      "src/math.js": `exports.add = (a, b) => a + b + 0;\n`,
      "package.json": JSON.stringify({ name: "p", version: "1.0.1", scripts: { test: "node --test" } }, null, 2) + "\n",
    });
    const r = await gateCheck(env, { scope: "tied" });
    assert.match(r.text, /Scope "tied" ran the whole test command: package\.json changed, which can change what every test does\./);
    assert.match(r.text, /\[npm run test\]/);
    assert.doesNotMatch(r.text, /PARTIAL/);
  });
});
