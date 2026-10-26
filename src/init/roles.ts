/** The RIA tools a role may call. Must match the tools registered in src/server.ts (a test checks it). */
export type RiaTool = "repo_map" | "context_for" | "find_path" | "impact" | "plan_score" | "gate_begin" | "gate_check" | "gate_rollback";

export interface Role {
  id: string;
  title: string;
  /** Shown in the host's picker; says when to use the role. */
  description: string;
  /** False for roles that only read: on Copilot they are not given an edit tool. */
  edits: boolean;
  tools: RiaTool[];
  steps: string[];
  stop: string[];
  report: string[];
  /** Things the role must never do, shown under Limits. */
  rules?: string[];
  /** For a role that works on its own: the only situations in which it stops to ask the user. */
  ask?: string[];
}

const NAVIGATION: RiaTool[] = ["repo_map", "context_for", "find_path", "impact"];
const GATE: RiaTool[] = ["gate_begin", "gate_check", "gate_rollback"];

/** `done` says what a good `gate_check` looks like for the role; the other two conditions are the same for every role that edits. */
const afterEditStop = (done: string) => [
  done,
  "`gate_check` reports `regressed` or `mixed` and two attempts did not fix it: call `gate_rollback` (a preview), show the user what it would undo, and ask. Do not keep trying.",
  "The verdict is `unverified` (RIA found no check commands to compare): say so plainly, and do not describe the change as verified.",
];

export const ROLES: Role[] = [
  {
    id: "autopilot",
    title: "Autopilot",
    description:
      "Use when the user hands over a whole coding task (a feature, a bug, a refactor, a question or a review) and wants it done start to finish. It picks the approach, edits with a baseline, verifies, and asks the user only when something needs their decision.",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Work out what is being asked: a question (answer it, make no edits), a change (a feature, a fix, or moving code), or a review of someone else's change. If the goal is unclear or has two reasonable readings, ask before doing anything else.",
      "If you do not know the repository, call `repo_map` once. Then call `context_for` with the task as `query` (and `target` when you know a file) and read only the files it returns. For a bug, also call `find_path` from the entry point or the failing test to the suspect code.",
      "For a question or a review: call `impact` on the files involved (for a review, the changed files: read the dependents of any file whose public symbols changed, and the strongly coupled files the diff left out), then answer or report and stop. Make no edits.",
      "For a change: call `impact` on the files you expect to change. Files it lists as strongly coupled usually change together with them: read them and decide whether they need changing too.",
      "If there is more than one reasonable approach, write each as a plan (a short name and the files it would change, new files included) and call `plan_score`. Follow the top plan yourself, unless it is a close call, RIA's confidence is low, or the choice depends on something only the user knows: then ask.",
      "Call `gate_begin` before the first edit and make no edits until it returns. It records the baseline, including the failures that already existed.",
      "Make the smallest change that does the task. Add or update tests for new or fixed behaviour. When moving code, keep the behaviour the same: no new logic and no changed signatures in the same change. Update the dependents `impact` listed if a public signature changed. Fix the cause of a bug, never the check.",
      "Call `gate_check`. If it lists problems, fix them and check again, up to two attempts.",
    ],
    stop: [
      ...afterEditStop(
        "`gate_check` ends with the verdict the task expects (`improved` for a fix, `unchanged` or `improved` for new code, `unchanged` for moving code), lists no unresolved imports or missing exports, and nothing new fails. Then report and stop: say the change is ready and offer to commit it. Do not commit, push or open a pull request yourself.",
      ),
      "For a question or a review: you have answered it from files you read, and you have said which files you did not look at.",
    ],
    report: [
      "The answer, or what you changed and why you chose that approach, in plain words.",
      "The gate verdict and confidence, the tests you added, and the tests that ran.",
      "What you decided on your own, and anything you left out or could not verify.",
    ],
    rules: ["Never commit, push, open a pull request or apply `gate_rollback` on your own: those need the user's yes.", "Never make a check pass by deleting or weakening a test unless the user asked for that."],
    ask: [
      "The task is unclear, has two reasonable readings, or names a file or symbol that does not exist or is ambiguous.",
      "The right behaviour depends on a preference or a business rule that no file or test settles.",
      "`plan_score` calls it a close call, or RIA's confidence is low.",
      "`gate_begin` finds no build or test command to run, so the change could not be verified: say so and ask whether to go on or to add a test first.",
      "The change needs files beyond the plan, or changes a public signature that other files rely on and you cannot update them all.",
      "Something cannot be undone or leaves the repository: deleting files you did not create, installing or upgrading packages, network calls, credentials.",
    ],
  },
  {
    id: "reader",
    title: "Reader",
    description:
      "Use to understand or explain how part of a repository works, find where something is implemented, or answer a question about the code. Reads only the files RIA points to and never edits.",
    edits: false,
    tools: ["repo_map", "context_for", "find_path"],
    steps: [
      "In a repository you do not know yet, call `repo_map` once (with `focus` for one directory) to learn the layout, the entry points and the most depended-on files.",
      "Call `context_for` with the question as `query`, or a file or symbol as `target`. Read only the files it returns. Symbols carry line numbers, so read a large file in part.",
      "To explain how two places are connected, call `find_path` between them instead of opening files to trace imports by hand.",
      "`context_for` matches file paths and symbol names, not file contents. If it finds nothing relevant, search the text yourself, then call `context_for` again with what you found.",
    ],
    stop: [
      "The question is answered from files you actually read.",
      "Two `context_for` calls found nothing relevant: say what you searched and ask the user for a hint. Do not guess.",
    ],
    report: ["The answer first, then the evidence: file paths with line numbers.", "What you did not read, and any low-confidence note from RIA that your answer depends on."],
  },
  {
    id: "analyser",
    title: "Analyser",
    description:
      "Use before a change to judge its size and risk: what it would touch, what could break, which tests cover it, and which of several approaches is safest. Does not edit.",
    edits: false,
    tools: [...NAVIGATION, "plan_score"],
    steps: [
      "Call `context_for` with the task as `query` to find the files involved, and read what it returns.",
      "Call `impact` on the files that would change. Read the dependents and the hidden-coupling files it lists when they matter to the task.",
      "If there is more than one reasonable way to do the task, write each as a plan (a short name and the files it would change, new files included) and call `plan_score`. Always include the plan that touches the fewest files.",
      "Use `find_path` when you are unsure how a change reaches a distant file.",
    ],
    stop: [
      "You can name the recommended approach, the files at risk and the tests to run.",
      "RIA's confidence is low and the caveats cannot be resolved by reading: say so and stop instead of guessing.",
    ],
    report: [
      "The recommended approach with its `plan_score` points and the factors that decided it (or why you chose differently).",
      "Files to change, files that may be affected, tests to run.",
      "Confidence and caveats, and what RIA cannot see: it ranks files, not what changes inside them.",
    ],
  },
  {
    id: "extractor",
    title: "Extractor",
    description:
      "Use to move or split code without changing what it does: pull a function or class into its own file, merge duplicates, or move code to another module. Changes imports, not behaviour.",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Call `context_for` with the file or symbol to extract as `target`. Read it and the files that import it.",
      "Call `impact` on the source file. Its public surface is what must keep working, and its dependents are the files whose imports must change.",
      "If the code could go in several places, compare them with `plan_score`. Put the importers that must change into each plan.",
      "Call `gate_begin` before the first edit and make no edits until it returns.",
      "Move the code in small steps: create the new file, move the code, then update every import `impact` listed, tests included. Do not change signatures or logic in the same change.",
      "Call `gate_check`. The test results must be the same as at the baseline. Fix what it lists and check again.",
    ],
    stop: afterEditStop("`gate_check` ends with `unchanged` (behaviour must not change) and lists no unresolved imports or missing exports."),
    report: [
      "What moved where, and the files whose imports changed.",
      "The gate verdict and confidence, and which tests ran.",
      "Anything not verified: a project with few tests gives a weak check.",
    ],
  },
  {
    id: "writer",
    title: "Writer",
    description:
      "Use to add a feature or new code: find the code to follow, choose between approaches, edit with a baseline recorded, and check the result against the project's own build and tests.",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Call `context_for` with the task as `query` and read the files it returns, to learn the conventions you must follow.",
      "Call `impact` on the files you expect to change. Files listed as strongly coupled usually change together with them: read them and decide whether they need changing too.",
      "If there is more than one reasonable approach, write each as a plan and call `plan_score`. Follow the top plan unless you can name something RIA cannot see that changes the order, and say so.",
      "Call `gate_begin` before the first edit and make no edits until it returns.",
      "Make the change, with tests for the new behaviour. Update the dependents `impact` listed if a public signature changed.",
      "Call `gate_check`. Fix what it lists and check again.",
    ],
    stop: afterEditStop("`gate_check` ends with `unchanged` or `improved`, lists no unresolved imports or missing exports, and your new tests are among the ones that pass."),
    report: [
      "What you changed and why you chose that approach.",
      "The gate verdict and confidence, the tests you added, and the tests that ran.",
      "Anything you left out, and anything the gate could not verify.",
    ],
  },
  {
    id: "fixer",
    title: "Fixer",
    description:
      "Use to fix a bug or a failing build or test: find the cause from the symptom, make the smallest fix, and prove it with the project's own checks. Rolls back if the fix does not work.",
    edits: true,
    tools: [...NAVIGATION, ...GATE],
    steps: [
      "Call `context_for` with the error text or the symptom as `query` (and `target` when you know the file). Read the files it returns.",
      "Call `find_path` from the entry point or the failing test to the suspect code to see how it is reached.",
      "Call `gate_begin` before the first edit. Its baseline records which failures already existed, so you neither claim nor cause the wrong ones. Make no edits until it returns.",
      "Call `impact` on the file you will fix, then make the smallest change that removes the cause. Add or update a test that fails without the fix when you can.",
      "Call `gate_check`. The goal is that the failure is gone and nothing new fails.",
    ],
    stop: afterEditStop(
      "`gate_check` ends with `improved`: the failure you set out to fix now passes and nothing new fails. If it ends `unchanged`, no existing check proves the fix: say so.",
    ),
    report: [
      "The cause, in one or two sentences, and the evidence for it.",
      "What you changed, the gate verdict, and the failures that were already there before your change.",
      "Anything you could not reproduce or verify.",
    ],
    rules: ["Never make a check pass by deleting or weakening a test unless the user asked for that."],
  },
  {
    id: "reviewer",
    title: "Reviewer",
    description:
      "Use to review a change someone else made (uncommitted changes, a branch or a pull request): what it affects, what it left out, and whether tests cover it. Reports findings and never edits.",
    edits: false,
    tools: [...NAVIGATION],
    steps: [
      "Get the list of changed files from the diff the user points at. If you cannot see it, ask the user for it.",
      "Call `impact` on the changed files. Read the dependents of any file whose public symbols changed and check they still fit.",
      "Look at the hidden-coupling files `impact` lists: files that usually change together with these but are not in the diff. Ask whether each should have changed.",
      "Check that each changed source file has a tied test, and that the diff adds or updates tests for new behaviour.",
      "Use `context_for` on a changed file to see the conventions around it when something looks out of place.",
    ],
    stop: ["Every changed file has been looked at, or you say which ones you did not review.", "RIA could not analyse a file (an unsupported language or unresolved imports): say so instead of implying it was checked."],
    report: [
      "Findings ordered by severity, each with the file and line.",
      "Keep what RIA computed (dependents, coupling, tests) separate from your own judgement.",
      "Confidence and caveats from RIA, and the files you did not review.",
    ],
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);
