import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOutput } from "../src/gate/parse";

const ROOT = "C:\\proj dir";
const parse = (out: string) => parseOutput(out, ROOT);

describe("test runner summaries", () => {
  it("node:test spec reporter", () => {
    const r = parse(`✔ passes (0.5ms)\n✖ fails (1.2ms)\nℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n\n✖ failing tests:\n\ntest at x.test.js:3:1\n✖ fails (1.2ms)\n`);
    assert.deepEqual(r.tests, { passed: 1, failed: 1, skipped: 0, total: 2 });
    assert.deepEqual(r.failedTests, ["fails"]);
  });

  it("TAP", () => {
    const r = parse(`TAP version 13\nok 1 - passes\nnot ok 2 - fails\n# tests 2\n# pass 1\n# fail 1\n# skipped 0\n`);
    assert.deepEqual(r.tests, { passed: 1, failed: 1, skipped: 0, total: 2 });
    assert.deepEqual(r.failedTests, ["fails"]);
  });

  it("jest, ignoring the timing in file names", () => {
    const r = parse(`FAIL src/a.test.ts (2.3 s)\n  ● math › adds\n    expect(received).toBe(expected)\nTests:       1 failed, 2 skipped, 71 passed, 74 total\n`);
    assert.deepEqual(r.tests, { passed: 71, failed: 1, skipped: 2, total: 74 });
    assert.deepEqual(r.failedTests, ["math › adds", "src/a.test.ts"]);
  });

  it("vitest", () => {
    const r = parse(` FAIL  src/a.test.ts > adds\n\n      Tests  1 failed | 71 passed (72)\n`);
    assert.deepEqual(r.tests, { passed: 71, failed: 1, skipped: 0, total: 72 });
    assert.deepEqual(r.failedTests, ["src/a.test.ts > adds"]);
  });

  it("pytest, with and without -q", () => {
    const loud = parse(`FAILED tests/test_a.py::test_add - assert 1 == 2\n=========== 1 failed, 71 passed, 2 skipped in 0.50s ===========\n`);
    assert.deepEqual(loud.tests, { passed: 71, failed: 1, skipped: 2, total: 74 });
    assert.deepEqual(loud.failedTests, ["tests/test_a.py::test_add"]);
    assert.deepEqual(parse(`........\n72 passed in 0.31s\n`).tests, { passed: 72, failed: 0, skipped: 0, total: 72 });
    assert.deepEqual(parse(`no tests ran in 0.01s\n`).tests, { passed: 0, failed: 0, skipped: 0, total: 0 });
  });

  it("go test names failing tests and packages but not timings", () => {
    const r = parse(`--- FAIL: TestAdd (0.00s)\n    a_test.go:9: got 1\nFAIL\nFAIL\texample.com/app/pkg\t0.003s\nok  \texample.com/app/other\t0.002s\n`);
    assert.deepEqual(r.failedTests, ["TestAdd", "package example.com/app/pkg"]);
    assert.equal(r.tests, undefined);
  });

  it("cargo sums every test binary", () => {
    const r = parse(`test tests::adds ... FAILED\ntest result: FAILED. 70 passed; 2 failed; 1 ignored; 0 measured\ntest result: ok. 5 passed; 0 failed; 0 ignored; 0 measured\n`);
    assert.deepEqual(r.tests, { passed: 75, failed: 2, skipped: 1, total: 78 });
    assert.deepEqual(r.failedTests, ["tests::adds"]);
  });

  it("dotnet", () => {
    const r = parse(`  Failed Ns.Cls.Method [12 ms]\nFailed!  - Failed:     1, Passed:    71, Skipped:     0, Total:    72, Duration: 1 s - x.dll (net8.0)\n`);
    assert.deepEqual(r.tests, { passed: 71, failed: 1, skipped: 0, total: 72 });
    assert.deepEqual(r.failedTests, ["Ns.Cls.Method"]);
  });

  it("mocha", () => {
    assert.deepEqual(parse(`  71 passing (2s)\n  1 failing\n  2 pending\n`).tests, { passed: 71, failed: 1, skipped: 2, total: 74 });
  });

  it("maven takes the final summary, not the per-class lines", () => {
    const r = parse(`[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s - in A\n[ERROR] Tests run: 72, Failures: 1, Errors: 1, Skipped: 2\n`);
    assert.deepEqual(r.tests, { passed: 68, failed: 2, skipped: 2, total: 72 });
  });

  it("reports nothing for output it does not recognise", () => {
    const r = parse(`building...\ndone\n`);
    assert.deepEqual([r.tests, r.failedTests, r.diagnostics, r.parsed], [undefined, [], [], false]);
  });

  it("does not turn a bare FAIL line into a test name", () => {
    assert.deepEqual(parse(`FAIL\nsomething unrelated\n`).failedTests, []);
  });
});

describe("compiler and linter diagnostics", () => {
  const texts = (out: string) => parse(out).diagnostics.map((d) => `${d.severity}|${d.text}`);

  it("tsc, plain and pretty, with absolute paths made relative and no line numbers", () => {
    assert.deepEqual(
      texts(`C:\\proj dir\\src\\a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts:4:1 - error TS2304: Cannot find name 'x'.\nerror TS18003: No inputs were found.\n`),
      [
        "error|src/a.ts: error TS2322: Type 'string' is not assignable to type 'number'.",
        "error|src/b.ts: error TS2304: Cannot find name 'x'.",
        "error|error TS18003: No inputs were found.",
      ],
    );
  });

  it("gcc / clang with severity", () => {
    assert.deepEqual(texts(`src/main.c:12:5: error: 'x' undeclared\nsrc/main.c:20:1: warning: unused variable 'y'\n`), [
      "error|src/main.c: error: 'x' undeclared",
      "warning|src/main.c: warning: unused variable 'y'",
    ]);
  });

  it("rustc needs the location line to count", () => {
    assert.deepEqual(texts(`error[E0308]: mismatched types\n --> src/main.rs:2:5\nerror: aborting due to 1 previous error\n`), [
      "error|src/main.rs: error[E0308]: mismatched types",
    ]);
  });

  it("msbuild, dropping the trailing project name", () => {
    assert.deepEqual(texts(`C:\\proj dir\\Program.cs(5,9): error CS1002: ; expected [C:\\proj dir\\App.csproj]\n`), ["error|Program.cs: error CS1002: ; expected"]);
  });

  it("eslint stylish, even when the path contains spaces", () => {
    assert.deepEqual(
      texts(`C:\\proj dir\\src\\a.js\n  3:5  error  'x' is not defined  no-undef\n  4:1  warning  Unexpected console statement  no-console\n\n✖ 2 problems\n`),
      ["error|src/a.js: error no-undef: 'x' is not defined", "warning|src/a.js: warning no-console: Unexpected console statement"],
    );
  });

  it("ruff, mypy and go build", () => {
    assert.deepEqual(texts(`src/a.py:3:5: F401 'os' imported but unused\nsrc/a.py:9: error: Incompatible types\n./main.go:12:5: undefined: x\n`), [
      "error|src/a.py: F401: 'os' imported but unused",
      "error|src/a.py: error: Incompatible types",
      "error|main.go: undefined: x",
    ]);
  });

  it("lists a repeated diagnostic once", () => {
    assert.equal(parse(`src/a.ts(1,1): error TS1: x\nsrc/a.ts(1,1): error TS1: x\n`).diagnostics.length, 1);
  });
});
