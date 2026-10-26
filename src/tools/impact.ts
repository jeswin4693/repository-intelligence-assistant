import * as path from "node:path";
import { reach } from "../repo/graph";
import { RepoIndex } from "../repo/repo-index";
import { byDirectory, pct, plural, previewSymbols, resolveOrExplain, testsFor } from "./shared";

export interface ImpactOptions {
  files: string[];
  depth?: number;
}

export interface Dependent {
  path: string;
  distance: number;
  via: string;
  isTest: boolean;
}

export interface ImpactResult {
  targets: string[];
  dependents: Dependent[];
  hiddenCoupling: { path: string; support: number; confidence: number; of: string }[];
  tests: { path: string; why: string }[];
  testCoverage: "direct" | "transitive" | "none";
  publicSurface: { file: string; symbols: string[] }[];
  risk: { level: "low" | "medium" | "high"; score: number; reasons: string[] };
  confidence: { level: "high" | "medium" | "low"; caveats: string[] };
  notes: string[];
}

/** Co-changing files weaker than this are coincidence more often than coupling. */
export const MIN_COUPLING = 0.3;
export const STRONG_COUPLING = 0.5;

export function impact(index: RepoIndex, opts: ImpactOptions): ImpactResult | { error: string } {
  const depth = opts.depth ?? 3;
  const graph = index.graph();
  const notes: string[] = [];
  const targets: string[] = [];
  for (const f of opts.files) {
    const t = resolveOrExplain(index, f);
    if ("error" in t) {
      if (opts.files.length === 1) return t;
      notes.push(t.error);
    } else if (!targets.includes(t.path)) {
      targets.push(t.path);
    }
  }
  if (targets.length === 0) return { error: notes.join("\n") || "No files given." };

  const reached = reach(graph, targets, "in", depth);
  const dependents: Dependent[] = [...reached]
    .map(([p, r]) => ({ path: p, distance: r.distance, via: r.via, isTest: graph.files.get(p)?.isTest ?? false }))
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));

  const tests = new Map<string, string>();
  for (const t of targets) for (const l of testsFor(graph, t)) tests.set(l.path, l.why);
  const directTests = tests.size;
  for (const d of dependents) {
    if (d.isTest && !tests.has(d.path)) tests.set(d.path, `reaches it through ${d.via} (${d.distance} hops)`);
  }
  const testCoverage = directTests > 0 ? "direct" : tests.size > 0 ? "transitive" : "none";

  const hidden = new Map<string, { path: string; support: number; confidence: number; of: string }>();
  for (const t of targets) {
    for (const c of index.coChange(t)) {
      if (c.confidence < MIN_COUPLING || targets.includes(c.path) || reached.has(c.path)) continue;
      const prev = hidden.get(c.path);
      if (!prev || c.confidence > prev.confidence) hidden.set(c.path, { ...c, of: t });
    }
  }
  const hiddenCoupling = [...hidden.values()].sort((a, b) => b.confidence - a.confidence);

  const publicSurface = targets
    .map((file) => ({ file, symbols: previewSymbols(graph.files.get(file)!, 12, true, true) }))
    .filter((s) => s.symbols.length > 0);

  const nonTest = dependents.filter((d) => !d.isTest).length;
  const strong = hiddenCoupling.filter((h) => h.confidence >= STRONG_COUPLING).length;
  const targetIsTest = targets.every((t) => graph.files.get(t)?.isTest);
  const untested = testCoverage === "none" && !targetIsTest;
  const score = Math.min(nonTest, 20) + 2 * strong + (untested ? 4 : 0);
  const reasons = [
    `${nonTest} non-test file(s) depend on it within ${depth} hops (1 point each, max 20)`,
    `${strong} file(s) change with it in >=${pct(STRONG_COUPLING)} of commits without importing it (2 points each)`,
    untested ? "no test is tied to it (4 points)" : `tests: ${testCoverage}`,
  ];
  const level = score < 5 ? "low" : score < 12 ? "medium" : "high";

  const caveats: string[] = [];
  const history = index.history();
  if (!history) caveats.push("no git history, so hidden coupling was not assessed");
  else if (history.commits.length < 20) caveats.push(`only ${plural(history.commits.length, "commit")} of history, coupling figures are weak`);
  for (const t of targets) {
    const rec = graph.files.get(t);
    if (rec?.language === "other") caveats.push(`${t} is not a language RIA parses, so only co-change evidence applies`);
    const miss = graph.unresolved.get(t);
    if (miss?.length) caveats.push(`${t} has ${miss.length} relative import(s) that did not resolve (${miss.slice(0, 3).join(", ")})`);
  }
  const brokenDependents = dependents.filter((d) => graph.unresolved.has(d.path)).length;
  if (brokenDependents) caveats.push(`${brokenDependents} dependent file(s) have unresolved relative imports, so the graph may be incomplete`);
  const confidenceLevel = caveats.length === 0 ? "high" : caveats.length === 1 ? "medium" : "low";

  return {
    targets,
    dependents,
    hiddenCoupling,
    tests: [...tests].map(([p, why]) => ({ path: p, why })),
    testCoverage,
    publicSurface,
    risk: { level, score, reasons },
    confidence: { level: confidenceLevel, caveats },
    notes,
  };
}

const LIST_LIMIT = 25;
const more = (n: number) => (n > LIST_LIMIT ? [`  ... and ${n - LIST_LIMIT} more`] : []);

export function formatImpact(r: ImpactResult, depth: number): string {
  const out: string[] = [];
  out.push(`Impact of changing ${r.targets.join(", ")}`);
  out.push(`Risk: ${r.risk.level.toUpperCase()} (score ${r.risk.score})`);
  for (const reason of r.risk.reasons) out.push(`  - ${reason}`);

  const nonTest = r.dependents.filter((d) => !d.isTest);
  out.push("", `Dependents (${nonTest.length} non-test, up to ${depth} hops):`);
  if (nonTest.length === 0) out.push("  none found");
  for (const d of nonTest.slice(0, LIST_LIMIT)) out.push(`  ${d.distance === 1 ? "direct  " : `hop ${d.distance}   `}${d.path}${d.distance > 1 ? `  (via ${d.via})` : ""}`);
  out.push(...more(nonTest.length));

  out.push("", "Hidden coupling (change together, no import between them):");
  if (r.hiddenCoupling.length === 0) out.push("  none found");
  for (const h of r.hiddenCoupling.slice(0, LIST_LIMIT)) out.push(`  ${h.path}  ${pct(h.confidence)} of ${path.posix.basename(h.of)}'s commits (${h.support})`);
  out.push(...more(r.hiddenCoupling.length));

  out.push("", `Tests (${r.testCoverage}, ${r.tests.length}):`);
  if (r.tests.length === 0) out.push("  none found");
  if (r.tests.length > LIST_LIMIT) out.push(`  concentrated in: ${byDirectory(r.tests.map((t) => t.path))}`);
  for (const t of r.tests.slice(0, LIST_LIMIT)) out.push(`  ${t.path}  (${t.why})`);
  out.push(...more(r.tests.length));

  if (r.publicSurface.length) {
    out.push("", "Public surface of the changed files:");
    for (const s of r.publicSurface) out.push(`  ${s.file}: ${s.symbols.join(", ")}`);
  }

  out.push("", `Confidence: ${r.confidence.level}`);
  for (const c of r.confidence.caveats) out.push(`  - ${c}`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  return out.join("\n");
}
