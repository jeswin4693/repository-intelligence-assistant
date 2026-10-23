import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { HistoryEvalResult, auc, aucMargin, evaluateHistory, formatHistoryEval, planVerdict } from "../src/eval/history-eval";
import { buildHistory, headOf, loadCommitLog, loadHistory } from "../src/git/history";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, commit, git, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const repo = (files: Record<string, string>) => {
  const dir = makeRepo(files);
  dirs.push(dir);
  gitInit(dir);
  return dir;
};
const body = (name: string, n: number) => `export const ${name} = ${n};\n`;
const indexOf = (dir: string) => {
  const index = new RepoIndex(dir, { cache: false });
  index.refresh();
  return index;
};

/** invoice.ts and tax.ts change together four times, with a subject that names them. */
function coupledRepo(): string {
  const dir = repo({ "src/invoice.ts": body("invoice", 0), "src/tax.ts": body("tax", 0) });
  commit(dir, "initial");
  for (let n = 1; n <= 3; n++) commit(dir, `Adjust invoice and tax rounding ${n}`, { "src/invoice.ts": body("invoice", n), "src/tax.ts": body("tax", n) });
  return dir;
}

describe("auc", () => {
  it("is the chance a positive outranks a negative, with ties counted half", () => {
    assert.equal(auc([3, 4], [1, 2]), 1);
    assert.equal(auc([1, 2], [3, 4]), 0);
    assert.equal(auc([1], [1]), 0.5);
    assert.equal(auc([2, 4], [1, 3]), 0.75);
    assert.equal(auc([], [1]), null);
    assert.equal(auc([1], []), null);
  });

  it("has a margin that shrinks as the sample grows", () => {
    assert.ok(Math.abs(aucMargin(0.5, 20, 20) - 0.181) < 0.002, `got ${aucMargin(0.5, 20, 20)}`);
    assert.ok(aucMargin(0.5, 100, 100) < aucMargin(0.5, 20, 20) / 2);
    assert.ok(aucMargin(0.9, 20, 20) < aucMargin(0.5, 20, 20), "a clear separation is more certain than a coin flip");
  });
});

describe("planVerdict", () => {
  const plans = (scoreAuc: number | null, scoreMargin: number | null, sizeAuc: number | null, sizeMargin: number | null): NonNullable<HistoryEvalResult["plans"]> => ({
    cases: 100,
    followUps: 30,
    window: 10,
    scoreAuc,
    scoreMargin,
    sizeAuc,
    sizeMargin,
    meanScore: { followUp: 1, clean: 1 },
  });

  it("only claims what the margins allow", () => {
    assert.match(planVerdict(plans(0.8, 0.05, 0.5, 0.05)), /better than the size of the change does/);
    assert.match(planVerdict(plans(0.5, 0.05, 0.6, 0.05)), /does not do better than counting files/);
    assert.match(planVerdict(plans(0.62, 0.08, 0.58, 0.07)), /beats a coin, but its margin overlaps with plain file count/);
    assert.match(planVerdict(plans(0.56, 0.1, 0.5, 0.1)), /cannot tell it from chance/);
    assert.match(planVerdict(plans(null, null, null, null)), /Not enough cases/);
  });
});

describe("history helpers", () => {
  it("reads subjects and files newest first, following renames", () => {
    const dir = coupledRepo();
    git(dir, "mv", "src/tax.ts", "src/vat.ts");
    git(dir, "commit", "-q", "-m", "Rename tax to vat");
    const log = loadCommitLog(dir);
    assert.deepEqual(log.map((c) => c.subject), ["Rename tax to vat", "Adjust invoice and tax rounding 3", "Adjust invoice and tax rounding 2", "Adjust invoice and tax rounding 1", "initial"]);
    assert.deepEqual(log[0].files, ["src/vat.ts"]);
    assert.deepEqual(log[1].files, ["src/invoice.ts", "src/tax.ts"]);
    assert.match(log[0].hash, /^[0-9a-f]{40}$/);
    assert.deepEqual(loadCommitLog(makeRepoOutsideGit()), []);
  });

  it("builds the same history as loadHistory does", () => {
    const dir = coupledRepo();
    commit(dir, "Bulk", Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`gen/f${i}.ts`, body(`f${i}`, i)])));
    const head = headOf(dir)!;
    const built = buildHistory(loadCommitLog(dir).map((c) => c.files), head);
    const loaded = loadHistory(dir)!;
    assert.deepEqual(built.commits, loaded.commits);
    assert.deepEqual([...built.byFile], [...loaded.byFile]);
    assert.equal(built.commits.length, 4, "the 45-file commit is skipped as bulk");
  });
});

function makeRepoOutsideGit(): string {
  const dir = makeRepo({ "a.txt": "x\n" });
  dirs.push(dir);
  return dir;
}

describe("evaluateHistory", () => {
  it("only lets a commit see the commits older than it", () => {
    const dir = coupledRepo();
    const index = indexOf(dir);
    const r = evaluateHistory(index, {});
    assert.ok(!("error" in r));
    assert.ok(r.impact);
    // four commits touch both files, two files each: eight questions. The newest two commits have at least two older
    // commits that changed both files (the minimum for coupling), the oldest two do not. With the whole history every one would be found.
    assert.equal(r.impact.cases, 8);
    assert.equal(r.impact.rates.coupling, 0.5);
    assert.equal(r.impact.rates.union, 0.5);
    assert.equal(r.impact.rates.couplingOnly, 0.5);
    assert.equal(r.impact.rates.dependents, 0);
    assert.equal(r.impact.rates.tests, 0);
    assert.equal(r.sampled, 4);
    assert.match(r.notes.join("\n"), /Only 4 usable commits/);
  });

  it("leaves the index reading real git history afterwards", () => {
    const dir = coupledRepo();
    const index = indexOf(dir);
    evaluateHistory(index, {});
    assert.equal(index.history()?.commits.length, 4);
    assert.deepEqual(index.coChange("src/invoice.ts").map((c) => [c.path, c.support]), [["src/tax.ts", 4]]);
  });

  it("compares with lists of the same length from the same folders and at random", () => {
    const dir = coupledRepo();
    const r = evaluateHistory(indexOf(dir), {});
    assert.ok(!("error" in r) && r.impact);
    // the other file lives in the same folder, so a same-length list of siblings finds it: the baseline is not a straw man
    assert.equal(r.impact.baselines.siblings, 0 + 1 * 1, "a folder with only the two files");
    assert.ok(r.impact.baselines.random > 0);
  });

  it("asks context_for for the files of a commit using its subject", () => {
    const dir = coupledRepo();
    const r = evaluateHistory(indexOf(dir), {});
    assert.ok(!("error" in r) && r.context);
    assert.equal(r.context.cases, 3, "the subject 'initial' is too short to be a task");
    assert.equal(r.context.skippedWords, 1);
    assert.equal(r.context.recall, 1);
    assert.equal(r.context.anyHit, 1);
    assert.equal(r.context.overBudget, 0);
    // a two-file repository: the answer is the whole repository, never more
    assert.ok(r.context.tokens.median > 0 && r.context.tokens.median <= r.context.tokens.repo);
  });

  it("skips commits that are too small, too large, or touch files that are gone", () => {
    const dir = coupledRepo();
    commit(dir, "Only one file", { "src/invoice.ts": body("invoice", 9) });
    commit(dir, "Adds a file that is removed later", { "src/temp.ts": body("temp", 1), "src/tax.ts": body("tax", 9) });
    fs.rmSync(path.join(dir, "src/temp.ts"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Remove temp");
    const r = evaluateHistory(indexOf(dir), {});
    assert.ok(!("error" in r));
    assert.equal(r.skipped.missing, 1, "the commit that added temp.ts");
    assert.equal(r.skipped.size, 2, "the single-file commits");
    assert.equal(r.sampled, 4);
  });

  it("says plainly when there is no history", () => {
    const r = evaluateHistory(indexOf(makeRepoOutsideGit()), {});
    assert.ok("error" in r);
    assert.match(r.error, /No git history to evaluate/);
  });

  it("checks plan_score against later fixes, and compares it with plain file count", () => {
    // every commit touches exactly two files, so file count alone cannot tell them apart
    const dir = repo({ "src/a0.ts": body("a0", 0), "src/a1.ts": body("a1", 0) });
    commit(dir, "initial");
    commit(dir, "Add beta", { "src/b0.ts": body("b0", 0), "src/b1.ts": body("b1", 0) });
    // alpha files are fixed again and again, beta files never are
    for (let r = 1; r <= 24; r++) {
      commit(dir, `Update alpha ${r}`, { "src/a0.ts": body("a0", r), "src/a1.ts": body("a1", r) });
      commit(dir, `Update beta ${r}`, { "src/b0.ts": body("b0", r), "src/b1.ts": body("b1", r) });
      if (r % 2 === 0) commit(dir, `Fix alpha ${r}`, { "src/a0.ts": body("a0", r + 100), "src/a1.ts": body("a1", r + 100) });
    }
    const r = evaluateHistory(indexOf(dir), {});
    assert.ok(!("error" in r) && r.plans);
    assert.ok(r.plans.followUps >= 10 && r.plans.cases - r.plans.followUps >= 10);
    assert.equal(r.plans.window, 10);
    assert.equal(r.plans.sizeAuc, 0.5);
    assert.ok(r.plans.scoreAuc !== null && r.plans.scoreMargin !== null && r.plans.scoreMargin > 0);
    assert.ok(Number.isFinite(r.plans.meanScore.followUp) && Number.isFinite(r.plans.meanScore.clean));
    assert.equal(r.skipped.size, 0);
  });

  it("does not run the plan check on a history too short to support it", () => {
    const r = evaluateHistory(indexOf(coupledRepo()), {});
    assert.ok(!("error" in r));
    assert.equal(r.plans, null);
  });
});

describe("formatHistoryEval", () => {
  it("prints each measurement next to its baseline, and how to read it", () => {
    const r = evaluateHistory(indexOf(coupledRepo()), {});
    assert.ok(!("error" in r));
    const text = formatHistoryEval(r);
    assert.match(text, /^History evaluation of ria-test-\S+: 4 commits sampled/);
    assert.match(text, /Nothing was written to the repository/);
    assert.match(text, /impact: one file of a real commit is held out.*\(8 cases\)/);
    assert.match(text, /The held-out file was in what impact showed: +50%/);
    assert.match(text, /through hidden coupling \(git history\): +50% +\(50% found by history alone\)/);
    assert.match(text, /A list of the same length from the same folders: /);
    assert.match(text, /A list of the same length picked at random: +\d/);
    assert.match(text, /context_for: .*\(3 cases, 1 subjects too short\)/);
    assert.match(text, /Answers larger than the 8000-token budget: 0%/);
    assert.match(text, /Note: Only 4 usable commits/);
    assert.match(text, /Read the rates against the baselines, not against 100%/);
    assert.match(text, /not independent/);
  });
});

describe("ria eval history (command line)", () => {
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "index.ts"), ...args], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("prints the report, writes nothing into the repository, and can print JSON", () => {
    const dir = coupledRepo();
    const before = fs.readdirSync(dir).sort();
    assert.match(cli("eval", "history", "--root", dir), /History evaluation of/);
    const json = JSON.parse(cli("eval", "history", "--root", dir, "--json", "--commits", "2")) as HistoryEvalResult;
    assert.equal(json.sampled, 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "no .ria folder and nothing else was added");
  });

  it("exits with 1 when a rate is below the threshold given, and with 0 when it is not", () => {
    const dir = coupledRepo();
    // half of the held-out files are found (see "only lets a commit see the commits older than it")
    assert.match(cli("eval", "history", "--root", dir, "--min-recall", "0.4", "--min-context-hit", "1"), /History evaluation of/);
    const fail = (...args: string[]) => {
      try {
        cli("eval", "history", "--root", dir, ...args);
      } catch (e) {
        const err = e as { status: number; stderr: string; stdout: string };
        return { status: err.status, stderr: err.stderr, stdout: err.stdout };
      }
      return assert.fail("expected a non-zero exit");
    };
    const recall = fail("--min-recall", "0.9");
    assert.equal(recall.status, 1);
    assert.match(recall.stderr, /impact found the held-out file in 50% of cases, below --min-recall 0\.9/);
    assert.match(recall.stdout, /History evaluation of/, "the report is still printed");
    assert.match(fail("--min-context-hit", "1.5").stderr, /--min-context-hit must be a number from 0 to 1/);
  });

  it("explains what is missing", () => {
    const stderr = (...args: string[]) => {
      try {
        cli(...args);
      } catch (e) {
        return (e as { stderr: string }).stderr;
      }
      return assert.fail("expected a non-zero exit");
    };
    assert.match(stderr("eval", "--root", projectRoot), /eval needs a subcommand: history/);
    assert.match(stderr("eval", "history", "--root", makeRepoOutsideGit()), /No git history to evaluate/);
    assert.match(stderr("eval", "history", "--commits", "0", "--root", projectRoot), /--commits must be a positive integer/);
  });
});
