import { RepoIndex } from "../repo/repo-index";
import { ImpactResult } from "../tools/impact";
import { Change } from "./snapshot";
import { CommandResult } from "./types";

/**
 * `gate_check` with `scope: "tied"`: run only the tests tied to the changed files instead of the whole suite.
 *
 * Running fewer tests can make a gate say "fine" about something it did not look at, so this only happens when it is
 * sound enough, and otherwise the whole command runs and the report says why:
 *  - the project said how to run a subset (`gate.targeted.test` in ria.config.json): the command is never made up
 *    here, and the caller of the tool only picks a scope, never a command;
 *  - the tests were green at the baseline: with failures already there, only the whole run can tell new from old;
 *  - some test is tied to the change, and not most of them (then there is nothing to save).
 */

/** When the tied tests are more than this share of all test files, running everything costs about the same. */
export const MAX_TIED_SHARE = 0.6;

/** File names go into a shell command, so only plainly safe ones are passed on. */
const SAFE_PATH = /^[A-Za-z0-9_./@+-]+$/;

export type TargetedPlan = { command: string; files: string[]; of: number } | { reason: string };

export function planTargeted(opts: {
  template: string | undefined;
  index: RepoIndex;
  changes: Change[];
  blast: ImpactResult | undefined;
  baseline: CommandResult | undefined;
}): TargetedPlan {
  const { template, index, changes, blast, baseline } = opts;
  if (!template) return { reason: "no targeted test command is configured (add gate.targeted.test, with a {files} placeholder, to ria.config.json)" };
  if (!template.includes("{files}")) return { reason: "gate.targeted.test in ria.config.json has no {files} placeholder" };
  if (!baseline) return { reason: "no test command was run at the baseline, so there is nothing to compare a partial run with" };
  if (baseline.status !== "pass") {
    return { reason: "the tests were already failing at the baseline, and only a full run can tell a new failure from an old one" };
  }

  const isTest = (p: string) => index.files.get(p)?.isTest === true;
  const tied = new Set<string>();
  for (const c of changes) if (c.status !== "D" && isTest(c.path)) tied.add(c.path);
  for (const t of blast?.tests ?? []) if (isTest(t.path)) tied.add(t.path);
  if (tied.size === 0) return { reason: "no test is tied to the changed files, so there is nothing to narrow the run to" };

  const total = [...index.files.values()].filter((f) => f.isTest).length;
  if (total > 0 && tied.size > MAX_TIED_SHARE * total) {
    return { reason: `the tied tests are ${tied.size} of ${total} test files, so a full run costs about the same` };
  }
  const files = [...tied].sort();
  if (files.some((f) => !SAFE_PATH.test(f))) return { reason: "a tied test has a path with characters that are not safe to put in a command" };

  return { command: template.split("{files}").join(files.join(" ")), files, of: total };
}
