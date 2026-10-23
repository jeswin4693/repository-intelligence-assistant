import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RepoIndex } from "../src/repo/repo-index";
import { contextFor, formatContext, tokenize } from "../src/tools/context";
import { findPath, formatPath } from "../src/tools/find-path";
import { formatImpact, impact } from "../src/tools/impact";
import { repoMap } from "../src/tools/repo-map";
import { cleanup, commit, gitInit, makeRepo } from "./helpers";

let dir: string;
let index: RepoIndex;

before(() => {
  dir = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", main: "src/index.ts", scripts: { start: "tsx src/index.ts" } }),
    "src/index.ts": `import { createInvoice } from "./billing/invoice";\nimport { findUser } from "./users/user";\ncreateInvoice(findUser("x"));\n`,
    "src/billing/invoice.ts": `import { audit } from "../audit";\nexport function createInvoice(u: unknown) { audit(u); }\n`,
    "src/billing/tax.ts": `export function taxFor(n: number) { return n * 0.2; }\n`,
    "src/users/user.ts": `export function findUser(id: string) { return id; }\n`,
    "src/audit.ts": `export function audit(x: unknown) { return x; }\n`,
    "src/legacy.ts": `export const LEGACY = 1;\n`,
    "tests/invoice.test.ts": `import { createInvoice } from "../src/billing/invoice";\n`,
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

describe("tokenize", () => {
  it("splits camelCase and snake_case, drops filler and short words", () => {
    assert.deepEqual(tokenize("How does createInvoice handle the tax_rate?"), ["create", "invoice", "handle", "tax", "rate"]);
  });
});

describe("impact", () => {
  it("lists dependents, hidden coupling from git history, tests and public surface", () => {
    const r = impact(index, { files: ["src/billing/invoice.ts"] });
    assert.ok(!("error" in r));
    assert.deepEqual(r.dependents.map((d) => [d.path, d.distance]), [["src/index.ts", 1], ["tests/invoice.test.ts", 1]]);
    assert.equal(r.hiddenCoupling[0].path, "src/billing/tax.ts");
    assert.equal(r.hiddenCoupling[0].support, 3);
    assert.equal(r.testCoverage, "direct");
    assert.deepEqual(r.tests.map((t) => t.path), ["tests/invoice.test.ts"]);
    assert.deepEqual(r.publicSurface[0].symbols, ["function createInvoice (L2)"]);
    assert.equal(r.risk.level, "low");
  });

  it("counts a test that only reaches the file through another file as transitive coverage", () => {
    const r = impact(index, { files: ["src/audit.ts"] });
    assert.ok(!("error" in r));
    assert.equal(r.testCoverage, "transitive");
    assert.deepEqual(r.dependents.map((d) => [d.path, d.distance]), [["src/billing/invoice.ts", 1], ["src/index.ts", 2], ["tests/invoice.test.ts", 2]]);
    assert.match(r.tests[0].why, /reaches it through src\/billing\/invoice\.ts/);
    assert.match(r.risk.reasons.join("\n"), /2 non-test file\(s\) depend on it/);
  });

  it("flags files nothing ties to a test", () => {
    const r = impact(index, { files: ["src/legacy.ts"] });
    assert.ok(!("error" in r));
    assert.equal(r.testCoverage, "none");
    assert.match(r.risk.reasons.join("\n"), /no test is tied to it/);
  });

  it("always says how far to trust the result", () => {
    const r = impact(index, { files: ["src/audit.ts"] });
    assert.ok(!("error" in r));
    assert.ok(["high", "medium", "low"].includes(r.confidence.level));
    assert.match(r.confidence.caveats.join(" "), /commits of history/);
  });

  it("accepts several files and reports unknown ones without failing", () => {
    const r = impact(index, { files: ["src/audit.ts", "src/nope.ts"] });
    assert.ok(!("error" in r));
    assert.deepEqual(r.targets, ["src/audit.ts"]);
    assert.match(r.notes.join(""), /nope\.ts/);
  });

  it("errors clearly when nothing resolves", () => {
    const r = impact(index, { files: ["src/nope.ts"] });
    assert.ok("error" in r);
    assert.match(r.error, /not a file or symbol/);
  });

  it("formats a readable report", () => {
    const r = impact(index, { files: ["src/billing/invoice.ts"] });
    assert.ok(!("error" in r));
    const text = formatImpact(r, 3);
    assert.match(text, /^Impact of changing src\/billing\/invoice\.ts/);
    assert.match(text, /Hidden coupling/);
    assert.match(text, /src\/billing\/tax\.ts/);
    assert.match(text, /Confidence:/);
  });
});

describe("impact on a widely tested file", () => {
  it("counts the tests and shows where they are concentrated instead of only truncating", () => {
    const files: Record<string, string> = { "src/core.ts": `export const core = 1;\n` };
    for (let i = 0; i < 20; i++) files[`tests/auth/a${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    for (let i = 0; i < 12; i++) files[`tests/billing/b${i}.spec.ts`] = `import { core } from "../../src/core";\n`;
    const dir2 = makeRepo(files);
    try {
      const i2 = new RepoIndex(dir2, { cache: false });
      i2.refresh();
      const r = impact(i2, { files: ["src/core.ts"] });
      assert.ok(!("error" in r));
      assert.equal(r.tests.length, 32);
      const text = formatImpact(r, 3);
      assert.match(text, /Tests \(direct, 32\):/);
      assert.match(text, /concentrated in: tests\/auth \(20\), tests\/billing \(12\)/);
      assert.match(text, /\.\.\. and 7 more/);
    } finally {
      cleanup(dir2);
    }
  });
});

describe("findPath", () => {
  it("follows imports forward", () => {
    const r = findPath(index, "src/index.ts", "src/audit.ts");
    assert.ok(!("error" in r));
    assert.deepEqual(r.hops?.map((h) => h.to), ["src/billing/invoice.ts", "src/audit.ts"]);
    assert.match(formatPath(r), /src\/index\.ts depends on src\/audit\.ts/);
  });

  it("walks against imports when needed", () => {
    const r = findPath(index, "src/audit.ts", "src/users/user.ts");
    assert.ok(!("error" in r));
    // audit <- invoice <- index -> user
    assert.deepEqual(r.hops?.map((h) => h.relation), ["imported by", "imported by", "imports"]);
    assert.match(formatPath(r), /Direction: mixed/);
  });

  it("accepts symbol names", () => {
    const r = findPath(index, "createInvoice", "audit");
    assert.ok(!("error" in r));
    assert.equal(r.hops?.length, 1);
  });

  it("falls back to co-change evidence when no import chain exists", () => {
    const r = findPath(index, "src/billing/invoice.ts", "src/billing/tax.ts");
    assert.ok(!("error" in r));
    assert.equal(r.hops, null);
    assert.equal(r.coChange?.support, 3);
    assert.match(formatPath(r), /do change together/);
  });

  it("explains unknown names", () => {
    const r = findPath(index, "src/index.ts", "ghost.ts");
    assert.ok("error" in r);
  });
});

describe("contextFor", () => {
  it("centres on a target and explains each file", () => {
    const r = contextFor(index, { target: "src/billing/invoice.ts" });
    assert.ok(!("error" in r));
    const byPath = new Map(r.items.map((i) => [i.path, i]));
    assert.equal(r.items[0].path, "src/billing/invoice.ts");
    assert.ok(byPath.get("src/audit.ts")?.roles.includes("dependency"));
    assert.ok(byPath.get("src/index.ts")?.roles.includes("dependent"));
    assert.ok(byPath.get("tests/invoice.test.ts")?.roles.includes("test"));
    assert.ok(byPath.get("src/billing/tax.ts")?.roles.includes("co-change"));
    assert.equal(byPath.has("src/legacy.ts"), false, "unrelated files stay out");
  });

  it("finds files for a task described in words, via names and symbols", () => {
    const r = contextFor(index, { query: "create an invoice" });
    assert.ok(!("error" in r));
    assert.equal(r.items[0].path, "src/billing/invoice.ts");
    assert.match(formatContext(r, "q", 8000), /not file contents/);
  });

  it("can leave tests out", () => {
    const r = contextFor(index, { target: "src/billing/invoice.ts", includeTests: false });
    assert.ok(!("error" in r));
    assert.equal(r.items.some((i) => i.roles.includes("test")), false);
  });

  it("shows the symbols that matched the query first, with line numbers", () => {
    const r = contextFor(index, { query: "create invoice" });
    assert.ok(!("error" in r));
    assert.equal(r.items[0].symbols[0], "function createInvoice (L2)");
  });

  it("honours the file budget", () => {
    const r = contextFor(index, { target: "src/billing/invoice.ts", maxFiles: 2 });
    assert.ok(!("error" in r));
    assert.equal(r.items.length, 2);
    assert.equal(r.truncated, true);
  });

  it("keeps the requested target even when it alone exceeds the token budget, and says so", () => {
    const r = contextFor(index, { target: "src/billing/invoice.ts", maxTokens: 1 });
    assert.ok(!("error" in r));
    assert.deepEqual(r.items.map((i) => i.path), ["src/billing/invoice.ts"]);
    assert.match(r.notes.join(" "), /alone is ~\d+ tokens, over the 1 budget/);
  });

  it("applies the token budget to query matches too", () => {
    // invoice.ts is ~26 tokens and its test ~14: both match "invoice", only one fits in 30
    const r = contextFor(index, { query: "invoice", maxTokens: 30 });
    assert.ok(!("error" in r));
    assert.ok(r.totalTokens <= 30, `used ${r.totalTokens}`);
    assert.equal(r.truncated, true);
    assert.equal(r.items[0].path, "src/billing/invoice.ts");
  });

  it("still returns the best match when nothing fits the budget", () => {
    const r = contextFor(index, { query: "invoice", maxTokens: 1 });
    assert.ok(!("error" in r));
    assert.equal(r.items.length, 1);
    assert.match(r.notes.join(" "), /over the 1 budget/);
  });

  it("says so when nothing matches", () => {
    const r = contextFor(index, { query: "zzzxqj" });
    assert.ok(!("error" in r));
    assert.equal(r.items.length, 0);
    assert.match(formatContext(r, "q", 8000), /grep/);
  });
});

describe("repoMap", () => {
  it("summarises languages, entry points, structure and key files", () => {
    const text = repoMap(index, {});
    assert.match(text, /Files: \d+ indexed/);
    assert.match(text, /typescript/);
    assert.match(text, /src\/index\.ts {2}\(package\.json main\)/);
    assert.match(text, /billing\/ {2}\(2\)/);
    assert.match(text, /src\/audit\.ts {2}\(typescript, 1 lines, imported by 1, imports 0\)/);
    assert.match(text, /Git history: 4 commits indexed/);
  });

  it("does not guess data files as entry points", () => {
    const dir2 = makeRepo({ "index.json": `{}`, "data/index.json": `{}`, "src/main.ts": `export const x = 1;\n` });
    try {
      const i2 = new RepoIndex(dir2, { cache: false });
      i2.refresh();
      const text = repoMap(i2, {});
      assert.match(text, /src\/main\.ts {2}\(by name\)/);
      assert.doesNotMatch(text, /index\.json {2}\(by name\)/);
    } finally {
      cleanup(dir2);
    }
  });

  it("can focus on a directory and respects the budget", () => {
    const focused = repoMap(index, { focus: "src/billing" });
    assert.match(focused, /focus: src\/billing\//);
    assert.doesNotMatch(focused, /src\/users\/user\.ts/);
    const tight = repoMap(index, { maxTokens: 100 });
    assert.match(tight, /omitted by the token budget/);
  });

  it("says when a focus matches nothing", () => {
    assert.match(repoMap(index, { focus: "nope" }), /No indexed files under "nope"/);
  });
});
