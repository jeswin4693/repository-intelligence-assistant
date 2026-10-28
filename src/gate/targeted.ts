import * as fs from "node:fs";
import * as path from "node:path";
import { RepoIndex } from "../repo/repo-index";
import { ImpactResult } from "../tools/impact";
import { CommandSpec, GateConfig } from "./detect";
import { Change } from "./snapshot";
import { CommandResult } from "./types";

/**
 * `gate_check` with `scope: "tied"`: run only the tests tied to the changed files instead of the whole suite.
 *
 * Running fewer tests can make a gate say "fine" about something it did not look at, so this only happens when it is
 * sound enough, and otherwise the whole command runs and the report says why:
 *  - the project said how to run a subset (`gate.targeted.test` in ria.config.json), or its own test script is one RIA
 *    knows how to narrow (see `targetedSetup`): a command is never made up from the caller of the tool, who only picks
 *    a scope;
 *  - the tests were green at the baseline: with failures already there, only the whole run can tell new from old;
 *  - no configuration file changed: a changed `package.json`, `jest.config.*` or `conftest.py` can affect every test;
 *  - some test is tied to the change, and not most of them (then there is nothing to save).
 */

/** When the tied tests are more than this share of all test files, running everything costs about the same. */
export const MAX_TIED_SHARE = 0.6;

/** File names go into a shell command, so only plainly safe ones are passed on. */
const SAFE_PATH = /^[A-Za-z0-9_./@+-]+$/;

/** A changed file like these can change what every test does, so the tied tests alone prove nothing. */
const AFFECTS_EVERY_TEST =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|jest\.config\.[^/]+|jest\.setup\.[^/]+|vitest\.(config|workspace|setup)\.[^/]+|vite\.config\.[^/]+|babel\.config\.[^/]+|\.babelrc[^/]*|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|requirements[^/]*\.txt|ria\.config\.json)$/;

export interface TargetedSetup {
  /** The command with a `{files}` placeholder. */
  template: string;
  /** Where it came from, for the report. */
  source: string;
  /** Which of the tied test files the runner would pick up as a test (a helper in `tests/` is not one). */
  runnable?: RegExp;
}

export type TargetedPlan = { command: string; files: string[]; of: number } | { reason: string };

// ---------------------------------------------------------------- what RIA knows about test commands

/** Words from a test script that are safe to repeat in a command: no quoting, globbing, chaining or substitution. */
const PLAIN_WORD = /^[A-Za-z0-9_.\/@=:+-]+$/;

/** Options of the runner that change how it prints or runs, not what it counts; anything else (coverage thresholds, configs, filters) may. */
const JEST_OPTIONS = new Set(["--ci", "--silent", "--runInBand", "-i", "--colors", "--no-color", "--forceExit", "--passWithNoTests", "--watchAll=false"]);
const VITEST_OPTIONS = new Set(["run", "--run", "--silent", "--passWithNoTests", "--watch=false", "--no-color", "--color"]);

const JEST_FILES = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/;
const VITEST_FILES = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PYTEST_FILES = /(^|\/)test_[^/]*\.py$|_test\.py$/;

function testScript(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.test;
    return typeof script === "string" ? script.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How to run only some of the project's tests: the project's own `gate.targeted.test` first, else a command derived
 * from the test command RIA found, but only where that is exactly one known runner and the narrower command is the
 * same runner with the same options plus file names:
 *  - `node --test` (with any plain node options before it), jest and vitest, when the project's package manager is npm;
 *  - pytest, when RIA found the pytest configuration or tests itself.
 * Anything else (a wrapper, a chain with `&&`, coverage, a package manager RIA has not been checked with) returns
 * undefined and the whole test command runs. Go caches test results and so is not narrowed.
 */
export function targetedSetup(root: string, config: GateConfig, testSpec: CommandSpec | undefined): TargetedSetup | undefined {
  const configured = config.targeted?.test;
  if (configured) return { template: configured, source: "ria.config.json" };
  if (!testSpec || testSpec.source === "ria.config.json") return undefined;

  if (testSpec.name === "test" && testSpec.command === "python -m pytest -q" && testSpec.source.startsWith("pytest")) {
    return { template: "python -m pytest -q {files}", source: "pytest", runnable: PYTEST_FILES };
  }
  if (testSpec.command !== "npm run test") return undefined;
  const script = testScript(root);
  if (!script) return undefined;
  const words = script.split(/\s+/);
  if (words.some((w) => !PLAIN_WORD.test(w))) return undefined;

  if (words[0] === "node" && words.length > 1 && words[words.length - 1] === "--test") {
    return { template: `${script} {files}`, source: "package.json test script (node --test)" };
  }
  const options = words.slice(1);
  if (words[0] === "jest" && options.every((w) => JEST_OPTIONS.has(w))) {
    return { template: ["npx --no-install jest --runTestsByPath", ...options, "{files}"].join(" "), source: "package.json test script (jest)", runnable: JEST_FILES };
  }
  if (words[0] === "vitest" && options.every((w) => VITEST_OPTIONS.has(w))) {
    const kept = options.filter((w) => w !== "run" && w !== "--run");
    return { template: ["npx --no-install vitest run", ...kept, "{files}"].join(" "), source: "package.json test script (vitest)", runnable: VITEST_FILES };
  }
  return undefined;
}

// ---------------------------------------------------------------- the plan

export function planTargeted(opts: {
  template: string | undefined;
  /** Of the tied test files, only these are passed on; the others are helpers the runner would not pick up as tests. */
  runnable?: RegExp;
  index: RepoIndex;
  changes: Change[];
  blast: ImpactResult | undefined;
  baseline: CommandResult | undefined;
}): TargetedPlan {
  const { template, runnable, index, changes, blast, baseline } = opts;
  if (!template) return { reason: "no targeted test command is configured or known for this test command (add gate.targeted.test, with a {files} placeholder, to ria.config.json)" };
  if (!template.includes("{files}")) return { reason: "gate.targeted.test in ria.config.json has no {files} placeholder" };
  if (!baseline) return { reason: "no test command was run at the baseline, so there is nothing to compare a partial run with" };
  if (baseline.status !== "pass") {
    return { reason: "the tests were already failing at the baseline, and only a full run can tell a new failure from an old one" };
  }
  const shared = changes.find((c) => AFFECTS_EVERY_TEST.test(c.path));
  if (shared) return { reason: `${shared.path} changed, which can change what every test does` };

  const isTest = (p: string) => index.files.get(p)?.isTest === true && (!runnable || runnable.test(p));
  const tied = new Set<string>();
  for (const c of changes) if (c.status !== "D" && isTest(c.path)) tied.add(c.path);
  for (const t of blast?.tests ?? []) if (isTest(t.path)) tied.add(t.path);
  if (tied.size === 0) return { reason: "no test is tied to the changed files, so there is nothing to narrow the run to" };

  const total = [...index.files.keys()].filter(isTest).length;
  if (total > 0 && tied.size > MAX_TIED_SHARE * total) {
    return { reason: `the tied tests are ${tied.size} of ${total} test files, so a full run costs about the same` };
  }
  const files = [...tied].sort();
  if (files.some((f) => !SAFE_PATH.test(f))) return { reason: "a tied test has a path with characters that are not safe to put in a command" };

  return { command: template.split("{files}").join(files.join(" ")), files, of: total };
}
