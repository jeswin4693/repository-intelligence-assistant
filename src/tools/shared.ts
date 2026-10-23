import * as path from "node:path";
import { SymbolInfo } from "../repo/extract";
import { FileRecord, RepoGraph } from "../repo/graph";
import { RepoIndex } from "../repo/repo-index";

export const approxTokens = (bytes: number) => Math.ceil(bytes / 4);

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A file's public symbols, top-level ones first. Class members only fill the
 * remaining room when `includeMethods` is set, so a file with a big class does
 * not drown out everything else it defines.
 */
export function pickSymbols(rec: FileRecord, limit: number, includeMethods = false): SymbolInfo[] {
  const pool = rec.symbols.filter((s) => s.exported);
  const top = pool.filter((s) => s.kind !== "method");
  const chosen = top.length === 0 || includeMethods ? [...top, ...pool.filter((s) => s.kind === "method")] : top;
  return chosen.slice(0, limit);
}

/** `function auth (L120)`; the line number lets a reader open just that part of a large file. */
export const fmtSymbol = (s: SymbolInfo, withLine = false) => `${s.kind} ${s.name}${withLine ? ` (L${s.line})` : ""}`;

export function previewSymbols(rec: FileRecord, limit: number, includeMethods = false, withLines = false): string[] {
  return pickSymbols(rec, limit, includeMethods).map((s) => fmtSymbol(s, withLines));
}

/** `foo.test.ts`, `test_foo.py`, `FooTests.cs`, `foo_test.go` -> `foo`. */
function stemOf(file: string): string {
  const base = path.posix.basename(file);
  const noExt = base.slice(0, base.length - path.posix.extname(base).length);
  return noExt
    .replace(/\.(test|spec)$/i, "")
    .replace(/^test_/i, "")
    .replace(/_(test|spec)$/i, "")
    .replace(/Tests?$/, "")
    .toLowerCase();
}

const GENERIC_STEMS = new Set(["index", "main", "mod", "__init__", "app", "utils", "util", "types", "lib"]);

export interface TestLink {
  path: string;
  why: string;
}

/** Tests tied to a file by naming convention or by importing it directly. */
export function testsFor(graph: RepoGraph, file: string): TestLink[] {
  const found = new Map<string, string>();
  const stem = stemOf(file);
  const dir = path.posix.dirname(file);
  for (const rec of graph.files.values()) {
    if (!rec.isTest || rec.path === file || stemOf(rec.path) !== stem) continue;
    if (!GENERIC_STEMS.has(stem) || path.posix.dirname(rec.path) === dir) found.set(rec.path, "named after it");
  }
  for (const importer of graph.inn.get(file) ?? []) {
    if (graph.files.get(importer)?.isTest && !found.has(importer)) found.set(importer, "imports it");
  }
  return [...found].map(([p, why]) => ({ path: p, why }));
}

/** Resolves a user-supplied file/symbol or returns a message the caller can show as-is. */
export function resolveOrExplain(index: RepoIndex, input: string): { path: string } | { error: string } {
  const t = index.resolve(input);
  if ("path" in t) return t;
  if ("candidates" in t) {
    const shown = t.candidates.slice(0, 8).map((c) => `  - ${c}`).join("\n");
    const more = t.candidates.length > 8 ? `\n  ... and ${t.candidates.length - 8} more` : "";
    return { error: `"${input}" is ambiguous. Use one of these paths:\n${shown}${more}` };
  }
  return { error: `"${input}" is not a file or symbol in the index. Paths are relative to ${index.root}.` };
}
