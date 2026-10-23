import { Hop, shortestPath } from "../repo/graph";
import { RepoIndex } from "../repo/repo-index";
import { pct, resolveOrExplain } from "./shared";

export interface PathResult {
  from: string;
  to: string;
  hops: Hop[] | null;
  /** Set when no import chain exists but the files still change together. */
  coChange?: { support: number; confidence: number };
}

export function findPath(index: RepoIndex, fromInput: string, toInput: string): PathResult | { error: string } {
  const from = resolveOrExplain(index, fromInput);
  if ("error" in from) return from;
  const to = resolveOrExplain(index, toInput);
  if ("error" in to) return to;

  const hops = shortestPath(index.graph(), from.path, to.path);
  if (hops) return { from: from.path, to: to.path, hops };
  const link = index.coChange(from.path, 1, 200).find((c) => c.path === to.path);
  return { from: from.path, to: to.path, hops: null, coChange: link && { support: link.support, confidence: link.confidence } };
}

export function formatPath(r: PathResult): string {
  if (r.hops === null) {
    const lines = [`No import chain connects ${r.from} and ${r.to}; they are in separate parts of the dependency graph.`];
    if (r.coChange) lines.push(`They do change together: ${r.coChange.support} shared commit(s), ${pct(r.coChange.confidence)} of ${r.from}'s history.`);
    else lines.push("They also share no commit history, so nothing in the repo links them directly.");
    return lines.join("\n");
  }
  if (r.hops.length === 0) return `${r.from} and ${r.to} are the same file.`;
  const chain = [r.from, ...r.hops.map((h) => h.to)].join(" -> ");
  const lines = [`${chain}`, `${r.hops.length} hop(s):`];
  for (const h of r.hops) lines.push(`  ${h.from} ${h.relation} ${h.to}`);
  const reversed = r.hops.filter((h) => h.relation === "imported by").length;
  if (reversed === r.hops.length) lines.push(`Direction: ${r.to} depends on ${r.from} (follow the chain upward).`);
  else if (reversed === 0) lines.push(`Direction: ${r.from} depends on ${r.to}.`);
  else lines.push("Direction: mixed, the chain goes through a shared file.");
  return lines.join("\n");
}
