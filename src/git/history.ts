import { execFileSync } from "node:child_process";

export interface History {
  head: string;
  /** File lists of the commits that were kept (bulk commits are dropped). */
  commits: string[][];
  /** file -> indexes into `commits` */
  byFile: Map<string, number[]>;
}

export interface CoChange {
  path: string;
  /** Commits that touched both files. */
  support: number;
  /** support / commits touching the queried file. */
  confidence: number;
}

export function git(root: string, args: string[], env?: Record<string, string>): string {
  try {
    // longpaths: deep folders (OneDrive, nested projects) pass Windows' 260-character limit once git adds lock files
    return execFileSync("git", ["-c", "core.quotepath=false", "-c", "core.longpaths=true", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (e) {
    // git explains itself on stderr; keep that in the error so failures are diagnosable
    const stderr = (e as { stderr?: { toString(): string } }).stderr?.toString().trim();
    if (stderr && e instanceof Error) e.message = `${e.message}\n${stderr}`;
    throw e;
  }
}

export function headOf(root: string): string | null {
  try {
    return git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

/**
 * Reads recent history. Commits touching more than `maxFilesPerCommit` files
 * (mass renames, formatting runs, vendor drops) are skipped because they link
 * unrelated files. Returns null outside a git repo or in one without commits.
 */
export function loadHistory(root: string, maxCommits = 1500, maxFilesPerCommit = 40): History | null {
  const head = headOf(root);
  if (!head) return null;
  let raw: string;
  try {
    raw = git(root, ["log", "--no-merges", "--name-only", "--relative", "-M", "-n", String(maxCommits), "--format=%x1e"]);
  } catch {
    return null;
  }
  const commits: string[][] = [];
  const byFile = new Map<string, number[]>();
  for (const chunk of raw.split("\x1e")) {
    const files = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (files.length === 0 || files.length > maxFilesPerCommit) continue;
    const idx = commits.push(files) - 1;
    for (const f of files) {
      const list = byFile.get(f);
      if (list) list.push(idx);
      else byFile.set(f, [idx]);
    }
  }
  return { head, commits, byFile };
}

export function coChangeFor(
  history: History,
  file: string,
  exists: (p: string) => boolean,
  minSupport = 2,
  limit = 10,
): CoChange[] {
  const mine = history.byFile.get(file);
  if (!mine || mine.length === 0) return [];
  const counts = new Map<string, number>();
  for (const ci of mine) {
    for (const f of history.commits[ci]) {
      if (f !== file) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  const out: CoChange[] = [];
  for (const [p, support] of counts) {
    if (support >= minSupport && exists(p)) out.push({ path: p, support, confidence: support / mine.length });
  }
  out.sort((a, b) => b.confidence - a.confidence || b.support - a.support || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}
