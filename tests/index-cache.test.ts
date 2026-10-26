import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, commit, git, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const repo = (files: Record<string, string>) => {
  const dir = makeRepo(files);
  dirs.push(dir);
  return dir;
};

describe("RepoIndex", () => {
  it("only re-reads files that changed, and picks up edits and deletions", async () => {
    const dir = repo({ "a.ts": `export const a = 1;\n`, "b.ts": `import "./a";\n` });
    const first = new RepoIndex(dir);
    assert.deepEqual(first.refresh(), { files: 2, reindexed: 2 });
    assert.deepEqual(first.refresh(), { files: 2, reindexed: 0 });

    // a new process starts warm from .ria/index.json
    const second = new RepoIndex(dir);
    assert.deepEqual(second.refresh(), { files: 2, reindexed: 0 });

    await new Promise((r) => setTimeout(r, 20));
    writeFiles(dir, { "a.ts": `export const a = 1;\nexport function more() {}\n` });
    assert.deepEqual(second.refresh().reindexed, 1);
    assert.ok(second.graph().symbols.has("more"));

    fs.rmSync(path.join(dir, "b.ts"));
    assert.equal(second.refresh().files, 1);
    assert.equal(second.graph().out.size, 0);
  });

  it("looks up git HEAD once per refresh, and sees new commits at the next refresh", () => {
    const dir = repo({ "a.ts": `export const a = 1;\n`, "b.ts": `export const b = 1;\n` });
    gitInit(dir);
    commit(dir, "initial");
    const index = new RepoIndex(dir, { cache: false });
    index.refresh();
    const first = index.history();
    assert.equal(first?.commits.length, 1);
    assert.equal(index.history(), first, "same history object while nothing was refreshed");

    commit(dir, "more", { "a.ts": `export const a = 2;\n`, "b.ts": `export const b = 2;\n` });
    assert.equal(index.history(), first, "a call sees the repository as of its refresh");
    index.refresh();
    assert.equal(index.history()?.commits.length, 2);
    assert.deepEqual(index.coChange("a.ts").map((c) => [c.path, c.support]), [["b.ts", 2]]);
  });

  it("keeps its cache directory out of git status", () => {
    const dir = repo({ "a.ts": `export const a = 1;\n` });
    gitInit(dir);
    commit(dir, "init");
    new RepoIndex(dir).refresh();
    assert.ok(fs.existsSync(path.join(dir, ".ria", "index.json")));
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  });

  it("writes nothing into the repository when caching is off", () => {
    const dir = repo({ "a.ts": `export const a = 1;\n` });
    const index = new RepoIndex(dir, { cache: false });
    assert.deepEqual(index.refresh(), { files: 1, reindexed: 1 });
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false);
  });

  it("skips dependencies, lockfiles and binary-looking files", () => {
    const dir = repo({
      "src/a.ts": `export const a = 1;\n`,
      "node_modules/dep/index.js": `module.exports = 1;\n`,
      "package-lock.json": `{}`,
      "logo.png": `not really a png`,
      "blob.dat": `abc\0def`,
    });
    const index = new RepoIndex(dir);
    index.refresh();
    assert.deepEqual([...index.files.keys()], ["src/a.ts"]);
  });

  it("honours .gitignore inside a git repo", () => {
    const dir = repo({ "src/a.ts": `export const a = 1;\n`, "generated/g.ts": `export const g = 1;\n`, ".gitignore": `generated/\n` });
    gitInit(dir);
    commit(dir, "init");
    const index = new RepoIndex(dir);
    index.refresh();
    assert.ok(index.files.has("src/a.ts"));
    assert.equal(index.files.has("generated/g.ts"), false);
  });

  it("walks a folder that a parent repository ignores completely", () => {
    const parent = repo({ ".gitignore": `vendored/\n`, "vendored/lib/a.ts": `export const a = 1;\n`, "vendored/lib/b.ts": `import "./a";\n` });
    gitInit(parent);
    commit(parent, "init");
    const index = new RepoIndex(path.join(parent, "vendored"), { cache: false });
    index.refresh();
    assert.deepEqual([...index.files.keys()].sort(), ["lib/a.ts", "lib/b.ts"]);
  });

  describe("resolve", () => {
    const dir = repo({
      "src/a/index.ts": `export function shared() {}\n`,
      "src/b/index.ts": `export function other() {}\nexport function shared() {}\n`,
      "src/unique.ts": `export class Widget {}\n`,
    });
    const index = new RepoIndex(dir);
    index.refresh();

    it("accepts exact paths, windows separators, absolute paths, suffixes and symbols", () => {
      assert.deepEqual(index.resolve("src/unique.ts"), { path: "src/unique.ts" });
      assert.deepEqual(index.resolve("src\\unique.ts"), { path: "src/unique.ts" });
      assert.deepEqual(index.resolve(path.join(dir, "src", "unique.ts")), { path: "src/unique.ts" });
      assert.deepEqual(index.resolve("unique.ts"), { path: "src/unique.ts" });
      assert.deepEqual(index.resolve("Widget"), { path: "src/unique.ts" });
      assert.deepEqual(index.resolve("other"), { path: "src/b/index.ts" });
    });

    it("reports ambiguity instead of guessing", () => {
      assert.deepEqual(index.resolve("index.ts"), { candidates: ["src/a/index.ts", "src/b/index.ts"] });
      assert.deepEqual(index.resolve("shared"), { candidates: ["src/a/index.ts", "src/b/index.ts"] });
    });

    it("never resolves outside the repository", () => {
      assert.deepEqual(index.resolve("../../etc/passwd"), { notFound: true });
      assert.deepEqual(index.resolve(path.resolve(dir, "..", "elsewhere.ts")), { notFound: true });
      assert.deepEqual(index.resolve("nothing-here"), { notFound: true });
    });
  });
});
