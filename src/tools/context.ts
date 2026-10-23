import * as path from "node:path";
import { SymbolInfo } from "../repo/extract";
import { FileRecord, reach } from "../repo/graph";
import { RepoIndex } from "../repo/repo-index";
import { approxTokens, fmtSymbol, pct, pickSymbols, resolveOrExplain, testsFor } from "./shared";

export interface ContextOptions {
  target?: string;
  query?: string;
  maxFiles?: number;
  maxTokens?: number;
  includeTests?: boolean;
}

export interface ContextItem {
  path: string;
  score: number;
  roles: string[];
  reasons: string[];
  symbols: string[];
  lines: number;
  tokens: number;
}

export interface ContextResult {
  items: ContextItem[];
  notes: string[];
  truncated: boolean;
  totalTokens: number;
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "how", "what", "where", "when",
  "why", "does", "not", "are", "can", "should", "would", "could", "have", "has", "was", "were",
  "there", "their", "them", "then", "than", "will", "all", "any", "some", "also",
]);

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Equal, or one is a prefix of the other ("auth" ~ "authentication"). */
function tokenMatch(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

const hits = (query: string, candidates: Iterable<string>) => {
  let n = 0;
  for (const c of candidates) if (tokenMatch(query, c)) n++;
  return n;
};

/** Test files match query words less strongly than the code they cover. */
const TEST_DISCOUNT = 0.7;

interface QueryScore {
  score: number;
  /** Symbols whose names matched, with how many query words each matched. */
  symbols: Map<SymbolInfo, number>;
}

/** Scores files against query words by path and symbol names, weighting rare words higher. */
function scoreQuery(files: Iterable<FileRecord>, words: string[]): Map<string, QueryScore> {
  const profiles = [...files].map((rec) => {
    const syms = rec.symbols.slice(0, 200);
    return {
      path: rec.path,
      name: tokenize(path.posix.basename(rec.path, path.posix.extname(rec.path))),
      dir: tokenize(path.posix.dirname(rec.path)),
      syms,
      symTokens: syms.map((s) => tokenize(s.name)),
      weight: rec.isTest ? TEST_DISCOUNT : 1,
    };
  });
  const out = new Map<string, QueryScore>();
  for (const w of words) {
    const matches = profiles.map((p) => ({
      p,
      name: hits(w, p.name) > 0,
      dir: hits(w, p.dir) > 0,
      syms: p.syms.filter((_, i) => hits(w, p.symTokens[i]) > 0),
    }));
    const df = matches.filter((m) => m.name || m.dir || m.syms.length > 0).length;
    const idf = Math.log(1 + profiles.length / (1 + df));
    for (const m of matches) {
      const s = m.p.weight * idf * ((m.name ? 3 : 0) + (m.dir ? 1.5 : 0) + Math.min(m.syms.length, 3));
      if (s <= 0) continue;
      const entry = out.get(m.p.path) ?? { score: 0, symbols: new Map<SymbolInfo, number>() };
      entry.score += s;
      for (const sym of m.syms) entry.symbols.set(sym, (entry.symbols.get(sym) ?? 0) + 1);
      out.set(m.p.path, entry);
    }
  }
  return out;
}

interface Entry {
  /**
   * Each seed contributes its strongest link to the file once. Summing every
   * relationship would count one seed several times (a test is often both a
   * dependent and "the test for" the same file) and lift it above its own subject.
   */
  perSeed: Map<string, number>;
  roles: Set<string>;
  reasons: { text: string; score: number }[];
}

const totalScore = (e: Entry) => [...e.perSeed.values()].reduce((a, b) => a + b, 0);

export function contextFor(index: RepoIndex, opts: ContextOptions): ContextResult | { error: string } {
  const maxFiles = opts.maxFiles ?? 12;
  const maxTokens = opts.maxTokens ?? 8000;
  const includeTests = opts.includeTests ?? true;
  const graph = index.graph();
  const notes: string[] = [];
  const seeds = new Map<string, number>();

  const entries = new Map<string, Entry>();
  const add = (p: string, seed: string, score: number, role: string, reason: string) => {
    const e = entries.get(p) ?? { perSeed: new Map<string, number>(), roles: new Set<string>(), reasons: [] };
    e.perSeed.set(seed, Math.max(e.perSeed.get(seed) ?? 0, score));
    e.roles.add(role);
    e.reasons.push({ text: reason, score });
    entries.set(p, e);
  };

  let targetPath: string | undefined;
  if (opts.target) {
    const t = resolveOrExplain(index, opts.target);
    if ("error" in t) return t;
    targetPath = t.path;
    seeds.set(t.path, 1);
    add(t.path, t.path, 1, "target", "requested");
  }

  const matchedSymbols = new Map<string, SymbolInfo[]>();
  if (opts.query) {
    const words = [...new Set(tokenize(opts.query))];
    if (words.length === 0) notes.push("The query had no usable words after dropping short and filler words.");
    const scored = scoreQuery(graph.files.values(), words);
    const top = [...scored].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
    const best = top[0]?.[1].score ?? 0;
    for (const [p, s] of top) {
      const w = 0.5 + 0.5 * (s.score / best);
      if (!seeds.has(p)) seeds.set(p, w);
      add(p, p, w, "match", `path/symbol names match "${words.join(" ")}"`);
      matchedSymbols.set(p, [...s.symbols].sort((a, b) => b[1] - a[1] || a[0].line - b[0].line).map(([sym]) => sym));
    }
    if (top.length === 0) notes.push(`No file path or symbol name matches "${opts.query}". Search file contents with grep instead.`);
    else notes.push("Query matching uses file paths and symbol names, not file contents.");
  }

  if (seeds.size === 0) return { items: [], notes, truncated: false, totalTokens: 0 };

  for (const [seed, w] of seeds) {
    for (const [p, r] of reach(graph, [seed], "out", 2)) {
      add(p, seed, w * 0.6 ** r.distance, "dependency", r.distance === 1 ? `imported by ${seed}` : `${r.distance} hops from ${seed} (via ${r.via})`);
    }
    for (const [p, r] of reach(graph, [seed], "in", 2)) {
      add(p, seed, w * 0.5 ** r.distance, "dependent", r.distance === 1 ? `imports ${seed}` : `${r.distance} hops to ${seed} (via ${r.via})`);
    }
    for (const c of index.coChange(seed)) {
      if (c.confidence >= 0.3) add(c.path, seed, w * 0.8 * c.confidence, "co-change", `changed with ${seed} in ${pct(c.confidence)} of its commits (${c.support})`);
    }
    if (includeTests) {
      for (const t of testsFor(graph, seed)) add(t.path, seed, w * 0.45, "test", `test for ${seed} (${t.why})`);
    }
  }

  const ranked = [...entries].sort((a, b) => {
    const seedDiff = Number(seeds.has(b[0])) - Number(seeds.has(a[0]));
    return seedDiff || totalScore(b[1]) - totalScore(a[1]) || a[0].localeCompare(b[0]);
  });

  const items: ContextItem[] = [];
  let total = 0;
  let truncated = false;
  for (const [p, e] of ranked) {
    const rec = graph.files.get(p);
    if (!rec) continue;
    const tokens = approxTokens(rec.size);
    // The budget binds everything except what was asked for by name, and the
    // single best file when nothing else fits, so the answer is never empty.
    const mustInclude = p === targetPath || items.length === 0;
    if (!mustInclude && (items.length >= maxFiles || total + tokens > maxTokens)) {
      truncated = true;
      continue;
    }
    if (mustInclude && total + tokens > maxTokens) {
      notes.push(`${p} alone is ~${tokens} tokens, over the ${maxTokens} budget, so it is included anyway; use its symbol line numbers to read only the part you need.`);
    }
    total += tokens;
    const matched = (matchedSymbols.get(p) ?? []).slice(0, 5);
    const rest = pickSymbols(rec, 8).filter((s) => !matched.includes(s));
    items.push({
      path: p,
      score: Math.round(totalScore(e) * 100) / 100,
      roles: [...e.roles],
      reasons: [...new Set(e.reasons.sort((a, b) => b.score - a.score).map((r) => r.text))].slice(0, 3),
      symbols: [...matched, ...rest].slice(0, 8).map((s) => fmtSymbol(s, true)),
      lines: rec.lines,
      tokens,
    });
  }
  return { items, notes, truncated, totalTokens: total };
}

export function formatContext(r: ContextResult, label: string, maxTokens: number): string {
  if (r.items.length === 0) return [`No context found for ${label}.`, ...r.notes].join("\n");
  const lines = [`Context for ${label}: ${r.items.length} files, ~${r.totalTokens} tokens (budget ${maxTokens})${r.truncated ? ", more omitted by budget" : ""}`];
  r.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.path}  [${it.roles.join(", ")}]  score ${it.score}  ${it.lines} lines, ~${it.tokens} tok`);
    for (const reason of it.reasons) lines.push(`     - ${reason}`);
    if (it.symbols.length) lines.push(`     symbols: ${it.symbols.join(", ")}`);
  });
  for (const n of r.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}
