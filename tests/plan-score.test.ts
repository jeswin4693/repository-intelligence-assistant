import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { RepoIndex } from "../src/repo/repo-index";
import { PlanInput, PlanScoreResult, formatPlanScore, parsePlanArg, planScore } from "../src/tools/plan-score";
import { cleanup, commit, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
let dir: string;
let index: RepoIndex;

const A: PlanInput = { name: "Invoice only", files: ["src/billing/invoice.ts"] };
const B: PlanInput = { name: "Invoice and tax", files: ["src/billing/invoice.ts", "src/billing/tax.ts"] };
const C: PlanInput = { name: "Rewrite audit", files: ["src/audit.ts", "src/legacy.ts"] };

before(() => {
  dir = makeRepo({
    "src/index.ts": `import { createInvoice } from "./billing/invoice";\nimport { findUser } from "./users/user";\ncreateInvoice(findUser("x"));\n`,
    "src/billing/invoice.ts": `import { audit } from "../audit";\nexport function createInvoice(u: unknown) { audit(u); }\n`,
    "src/billing/tax.ts": `export function taxFor(n: number) { return n * 0.2; }\n`,
    "src/users/user.ts": `export function findUser(id: string) { return id; }\n`,
    "src/audit.ts": `export function audit(x: unknown) { return x; }\n`,
    "src/legacy.ts": `export const LEGACY = 1;\n`,
    "tests/invoice.test.ts": `import { createInvoice } from "../src/billing/invoice";\n`,
    "tests/tax.test.ts": `import { taxFor } from "../src/billing/tax";\n`,
    "README.md": `# fixture\n`,
  });
  gitInit(dir);
  commit(dir, "initial");
  // invoice.ts and tax.ts keep changing together without importing each other
  commit(dir, "invoice + tax 1", { "src/billing/invoice.ts": `import { audit } from "../audit";\nexport function createInvoice(u: unknown) { audit(u); return 1; }\n`, "src/billing/tax.ts": `export function taxFor(n: number) { return n * 0.21; }\n` });
  commit(dir, "invoice + tax 2", { "src/billing/invoice.ts": `import { audit } from "../audit";\nexport function createInvoice(u: unknown) { audit(u); return 2; }\n`, "src/billing/tax.ts": `export function taxFor(n: number) { return n * 0.22; }\n` });
  commit(dir, "user only", { "src/users/user.ts": `export function findUser(id: string) { return id + "!"; }\n` });
  index = new RepoIndex(dir);
  index.refresh();
});
after(() => cleanup(dir));

function score(plans: PlanInput[], depth?: number): PlanScoreResult {
  const r = planScore(index, { plans, depth });
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r;
}

const points = (r: PlanScoreResult, name: string) => {
  const plan = r.plans.find((p) => p.name === name)!;
  return Object.fromEntries(plan.components.map((c) => [c.key, c.points]));
};

describe("planScore", () => {
  it("ranks the plans by the points of each factor", () => {
    const r = score([A, B, C]);
    assert.deepEqual(r.plans.map((p) => [p.rank, p.name, p.score]), [[1, "Invoice and tax", 3], [2, "Invoice only", 4], [3, "Rewrite audit", 7.5]]);
    // the plan that leaves tax.ts out pays for ignoring a file that changed with invoice.ts in every commit
    assert.deepEqual(points(r, "Invoice only"), { scope: 1, blast: 1, tests: 0, coupling: 2, reading: 0 });
    assert.deepEqual(points(r, "Invoice and tax"), { scope: 2, blast: 1, tests: 0, coupling: 0, reading: 0 });
    // audit.ts is reached by a test only through invoice.ts (1 point), legacy.ts by none (3 points); blast is 1 direct + 0.5 at two hops
    assert.deepEqual(points(r, "Rewrite audit"), { scope: 2, blast: 1.5, tests: 4, coupling: 0, reading: 0 });
  });

  it("names the files a plan ignores and the files without a test", () => {
    const r = score([A, C]);
    const a = r.plans.find((p) => p.name === "Invoice only")!;
    assert.deepEqual(a.ignoredCoupling.map((h) => [h.path, h.support, h.confidence]), [["src/billing/tax.ts", 3, 1]]);
    const c = r.plans.find((p) => p.name === "Rewrite audit")!;
    assert.deepEqual(c.untested, [{ path: "src/audit.ts", coverage: "transitive" }, { path: "src/legacy.ts", coverage: "none" }]);
    assert.deepEqual(a.testsToRun.map((t) => t.path), ["tests/invoice.test.ts"]);
  });

  it("explains why the winner wins and what it costs, and calls a narrow lead a close call", () => {
    const rec = score([A, B]).recommendation;
    assert.equal(rec.plan, "Invoice and tax");
    assert.equal(rec.runnerUp, "Invoice only");
    assert.equal(rec.margin, 1);
    assert.equal(rec.closeCall, true);
    assert.deepEqual(rec.better, ["ignored coupling: 0.0 vs 2.0 points"]);
    assert.deepEqual(rec.costs, ["scope: 2.0 vs 1.0 points"]);

    const clear = score([B, C]).recommendation;
    assert.equal(clear.closeCall, false);
    assert.equal(clear.margin, 4.5);
    assert.match(clear.better.join("\n"), /missing tests: 0\.0 vs 4\.0/);
  });

  it("gives the same ranking whatever order the plans are listed in", () => {
    const D: PlanInput = { name: "Legacy with a test", files: ["src/legacy.ts", "tests/legacy.test.ts"] };
    const plans = [A, B, C, D];
    const expected = score(plans).plans.map((p) => `${p.name}:${p.score}`);
    const permute = (items: PlanInput[]): PlanInput[][] =>
      items.length <= 1 ? [items] : items.flatMap((x, i) => permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
    const orders = permute(plans);
    assert.equal(orders.length, 24);
    for (const order of orders) assert.deepEqual(score(order).plans.map((p) => `${p.name}:${p.score}`), expected);
  });

  it("breaks equal scores by something other than the listing order", () => {
    const x: PlanInput = { name: "Zeta", files: ["src/users/user.ts"] };
    const y: PlanInput = { name: "Alpha", files: ["src/users/user.ts"] };
    assert.deepEqual(score([x, y]).plans.map((p) => p.name), ["Alpha", "Zeta"]);
    assert.deepEqual(score([y, x]).plans.map((p) => p.name), ["Alpha", "Zeta"]);
  });

  it("treats files that are not in the index as new and says so", () => {
    const r = score([{ name: "Add discount", files: ["src/billing/invoice.ts", "src/billing/discount.ts"] }]);
    const p = r.plans[0];
    assert.deepEqual(p.created, ["src/billing/discount.ts"]);
    assert.equal(points(r, "Add discount").scope, 2);
    assert.match(p.confidence.caveats.join("\n"), /discount\.ts.*not in the index: treated as new files/);
  });

  it("counts a test file the plan adds as covering the file it is named after", () => {
    const without = score([{ name: "No test", files: ["src/legacy.ts"] }]);
    const withTest = score([{ name: "With test", files: ["src/legacy.ts", "tests/legacy.test.ts"] }]);
    assert.equal(points(without, "No test").tests, 3);
    assert.equal(points(withTest, "With test").tests, 0);
    assert.deepEqual(withTest.plans[0].created, ["tests/legacy.test.ts"]);
    // a new test file is not a source file, so it adds no scope
    assert.equal(points(withTest, "With test").scope, 1);
  });

  it("does not charge tests or full scope for documentation and config files", () => {
    const r = score([{ name: "Test only", files: ["tests/tax.test.ts"] }, { name: "Readme", files: ["README.md"] }]);
    assert.deepEqual(points(r, "Test only"), { scope: 0, blast: 0, tests: 0, coupling: 0, reading: 0 });
    assert.equal(points(r, "Readme").scope, 0.5);
    assert.equal(points(r, "Readme").tests, 0);
    assert.deepEqual(r.plans.find((p) => p.name === "Readme")!.created, []);
  });

  it("accepts a symbol name and de-duplicates files", () => {
    const r = score([{ name: "By symbol", files: ["createInvoice", "src/billing/invoice.ts", "invoice.ts"] }]);
    assert.deepEqual(r.plans[0].existing, ["src/billing/invoice.ts"]);
  });

  it("gives plans without a name, or with the same name, distinct labels", () => {
    const r = score([{ files: ["src/legacy.ts"] }, { files: ["src/audit.ts"] }, { name: "Same", files: ["src/users/user.ts"] }, { name: "Same", files: ["src/billing/tax.ts"] }]);
    assert.deepEqual(r.plans.map((p) => p.name).sort(), ["Plan 1", "Plan 2", "Same (#3)", "Same (#4)"]);
  });

  it("scores one plan on its own", () => {
    const r = score([A]);
    assert.equal(r.plans.length, 1);
    assert.equal(r.recommendation.runnerUp, undefined);
    assert.match(formatPlanScore(r), /one plan, so nothing to rank/);
  });

  it("shows what the plans share and what only one of them touches", () => {
    const o = score([A, B]).overlap;
    assert.deepEqual(o.inAll, ["src/billing/invoice.ts"]);
    assert.deepEqual(o.some, []);
    assert.deepEqual(o.only.map((x) => [x.plan, x.files]).sort(), [["Invoice and tax", ["src/billing/tax.ts"]], ["Invoice only", []]]);
  });

  it("also shows files that only some of the plans share", () => {
    const o = score([A, B, C]).overlap;
    assert.deepEqual(o.inAll, []);
    assert.deepEqual(o.some, [{ file: "src/billing/invoice.ts", plans: ["Invoice and tax", "Invoice only"] }]);
    assert.deepEqual(o.only.find((x) => x.plan === "Invoice and tax")?.files, ["src/billing/tax.ts"]);
    assert.match(formatPlanScore(score([A, B, C])), /src\/billing\/invoice\.ts: Invoice and tax, Invoice only/);
  });

  it("reports history that is too short to trust", () => {
    const r = score([A, B]);
    assert.equal(r.confidence.level, "medium");
    assert.match(r.confidence.caveats.join("\n"), /commits of history/);
  });

  it("rejects ambiguous, directory and out-of-repository files instead of scoring them silently", () => {
    const dir2 = makeRepo({ "src/a/util.ts": `export const a = 1;\n`, "src/b/util.ts": `export const b = 1;\n`, "src/main.ts": `export const m = 1;\n` });
    try {
      const i2 = new RepoIndex(dir2, { cache: false });
      i2.refresh();
      const ambiguous = planScore(i2, { plans: [{ name: "P", files: ["util.ts"] }] });
      assert.ok("error" in ambiguous);
      assert.match(ambiguous.error, /P: "util\.ts" is ambiguous\. Use one of: src\/a\/util\.ts, src\/b\/util\.ts/);

      const directory = planScore(i2, { plans: [{ name: "P", files: ["src/a"] }] });
      assert.ok("error" in directory);
      assert.match(directory.error, /"src\/a" is a directory.*src\/a\/util\.ts/);

      const outside = planScore(i2, { plans: [{ name: "P", files: [path.join(os.tmpdir(), "elsewhere", "x.ts")] }] });
      assert.ok("error" in outside);
      assert.match(outside.error, /is outside the repository/);

      const both = planScore(i2, { plans: [{ name: "One", files: ["util.ts"] }, { name: "Two", files: ["src/b"] }] });
      assert.ok("error" in both);
      assert.match(both.error, /One: .*\n.*Two: /);

      assert.ok("error" in planScore(i2, { plans: [] }));
    } finally {
      cleanup(dir2);
    }
  });
});

describe("planScore on repositories without history", () => {
  it("weights dependents by distance, caps a hot file, and says it had no history", () => {
    const files: Record<string, string> = {
      "src/core.ts": `export const core = 1;\n`,
      "src/x0.ts": `export const x0 = 0;\n`,
      "src/x1.ts": `import { x0 } from "./x0";\nexport const x1 = x0;\n`,
      "src/x2.ts": `import { x1 } from "./x1";\nexport const x2 = x1;\n`,
      "src/x3.ts": `import { x2 } from "./x2";\nexport const x3 = x2;\n`,
      "src/hub.ts": `export const hub = 1;\n`,
    };
    for (let i = 0; i < 30; i++) files[`src/user${i}.ts`] = `import { hub } from "./hub";\n`;
    for (let i = 0; i < 20; i++) files[`tests/auth/a${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    for (let i = 0; i < 12; i++) files[`tests/billing/b${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    const dir2 = makeRepo(files);
    try {
      const i2 = new RepoIndex(dir2, { cache: false });
      i2.refresh();
      const r = planScore(i2, { plans: [{ name: "Chain", files: ["src/x0.ts"] }, { name: "Hub", files: ["src/hub.ts"] }], depth: 2 });
      assert.ok(!("error" in r));
      const blast = (name: string) => r.plans.find((p) => p.name === name)!.components.find((c) => c.key === "blast")!.points;
      assert.equal(blast("Chain"), 1.5); // x1 directly (1) + x2 two hops away (0.5); x3 is beyond depth 2
      assert.equal(blast("Hub"), 20); // 30 direct dependents, capped
      assert.match(r.confidence.caveats.join("\n"), /no git history/);
      assert.equal(r.recommendation.plan, "Chain");

      // a capped figure says it was cut off; an uncapped one does not
      const detail = (name: string) => r.plans.find((p) => p.name === name)!.components.find((c) => c.key === "blast")!.detail;
      assert.match(detail("Hub"), /30 dependents outside the plan, 30 direct .*; capped at 20$/);
      assert.doesNotMatch(detail("Chain"), /capped/);
    } finally {
      cleanup(dir2);
    }
  });

  it("shows where a long list of tests to run is concentrated instead of an arbitrary few", () => {
    const files: Record<string, string> = { "src/core.ts": `export const core = 1;\n` };
    for (let i = 0; i < 20; i++) files[`tests/auth/a${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    for (let i = 0; i < 12; i++) files[`tests/billing/b${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    const dir2 = makeRepo(files);
    try {
      const i2 = new RepoIndex(dir2, { cache: false });
      i2.refresh();
      const r = planScore(i2, { plans: [{ name: "Core", files: ["src/core.ts"] }] });
      assert.ok(!("error" in r));
      assert.equal(r.plans[0].testsToRun.length, 32);
      assert.match(formatPlanScore(r), /Tests to run after the change \(32\), concentrated in: tests\/auth \(20\), tests\/billing \(12\)/);
    } finally {
      cleanup(dir2);
    }
  });
});

describe("formatPlanScore", () => {
  it("prints the recommendation, the points, what each plan leaves out and how to read the score", () => {
    const text = formatPlanScore(score([A, B, C]));
    assert.match(text, /^Plan scores for 3 candidate plans \(lower is better\)/);
    assert.match(text, /Recommended: Invoice and tax \(score 3\.0\)/);
    assert.match(text, /Close call: Invoice only is only 1\.0 point\(s\) behind/);
    assert.match(text, /#2 Invoice only {3}score 4\.0/);
    assert.match(text, /Points: scope 1\.0 \| blast radius 1\.0 \| missing tests 0\.0 \| ignored coupling 2\.0 \| reading cost 0\.0/);
    assert.match(text, /src\/billing\/tax\.ts {2}100% of invoice\.ts's commits \(3\)/);
    assert.match(text, /src\/legacy\.ts {2}\(no test reaches it\)/);
    assert.match(text, /Only in Rewrite audit: src\/audit\.ts, src\/legacy\.ts/);
    assert.match(text, /not a prediction/);
    assert.match(text, /gate_begin/);
  });
});

describe("parsePlanArg", () => {
  it("reads a name and a comma list of files", () => {
    assert.deepEqual(parsePlanArg("Patch it=src/a.ts, src/b.ts"), { name: "Patch it", files: ["src/a.ts", "src/b.ts"] });
  });
  it("accepts a bare list and does not mistake a path with = for a name", () => {
    assert.deepEqual(parsePlanArg("src/a.ts,src/b.ts"), { name: undefined, files: ["src/a.ts", "src/b.ts"] });
    assert.deepEqual(parsePlanArg("src/a=b.ts"), { name: undefined, files: ["src/a=b.ts"] });
  });
});

describe("ria plan (command line)", () => {
  it("ranks plans given with --plan and can print JSON", () => {
    const run = (...extra: string[]) =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", path.join(projectRoot, "src", "index.ts"), "plan", "--root", dir, "--no-cache", "--plan", "Small=src/billing/invoice.ts", "--plan", "Both=src/billing/invoice.ts,src/billing/tax.ts", ...extra],
        { cwd: projectRoot, encoding: "utf8" },
      );
    assert.match(run(), /Recommended: Both \(score 3\.0\)/);
    const json = JSON.parse(run("--json")) as PlanScoreResult;
    assert.deepEqual(json.plans.map((p) => p.name), ["Both", "Small"]);
    assert.equal(json.recommendation.closeCall, true);
  });

  it("fails with a message when no plan is given", () => {
    const fails = (args: string[]) => {
      try {
        execFileSync(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "index.ts"), ...args], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return (e as { stderr: string }).stderr;
      }
      return assert.fail("expected a non-zero exit");
    };
    assert.match(fails(["plan", "--root", dir, "--no-cache"]), /plan needs at least one --plan/);
  });
});
