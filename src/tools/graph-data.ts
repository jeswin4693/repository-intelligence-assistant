import * as path from "node:path";
import { RepoIndex } from "../repo/repo-index";

/** [kind, name, line, exported (0 or 1)] */
export type GraphSymbol = [string, string, number, number];

export interface GraphNode {
  path: string;
  lang: string;
  lines: number;
  test: boolean;
  /** The file's symbols in file order; spread over the whole file when there are more than the cap. */
  syms: GraphSymbol[];
  /** Symbols of the file that are not in `syms`. */
  moreSyms: number;
  /** Relative imports that did not resolve to a file of the repository. */
  gaps: string[];
}

export interface GraphData {
  repo: string;
  /** Commits the co-change history was read from; null outside git. */
  commits: number | null;
  stats: { files: number; lines: number; symbols: number; links: number; unresolved: number; languages: [string, number][] };
  nodes: GraphNode[];
  /** [importer, imported] as indexes into `nodes`. */
  links: [number, number][];
  /** Files that change together in git without importing each other: [a, b, commits touching both, confidence in percent]. */
  co: [number, number, number, number][];
  notes: string[];
}

export interface GraphOptions {
  /** Only the files under this folder. */
  focus?: string;
  /** Symbols kept per file. Default: 150, fewer when the repository is big, so the page stays a few megabytes. */
  maxSymbolsPerFile?: number;
  /** Read the git history for files that change together. Default true. */
  coChange?: boolean;
}

const SYMBOL_BUDGET = 60_000;
const MAX_CO_LINKS = 4_000;
const MAX_GAPS_PER_FILE = 12;

/** `n` items spread evenly over the list, so a long file is covered from top to bottom and not only at its start. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}

/** What the graph page draws, from the index: files, who imports whom, each file's symbols, and what changes together. */
export function buildGraphData(index: RepoIndex, opts: GraphOptions = {}): GraphData | { error: string } {
  const graph = index.graph();
  const focus = (opts.focus ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const all = [...graph.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const files = focus ? all.filter((f) => f.path === focus || f.path.startsWith(`${focus}/`)) : all;
  if (files.length === 0) return { error: focus ? `No indexed file under "${focus}".` : "No files were indexed." };

  const at = new Map(files.map((f, i) => [f.path, i]));
  const perFile = opts.maxSymbolsPerFile ?? Math.max(20, Math.min(150, Math.floor(SYMBOL_BUDGET / files.length)));
  const notes: string[] = [];

  let symbols = 0;
  let unresolved = 0;
  const languages = new Map<string, number>();
  const nodes: GraphNode[] = files.map((f) => {
    const kept = spread(f.symbols, perFile);
    const gaps = graph.unresolved.get(f.path) ?? [];
    symbols += f.symbols.length;
    unresolved += gaps.length;
    languages.set(f.language, (languages.get(f.language) ?? 0) + 1);
    return {
      path: f.path,
      lang: f.language,
      lines: f.lines,
      test: f.isTest,
      syms: kept.map((s): GraphSymbol => [s.kind, s.name, s.line, s.exported ? 1 : 0]),
      moreSyms: f.symbols.length - kept.length,
      gaps: gaps.slice(0, MAX_GAPS_PER_FILE),
    };
  });
  if (nodes.some((n) => n.moreSyms > 0)) notes.push(`Files with more than ${perFile} symbols show an even sample of them (the count of the rest is given).`);

  const links: [number, number][] = [];
  const linked = new Set<string>();
  for (const [file, i] of at) {
    for (const target of graph.out.get(file) ?? []) {
      const j = at.get(target);
      if (j === undefined) continue;
      links.push([i, j]);
      linked.add(`${Math.min(i, j)}:${Math.max(i, j)}`);
    }
  }

  const co: [number, number, number, number][] = [];
  const history = opts.coChange === false ? null : index.history();
  if (history) {
    const seen = new Set<string>();
    for (const [file, i] of at) {
      for (const c of index.coChange(file, 3, 4)) {
        const j = at.get(c.path);
        if (j === undefined || c.confidence < 0.5) continue;
        // documents and configuration change with everything (a README in nearly every commit): drawn, they would join the
        // whole picture to one file and hide the coupling between pieces of code, which is what this shows
        if (files[i].language === "other" || files[j].language === "other") continue;
        const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
        // a pair that imports each other is already an arrow: only the coupling that no import explains is new information
        if (linked.has(key) || seen.has(key) || co.length >= MAX_CO_LINKS) continue;
        seen.add(key);
        co.push([i, j, c.support, Math.round(c.confidence * 100)]);
      }
    }
  } else if (opts.coChange !== false) {
    notes.push("No git history was found, so files that change together are not shown.");
  }

  return {
    repo: path.basename(index.root),
    commits: history ? history.commits.length : null,
    stats: {
      files: files.length,
      lines: files.reduce((n, f) => n + f.lines, 0),
      symbols,
      links: links.length,
      unresolved,
      languages: [...languages].sort((a, b) => b[1] - a[1]),
    },
    nodes,
    links,
    co,
    notes,
  };
}
