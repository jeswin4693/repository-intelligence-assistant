/** The RIA tools a role may call. Must match the tools registered in src/server.ts (a test checks it). */
export type RiaTool = "start_task" | "repo_map" | "context_for" | "find_path" | "impact" | "plan_score" | "gate_begin" | "gate_check" | "gate_rollback";

export type RoleId = "autopilot" | "reader" | "analyser" | "extractor" | "writer" | "fixer" | "reviewer";

export interface Role {
  id: RoleId;
  title: string;
  /** Shown in the host's picker, and what Claude Code matches a request against: says when to use the role, in the user's words. */
  description: string;
  /**
   * The role in a few sentences. Injected with every request the router sends to this role, so it stays short;
   * the steps below are the full version.
   */
  brief: string;
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

const NAVIGATION: RiaTool[] = ["start_task", "repo_map", "context_for", "find_path", "impact"];
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
      'Use when the user hands over a whole task, mixes kinds of work ("add X and fix Y", "do it end to end", "take care of this ticket"), or the request is unclear. Splits it into parts, runs each with the right role\'s steps and a baseline, verifies, and asks the user only when a decision is needed.',
    brief:
      "Split the request into parts and name the role for each (new code: Writer, a bug: Fixer, moving code: Extractor, a question: Reader, options or risk: Analyser, a diff: Reviewer). Run each part with that role's steps and a gate baseline, one at a time, checking after each. Ask the user only when a decision is needed. Never commit, push or open a pull request yourself.",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Split the request into parts and name the role for each: a question (answer it, make no edits), new code or files (Writer), a bug or failing check (Fixer), moving or renaming code without changing behaviour (Extractor), options or risk (Analyser), someone else's change (Reviewer). If `start_task` is available, call it with the request to check your reading. If the goal is unclear or has two reasonable readings, ask before doing anything else.",
      "If you do not know the repository, call `repo_map` once. Then call `context_for` with the task as `query` (and `target` when you know a file) and read only the files it returns. For a bug, also call `find_path` from the entry point or the failing test to the suspect code.",
      "For a question or a review: call `impact` on the files involved (for a review, the changed files: read the dependents of any file whose public symbols changed, and the strongly coupled files the diff left out), then answer or report and stop. Make no edits.",
      "For a change: call `impact` once on all the files you expect to change. Files it lists as strongly coupled usually change together with them: read them and decide whether they need changing too.",
      "If there is more than one reasonable approach, write each as a plan (a short name and the files it would change, new files included) and call `plan_score`. Follow the top plan yourself, unless it is a close call, RIA's confidence is low, or the choice depends on something only the user knows: then ask.",
      "Call `gate_begin` before the first edit and make no edits until it returns. It records the baseline, including the failures that already existed.",
      "Make the smallest change that does the task, one part at a time. New code: copy the conventions of the closest existing example, put it beside its siblings, never overwrite an existing file, wire it in where its siblings are registered, and add tests in the same style. A bug: fix the cause, not the check, and add a test that fails without the fix. Moving code: keep the behaviour the same, with no new logic and no changed signatures in the same change, and update every importer `impact` listed.",
      "Call `gate_check` after each part. If it lists problems, fix them and check again, up to two attempts. When the `gate_begin` report offers faster checks, `scope` set to `tied` is enough between parts; finish with a `gate_check` without a scope.",
    ],
    stop: [
      ...afterEditStop(
        "`gate_check` ends with the verdict the task expects (`improved` for a fix, `unchanged` or `improved` for new code, `unchanged` for moving code), lists no unresolved imports or missing exports, and nothing new fails. Then report and stop: say the change is ready and offer to commit it. Do not commit, push or open a pull request yourself.",
      ),
      "For a question or a review: you have answered it from files you read, and you have said which files you did not look at.",
    ],
    report: [
      "The answer, or what you changed and why you chose that approach, in plain words, part by part when there were several.",
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
      'Use when the user wants to understand something or find it: "explain", "where is", "how does", "what does", "show me", "which files", "read", "summarize". Reads only what RIA points to, answers with file and line evidence, and never edits.',
    brief:
      "Do not edit. Use `context_for` (the question as `query`, or a `target`), `find_path` for how two places connect, and `impact` for who uses something. Read only what RIA returns, big files by line range. Answer first, then the evidence as `path:line`, and say what you did not read.",
    edits: false,
    tools: [...NAVIGATION],
    steps: [
      "Say in one line what kind of question it is, and pick the tool for it. Where is it: `context_for` with the question's words as `query`, or its name as `target`. How does it work: `context_for` with the entry point as `target`, then `find_path` from the entry point to the place. Who uses it: `impact` on the file that defines it (its dependents are its users; then search the text for the exact name, because imports are matched by pattern). What is in this folder: `repo_map` with `focus`.",
      "In a repository you do not know yet, call `repo_map` once first (`max_tokens` 3000 is enough for a look). Do not call it twice.",
      "Read the files `context_for` returns in the order it ranks them. Symbols carry line numbers, and a file shown as an outline is too big to read whole: read the symbol you need, not the file.",
      "To explain how two places are connected, call `find_path` between them instead of opening files to trace imports by hand.",
      "`context_for` matches file paths and symbol names, not file contents. If it finds nothing relevant, search the text yourself, then call `context_for` again with what you found.",
    ],
    stop: [
      "The question is answered from files you actually read.",
      "Two `context_for` calls found nothing relevant: say what you searched and ask the user for a hint. Do not guess.",
    ],
    report: [
      "The answer first, in plain words, then the evidence: file paths with line numbers.",
      "What you did not read, and any low-confidence note from RIA that your answer depends on.",
      "The natural next step in one line (for example, \"say so if you want this changed\"), without doing it.",
    ],
  },
  {
    id: "analyser",
    title: "Analyser",
    description:
      'Use when the user wants to judge before acting: "should we", "compare", "which approach", "what would break", "how risky", "how big", "is it safe", "what are my options". Maps what a change would touch and ranks the options with evidence. Does not edit.',
    brief:
      "Do not edit. List at least two approaches, including the smallest. Call `impact` once on all the files involved, then `plan_score` with each approach as a plan. Recommend one with the deciding factors, the files at risk and the tests to run, and say plainly what RIA cannot see.",
    edits: false,
    tools: [...NAVIGATION, "plan_score"],
    steps: [
      "State the decision in one line and list at least two approaches, always including the one that touches the fewest files. Add \"do nothing\" when it is a real option.",
      "Call `context_for` with the task as `query` and read only enough of what it returns to name the files each approach would touch, new files included.",
      "Call `impact` once with all those files together (it takes up to 50). Read the dependents, the hidden-coupling files, the tied tests and the public surface when they matter to the decision.",
      "Call `plan_score` with every approach as a plan. Read the factor lines, not only the total: they say why one plan wins. A lead under 2 points is a close call.",
      "Decide a close call on what RIA cannot see (how easy it is to undo, how simple it is, what the project already does, what changes inside the files), and say that this is what you did.",
      "Use `find_path` when you are unsure how a change reaches a distant file.",
    ],
    stop: [
      "You can name the recommended approach, the files at risk and the tests to run.",
      "RIA's confidence is low and the caveats cannot be resolved by reading: say so and stop instead of guessing.",
    ],
    report: [
      "The recommended approach with its `plan_score` points and the factors that decided it (or why you chose differently).",
      "Files to change, files that may be affected, tests to run.",
      "Confidence and caveats. Be plain that the score ranks the plans you wrote, from files and history, not from what changes inside a file; it is evidence, not proof.",
    ],
  },
  {
    id: "extractor",
    title: "Extractor",
    description:
      'Use when the user wants to restructure without changing behaviour: "refactor", "extract", "split", "move", "rename", "reorganize", "remove duplicates", "decouple", "clean up". Moves code, updates every import, and proves behaviour is unchanged.',
    brief:
      "Behaviour must not change. Call `impact` on the source file: its public surface must keep working and its dependents' imports must change. If no test is tied to the code, add a characterization test first or ask. Call `gate_begin`, move in small steps with no logic or signature changes, update every import, then `gate_check` (goal: `unchanged`).",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Say the move in one line: what moves, from where, to where, and what must stay identical (behaviour and public names).",
      "Call `context_for` with the file or symbol to extract as `target`. Read it and the files that import it. Call `impact` on the source file: its public surface is what must keep working, its dependents are the files whose imports must change, and its tied tests are your safety net.",
      "If no test is tied to the code, a verdict of `unchanged` proves little: add a test that pins the current behaviour first, or ask the user.",
      "If the code could go in several places, compare them with `plan_score`, putting the importers that must change into each plan.",
      "Call `gate_begin` before the first edit and make no edits until it returns.",
      "Move the code in small steps: create the new file with the code as it is, move it, then update every import `impact` listed, tests included, and remove the old copy. Do not rename, change signatures or change logic in the same change.",
      "Search the text for the old path and old names: RIA matches imports by pattern, so strings, dynamic imports, docs and config that mention them are missed.",
      "Call `gate_check`. The test results must be the same as at the baseline. Fix what it lists and check again. When the `gate_begin` report offers faster checks, `scope` set to `tied` runs only the tests tied to the moved code while you iterate; finish with a `gate_check` without a scope.",
    ],
    stop: afterEditStop("`gate_check` ends with `unchanged` (behaviour must not change) and lists no unresolved imports or missing exports."),
    report: [
      "What moved where, and the files whose imports changed.",
      "The gate verdict and confidence, and which tests ran.",
      "Anything not verified: a project with few tests gives a weak check; say which code no test covers.",
    ],
  },
  {
    id: "writer",
    title: "Writer",
    description:
      'Use when the user wants something new: "create", "add", "build", "write", "generate", "implement", "make a new file or folder", a feature, component, endpoint, test or document. Follows the repository\'s own conventions, wires the new code in, adds tests, and checks the result.',
    brief:
      "Find the closest existing example with `context_for` and copy its conventions. Put new files beside their siblings and never overwrite an existing path. Call `impact` on the existing files you will edit (an index, a router, a config) and `gate_begin` before the first edit. Write the smallest complete change with tests in the repository's style, then `gate_check` and fix what it lists, twice at most. Report the files, the tests and the verdict.",
    edits: true,
    tools: [...NAVIGATION, "plan_score", ...GATE],
    steps: [
      "Call `context_for` with the task as `query`. Pick the closest existing example of the same kind (a sibling file, component, route or test) and read it. Copy its conventions: the folder, the file name, the exports, the style, the error handling and the test layout.",
      "Choose where the new file or folder goes: beside its siblings, named the way they are. If the path already exists, do not overwrite it: choose another and say so, or ask.",
      "Find where new code has to be registered (an index or barrel file, a router, a registry, a config, a list of exports, the docs) by looking at how its sibling is. Call `impact` once on the existing files you will edit; there is nothing to analyse in files you only create. Files listed as strongly coupled usually change together with them: read them and decide whether they need changing too.",
      "If there is more than one reasonable approach, write each as a plan and call `plan_score`. Follow the top plan unless you can name something RIA cannot see that changes the order, and say so.",
      "Call `gate_begin` before the first edit and make no edits until it returns.",
      "Write the smallest complete thing that does what was asked: no stubs or TODO placeholders, no extra features, and no new dependency without asking. Add tests in the style of the sibling tests, one for each behaviour and one for a failure or edge case. Update the dependents `impact` listed if a public signature changed.",
      "Call `gate_check`. Fix what it lists and check again. When the `gate_begin` report offers faster checks, `gate_check` with `scope` set to `tied` runs only the tests tied to your change while you iterate; finish with a `gate_check` without a scope, which runs everything.",
    ],
    stop: afterEditStop(
      "`gate_check` ends with `unchanged` or `improved`, lists no unresolved imports or missing exports, and the number of tests that ran went up by the ones you added. For files that are not code (documents, config) the gate cannot verify the content: say so.",
    ),
    report: [
      "The files you created or changed, what each does and where it is wired in.",
      "The gate verdict and confidence, the tests you added, and the tests that ran.",
      "Anything you left out, and anything the gate could not verify.",
    ],
  },
  {
    id: "fixer",
    title: "Fixer",
    description:
      'Use when something is broken: "fix this", "it doesn\'t work", "failing test", "error", "crash", "bug", a stack trace or a failing build. Reproduces it, finds the cause, makes the smallest fix, adds a regression test, and proves it with the project\'s own checks.',
    brief:
      "Pin down the symptom: the exact error, the failing test. Locate it with `context_for` using the error text, and `find_path` from the failing test to the suspect code. Find the cause, not the symptom, and say it in one sentence with the evidence. Call `gate_begin` before the first edit, make the smallest fix, add a regression test, then `gate_check` (goal: `improved`). Never weaken a test to make it pass.",
    edits: true,
    tools: [...NAVIGATION, ...GATE],
    steps: [
      "Pin down the symptom: the exact error text, the failing test or command, and what should have happened. If you cannot tell what \"fixed\" would look like, ask one question.",
      "Call `context_for` with the error text, the names in the stack trace or the symptom as `query` (and `target` when you know the file). Read the files it returns.",
      "Call `find_path` from the failing test or the entry point to the suspect code to see how it is reached, and read the failing frame and its callers.",
      "Find the cause, not the symptom, and say it in one sentence with the evidence (the line, the value, the condition). Call `impact` on the file you will fix: dependents tell you who relies on the behaviour, and strongly coupled files may carry the same bug. Fix them too only if it is the same bug; otherwise mention them.",
      "Call `gate_begin` before the first edit. Its baseline records which failures already existed, so you neither claim nor cause the wrong ones; if the failure you are fixing appears there, that is your reproduction. Make no edits until it returns.",
      "Make the smallest change that removes the cause, with no refactoring or unrelated edits. Add or update a test that fails without the fix when you can.",
      "Call `gate_check`. The goal is that the failure is gone and nothing new fails.",
    ],
    stop: afterEditStop(
      "`gate_check` ends with `improved`: the failure you set out to fix now passes and nothing new fails. If it ends `unchanged`, no existing check proves the fix: say so.",
    ),
    report: [
      "The cause, in one or two sentences, and the evidence for it.",
      "What you changed, the gate verdict, and the failures that were already there before your change.",
      "Places that may have the same bug and that you did not change, and anything you could not reproduce or verify.",
    ],
    rules: ["Never make a check pass by deleting or weakening a test unless the user asked for that."],
  },
  {
    id: "reviewer",
    title: "Reviewer",
    description:
      'Use when the user wants someone else\'s change checked: "review", "look over this diff", "check my changes", "PR review", "before I commit or merge". Finds what the change affects, what it left out and what is untested. Reports findings by severity and never edits.',
    brief:
      "Do not edit. Get the diff (`git diff`), call `impact` on the changed files, and check the dependents of any changed public symbol, the hidden-coupling files the diff left out, the tests for new behaviour, edge cases and security basics. Report findings by severity (blocker, major, minor, nit) with `path:line`, keeping RIA's evidence apart from your own judgement.",
    edits: false,
    tools: [...NAVIGATION],
    steps: [
      "Get the change: `git diff` for uncommitted work, `git diff <base>...HEAD` for a branch, or the diff of the pull request the user points at. If you cannot see it, ask the user for it. List the changed files, and say which generated or lock files you skipped.",
      "Call `impact` once on all the changed files. Read the dependents of any file whose public symbols changed and check they still fit, and look at the hidden-coupling files it lists: files that usually change together with these but are not in the diff. Ask whether each should have changed.",
      "Check each changed file: does it do what the change claims; does a changed public signature still fit its dependents; are the error and edge cases handled; does each changed source file have a tied test, and does the diff add or update tests for new behaviour; are there security problems (secrets, unsafe input, missing checks); is there leftover debug or TODO code.",
      "Use `context_for` on a changed file to see the conventions around it when something looks out of place.",
      "Label each finding: blocker (breaks behaviour or is unsafe), major, minor or nit. Give the file and line, why it matters, and a suggested fix.",
    ],
    stop: ["Every changed file has been looked at, or you say which ones you did not review.", "RIA could not analyse a file (an unsupported language or unresolved imports): say so instead of implying it was checked."],
    report: [
      "Findings ordered by severity, each with the file and line.",
      "Keep what RIA computed (dependents, coupling, tests) separate from your own judgement.",
      "A recommendation (ready, or changes needed), the confidence and caveats from RIA, and the files you did not review.",
    ],
  },
];

export const ROLE_IDS = ROLES.map((r) => r.id);

export const roleById = (id: string): Role | undefined => ROLES.find((r) => r.id === id);
