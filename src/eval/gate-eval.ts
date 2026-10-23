import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Verdict } from "../gate/compare";
import { gateBegin, gateCheck, gateRollback } from "../gate/gate";
import { git } from "../git/history";
import { RepoIndex } from "../repo/repo-index";

/** `null` deletes the file. */
type Files = Record<string, string | null>;

export interface Fault {
  name: string;
  /** What the gate should conclude, decided from what the change does, not from what the gate printed. */
  expect: Verdict;
  /** Text the report must also contain. */
  expectText?: RegExp;
  /** Changes already in the project when the baseline is taken (a project that starts out broken). */
  before?: Files;
  /** The change being judged. */
  after: Files;
  /** False for a project that has no build or test command at all. */
  commands?: boolean;
}

export interface FaultResult {
  name: string;
  expect: Verdict;
  got: Verdict;
  textOk: boolean;
  /** After gate_rollback the working tree is byte for byte what it was at the baseline. */
  restored: boolean;
  ok: boolean;
  failure?: string;
}

export interface GateEvalResult {
  results: FaultResult[];
  correct: number;
  restored: number;
}

const MATH_OK = `exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n`;
const MATH_BROKEN = `exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n`;
const MATH_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
const { add, sub } = require("../src/math");
test("adds", () => assert.equal(add(1, 2), 3));
test("subtracts", () => assert.equal(sub(3, 1), 2));
`;
// reports every TODO in compiler style, with its line number
const LINT = `const fs = require("node:fs");
let bad = 0;
fs.readFileSync("src/math.js", "utf8").split("\\n").forEach((line, i) => {
  if (line.includes("TODO")) { console.log("src/math.js:" + (i + 1) + ":1: error: TODO left in code"); bad++; }
});
process.exit(bad ? 1 : 0);
`;
const CONFIG = JSON.stringify({ gate: { commands: { test: "node --test test/math.test.js", lint: "node lint.js" } } });

const BASE: Files = {
  "src/math.js": MATH_OK,
  "test/math.test.js": MATH_TEST,
  "lint.js": LINT,
  "src/lib.ts": `export function keep() {}\nexport function drop() {}\n`,
  "src/use.ts": `import { keep } from "./lib";\nkeep();\n`,
  "ria.config.json": CONFIG,
};

export const FAULTS: Fault[] = [
  { name: "a logic bug that breaks a test", expect: "regressed", expectText: /new failing tests: adds/, after: { "src/math.js": MATH_BROKEN } },
  { name: "a new linter error", expect: "regressed", expectText: /TODO left in code/, after: { "src/math.js": `${MATH_OK}// TODO remove\n` } },
  { name: "a deleted file that another file imports", expect: "regressed", expectText: /Imports that no longer resolve/, after: { "src/lib.ts": null } },
  { name: "an imported file moved without updating the import", expect: "regressed", expectText: /Imports that no longer resolve/, after: { "src/lib.ts": null, "src/library.ts": `export function keep() {}\n` } },
  { name: "a failing test that gets fixed", expect: "improved", expectText: /fixed tests: adds/, before: { "src/math.js": MATH_BROKEN }, after: { "src/math.js": MATH_OK } },
  {
    name: "one problem fixed while another is introduced",
    expect: "mixed",
    before: { "src/math.js": `${MATH_OK}// TODO remove\n` },
    after: { "src/math.js": MATH_BROKEN },
  },
  { name: "a comment-only change", expect: "unchanged", after: { "src/math.js": `// adds and subtracts\n${MATH_OK}` } },
  {
    name: "a new passing test",
    expect: "unchanged",
    after: { "test/extra.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("one", () => assert.equal(1, 1));\n` },
  },
  {
    name: "an edit that only moves an old linter error down",
    expect: "unchanged",
    before: { "src/math.js": `${MATH_OK}// TODO later\n` },
    after: { "src/math.js": `// header\n// header\n${MATH_OK}// TODO later\n` },
  },
  { name: "an unrelated change in a project that was already failing", expect: "unchanged", before: { "src/math.js": MATH_BROKEN }, after: { "src/other.js": "exports.x = 1;\n" } },
  {
    name: "an export that others import is removed (reported, not judged)",
    expect: "unchanged",
    expectText: /Exports gone from src\/lib\.ts: drop \(imported by 1 file\)/,
    after: { "src/lib.ts": `export function keep() {}\n` },
  },
  { name: "no check commands and a broken import", expect: "regressed", commands: false, after: { "src/lib.ts": null } },
  { name: "no check commands and a harmless change", expect: "unverified", commands: false, after: { "src/math.js": `// harmless\n${MATH_OK}` } },
];

function write(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

/** Path -> hash of every file the project owns (not git's or RIA's own folders). */
function hashTree(dir: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".ria") continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of hashTree(dir, child)) out.set(k, v);
    else out.set(child, createHash("sha256").update(fs.readFileSync(path.join(dir, child))).digest("hex"));
  }
  return out;
}

const sameTree = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

async function runFault(f: Fault): Promise<FaultResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ria-eval-gate-"));
  try {
    write(dir, { ...BASE, ...(f.commands === false ? { "ria.config.json": null } : {}), ...f.before });
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "user.name=ria-eval", "-c", "user.email=ria-eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]);

    const env = { index: new RepoIndex(dir) };
    await gateBegin(env, { label: f.name });
    const baseline = hashTree(dir);
    write(dir, f.after);
    const check = await gateCheck(env);
    await gateRollback(env, { apply: true });

    const textOk = f.expectText ? f.expectText.test(check.text) : true;
    const restored = sameTree(hashTree(dir), baseline);
    const ok = check.verdict === f.expect && textOk && restored;
    return { name: f.name, expect: f.expect, got: check.verdict, textOk, restored, ok };
  } catch (e) {
    return { name: f.name, expect: f.expect, got: "unverified", textOk: false, restored: false, ok: false, failure: e instanceof Error ? e.message : String(e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the faults one after another (each takes a few seconds: it runs real build and test commands). */
export async function evaluateGate(faults: Fault[] = FAULTS, progress?: (name: string) => void): Promise<GateEvalResult> {
  const results: FaultResult[] = [];
  for (const f of faults) {
    progress?.(f.name);
    results.push(await runFault(f));
  }
  return { results, correct: results.filter((r) => r.got === r.expect && r.textOk).length, restored: results.filter((r) => r.restored).length };
}

export function formatGateEval(r: GateEvalResult): string {
  const n = r.results.length;
  const width = Math.max(...r.results.map((x) => x.name.length));
  const out = [`Gate fault matrix: ${r.correct} of ${n} verdicts correct, ${r.restored} of ${n} rollbacks left the tree byte for byte as it was`, ""];
  for (const x of r.results) {
    const verdict = x.got === x.expect ? `${x.got}` : `${x.got} (expected ${x.expect})`;
    const flags = [!x.textOk && "report is missing the expected detail", !x.restored && "rollback did not restore the tree", x.failure && `error: ${x.failure}`].filter(Boolean);
    out.push(`  ${x.ok ? "ok  " : "FAIL"} ${x.name.padEnd(width)}  ${verdict}${flags.length ? `  [${flags.join("; ")}]` : ""}`);
  }
  out.push(
    "",
    "How to read this",
    "  - Each case builds a small project with its own build, test and lint commands, takes a baseline, makes one change and asks for the verdict. What the right verdict is was decided from what the change does, before running it.",
    "  - These are cases the gate was built for. They show it has not regressed; they do not measure how it does on a project it has never seen.",
    "  - An export removed from a file that others import is reported but not judged, because exports are read by pattern matching; a project that compiles would catch it through its own build command.",
  );
  return out.join("\n");
}
