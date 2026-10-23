import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { diffSnapshots, readAt, restoreChanges, takeSnapshot } from "../src/gate/snapshot";
import { cleanup, commit, git, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

function repo(files: Record<string, string>): string {
  const dir = makeRepo(files);
  dirs.push(dir);
  gitInit(dir);
  commit(dir, "initial");
  fs.mkdirSync(path.join(dir, ".ria"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".ria", ".gitignore"), "*\n");
  return dir;
}
const scratch = (dir: string) => path.join(dir, ".ria", "gate", "t");
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

describe("snapshots", () => {
  it("sees modified, added and deleted files, including untracked ones", () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "a.txt": "a2\n", "new/deep/d.txt": "d\n" });
    fs.rmSync(path.join(dir, "b.txt"));
    const now = takeSnapshot(dir, scratch(dir), "now");
    assert.deepEqual(diffSnapshots(dir, base, now), [
      { status: "M", path: "a.txt" },
      { status: "D", path: "b.txt" },
      { status: "A", path: "new/deep/d.txt" },
    ]);
  });

  it("does not disturb the index, the stash, branches or the files themselves", () => {
    const dir = repo({ "a.txt": "a\n" });
    writeFiles(dir, { "a.txt": "dirty\n", "untracked.txt": "u\n" });
    git(dir, "add", "a.txt");
    const before = [git(dir, "status", "--porcelain"), git(dir, "stash", "list"), git(dir, "branch", "--list"), git(dir, "rev-parse", "HEAD")];
    takeSnapshot(dir, scratch(dir), "base", "refs/ria/gate/t");
    const after = [git(dir, "status", "--porcelain"), git(dir, "stash", "list"), git(dir, "branch", "--list"), git(dir, "rev-parse", "HEAD")];
    assert.deepEqual(after, before);
    assert.equal(read(dir, "a.txt"), "dirty\n");
  });

  it("ignores .ria/ and anything .gitignore excludes", () => {
    const dir = repo({ ".gitignore": "dist/\n", "a.txt": "a\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "dist/out.js": "x", ".ria/gate/t/log.txt": "log", "b.txt": "b\n" });
    const now = takeSnapshot(dir, scratch(dir), "now");
    assert.deepEqual(diffSnapshots(dir, base, now), [{ status: "A", path: "b.txt" }]);
  });

  it("reads a file as it was at the snapshot", () => {
    const dir = repo({ "a.txt": "old\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "a.txt": "new\n" });
    assert.equal(readAt(dir, base, "a.txt"), "old\n");
    assert.equal(readAt(dir, base, "missing.txt"), null);
  });
});

describe("restoreChanges", () => {
  it("undoes edits, brings back deletions and removes additions with the directories they leave empty", () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "keep/k.txt": "k\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "a.txt": "changed\n", "new/deep/d.txt": "d\n", "keep/extra.txt": "e\n" });
    fs.rmSync(path.join(dir, "b.txt"));
    const changes = diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "now"));
    restoreChanges(dir, base, changes);

    assert.equal(read(dir, "a.txt"), "a\n");
    assert.equal(read(dir, "b.txt"), "b\n");
    assert.equal(fs.existsSync(path.join(dir, "new")), false, "empty directories are removed");
    assert.equal(fs.existsSync(path.join(dir, "keep", "extra.txt")), false);
    assert.equal(fs.existsSync(path.join(dir, "keep", "k.txt")), true, "a directory with other files stays");
    assert.deepEqual(diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "after")), []);
  });

  it("keeps work that was already uncommitted when the baseline was taken", () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    writeFiles(dir, { "a.txt": "my own unfinished edit\n", "mine.txt": "mine\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "b.txt": "ai edit\n", "ai-new.txt": "x\n" });
    restoreChanges(dir, base, diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "now")));

    assert.equal(read(dir, "a.txt"), "my own unfinished edit\n");
    assert.equal(read(dir, "mine.txt"), "mine\n");
    assert.equal(read(dir, "b.txt"), "b\n");
    assert.equal(fs.existsSync(path.join(dir, "ai-new.txt")), false);
  });

  it("does not stage anything", () => {
    const dir = repo({ "a.txt": "a\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    writeFiles(dir, { "a.txt": "x\n" });
    restoreChanges(dir, base, diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "now")));
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  });

  it("refuses paths that leave the repository", () => {
    const dir = repo({ "a.txt": "a\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    assert.throws(() => restoreChanges(dir, base, [{ status: "A", path: "../escape.txt" }]), /outside the repository/);
    assert.throws(() => restoreChanges(dir, base, [{ status: "M", path: "../escape.txt" }]), /outside the repository/);
  });
});

describe("line endings", () => {
  const settings: { name: string; autocrlf: string; attributes: string }[] = [
    { name: "core.autocrlf=true", autocrlf: "true", attributes: "" },
    { name: "core.autocrlf=input", autocrlf: "input", attributes: "" },
    { name: "core.autocrlf=false", autocrlf: "false", attributes: "" },
    { name: "a .gitattributes forcing eol=crlf", autocrlf: "false", attributes: "*.txt text eol=crlf\n" },
    { name: "a .gitattributes with text=auto", autocrlf: "true", attributes: "* text=auto\n" },
  ];

  for (const s of settings) {
    it(`a rollback restores files byte for byte under ${s.name}`, () => {
      const dir = makeRepo({});
      dirs.push(dir);
      gitInit(dir);
      git(dir, "config", "core.autocrlf", s.autocrlf);
      const crlf = Buffer.from("one\r\ntwo\r\n");
      const lf = Buffer.from("one\ntwo\n");
      const mixed = Buffer.from("one\r\ntwo\nthree\r\n");
      fs.writeFileSync(path.join(dir, "crlf.txt"), crlf);
      fs.writeFileSync(path.join(dir, "lf.txt"), lf);
      fs.writeFileSync(path.join(dir, "mixed.txt"), mixed);
      if (s.attributes) fs.writeFileSync(path.join(dir, ".gitattributes"), s.attributes);
      commit(dir, "initial");
      fs.mkdirSync(path.join(dir, ".ria"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".ria", ".gitignore"), "*\n");

      const statusBefore = git(dir, "status", "--porcelain");
      const base = takeSnapshot(dir, scratch(dir), "base");
      for (const f of ["crlf.txt", "lf.txt", "mixed.txt"]) fs.writeFileSync(path.join(dir, f), Buffer.from("rewritten\n"));
      const changes = diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "now"));
      assert.equal(changes.length, 3);
      restoreChanges(dir, base, changes);

      assert.deepEqual(fs.readFileSync(path.join(dir, "crlf.txt")), crlf);
      assert.deepEqual(fs.readFileSync(path.join(dir, "lf.txt")), lf);
      assert.deepEqual(fs.readFileSync(path.join(dir, "mixed.txt")), mixed);
      assert.equal(git(dir, "status", "--porcelain"), statusBefore, "git sees the same state as before the edit");
      assert.deepEqual(diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "after")), []);
    });
  }

  it("treats a change of line endings alone as a change", () => {
    const dir = repo({ "a.txt": "one\ntwo\n" });
    const base = takeSnapshot(dir, scratch(dir), "base");
    fs.writeFileSync(path.join(dir, "a.txt"), Buffer.from("one\r\ntwo\r\n"));
    assert.deepEqual(diffSnapshots(dir, base, takeSnapshot(dir, scratch(dir), "now")), [{ status: "M", path: "a.txt" }]);
  });
});

describe("a root below the top of the repository", () => {
  it("reports and restores only what is under the root, with root-relative paths", () => {
    const top = repo({ "app/x.txt": "x\n", "other/y.txt": "y\n" });
    const root = path.join(top, "app");
    fs.mkdirSync(path.join(root, ".ria"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ria", ".gitignore"), "*\n");
    const base = takeSnapshot(root, scratch(root), "base");
    writeFiles(top, { "app/x.txt": "x2\n", "other/y.txt": "y2\n", "app/z.txt": "z\n" });
    const changes = diffSnapshots(root, base, takeSnapshot(root, scratch(root), "now"));
    assert.deepEqual(changes, [
      { status: "M", path: "x.txt" },
      { status: "A", path: "z.txt" },
    ]);
    assert.equal(readAt(root, base, "x.txt"), "x\n");
    restoreChanges(root, base, changes);
    assert.equal(read(top, "app/x.txt"), "x\n");
    assert.equal(read(top, "other/y.txt"), "y2\n", "files outside the root are left alone");
  });
});
