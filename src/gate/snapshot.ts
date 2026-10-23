import * as fs from "node:fs";
import * as path from "node:path";
import { git, headOf } from "../git/history";

export class GateError extends Error {}

export interface Snapshot {
  commit: string;
  tree: string;
}

export interface Change {
  status: "M" | "A" | "D";
  path: string;
}

/** `git commit-tree` refuses to run without an identity; the snapshot never needs the user's. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "RIA",
  GIT_AUTHOR_EMAIL: "ria@localhost",
  GIT_COMMITTER_NAME: "RIA",
  GIT_COMMITTER_EMAIL: "ria@localhost",
};

const RESTORE_BATCH = 100;

/** The empty tree exists in every SHA-1 repository without being stored. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const rawOptionsByRoot = new Map<string, string[]>();

/**
 * Options that make git hash and write files byte for byte: no CRLF conversion
 * and none of the filters a .gitattributes can switch on (text=auto, eol, LFS).
 * Without them a rollback could change the line endings of files it restores,
 * because git normalises on the way in and converts back on the way out.
 * `--attr-source` needs git 2.40; older versions still get the autocrlf part.
 */
function rawOptions(root: string): string[] {
  const known = rawOptionsByRoot.get(root);
  if (known) return known;
  const base = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
  const strict = [...base, "--attr-source", EMPTY_TREE];
  let chosen = base;
  try {
    git(root, [...strict, "rev-parse", "--git-dir"]);
    chosen = strict;
  } catch {
    // git too old for --attr-source
  }
  rawOptionsByRoot.set(root, chosen);
  return chosen;
}

export function requireGit(root: string): void {
  let inside = false;
  try {
    inside = git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    // not a repository
  }
  if (!inside) {
    throw new GateError(
      "The change gate needs a git repository: it records the working tree in git to tell what changed and to undo it.",
    );
  }
}

/**
 * Records the whole working tree (tracked, modified and untracked-but-not-ignored
 * files) as a commit, byte for byte, without touching the user's index, stash,
 * branches or files. The tree is built in a private index kept in `scratchDir`:
 * the first snapshot of a run hashes everything, later ones only what changed.
 * The user's own index is not used as a shortcut because it holds line-ending
 * normalised content. `ref` keeps the commit from being garbage collected.
 */
export function takeSnapshot(root: string, scratchDir: string, message: string, ref?: string): Snapshot {
  fs.mkdirSync(scratchDir, { recursive: true });
  // short names: git adds ".lock" to the index path, and deep repositories sit close to Windows' path limit
  const rawIndex = path.join(scratchDir, "raw.idx");
  const tmpIndex = path.join(scratchDir, `t${process.pid}.idx`);
  try {
    if (fs.existsSync(rawIndex)) fs.copyFileSync(rawIndex, tmpIndex);
    const env = { ...IDENTITY, GIT_INDEX_FILE: tmpIndex };
    git(root, [...rawOptions(root), "add", "-A"], env);
    fs.copyFileSync(tmpIndex, rawIndex);
    const tree = git(root, ["write-tree"], env).trim();
    const head = headOf(root);
    const args = ["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", message];
    if (head) args.push("-p", head);
    const commit = git(root, args, env).trim();
    if (ref) git(root, ["update-ref", ref, commit]);
    return { commit, tree };
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** Files that differ between two snapshots, relative to `root`. Renames show as a delete plus an add. */
export function diffSnapshots(root: string, from: Snapshot, to: Snapshot): Change[] {
  const raw = git(root, ["diff", "--name-status", "--no-renames", "--relative", "-z", from.commit, to.commit]);
  const parts = raw.split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    if (status === "M" || status === "A" || status === "D") changes.push({ status, path: parts[i + 1] });
    else if (status === "T") changes.push({ status: "M", path: parts[i + 1] });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function readAt(root: string, snapshot: Snapshot, file: string): string | null {
  try {
    return git(root, ["show", `${snapshot.commit}:${prefixOf(root)}${file}`]);
  } catch {
    return null;
  }
}

/** `root` may be a subdirectory of the repository; `git show` wants paths from the top. */
function prefixOf(root: string): string {
  return git(root, ["rev-parse", "--show-prefix"]).trim();
}

export function snapshotExists(root: string, snapshot: Snapshot): boolean {
  try {
    git(root, ["cat-file", "-e", `${snapshot.commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function dropRef(root: string, ref: string): void {
  try {
    git(root, ["update-ref", "-d", ref]);
  } catch {
    // already gone
  }
}

/**
 * Puts the files in `changes` back to how they were in `base`: modified and
 * deleted files are restored from the snapshot, files added since are removed.
 * Files outside `changes` are never touched, so work that was already uncommitted
 * when the baseline was taken stays exactly as it was.
 */
export function restoreChanges(root: string, base: Snapshot, changes: Change[]): void {
  const absRoot = path.resolve(root);
  const inside = (rel: string) => {
    const abs = path.resolve(absRoot, rel);
    return abs.startsWith(absRoot + path.sep) ? abs : undefined;
  };

  const restore = changes.filter((c) => c.status !== "A").map((c) => c.path);
  for (let i = 0; i < restore.length; i += RESTORE_BATCH) {
    const batch = restore.slice(i, i + RESTORE_BATCH);
    if (batch.some((p) => !inside(p))) throw new GateError("Refusing to restore a path outside the repository.");
    git(root, [...rawOptions(root), "restore", `--source=${base.commit}`, "--worktree", "--", ...batch]);
  }

  for (const c of changes) {
    if (c.status !== "A") continue;
    const abs = inside(c.path);
    if (!abs) throw new GateError("Refusing to delete a path outside the repository.");
    fs.rmSync(abs, { force: true });
    // drop directories the removed file leaves empty, but never the root itself
    for (let dir = path.dirname(abs); dir.startsWith(absRoot + path.sep); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
  }
}
