import * as fs from "node:fs";
import * as path from "node:path";
import { CoChange, History, coChangeFor, git, headOf, loadHistory } from "../git/history";
import { analyze } from "./extract";
import { FileRecord, RepoGraph, buildGraph } from "./graph";
import { WALK_SKIP_DIRS, isTestFile, languageOf, shouldIndex } from "./languages";
import { ensureRiaDir, riaDir } from "./ria-dir";

/** Bump when the shape or meaning of a FileRecord changes, so stale caches are dropped. */
const CACHE_SCHEMA = 3;
const MAX_FILE_BYTES = 1_000_000;

export type Target = { path: string } | { candidates: string[] } | { notFound: true };

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(e.name)) visit(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit(root, "");
  return out;
}

/**
 * Tracked and untracked-but-not-ignored files when git can say; a plain walk
 * otherwise, including when git reports nothing at all (a folder that a parent
 * repository ignores entirely, such as a vendored checkout).
 */
function listFiles(root: string): string[] {
  try {
    const raw = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
    const files = [...new Set(raw.split("\0").filter(Boolean))];
    if (files.length > 0) return files;
  } catch {
    // not a git repository
  }
  return walk(root);
}

export interface RepoIndexOptions {
  /** Persist the index under `.ria/` for fast restarts. Turn off for read-only or foreign checkouts. */
  cache?: boolean;
}

export class RepoIndex {
  readonly root: string;
  private records = new Map<string, FileRecord>();
  private version = 0;
  private graphCache?: { version: number; graph: RepoGraph };
  private historyCache: History | null = null;
  private readonly persist: boolean;

  constructor(root: string, options: RepoIndexOptions = {}) {
    this.root = path.resolve(root);
    this.persist = options.cache ?? true;
    if (this.persist) this.loadCache();
  }

  /** False when the index was opened with `cache: false`; features that must write to the repo check this. */
  get persists(): boolean {
    return this.persist;
  }

  private loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(riaDir(this.root), "index.json"), "utf8"));
      if (data?.schema !== CACHE_SCHEMA || !Array.isArray(data.records)) return;
      for (const r of data.records as FileRecord[]) {
        if (typeof r?.path === "string") this.records.set(r.path, r);
      }
    } catch {
      // no cache, or an unreadable one: start empty
    }
  }

  private saveCache() {
    try {
      const dir = ensureRiaDir(this.root);
      const tmp = path.join(dir, `index.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, records: [...this.records.values()] }));
      fs.renameSync(tmp, path.join(dir, "index.json"));
    } catch {
      // a read-only checkout still works, just without a warm start
    }
  }

  /** Re-reads only files whose size or mtime changed since they were last analysed. */
  refresh(): { files: number; reindexed: number } {
    const seen = new Set<string>();
    let reindexed = 0;
    for (const rel of listFiles(this.root)) {
      if (!shouldIndex(rel)) continue;
      const abs = path.join(this.root, rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // tracked but deleted in the working tree
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      seen.add(rel);
      const prev = this.records.get(rel);
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) {
        seen.delete(rel);
        continue;
      }
      this.records.set(rel, {
        path: rel,
        language: languageOf(rel),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isTest: isTestFile(rel),
        ...analyze(rel, text),
      });
      reindexed++;
    }
    let removed = 0;
    for (const key of [...this.records.keys()]) {
      if (!seen.has(key)) {
        this.records.delete(key);
        removed++;
      }
    }
    if (reindexed || removed) {
      this.version++;
      if (this.persist) this.saveCache();
    }
    return { files: this.records.size, reindexed };
  }

  get files(): Map<string, FileRecord> {
    return this.records;
  }

  graph(): RepoGraph {
    if (!this.graphCache || this.graphCache.version !== this.version) {
      this.graphCache = { version: this.version, graph: buildGraph(this.records) };
    }
    return this.graphCache.graph;
  }

  /** Null outside a git repository, or in one with no commits. */
  history(): History | null {
    const head = headOf(this.root);
    if (!head) return null;
    if (this.historyCache?.head !== head) this.historyCache = loadHistory(this.root);
    return this.historyCache;
  }

  coChange(file: string, minSupport = 2, limit = 10): CoChange[] {
    const h = this.history();
    return h ? coChangeFor(h, file, (p) => this.records.has(p), minSupport, limit) : [];
  }

  /**
   * Turns whatever the caller typed into an indexed file: an exact or absolute
   * path, a unique path suffix (`graph.ts`), or a symbol name. Lookups only ever
   * hit the index, so a crafted path cannot reach outside the repo.
   */
  resolve(input: string): Target {
    let norm = input.trim().replace(/\\/g, "/");
    if (path.isAbsolute(input.trim())) {
      const rel = path.relative(this.root, input.trim()).replace(/\\/g, "/");
      if (rel.startsWith("..")) return { notFound: true };
      norm = rel;
    }
    norm = norm.replace(/^\.\//, "");
    if (this.records.has(norm)) return { path: norm };

    const keys = [...this.records.keys()];
    const lower = norm.toLowerCase();
    const bySuffix = keys.filter((f) => f.endsWith("/" + norm) || f.toLowerCase() === lower);
    if (bySuffix.length === 1) return { path: bySuffix[0] };
    if (bySuffix.length > 1) return { candidates: bySuffix.sort() };

    const owners = this.graph().symbols.get(norm);
    if (owners?.length === 1) return { path: owners[0] };
    if (owners && owners.length > 1) return { candidates: [...owners].sort() };
    return { notFound: true };
  }
}
