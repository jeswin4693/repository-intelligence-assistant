import * as path from "node:path";
import { reach } from "../repo/graph";
import { Language, isTestFile, languageOf } from "../repo/languages";
import { RepoIndex } from "../repo/repo-index";
import { STRONG_COUPLING, impact } from "./impact";
import { approxTokens, byDirectory, namedTestFor, pct, plural, testsFor } from "./shared";

export interface PlanInput {
  name?: string;
  files: string[];
}

export interface PlanScoreOptions {
  plans: PlanInput[];
  depth?: number;
}

export type ComponentKey = "scope" | "blast" | "tests" | "coupling" | "reading";

export interface Component {
  key: ComponentKey;
  label: string;
  points: number;
  detail: string;
}

export interface ScoredPlan {
  name: string;
  /** 1 is the best (lowest score). */
  rank: number;
  score: number;
  /** Files of the plan that are in the index. */
  existing: string[];
  /** Files of the plan that are not in the index, treated as files the plan will create. */
  created: string[];
  readTokens: number;
  components: Component[];
  untested: { path: string; coverage: "transitive" | "none" }[];
  ignoredCoupling: { path: string; support: number; confidence: number; of: string }[];
  testsToRun: { path: string; why: string }[];
  confidence: { level: "high" | "medium" | "low"; caveats: string[] };
}

export interface Recommendation {
  plan: string;
  runnerUp?: string;
  /** Points between the best plan and the runner-up. */
  margin: number;
  closeCall: boolean;
  /** Where the best plan scores clearly lower than the runner-up. */
  better: string[];
  /** Where it scores clearly higher: what choosing it costs. */
  costs: string[];
}

export interface PlanScoreResult {
  plans: ScoredPlan[];
  recommendation: Recommendation;
  overlap: { inAll: string[]; some: { file: string; plans: string[] }[]; only: { plan: string; files: string[] }[] };
  confidence: { level: "high" | "medium" | "low"; caveats: string[] };
}

const SCOPE_CAP = 20;
const BLAST_CAP = 20;
const TESTS_CAP = 15;
const COUPLING_CAP = 15;
const READING_CAP = 10;
const TOKENS_PER_POINT = 2000;
/** Scores closer than this are within the noise of a heuristic. */
const CLOSE_CALL = 2;
/** A difference smaller than this is not worth naming as a reason. */
const MEANINGFUL = 1;
const LIST_LIMIT = 5;

const TEST_POINTS = { direct: 0, transitive: 1, none: 3 } as const;
const hopWeight = (distance: number) => (distance <= 1 ? 1 : distance === 2 ? 0.5 : 0.25);
/** Config, docs and data files are cheap to change; RIA cannot judge their risk anyway. */
const fileWeight = (language: Language) => (language === "other" ? 0.5 : 1);

/** A capped figure looks exact unless the output says it was cut off. */
const capNote = (raw: number, cap: number) => (raw > cap ? `; capped at ${cap}` : "");
const round1 = (x: number) => Math.round(x * 10) / 10;
const fmt = (x: number) => x.toFixed(1);
const levelOf = (caveats: number): "high" | "medium" | "low" => (caveats === 0 ? "high" : caveats === 1 ? "medium" : "low");

interface ResolvedPlan {
  name: string;
  existing: string[];
  created: string[];
}

/** Splits `Name=a.ts,b.ts` (or just `a.ts,b.ts`) from the command line into a plan. */
export function parsePlanArg(arg: string): PlanInput {
  const m = /^([^=,/\\]+)=(.+)$/.exec(arg);
  const list = (m ? m[2] : arg).split(",").map((s) => s.trim()).filter(Boolean);
  return { name: m?.[1].trim(), files: list };
}

function newPathOf(index: RepoIndex, input: string): string | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "An empty file path was given." };
  let norm = raw.replace(/\\/g, "/");
  if (path.isAbsolute(raw)) {
    const rel = path.relative(index.root, raw).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: `"${input}" is outside the repository.` };
    norm = rel;
  }
  norm = norm.replace(/^\.\//, "");
  const dir = norm.replace(/\/+$/, "") + "/";
  for (const f of index.files.keys()) {
    if (f.startsWith(dir)) return { error: `"${input}" is a directory. List the files the plan will change, e.g. ${f}.` };
  }
  return norm;
}

function resolvePlans(index: RepoIndex, plans: PlanInput[]): ResolvedPlan[] | { error: string } {
  const given = plans.map((p, i) => p.name?.trim() || `Plan ${i + 1}`);
  // two plans with the same name would be indistinguishable in the ranking
  const names = given.map((n, i) => (given.filter((g) => g === n).length > 1 ? `${n} (#${i + 1})` : n));
  const errors: string[] = [];
  const resolved = plans.map((p, i): ResolvedPlan => {
    const existing: string[] = [];
    const created: string[] = [];
    for (const input of p.files) {
      const t = index.resolve(input);
      if ("path" in t) {
        if (!existing.includes(t.path)) existing.push(t.path);
      } else if ("candidates" in t) {
        errors.push(`${names[i]}: "${input}" is ambiguous. Use one of: ${t.candidates.slice(0, 6).join(", ")}${t.candidates.length > 6 ? ", ..." : ""}`);
      } else {
        const np = newPathOf(index, input);
        if (typeof np !== "string") errors.push(`${names[i]}: ${np.error}`);
        else if (!created.includes(np)) created.push(np);
      }
    }
    return { name: names[i], existing, created };
  });
  return errors.length ? { error: errors.join("\n") } : resolved;
}

function scorePlan(index: RepoIndex, plan: ResolvedPlan, depth: number): Omit<ScoredPlan, "rank"> {
  const graph = index.graph();
  const { existing, created } = plan;
  const record = (f: string) => graph.files.get(f)!;

  const sources = existing.filter((f) => !record(f).isTest);
  const testFiles = existing.filter((f) => record(f).isTest);
  const createdTests = created.filter(isTestFile);
  const createdSources = created.filter((f) => !isTestFile(f));

  const r = existing.length > 0 ? impact(index, { files: existing, depth }) : undefined;
  const result = r && !("error" in r) ? r : undefined;
  const dependents = (result?.dependents ?? []).filter((d) => !d.isTest);

  // scope: every source file changed, new ones included
  const scopeRaw = sources.reduce((n, f) => n + fileWeight(record(f).language), 0) + createdSources.reduce((n, f) => n + fileWeight(languageOf(f)), 0);
  const scope = Math.min(scopeRaw, SCOPE_CAP);
  // blast radius: who imports the plan's files, nearer ones count more
  const blastRaw = dependents.reduce((n, d) => n + hopWeight(d.distance), 0);
  const blast = Math.min(blastRaw, BLAST_CAP);
  const direct = dependents.filter((d) => d.distance === 1).length;

  // tests: a source file is covered when a test is named after or imports it, or the plan adds one
  const untested: ScoredPlan["untested"] = [];
  let assessed = 0;
  let testPoints = 0;
  for (const f of sources) {
    if (record(f).language === "other") continue;
    assessed++;
    const covered = testsFor(graph, f).length > 0 || createdTests.some((t) => namedTestFor(t, f));
    if (covered) continue;
    const transitive = [...reach(graph, [f], "in", depth).keys()].some((p) => record(p)?.isTest);
    const coverage = transitive ? "transitive" : "none";
    untested.push({ path: f, coverage });
    testPoints += TEST_POINTS[coverage];
  }
  const tests = Math.min(testPoints, TESTS_CAP);
  const noTest = untested.filter((u) => u.coverage === "none").length;

  // hidden coupling the plan leaves out
  const ignoredCoupling = result?.hiddenCoupling ?? [];
  const strong = ignoredCoupling.filter((h) => h.confidence >= STRONG_COUPLING).length;
  const couplingRaw = 2 * strong + (ignoredCoupling.length - strong);
  const coupling = Math.min(couplingRaw, COUPLING_CAP);

  // reading cost: what has to be read to make the change (a big file can be read in part, so this is an upper bound)
  const readTokens = existing.reduce((n, f) => n + approxTokens(record(f).size), 0);
  const readingRaw = readTokens / TOKENS_PER_POINT;
  const reading = Math.min(readingRaw, READING_CAP);

  const parts = [plural(sources.length + createdSources.length, "source file")];
  if (createdSources.length) parts.push(`${createdSources.length} new`);
  if (testFiles.length + createdTests.length) parts.push(plural(testFiles.length + createdTests.length, "test file"));
  const components: Component[] = [
    { key: "scope", label: "scope", points: round1(scope), detail: `${parts.join(", ")} (1 point each, non-code files half)${capNote(scopeRaw, SCOPE_CAP)}` },
    {
      key: "blast",
      label: "blast radius",
      points: round1(blast),
      detail: `${plural(dependents.length, "dependent")} outside the plan, ${direct} direct (1 point direct, 0.5 at 2 hops, 0.25 further)${capNote(blastRaw, BLAST_CAP)}`,
    },
    {
      key: "tests",
      label: "missing tests",
      points: round1(tests),
      detail:
        untested.length === 0
          ? `all ${assessed} source file(s) have a test`
          : `${untested.length} of ${assessed} source file(s) lack a direct test: ${noTest} with none (3 points), ${untested.length - noTest} reached only through other files (1 point)${capNote(testPoints, TESTS_CAP)}`,
    },
    {
      key: "coupling",
      label: "ignored coupling",
      points: round1(coupling),
      detail: `${strong} strongly and ${ignoredCoupling.length - strong} loosely coupled file(s) left out (2 and 1 points)${capNote(couplingRaw, COUPLING_CAP)}`,
    },
    {
      key: "reading",
      label: "reading cost",
      points: round1(reading),
      detail: `about ${readTokens} tokens if every file is read whole (1 point per ${TOKENS_PER_POINT})${capNote(readingRaw, READING_CAP)}`,
    },
  ];

  const caveats = [...(result?.confidence.caveats ?? [])];
  if (existing.length === 0) caveats.push("no file of this plan is in the index, so only its size was scored");
  if (created.length) {
    caveats.push(`${created.slice(0, 3).join(", ")}${created.length > 3 ? ", ..." : ""} not in the index: treated as new files (if one is a typo, the plan is under-scored)`);
  }

  return {
    name: plan.name,
    score: round1(components.reduce((n, c) => n + c.points, 0)),
    existing,
    created,
    readTokens,
    components,
    untested,
    ignoredCoupling,
    testsToRun: result?.tests ?? [],
    confidence: { level: levelOf(caveats.length), caveats },
  };
}

function recommend(ranked: ScoredPlan[]): Recommendation {
  const [best, second] = ranked;
  if (!second) return { plan: best.name, margin: 0, closeCall: false, better: [], costs: [] };
  const better: string[] = [];
  const costs: string[] = [];
  const diffs = best.components.map((c, i) => ({ c, other: second.components[i].points }));
  for (const { c, other } of diffs.sort((a, b) => b.other - b.c.points - (a.other - a.c.points))) {
    const line = `${c.label}: ${fmt(c.points)} vs ${fmt(other)} points`;
    if (other - c.points >= MEANINGFUL) better.push(line);
    else if (c.points - other >= MEANINGFUL) costs.unshift(line);
  }
  const margin = round1(second.score - best.score);
  return { plan: best.name, runnerUp: second.name, margin, closeCall: margin < CLOSE_CALL, better: better.slice(0, 3), costs: costs.slice(0, 3) };
}

/** Which plans touch each file: in every plan, in some of them, or in one only. */
function overlapOf(ranked: ScoredPlan[]): PlanScoreResult["overlap"] {
  if (ranked.length < 2) return { inAll: [], some: [], only: [] };
  const owners = new Map<string, string[]>();
  for (const p of ranked) {
    for (const f of [...p.existing, ...p.created]) owners.set(f, [...(owners.get(f) ?? []), p.name]);
  }
  const entries = [...owners].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    inAll: entries.filter(([, plans]) => plans.length === ranked.length).map(([f]) => f),
    some: entries.filter(([, plans]) => plans.length > 1 && plans.length < ranked.length).map(([file, plans]) => ({ file, plans })),
    only: ranked.map((p) => ({ plan: p.name, files: entries.filter(([, plans]) => plans.length === 1 && plans[0] === p.name).map(([f]) => f) })),
  };
}

export function planScore(index: RepoIndex, opts: PlanScoreOptions): PlanScoreResult | { error: string } {
  if (opts.plans.length === 0) return { error: "Provide at least one plan." };
  const resolved = resolvePlans(index, opts.plans);
  if ("error" in resolved) return resolved;

  const depth = opts.depth ?? 3;
  const scored = resolved.map((p) => scorePlan(index, p, depth));
  // the order must not depend on how the plans were listed
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.existing.length + a.created.length - (b.existing.length + b.created.length) ||
      a.name.localeCompare(b.name) ||
      [...a.existing, ...a.created].sort().join("\0").localeCompare([...b.existing, ...b.created].sort().join("\0")),
  );
  const plans = scored.map((p, i) => ({ ...p, rank: i + 1 }));

  const caveats = [...new Set(plans.flatMap((p) => p.confidence.caveats))];
  const levels = plans.map((p) => p.confidence.level);
  const level = levels.includes("low") ? "low" : levels.includes("medium") ? "medium" : "high";
  return { plans, recommendation: recommend(plans), overlap: overlapOf(plans), confidence: { level, caveats } };
}

const more = (n: number) => (n > LIST_LIMIT ? [`    ... and ${n - LIST_LIMIT} more`] : []);

export function formatPlanScore(r: PlanScoreResult): string {
  const out: string[] = [];
  const many = r.plans.length > 1;
  out.push(many ? `Plan scores for ${r.plans.length} candidate plans (lower is better)` : `Plan score for ${r.plans[0].name} (lower is better; one plan, so nothing to rank)`);

  if (many) {
    const rec = r.recommendation;
    out.push("", `Recommended: ${rec.plan} (score ${fmt(r.plans[0].score)})`);
    if (rec.closeCall) {
      out.push(`  Close call: ${rec.runnerUp} is only ${fmt(rec.margin)} point(s) behind. That is within the noise of this heuristic, so decide on what it cannot see (simplicity, reversibility, team habits).`);
    } else {
      out.push(`  Ahead of ${rec.runnerUp} by ${fmt(rec.margin)} points.`);
    }
    for (const b of rec.better) out.push(`  + ${b}`);
    for (const c of rec.costs) out.push(`  - costs more in ${c}`);
  }

  for (const p of r.plans) {
    out.push("", `${many ? `#${p.rank} ` : ""}${p.name}   score ${fmt(p.score)}`);
    const files = [...p.existing, ...p.created.map((f) => `${f} (new)`)];
    out.push(`  Files: ${files.length > 8 ? `${files.slice(0, 8).join(", ")}, ... (${files.length} in all)` : files.join(", ")}`);
    out.push(`  Points: ${p.components.map((c) => `${c.label} ${fmt(c.points)}`).join(" | ")}`);
    for (const c of p.components) if (c.points > 0) out.push(`    - ${c.label}: ${c.detail}`);

    if (p.ignoredCoupling.length) {
      out.push("  Leaves out files that change with it (consider adding them, or say why not):");
      for (const h of p.ignoredCoupling.slice(0, LIST_LIMIT)) out.push(`    ${h.path}  ${pct(h.confidence)} of ${path.posix.basename(h.of)}'s commits (${h.support})`);
      out.push(...more(p.ignoredCoupling.length));
    }
    if (p.untested.length) {
      out.push("  Without a direct test:");
      for (const u of p.untested.slice(0, LIST_LIMIT)) out.push(`    ${u.path}  (${u.coverage === "none" ? "no test reaches it" : "only through other files"})`);
      out.push(...more(p.untested.length));
    }
    if (p.testsToRun.length > LIST_LIMIT) {
      out.push(`  Tests to run after the change (${p.testsToRun.length}), concentrated in: ${byDirectory(p.testsToRun.map((t) => t.path))}`);
    } else if (p.testsToRun.length) {
      out.push(`  Tests to run after the change (${p.testsToRun.length}): ${p.testsToRun.map((t) => t.path).join(", ")}`);
    }
    out.push(`  Confidence: ${p.confidence.level}`);
    for (const c of p.confidence.caveats) out.push(`    - ${c}`);
  }

  if (many) {
    const { inAll, some, only } = r.overlap;
    const list = (files: string[]) => `${files.slice(0, 8).join(", ")}${files.length > 8 ? `, ... (${files.length} in all)` : ""}`;
    out.push("", "Overlap");
    if (inAll.length) out.push(`  In every plan: ${list(inAll)}`);
    for (const s of some.slice(0, 6)) out.push(`  ${s.file}: ${s.plans.join(", ")}`);
    if (some.length > 6) out.push(`  ... and ${some.length - 6} more shared by some plans`);
    for (const o of only) if (o.files.length) out.push(`  Only in ${o.plan}: ${list(o.files)}`);
  }

  out.push(
    "",
    "How to read this",
    "  - The plans come from the chat model and the score is a transparent heuristic, not a prediction. It ranks relative cost and risk; it does not know which plan is correct.",
    "  - It sees which files a plan touches, not what changes inside them, so every listed file is assumed able to change its public symbols.",
    "  - Run gate_begin before the first edit and gate_check after it, whichever plan is chosen.",
  );
  return out.join("\n");
}
