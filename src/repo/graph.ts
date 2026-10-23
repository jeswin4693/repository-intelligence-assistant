import * as path from "node:path";
import { Extracted } from "./extract";
import { Language } from "./languages";
import { ResolveEnv, resolveImport } from "./resolve";

export interface FileRecord extends Extracted {
  path: string;
  language: Language;
  size: number;
  mtimeMs: number;
  isTest: boolean;
}

export interface RepoGraph {
  files: Map<string, FileRecord>;
  /** file -> files it imports */
  out: Map<string, Set<string>>;
  /** file -> files that import it */
  inn: Map<string, Set<string>>;
  /** Relative imports that did not resolve to a repo file, per file. */
  unresolved: Map<string, string[]>;
  /** symbol name (bare and qualified) -> defining files */
  symbols: Map<string, string[]>;
}

function makeEnv(files: Map<string, FileRecord>): ResolveEnv {
  const byBase = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  const byNamespace = new Map<string, string[]>();
  const goModules: ResolveEnv["goModules"] = [];
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const rec of files.values()) {
    push(byBase, path.posix.basename(rec.path), rec.path);
    push(byDir, path.posix.dirname(rec.path), rec.path);
    for (const ns of rec.namespaces) push(byNamespace, ns, rec.path);
    if (rec.moduleName) goModules.push({ dir: path.posix.dirname(rec.path), module: rec.moduleName });
  }
  // longest module path first so nested modules win over their parents
  goModules.sort((a, b) => b.module.length - a.module.length);
  return {
    has: (f) => files.has(f),
    bySuffix: (suffix) =>
      (byBase.get(path.posix.basename(suffix)) ?? []).filter((f) => f === suffix || f.endsWith("/" + suffix)),
    dirFiles: (dir) => byDir.get(dir === "" ? "." : dir) ?? [],
    dirsBySuffix: (suffix) => [...byDir.keys()].filter((d) => d === suffix || d.endsWith("/" + suffix)),
    namespaceFiles: (ns) => byNamespace.get(ns) ?? [],
    goModules,
  };
}

export function buildGraph(files: Map<string, FileRecord>): RepoGraph {
  const env = makeEnv(files);
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const unresolved = new Map<string, string[]>();
  const symbols = new Map<string, string[]>();

  const link = (m: Map<string, Set<string>>, a: string, b: string) => {
    const set = m.get(a);
    if (set) set.add(b);
    else m.set(a, new Set([b]));
  };
  const own = (name: string, file: string) => {
    const list = symbols.get(name);
    if (!list) symbols.set(name, [file]);
    else if (!list.includes(file)) list.push(file);
  };

  for (const rec of files.values()) {
    for (const imp of rec.imports) {
      const res = resolveImport(rec.path, rec.language, imp, env);
      for (const target of res.targets) {
        if (target === rec.path) continue;
        link(out, rec.path, target);
        link(inn, target, rec.path);
      }
      if (!res.external && res.targets.length === 0) {
        const list = unresolved.get(rec.path);
        if (list) list.push(imp.spec);
        else unresolved.set(rec.path, [imp.spec]);
      }
    }
    for (const s of rec.symbols) {
      own(s.name, rec.path);
      const dot = s.name.lastIndexOf(".");
      if (dot > 0) own(s.name.slice(dot + 1), rec.path);
    }
  }
  return { files, out, inn, unresolved, symbols };
}

export interface Reach {
  distance: number;
  /** The node this one was reached from. */
  via: string;
}

/** Breadth-first reach from `starts` following imports (`out`) or importers (`in`). */
export function reach(graph: RepoGraph, starts: string[], direction: "out" | "in", maxDepth: number): Map<string, Reach> {
  const edges = direction === "out" ? graph.out : graph.inn;
  const seen = new Map<string, Reach>();
  const startSet = new Set(starts);
  let frontier = [...startSet];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const n of edges.get(node) ?? []) {
        if (startSet.has(n) || seen.has(n)) continue;
        seen.set(n, { distance: depth, via: node });
        next.push(n);
      }
    }
    frontier = next;
  }
  return seen;
}

export interface Hop {
  from: string;
  to: string;
  relation: "imports" | "imported by";
}

class MinHeap {
  private items: { key: string; cost: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(key: string, cost: number) {
    const a = this.items;
    a.push({ key, cost });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].cost <= a[i].cost) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): { key: string; cost: number } {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const FORWARD_COST = 1;
/** Walking against an import is allowed but slightly dearer, so forward chains win ties. */
const REVERSE_COST = 1.25;

/** Cheapest chain of import relationships between two files, or null if they are unconnected. */
export function shortestPath(graph: RepoGraph, from: string, to: string): Hop[] | null {
  if (from === to) return [];
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, Hop>();
  const heap = new MinHeap();
  heap.push(from, 0);
  while (heap.size) {
    const { key, cost } = heap.pop();
    if (cost > (dist.get(key) ?? Infinity)) continue;
    if (key === to) break;
    const relax = (n: string, step: number, relation: Hop["relation"]) => {
      const c = cost + step;
      if (c < (dist.get(n) ?? Infinity)) {
        dist.set(n, c);
        prev.set(n, { from: key, to: n, relation });
        heap.push(n, c);
      }
    };
    for (const n of graph.out.get(key) ?? []) relax(n, FORWARD_COST, "imports");
    for (const n of graph.inn.get(key) ?? []) relax(n, REVERSE_COST, "imported by");
  }
  if (!prev.has(to)) return null;
  const hops: Hop[] = [];
  for (let node = to; node !== from; ) {
    const hop = prev.get(node)!;
    hops.push(hop);
    node = hop.from;
  }
  return hops.reverse();
}
