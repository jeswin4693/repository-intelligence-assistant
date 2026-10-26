import * as path from "node:path";
import { LogCommit, buildHistory, loadCommitLog } from "../git/history";
import { RepoIndex } from "../repo/repo-index";
import { contextFor, tokenize } from "../tools/context";
import { impact } from "../tools/impact";
import { planScore } from "../tools/plan-score";
import { approxTokens, pct } from "../tools/shared";

export interface HistoryEvalOptions {
  /** Usable commits to sample, newest first. Default 150. */
  commits?: number;
  /** Commits touching more files than this are skipped. Default 12. */
  maxFiles?: number;
  /** How many entries of each `impact` list count as shown to the chat. Default 25, as in its report. */
  listSize?: number;
  /** Files held out per commit. Default 4. */
  heldOutPerCommit?: number;
}

export interface ChannelRates {
  union: number;
  dependents: number;
  coupling: number;
  tests: number;
  /** Found through git history alone: not by dependents or tests. */
  couplingOnly: number;
  /** Found through the import graph alone: not by coupling. */
  graphOnly: number;
}

export interface HistoryEvalResult {
  repo: string;
  indexedFiles: number;
  logCommits: number;
  sampled: number;
  skipped: { size: number; missing: number };
  impact: {
    cases: number;
    rates: ChannelRates;
    /** What a list of the same length would find: files in the same folders, and files picked at random. */
    baselines: { siblings: number; random: number };
    shown: { median: number; mean: number };
    heldOutTest: { cases: number; found: number };
    heldOutSource: { cases: number; found: number };
  } | null;
  context: {
    cases: number;
    skippedWords: number;
    recall: number;
    anyHit: number;
    random: number;
    tokens: { median: number; mean: number; repo: number };
    /** Share of tasks where the answer was bigger than the token budget (the best file is always returned, however large). */
    overBudget: number;
  } | null;
  plans: {
    cases: number;
    followUps: number;
    window: number;
    scoreAuc: number | null;
    scoreMargin: number | null;
    sizeAuc: number | null;
    sizeMargin: number | null;
    meanScore: { followUp: number; clean: number };
  } | null;
  notes: string[];
}

const CONTEXT_FILES = 12;
const CONTEXT_TOKENS = 8000;
const FOLLOW_UP_WINDOW = 10;
const FIX_WORDS = /\b(fix(es|ed)?|bugs?|hotfix|revert(ed)?|regress\w*)\b/i;
/** Fewer cases than this and a rate is anecdote. */
const MIN_FOR_AUC = 10;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Chance that a random positive outranks a random negative (ties count half). Null when either side is empty. */
export function auc(positives: number[], negatives: number[]): number | null {
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

/** Half-width of an approximate 95% interval around an AUC (Hanley and McNeil, 1982). */
export function aucMargin(a: number, positives: number, negatives: number): number {
  const q1 = a / (2 - a);
  const q2 = (2 * a * a) / (1 + a);
  const variance = (a * (1 - a) + (positives - 1) * (q1 - a * a) + (negatives - 1) * (q2 - a * a)) / (positives * negatives);
  return 1.96 * Math.sqrt(Math.max(0, variance));
}

interface PlanRow {
  score: number;
  count: number;
  followUp: boolean;
}

function planSummary(all: PlanRow[], followUps: PlanRow[], clean: PlanRow[]): NonNullable<HistoryEvalResult["plans"]> {
  const withMargin = (pos: number[], neg: number[]) => {
    const a = auc(pos, neg);
    return { auc: a, margin: a === null ? null : aucMargin(a, pos.length, neg.length) };
  };
  const score = withMargin(followUps.map((r) => r.score), clean.map((r) => r.score));
  const size = withMargin(followUps.map((r) => r.count), clean.map((r) => r.count));
  return {
    cases: all.length,
    followUps: followUps.length,
    window: FOLLOW_UP_WINDOW,
    scoreAuc: score.auc,
    scoreMargin: score.margin,
    sizeAuc: size.auc,
    sizeMargin: size.margin,
    meanScore: { followUp: mean(followUps.map((r) => r.score)), clean: mean(clean.map((r) => r.score)) },
  };
}

interface Case {
  pos: number;
  commit: LogCommit;
  files: string[];
}

/**
 * Replays a repository's own history against the tools. Each commit is looked at as the developer would
 * have, knowing only the older commits (`index.useHistory`), though the import graph is today's.
 * Read-only: nothing is written to the repository.
 */
export function evaluateHistory(index: RepoIndex, opts: HistoryEvalOptions = {}): HistoryEvalResult | { error: string } {
  const want = opts.commits ?? 150;
  const maxFiles = opts.maxFiles ?? 12;
  const listSize = opts.listSize ?? 25;
  const perCommit = opts.heldOutPerCommit ?? 4;

  const log = loadCommitLog(index.root);
  if (log.length === 0) return { error: "No git history to evaluate: this is not a git repository, or it has no commits." };

  const cases: Case[] = [];
  const skipped = { size: 0, missing: 0 };
  for (let i = 0; i < log.length && cases.length < want; i++) {
    const files = [...new Set(log[i].files)].sort();
    if (files.length < 2 || files.length > maxFiles) skipped.size++;
    else if (!files.every((f) => index.files.has(f))) skipped.missing++;
    else cases.push({ pos: i, commit: log[i], files });
  }

  const allFiles = [...index.files.keys()].sort();
  const N = allFiles.length;
  const repoTokens = [...index.files.values()].reduce((n, r) => n + approxTokens(r.size), 0);
  const notes: string[] = [];
  if (cases.length < 30) notes.push(`Only ${cases.length} usable commits: treat every rate below as an anecdote, not a measurement.`);

  const found = { union: 0, dependents: 0, coupling: 0, tests: 0, couplingOnly: 0, graphOnly: 0 };
  const shownSizes: number[] = [];
  const siblingsHit: number[] = [];
  const randomRate: number[] = [];
  const kind = { test: { cases: 0, found: 0 }, source: { cases: 0, found: 0 } };
  const contextRows: { recall: number; any: boolean; tokens: number }[] = [];
  let skippedWords = 0;
  const planRows: PlanRow[] = [];

  try {
    for (const c of cases) {
      // what was known before this commit
      index.useHistory(buildHistory(log.slice(c.pos + 1).map((x) => x.files), "eval"));

      for (const hidden of c.files.slice(0, perCommit)) {
        const seeds = c.files.filter((f) => f !== hidden);
        const r = impact(index, { files: seeds });
        if ("error" in r) continue;
        const dependents = r.dependents.filter((d) => !d.isTest).slice(0, listSize).map((d) => d.path);
        const coupling = r.hiddenCoupling.slice(0, listSize).map((h) => h.path);
        const tests = r.tests.slice(0, listSize).map((t) => t.path);
        const shown = new Set([...dependents, ...coupling, ...tests]);

        const inDeps = dependents.includes(hidden);
        const inCoupling = coupling.includes(hidden);
        const inTests = tests.includes(hidden);
        const any = inDeps || inCoupling || inTests;
        if (any) found.union++;
        if (inDeps) found.dependents++;
        if (inCoupling) found.coupling++;
        if (inTests) found.tests++;
        if (inCoupling && !inDeps && !inTests) found.couplingOnly++;
        if ((inDeps || inTests) && !inCoupling) found.graphOnly++;
        shownSizes.push(shown.size);

        const isTest = index.files.get(hidden)?.isTest ?? false;
        const k = isTest ? kind.test : kind.source;
        k.cases++;
        if (any) k.found++;

        // same budget as what impact showed: that many files from the seeds' own folders, and that many at random
        const dirs = new Set(seeds.map((s) => path.posix.dirname(s)));
        const budget = Math.max(shown.size, 1);
        const siblings: string[] = [];
        for (const p of allFiles) {
          if (siblings.length >= budget) break;
          if (dirs.has(path.posix.dirname(p)) && !seeds.includes(p)) siblings.push(p);
        }
        siblingsHit.push(siblings.includes(hidden) ? 1 : 0);
        randomRate.push(Math.min(1, budget / Math.max(1, N - seeds.length)));
      }

      const words = tokenize(c.commit.subject);
      if (words.length < 3) skippedWords++;
      else {
        const r = contextFor(index, { query: c.commit.subject, maxFiles: CONTEXT_FILES, maxTokens: CONTEXT_TOKENS });
        if (!("error" in r)) {
          const got = new Set(r.items.map((i) => i.path));
          const hit = c.files.filter((f) => got.has(f)).length;
          contextRows.push({ recall: hit / c.files.length, any: hit > 0, tokens: r.totalTokens });
        }
      }

      if (c.pos >= FOLLOW_UP_WINDOW) {
        const plan = planScore(index, { plans: [{ name: "commit", files: c.files }] });
        if (!("error" in plan)) {
          const mine = new Set(c.files);
          const newer = log.slice(c.pos - FOLLOW_UP_WINDOW, c.pos);
          planRows.push({
            score: plan.plans[0].score,
            count: c.files.length,
            followUp: newer.some((n) => FIX_WORDS.test(n.subject) && n.files.some((f) => mine.has(f))),
          });
        }
      }
    }
  } finally {
    index.useHistory(undefined);
  }

  const n = shownSizes.length;
  const rate = (x: number) => (n ? x / n : 0);
  const withFollowUp = planRows.filter((r) => r.followUp);
  const clean = planRows.filter((r) => !r.followUp);
  const enoughPlans = withFollowUp.length >= MIN_FOR_AUC && clean.length >= MIN_FOR_AUC;
  if (planRows.length > 0 && !enoughPlans) notes.push(`plan_score check skipped: ${withFollowUp.length} changes were followed by a fix and ${clean.length} were not; it needs at least ${MIN_FOR_AUC} of each.`);

  return {
    repo: path.basename(index.root),
    indexedFiles: N,
    logCommits: log.length,
    sampled: cases.length,
    skipped,
    impact: n
      ? {
          cases: n,
          rates: {
            union: rate(found.union),
            dependents: rate(found.dependents),
            coupling: rate(found.coupling),
            tests: rate(found.tests),
            couplingOnly: rate(found.couplingOnly),
            graphOnly: rate(found.graphOnly),
          },
          baselines: { siblings: mean(siblingsHit), random: mean(randomRate) },
          shown: { median: median(shownSizes), mean: mean(shownSizes) },
          heldOutTest: kind.test,
          heldOutSource: kind.source,
        }
      : null,
    context: contextRows.length
      ? {
          cases: contextRows.length,
          skippedWords,
          recall: mean(contextRows.map((r) => r.recall)),
          anyHit: mean(contextRows.map((r) => (r.any ? 1 : 0))),
          random: Math.min(1, CONTEXT_FILES / Math.max(1, N)),
          tokens: { median: median(contextRows.map((r) => r.tokens)), mean: mean(contextRows.map((r) => r.tokens)), repo: repoTokens },
          overBudget: mean(contextRows.map((r) => (r.tokens > CONTEXT_TOKENS ? 1 : 0))),
        }
      : null,
    plans: enoughPlans ? planSummary(planRows, withFollowUp, clean) : null,
    notes,
  };
}

/** What the plan_score check allows us to say, given the margins of this sample. */
export function planVerdict(p: NonNullable<HistoryEvalResult["plans"]>): string {
  if (p.scoreAuc === null || p.scoreMargin === null || p.sizeAuc === null || p.sizeMargin === null) return "Not enough cases to judge.";
  const beatsCoin = p.scoreAuc - p.scoreMargin > 0.5;
  const beatsSize = p.scoreAuc - p.scoreMargin > p.sizeAuc + p.sizeMargin;
  if (beatsCoin && beatsSize) return "The score predicts follow-up fixes better than the size of the change does, beyond the margin of this sample.";
  if (p.scoreAuc <= p.sizeAuc) return "The score does not do better than counting files here.";
  if (beatsCoin) return "The score beats a coin, but its margin overlaps with plain file count: not shown to add anything beyond size.";
  return "The score points the right way, but this sample cannot tell it from chance or from counting files.";
}

const p0 = (x: number) => pct(x);
/** A baseline under 1% is shown with a decimal so it does not read as zero. */
const pSmall = (x: number) => (x > 0 && x < 0.01 ? `${(x * 100).toFixed(x < 0.001 ? 2 : 1)}%` : pct(x));

export function formatHistoryEval(r: HistoryEvalResult): string {
  const out: string[] = [];
  out.push(`History evaluation of ${r.repo}: ${r.sampled} commits sampled (newest first) of ${r.logCommits} read, ${r.indexedFiles} files indexed`);
  out.push(`  Skipped ${r.skipped.size} commits that touch fewer than 2 or too many files, and ${r.skipped.missing} that touch files no longer in the repository.`);
  out.push("  Every case sees only the commits older than the one being tested. Nothing was written to the repository.");

  if (r.impact) {
    const i = r.impact;
    out.push("", `impact: one file of a real commit is held out, impact is asked about the others (${i.cases} cases)`);
    out.push(`  The held-out file was in what impact showed:  ${p0(i.rates.union)}`);
    out.push(`    through dependents (import graph):          ${p0(i.rates.dependents)}`);
    out.push(`    through hidden coupling (git history):      ${p0(i.rates.coupling)}   (${p0(i.rates.couplingOnly)} found by history alone)`);
    out.push(`    through tests tied to the change:           ${p0(i.rates.tests)}`);
    out.push(`  A list of the same length from the same folders: ${p0(i.baselines.siblings)}`);
    out.push(`  A list of the same length picked at random:      ${pSmall(i.baselines.random)}`);
    out.push(`  Files shown per question: median ${Math.round(i.shown.median)}, mean ${Math.round(i.shown.mean)}`);
    const t = i.heldOutTest;
    const s = i.heldOutSource;
    out.push(`  By kind of held-out file: source ${s.cases ? p0(s.found / s.cases) : "n/a"} of ${s.cases}, test ${t.cases ? p0(t.found / t.cases) : "n/a"} of ${t.cases}`);
  } else out.push("", "impact: no usable cases.");

  if (r.context) {
    const c = r.context;
    out.push("", `context_for: the commit subject is the task, the commit's files are what should come back (${c.cases} cases, ${c.skippedWords} subjects too short)`);
    out.push(`  At least one of the files was in the ${CONTEXT_FILES} returned: ${p0(c.anyHit)}`);
    out.push(`  Share of the commit's files returned (average):  ${p0(c.recall)}   (${CONTEXT_FILES} files picked at random: ${pSmall(c.random)})`);
    const share = (x: number) => pSmall(x / Math.max(1, c.tokens.repo));
    out.push(`  Tokens returned per task: median ${Math.round(c.tokens.median)} (${share(c.tokens.median)} of the ${c.tokens.repo} it takes to read the whole repository), mean ${Math.round(c.tokens.mean)}`);
    out.push(`  Answers larger than the ${CONTEXT_TOKENS}-token budget: ${p0(c.overBudget)} (the best file is always returned, however large it is)`);
  } else out.push("", "context_for: no usable cases.");

  if (r.plans) {
    const p = r.plans;
    const show = (a: number | null, margin: number | null) => (a === null ? "n/a" : `${p0(a)} (plus or minus ${Math.round((margin ?? 0) * 100)})`);
    out.push("", `plan_score (exploratory): does the score of a change predict that a fix touching the same files follows within ${p.window} commits? (${p.cases} changes, ${p.followUps} followed by a fix)`);
    out.push(`  Chance the score ranks a fixed-later change above a clean one:  ${show(p.scoreAuc, p.scoreMargin)}   (50% is a coin)`);
    out.push(`  The same using only the number of files changed:                ${show(p.sizeAuc, p.sizeMargin)}`);
    out.push(`  Mean score: ${p.meanScore.followUp.toFixed(1)} when a fix followed, ${p.meanScore.clean.toFixed(1)} when not`);
    out.push(`  ${planVerdict(p)}`);
  }

  for (const n of r.notes) out.push("", `Note: ${n}`);
  out.push(
    "",
    "How to read this",
    "  - Real commits are a proxy for tasks: a developer may well edit a file the tools did not suggest, and still be right. Read the rates against the baselines, not against 100%.",
    "  - Up to four files are held out of each commit, so the cases of one commit are not independent: the sample is smaller than its case count suggests.",
    "  - The import graph is today's, the history is as it was before each commit. A file that moved since the commit is skipped.",
    "  - The plan_score check uses 'a commit with fix, bug or revert in its subject touched the same files soon after' as the outcome. That is noisy, and a larger change has more chances to be followed by one, hence the comparison with file count.",
  );
  return out.join("\n");
}
