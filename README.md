# Repository Intelligence Assistant (RIA)

RIA is a tool layer for AI chats (Copilot Chat in VS Code, Claude Code, any MCP client). It gives
the chat a precomputed picture of a repository, so it reads the right files instead of searching
blindly, and it checks every change before and after, so mistakes are caught and can be undone.

It has no LLM and needs no API key: the chat model reasons and writes code, RIA supplies
navigation, evidence and verification. It works on any repository and any language.

**Contents**
[In plain words](#in-plain-words) ·
[The idea](#the-idea) ·
[Architecture](#architecture) ·
[Status](#status-what-is-built) ·
[Tools](#tools) ·
[The change gate](#the-change-gate) ·
[Use it](#use-it) ·
[How the analysis works](#how-the-analysis-works) ·
[Roadmap](#roadmap-what-is-left-to-build) ·
[Known limits](#known-limits) ·
[Develop](#develop)

---

## In plain words

Think of the AI chat as a new employee in a big office, and RIA as the building directory plus a
safety inspector.

- **The directory** tells the employee which files matter for a task, how files are connected,
  and what could break if one of them changes.
- **The inspector** saves the state of the project before the employee starts, runs the
  project's own build and tests again afterwards, says what got better or worse, and can put
  everything back exactly as it was.

The loop an AI chat follows with RIA:

```text
pick the role -> orient  ->  find the right files  ->  compare plans  ->  gate_begin  ->  edit  ->  gate_check  ->  fix or gate_rollback
start_task       repo_map    context_for / impact      plan_score         baseline        chat     better/worse     undo if needed
```

The first step is automatic. RIA reads what you typed and decides which kind of work it is: something new (the
**Writer**), a bug (the **Fixer**), a question about the code (the **Reader**), a judgement about options or risk (the
**Analyser**), moving code without changing it (the **Extractor**), a check of someone's change (the **Reviewer**), or a
whole task or several at once (the **Autopilot**). Each role has its own steps, so "create a new file" and "fix this
error" are not handled the same way. See "Roles, and how the right one is chosen".

---

## The idea

**Problem.** AI chats are good at writing code and weak at two things: finding the right
files in a large project without reading everything, and knowing whether their change broke
something. Other tools answer "what does this code do?". RIA answers "what should I read?",
"what will this touch?" and "did my change make things better or worse?".

**Principles** (these decide what gets built and what does not):

1. **The chat is the brain, RIA is the toolbox.** No LLM inside RIA, no API key. It plugs into
   whatever AI chat the user already has, through MCP (and the same tools work from a terminal).
2. **Any language, any project, any task.** No domain dependencies. Business Central/AL and
   Made2Manage are deliberately not special-cased.
3. **Evidence, not guesses.** Every answer is computed from files, imports and git history, says
   where it came from, and says how far to trust it.
4. **Safe by design.** The model can choose among the project's own commands but cannot supply
   one. Rollback previews before it acts. RIA writes only to `.ria/` and, for gate snapshots, to
   private git objects and refs (`refs/ria/*`); it never touches your index, stash or branches.
   Anything fetched from the web is untrusted (when the skill forge exists).
5. **Verify, do not trust.** A change is not done until the gate has compared it with a baseline.

**What makes it different from other repo assistants**

| Idea | What it means | Status |
|---|---|---|
| Verified change loop | Baseline before an edit, comparison after, verdict, byte-exact undo | **Built** |
| Path planning with scoring | Several candidate plans are ranked by blast radius, test coverage and ignored coupling before editing | **Built** |
| Skill forge | Learn from web sources into reusable skills, with provenance, sandbox test and human approval | Planned (step 5) |
| Roles as configuration | Reader, Analyser, Extractor, Writer, Fixer, Reviewer and Autopilot are instruction files that tell the chat which RIA tools to use in which order; `ria init` installs them for Claude Code and Copilot | **Built** |
| The role follows the request | The wording of each request picks the role (a router with no model in it): a `start_task` tool for any chat, and a Claude Code hook that adds the role to every request | **Built**, checked in Claude Code |

---

## Architecture

```text
 You  <->  AI chat in VS Code (Copilot Chat / Claude Code / any MCP client)
                  |   reasons, reads, edits files, decides when to call a tool
                  v   MCP over stdio                                  same tools from a terminal
 +--------------- src/server.ts ---------------+                     +--- src/index.ts (CLI) ---+
 |  repo_map  context_for  find_path  impact    |   NAVIGATION        |  ria map | context |     |
 |  plan_score                                  |   PLANNING          |  path | impact | plan    |
 |  gate_begin  gate_check  gate_rollback       |   CHANGE GATE       |  gate ... | init         |
 +----------------------+-----------------------+                     +--------------------------+
                        |
        +---------------+------------------------------+
        v                                              v
 REPO INTELLIGENCE LAYER (src/repo, src/git)     GATE ENGINE (src/gate)
  file list -> symbols + imports (regex rows)      snapshot   git commit from a private index, byte-exact
  imports -> repo files (per-language resolvers)   detect     the project's own build/typecheck/lint/test
  import graph (who uses whom, shortest path)      run        timeout, process-tree kill, capped output
  git history -> co-change coupling                parse      test counts, failed tests, diagnostics
  incremental cache (.ria/index.json)              compare    new vs fixed problems -> verdict + confidence
        |                                                |
        v                                                v
 your repository (read only)        .ria/  (index cache, gate runs; ignores itself)
                                    .git/refs/ria/gate/<run id>  (snapshot commits)

 Planned on top: skill forge, VS Code extension.
```

### Code map

| Area | Files | Job |
|---|---|---|
| Entry points | `src/index.ts`, `src/server.ts` | CLI (`ria ...`) and the MCP server; tool schemas and descriptions the chat sees |
| Index | `src/repo/languages.ts`, `extract.ts` | What counts as a file, language by extension, symbols and imports from per-language regex rows |
| Graph | `src/repo/resolve.ts`, `graph.ts` | Import to file resolution per language; graph, reach (BFS), shortest path (Dijkstra) |
| Index store | `src/repo/repo-index.ts`, `ria-dir.ts` | File listing (git or walk), incremental refresh, `.ria/` cache, target resolution (path, suffix, symbol) |
| History | `src/git/history.ts` | `git` wrapper (stderr kept, long paths on), co-change from `git log` |
| Navigation tools | `src/tools/repo-map.ts`, `context.ts`, `find-path.ts`, `impact.ts`, `plan-score.ts`, `shared.ts` | The five read-only tools and their text reports |
| Routing | `src/tools/route.ts` | `start_task` and `ria route`: which role a request calls for (word and phrase rules, no model), the role's playbook, and the short note the hook adds |
| Gate | `src/gate/snapshot.ts` | Byte-exact snapshots in git, diff between snapshots, restore |
| | `src/gate/detect.ts`, `runner.ts` | Find the project's commands; run them with timeout and heartbeat |
| | `src/gate/parse.ts`, `compare.ts` | Read test and compiler output; compare with baseline; verdict and confidence |
| | `src/gate/store.ts`, `gate.ts`, `types.ts` | Run state on disk, pruning; begin / check / rollback and the report |
| | `src/gate/targeted.ts` | `gate_check` with `scope: "tied"`: whether and how to run only the tests tied to the changed files (the narrow commands RIA knows for jest, vitest, node --test and pytest), and why it falls back |
| Roles | `src/init/roles.ts`, `render.ts`, `init.ts` | The seven roles written once; rendered as Claude Code skills and VS Code agents; `ria init` plans and applies the install, hooks included (CLI only, not an MCP tool) |
| Hooks | `src/hooks/prompt.ts`, `stop.ts` | `ria hook prompt`: the Claude Code `UserPromptSubmit` hook that tells the chat which role each request needs. `ria hook stop`: the `Stop` hook that holds the chat back while the gate says its change made things worse |
| Evaluation | `src/eval/history-eval.ts`, `gate-eval.ts` | `ria eval history`: replays a repository's git history against the tools. `ria eval gate`: the gate against injected faults in throwaway projects |
| Tests | `tests/*.test.ts`, `tests/helpers.ts` | 307 tests: parsers, graph, git history, plan scoring, roles and install, role routing and its prompt sets, evaluation, snapshots, full gate flows, both hooks, real MCP client over stdio |

### What happens on a call

- **Navigation tool** (`impact`, for example): refresh the index (re-read only files whose size or
  mtime changed) -> build the graph if anything changed -> resolve the file or symbol the caller
  named -> compute dependents, co-change partners, tests and a risk score -> return a text report.
- **`plan_score`**: resolve every file of every plan (files not in the index count as files the plan
  creates) -> run `impact` on each plan's files -> turn the result into five point components -> sort
  by total, with ties broken by content so the order never depends on how the plans were listed.
- **`ria eval history`** (command line only): read the log -> for each recent commit, rebuild the history of the
  commits older than it and make the index answer from that -> ask `impact` and `context_for` the question a
  developer would have had -> score the answers against what the commit really touched, and against baselines.
- **`ria init`** (command line only): work out every file to write (one MCP config entry and seven role files per
  host) without touching disk -> print that as a preview -> write only with `--apply`. It does not index the
  repository, so it creates no `.ria/` folder.
- **`gate_begin`**: detect commands -> run each -> snapshot the tree (after the runs, so side
  effects of the checks are part of the starting state) -> save the run under `.ria/gate/<id>/`.
- **`gate_check`**: snapshot the edited tree -> list changed files -> re-run the commands ->
  compare with the baseline -> check imports and exports -> run `impact` on the changed files ->
  verdict, confidence and "may be affected".
- **`gate_rollback`**: snapshot now -> diff against the baseline -> preview, or restore changed
  files and delete added ones -> verify the tree matches the baseline again.

### On-disk state

| Where | What | Cleanup |
|---|---|---|
| `.ria/index.json` | Per-file symbols, imports, size, mtime | Safe to delete; rebuilt on the next call |
| `.ria/gate/<id>/` | `run.json`, the private snapshot index (`raw.idx`), command logs | Last 5 runs kept, older ones pruned at `gate_begin` |
| `.git/refs/ria/gate/<id>` | The baseline snapshot commit, so git does not collect it | Dropped with its run |
| `.ria/.gitignore` | Contains `*`, so `.ria/` never shows in `git status` or in a snapshot | |

### Design decisions

| Decision | Why |
|---|---|
| An MCP server, not an agent | Works with any chat the user already has; no API key; the host model keeps doing the reasoning |
| Regex rows per language, not a parser | No native dependencies, many languages from day one, and a parser can replace a row later without touching the graph or the tools |
| Snapshots are git commits built in a private index | The user's index, stash and branches are never touched, and untracked files are covered |
| Snapshots and restores bypass line-ending conversion and `.gitattributes` filters; the private index is seeded from RIA's own previous snapshot, never from the user's index | `autocrlf` made a rollback change file bytes; the user's index holds normalised content |
| Gate commands come only from project files or `ria.config.json` | A tool caller (the model) cannot make RIA run an arbitrary command |
| Only new problems count against a change | A project that was already failing is not blamed for it |
| Diagnostics are compared without line numbers | An edit that shifts lines must not make old errors look new |
| Rollback restores only what changed since the baseline, previews first | Work that was uncommitted before `gate_begin` survives; nothing destructive happens by accident |
| Per-seed maximum, not a sum, when ranking `context_for` | A test that is both a dependent and "the test for" a file must not outrank the file itself |
| Token budget binds everything except an explicitly requested target | The answer stays small, and asking for a big file by name still works (with a note) |
| A best file or target that alone is over the budget is listed as an outline of its symbols, and only the outline is charged; a file with fewer than two symbols is charged in full | One huge file used the whole budget (a third of tasks on the measured repository) and crowded out the files related to it; with a single symbol an outline would hide the real cost of reading |
| Run ids end in milliseconds plus random hex and are matched against an exact pattern | Runs sort in creation order, and an id from tool input can never become a path |
| `core.longpaths=true` on every git call, short scratch file names | Deep folders (OneDrive) pass Windows' 260-character limit once git adds `.lock` files |
| Git `HEAD` is read once per refresh, not once per history lookup | `impact` and `plan_score` ask for history once per file, and every lookup spawned a git process |
| `plan_score` returns points per factor, not one opaque number, and says when a figure was capped | The chat (and you) can see why a plan won, and a saturated figure does not look exact |
| Plans that name files outside the index are scored as creating them; ambiguous names and directories are errors | A typo would score as a new file, so the output says so; guessing between two files would change the ranking silently |
| The roles are written once and rendered per host | Claude Code skills and VS Code agents differ only in their header, so one edit changes both and a test checks both against the real tool list |
| `ria init` previews unless `--apply`, keeps a role file you edited unless `--force`, merges into an existing MCP config, and is not an MCP tool | Your edits and other servers survive; a chat must not be able to rewrite its own configuration |
| On Copilot, read-only roles are given no edit tool and no gate tool | The agent's tool list is an allow-list VS Code enforces, so "does not edit" is real there, unlike the role's steps |
| The history evaluation shows each commit only the commits older than it, and prints every rate next to a baseline of the same size | Otherwise the answer leaks into the question, and a recall figure has nothing to be compared with |
| `ria eval` never writes into the repository it measures (cache off, whatever the flags say), and `eval gate` builds its own throwaway projects | Measuring must not change what is measured |
| An evaluation states what its sample can and cannot show (margins of error, "not shown" instead of "better") | The first reading of the `plan_score` check overclaimed; the margin of error corrected it |

---

## Status: what is built

Steps 1 to 4 and 6 are done. About 5,800 lines of source and 4,000 lines of tests (a third of the test lines are
the prompt sets that check the role routing). All 307 tests
pass, typecheck and build are clean.

| Step | What | State |
|---|---|---|
| 1 | MCP server and navigation tools: `repo_map`, `context_for`, `find_path`, `impact` | Done |
| 2 | Change gate: `gate_begin`, `gate_check`, `gate_rollback` | Done |
| 3 | Plan scoring: `plan_score` | Done |
| 4 | Role pack for Claude Code and Copilot Chat, installed by `ria init`, with the role chosen from each request (`start_task`, a Claude Code hook) | Done |
| 5 | Skill forge | To do |
| 6 | Eval harness: `ria eval history`, `ria eval gate` | Done |
| 7 | VS Code extension | Optional |

**How it was verified**

- Unit and fixture tests for every parser, resolver, ranking rule and gate flow.
- A real MCP client talking to the server over stdio, including progress notifications.
- Real code: a copy of the MCP SDK (175 files), a 4,740-file repository with 1,488 commits (read-only,
  `--no-cache`), and this repository itself, where the gate caught a deliberately added type error and
  logic bug and the rollback left 14 files of other uncommitted work untouched.
- Running on real code and on a real Windows machine exposed problems the first fixtures missed: the token
  budget was not enforced, symbols had no line numbers, an ignored folder looked empty, data files were
  guessed as entry points, long test lists were not summarised, rollbacks could change line endings, and long
  paths broke git. Each now has a test.
- `plan_score` on the same 4,740-file repository (three candidate plans for one task, read-only, `--no-cache`,
  about 6 s including the index) showed that test lists were unreadable, a file shared by two of three plans
  appeared nowhere in the overlap section, and capped figures looked exact. Each now has a test. Ranking
  also does not depend on the order the plans are listed in (all 24 orders of four plans are tested).
- The role pack: the file formats were checked against each host's current documentation (fetched 2026-10-23, since
  VS Code has renamed these features before). A test takes the command and arguments `ria init` wrote for each host
  and starts a real server from them. `ria init` was previewed on the 4,740-file repository (nothing written there,
  no `.ria/`), applied into a scratch folder, and the generated files were read as the chat would read them; that
  showed the Fixer's stop condition expected the wrong gate verdict, which is fixed and tested.

**Measured so far.** One repository (a 4,740-file TypeScript test-automation project with 1,488 commits), read-only,
with `ria eval history`. The numbers describe that repository and nothing else.

| Question | Result | Compared with |
|---|---|---|
| One file of a real commit is held out: did `impact` list it? (453 cases from 150 commits) | 39% | 5% for a list of the same length from the same folders, 0.3% at random |
| ...through what | 16% git history alone, 11% import graph, 11% tied tests | |
| `context_for` with the commit subject as the task: was a changed file among the 12 returned? (48 cases) | 52%, and 26% of the commit's files on average (42% and 19% before oversized files became outlines, same cases) | 0.3% at random |
| How much `context_for` returned | median about 7,900 tokens (0.05% of reading the whole repository), mean about 7,800 (it was 44,600) | An oversized file counts as its outline, not as the file, so "over budget" is 0% by construction (it was a third of the answers); the chat can still read the whole file |
| Does the `plan_score` of a change predict a fix on the same files within 10 commits better than file count does? (147 changes) | 61%, plus or minus 11 | 50%, plus or minus 11 for file count: not shown to be better |
| The gate against 13 injected faults and fixes | 13 of 13 verdicts right, 13 of 13 rollbacks byte-exact | Cases the gate was built for, so a guard against regressions, not an independent test |

Three things the measurements changed. A first reading of the `plan_score` check said it "adds something beyond size";
the margin of error showed it does not yet, and the report now says that. A guess that `impact` misses dependents
because it shows only 25 of them in alphabetical order was tested by showing 100 and then all of them: dependents
went from 11.5% to 11.9%, so the cut-off is not the problem and ranking was left alone (only the tests list gains,
from 11% to 17%). And a one-file-at-a-time look at the tests list (2026-10-26) showed why: 173 of 453 questions had
more than 25 tied tests, the held-out test was somewhere in the list in 79 of them (17%) and in the first 25 in 51
(11%), and the lists where it was missed had a median of 155 tests. Ordering the list by co-change history, by
closeness of path, or both moved the first-25 figure from 51 to at most 54, so nothing in the graph or the history
separates those tests and the ordering was not kept.

**Checked in a real host (2026-10-26):** Claude Code in VS Code started the server from this repository's
[.mcp.json](.mcp.json) and its model called `repo_map`, `impact` and `plan_score` successfully. And a headless
Claude Code 2.1.278 (`claude -p`, no tools, a throwaway project with a gate run whose change broke a test) ran the
`ria hook stop` recipe on Windows: the exec-form command started, the repository came from `CLAUDE_PROJECT_DIR`, the
JSON block kept the chat working and was shown to it as "Stop hook feedback", the second stop (with
`stop_hook_active` true) was held back again as "2 of 2", and the third was let go. That chat had no tools, so it
could not act on the report; whether a chat with tools fixes the change is not tested.

**The role hook, in Claude Code (2026-10-26).** `ria init --host claude --hooks --apply` into a throwaway project (a
3-file Node project with a `node --test` suite), then the real `claude -p` on the smallest model (Haiku), with tools
and the RIA server, reading its own event stream. In single runs the hook injected the right role every time: Reader
for "explain how the math module is used, don't change anything" (no edits, answered with `src/math.js:1-2`), Writer
for "create a new file…", Fixer for "the add function returns the wrong result and the test fails. fix it", Extractor
for "move the sub function into its own file… without changing behaviour", Reviewer for "review my uncommitted
changes", Analyser for "what would break if I rename…", Writer for the typo'd "creaet a new file…", and nothing for
"thanks, that is all for now". The chat then did what the role says: the Fixer and the Extractor called `gate_begin`
before editing and `gate_check` after (the Extractor also updated all three importers, the test included); the Reviewer
read the diff, called `impact`, edited nothing and reported a blocker with `src/math.js:2`. Running it showed two
things the tests had not. A verb after "the" was read as a command (in "the *add* function returns the wrong result" the
router saw "add" and sent a fix to the Autopilot), which is now fixed with a test. And the role is advice, not enforcement:
the typo'd "creaet a new file…" run skipped the gate, and the Analyser used `grep` and not `impact` on a three-file project.

To see whether the hook changes anything, the same two tasks were run four times each with the hook on and off
(everything else the same, including the server and the skills): does the chat call `gate_begin` before its first edit?

| Task | Hook on | Hook off |
|---|---|---|
| "create a new file src/greet.js that exports greet(name)…, with a test" (Writer) | 3 of 4 | 0 of 4 |
| "move the sub function into its own file src/sub.js without changing behaviour" (Extractor) | 4 of 4 | 4 of 4 |

With the hook off the Writer task made no RIA call at all in four runs; with it on, three of four followed the Writer's
steps and one still skipped them. The Extractor needed no help, because "without changing behaviour" is cue enough. Read
it as direction, not proof: 16 runs, one small model and a toy project, with four runs per cell, so one run more or
less changes the picture.
A stronger model may follow the roles more often unaided; a bigger repository may make the RIA tools matter more. The
16 runs cost $1.40.

**Plain Claude Code against Claude Code with RIA, on a real repository (2026-10-26).** The same four jobs, each run
twice in each condition (16 runs), every one on a fresh clone of this repository (56 files, a 280-test suite), on the
smallest model. The outcomes were checked afterwards by scripts that do not trust the chat: the new function's behaviour,
typecheck, the whole suite, whether any test was edited, a checklist of facts in an explanation, and the list of files
that use a renamed function.

| Job | Correct, plain → RIA | Cost, plain → RIA | Time, plain → RIA | Gate started before the edit, plain → RIA |
|---|---|---|---|---|
| Write `wordCount` and its tests | 2 of 2 → 2 of 2 | $0.10 → $0.21 | 79 s → 167 s | 0 of 2 → 1 of 2 |
| Fix a planted off-by-one in `reach` | 2 of 2 → 2 of 2 | $0.105 → $0.114 | 171 s → 233 s | 0 of 2 → 2 of 2 |
| Explain how the gate decides its verdict (7-point checklist) | 1 of 2 → 2 of 2 | $0.09 → $0.11 | 21 s → 17 s | not applicable |
| Find what breaks if `approxTokens` is renamed (4 files) | 2 of 2 → 2 of 2 | $0.04 → $0.07 | 18 s → 35 s | not applicable |

The estimated cost of the 16 runs was $0.68 for plain and $1.02 with RIA (Claude Code's own price estimate, not a bill).
How to read it. The outcomes are a tie: on small, easy jobs plain Claude Code already gets them right, and the single
miss was one explanation that lacked one of seven facts, which two runs per cell cannot call a difference. What RIA
changed is the process: the Fixer started a gate baseline before editing both times and checked afterwards, the Analyser
called `impact` and `plan_score`, and plain Claude Code did neither. The price is about 50% more cost and, on the editing
jobs, up to twice the time, mostly the gate running the 60-second suite twice and extra turns. On a clean repository
with a fast, fully green suite that is largely repeated work, because the plain chat also ran the suite itself. The
gate's real advantage, that only new failures count against a change, needs a repository that already has failing
tests, which this comparison did not have. One RIA Writer run loaded the RIA tools eight times and never called one
(the role was injected, but loading a deferred tool is not calling it); the hook's note now says how to load and call
them, and that has not been re-measured. 16 runs, one small model, one small repository.

The comparison also found a bug in the hook. Claude Code runs it for messages it delivers itself, such as the
`<task-notification>` that reports a finished subagent, and the router read that report ("fixed", "extracts") as a
request and injected the Autopilot into the conversation. The hook now ignores such messages, prompts that name a
subagent (`agent_id`), and the editor's `<ide_...>` context in front of the typed text, with tests.

**The same comparison on a repository that already has failing tests (2026-10-26).** The gate's main promise is that a
project that is already failing is not blamed for it, and the clean repository above could not test that. So the same
two jobs (write `wordCount`; fix the planted `reach` bug) were run on fresh clones of the current code in which two
unrelated tests had been broken on purpose and committed as "known failures" (`risk.level` expected `"high"` in
`tests/tools.test.ts`, and a package-manager command with a stray letter in `tests/gate-detect.test.ts`; the code under
test is right in both). Two runs per cell, 8 runs, the smallest model. A run counts as clean only if the job is done,
both known failures are still there and untouched, and no new test fails, all checked by scripts afterwards.

| Job | Clean, plain → RIA | Cost, plain → RIA | Time, plain → RIA | Told you about the old failures, plain → RIA |
|---|---|---|---|---|
| Write `wordCount` and tests | 2 of 2 → 2 of 2 | $0.08 → $0.19 | 90 s → 331 s | 0 of 2 → 2 of 2 |
| Fix the planted bug | **1 of 2** → 2 of 2 | $0.19 → $0.115 | 391 s → 323 s | 0 of 2 → 1 of 2 |

What the one unclean run did. Plain Claude fixed the real bug, and then also changed the assertion in an unrelated
failing test (`"high"` back to `"low"`) and reported *"Updated the test expectation… since the impact risk calculation
changed with the corrected reach behavior"*. That was not true: the fix had nothing to do with that test. A chat that
edits an unrelated failing test to make the suite greener, and invents the reason, is how a real problem in a real
project gets hidden. Neither RIA Fixer run did that. In the two RIA Writer runs and one RIA Fixer run the chat's
report said the two failures were "pre-existing and unrelated"; the plain Writer runs never ran the whole suite, so
they neither noticed nor said anything, and none of the plain runs mentioned them. How to read it: the gate recorded the
failures at the baseline ("already failing, only new problems count") and the Fixer role forbids making a check pass by
weakening a test, which are the likely reasons, but with two runs per cell one tampering run is a signal and not a
rate. The cost picture is mixed: the Writer job was about 2.5 times dearer and 3.7 times slower with RIA (two full-suite
gate runs, and a red baseline correctly rules out scope `tied`), while the Fixer job was cheaper and faster, because the
plain chat spent more turns running and re-running the suite. The 8 runs cost an estimated $0.53 plain and $0.61 with
RIA. A fix for the Writer's time on a red baseline is in the backlog.

**Not verified yet:** Copilot Chat, the role files in Copilot, behaviour against those hosts' tool-call timeouts on a
long gate run, and any model other than the smallest Claude one. The history numbers come from one repository.

---

## Tools

| Tool | Parameters | Use it to |
|---|---|---|
| `start_task` | `task` (the user's request in their own words) | At the start of every new request: get the role it calls for (writer, fixer, reader, analyser, extractor, reviewer or autopilot), why, and that role's steps, stop conditions and report; says when the request is only a follow-up |
| `repo_map` | `max_tokens` (500-20000, default 4000), `focus` (directory) | Orient in an unfamiliar repo: languages, entry points, structure, most depended-on files and their symbols |
| `context_for` | `target` (file or symbol), `query` (task in words), `max_files` (12), `max_tokens` (8000), `include_tests` (true) | Get the smallest ranked set of files to read, each with the reason it matters and a token estimate; a file bigger than the whole budget comes back as an outline of its symbols with line numbers |
| `find_path` | `from`, `to` (file, suffix or symbol) | See the cheapest chain of imports between two things, with direction; falls back to co-change evidence |
| `impact` | `files` (1-50), `depth` (1-6, default 3) | Before changing files: dependents, hidden coupling, tests, public symbols, risk score, confidence |
| `plan_score` | `plans` (1-8, each a `name` and `files`; files not in the index count as new), `depth` (1-6, default 3) | When a task can be done several ways: rank the candidate plans by files changed, blast radius, missing tests, ignored coupling and reading cost, with the reasons, the tests to run and the confidence |
| `gate_begin` | `label`, `commands` (names) | Before the first edit: record the tree and run the project's checks as a baseline |
| `gate_check` | `id`, `commands`, `scope` (`full` or `tied`) | After editing: re-run, compare, verdict; `tied` runs only the tests tied to the changed files when the project defines how |
| `gate_rollback` | `id`, `apply` | Undo everything since `gate_begin` (preview unless `apply` is true) |

Symbols in `context_for` and `impact` carry line numbers (`function auth (L120)`) so a large file
can be read in part. `start_task` and the navigation tools are marked read-only; the gate tools are not, and
`gate_rollback` is marked destructive.

---

## The change gate

`gate_begin` before an edit session, `gate_check` after, `gate_rollback` if it went wrong.

```text
Gate check for run 20261023-130124653-3cfa: REGRESSED
  - typecheck: now failed, 1 new error(s)
  - test: now failed, 2 new failing test(s)

Changed since the baseline (2 files): modified src/repo/graph.ts, src/tools/shared.ts

Checks, compared with the baseline:
  typecheck  passed -> FAILED  715ms  [npm run typecheck]
             new error: src/tools/shared.ts: error TS2322: Type 'number' is not assignable to type 'string'.
  test       passed -> FAILED (148 passed, 1 failed)  39.1s  [npm run test]
             new failing tests: graph queries, reach respects the depth limit

May be affected:
  Not changed, but depend on the changed code (8): src/gate/gate.ts, src/repo/repo-index.ts, ...
  Tests tied to the changed code (4): tests/graph.test.ts, tests/gate.test.ts, ...
  No test is tied (by name or import) to: src/tools/shared.ts
Confidence: high
```

**What it compares**, per command: pass or fail, test counts, which tests failed, and compiler or
linter errors. Only **new** problems count against a change. Without running anything it also
checks for imports that stopped resolving and exports that disappeared. The verdict is
`regressed`, `mixed`, `improved`, `unchanged` or `unverified`, and the report says how far to
trust it (no tests ran, output not recognised, nothing tied to the changed files, and so on).

**What runs.** Only the project's own commands, found from `package.json` scripts,
`pyproject.toml`/pytest/ruff/mypy configuration, `go.mod`, `Cargo.toml`, `.sln`/`.csproj`,
`pom.xml`, a Gradle wrapper, or `Makefile` targets. The tool call can pick among them by name; it
cannot supply a command. Running them carries the same trust as running `npm test` yourself. To
change what runs, add `ria.config.json` at the repository root:

```json
{ "gate": { "timeoutSeconds": 300, "commands": { "test": "npm run test:unit", "lint": null, "e2e": "npm run e2e" } } }
```

A string replaces or adds a command, `null` turns one off. The default timeout is 600 seconds.

**Faster checks while you iterate (`scope: "tied"`).** The baseline always runs everything, but a later check can run
only the tests tied to the changed files (the tests named after or importing a changed file, those that reach it through
the import graph, and any test file that changed). For the common runners RIA works the command out itself, from the
project's own test script, and only when that script is exactly one known runner (so the narrow command is the same
runner with the same options plus file names):

| The project's test script | The narrowed command | Test files passed on |
|---|---|---|
| `node --test`, with plain node options before it (`node --import tsx --test`) | the script plus the files | any tied test file |
| `jest`, optionally with `--ci --silent --runInBand -i --colors --no-color --forceExit --passWithNoTests --watchAll=false` | `npx --no-install jest --runTestsByPath <same options> <files>` | `*.test.*`, `*.spec.*`, files in `__tests__/` |
| `vitest` or `vitest run`, optionally with `--silent --passWithNoTests --watch=false --no-color --color` | `npx --no-install vitest run <same options> <files>` | `*.test.*`, `*.spec.*` |
| pytest, found by RIA from its configuration or test files | `python -m pytest -q <files>` | `test_*.py`, `*_test.py` |

Anything else (`jest --coverage`, `tsc && jest`, `cross-env ... jest`, mocha, a test glob already in the script, a
`pnpm`, `yarn` or `bun` project, a command you wrote in `ria.config.json`) is left alone, and the whole command runs. Go
is not narrowed because `go test` already caches the results of packages that did not change. The project can always say
how itself, in `ria.config.json`, with a `{files}` placeholder; that wins over what RIA works out:

```json
{ "gate": { "targeted": { "test": "node --import tsx --test {files}" } } }
```

`gate_check` takes `scope: "tied"` (CLI: `gate check --scope tied`); the `gate_begin` report says when it is on offer.
Typecheck, build and lint still run in full. Running fewer tests can make a gate say "fine" about something it did not
look at, so it only narrows when that is sound, and otherwise runs the whole command and says why in the report:

- RIA knows the command, as above, or the project defined it (a tool caller picks one of two words, `full` or `tied`, and never supplies a command);
- the tests were green at the baseline (with failures already there, only a full run tells a new failure from an old one);
- no configuration file changed in the same edit (`package.json`, lockfiles, `tsconfig*.json`, `jest.config.*`,
  `vitest.config.*`, `vite.config.*`, `babel.config.*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`,
  `conftest.py`, `requirements*.txt`, `ria.config.json`), because those can change what every test does;
- some test is tied to the change, and not more than 60% of the test files (past that there is nothing to save);
- every tied file name is plainly safe to put in a command (letters, digits and `_ . / @ + -`).

Checked for real on small projects with jest 30, vitest and pytest 9 installed: the baseline passed, a harmless edit
ran only the tied test file and passed, a deliberate break was caught as `regressed` from the narrowed run, and an edit
to `conftest.py` ran the whole suite with the reason printed. Those projects have 4 tests, so they show that it works,
not that it is faster: `npx` start-up costs about as much as the tests save.

A narrowed result is marked `PARTIAL` in the report, is not read as "fewer tests ran", can still find a regression in a
tied test, and caps the confidence at medium with the instruction to finish with a check without a scope. The roles that
edit say the same. Measured on this repository (295 tests, a 52 s baseline): after a one-line change to
`src/hooks/prompt.ts`, which ties 1 test file of 21, the tied check took 7 s and the full check 58 s. A change to
`src/repo/graph.ts` ties 11 of 18 test files, so it correctly falls back to the full run. The tied set comes from regex
import matching, so a test tied only through a string, a config file or a dynamic import is missed: that is why the
last check has no scope.

**Undo.** Files are stored and restored byte for byte: line endings are never converted, and
`.gitattributes` filters are bypassed too on git 2.40 or newer. `gate_rollback` restores only what
changed since `gate_begin`; work that was already uncommitted then is kept. It previews by default
and needs `apply` to act.

**From a terminal or CI**

```powershell
node dist/index.js gate begin --label "fix tax rounding"
# ... edit ...
node dist/index.js gate check          # exit code 1 when the verdict is regressed or mixed
node dist/index.js gate check --scope tied   # only the tests tied to the changed files (jest, vitest, node --test, pytest, or ria.config.json)
node dist/index.js gate rollback       # preview; add --apply to do it
```

**Gate limits.** It needs git and a writable repository (not `--no-cache`). `gate_begin` and
`gate_check` run the whole commands by default, so a slow test suite makes them slow (the baseline always does;
`scope: "tied"` shortens later checks, see above); progress messages are sent while they run. Output parsers cover node:test, jest, vitest, mocha, pytest, go, cargo, dotnet
and maven for tests, and tsc, eslint, gcc/clang, rustc, msbuild, ruff, mypy and go build for
diagnostics. Anything else falls back to exit codes and says so.

---

## Use it

```powershell
npm install
npm run build        # the MCP configs and `node dist/index.js` need the build
```

**VS Code (Copilot agent mode).** Add to `.vscode/mcp.json` in the repository you want analysed:

```json
{
  "servers": {
    "ria": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/repository-intelligence-assistant/dist/index.js", "serve", "--root", "${workspaceFolder}"]
    }
  }
}
```

**Claude Code.** From the repository you want analysed:

```powershell
claude mcp add ria -- node C:/path/to/repository-intelligence-assistant/dist/index.js serve --root .
```

This repository ships both configs ([.vscode/mcp.json](.vscode/mcp.json), [.mcp.json](.mcp.json))
so RIA can analyse itself once built.

**Roles, and how the right one is chosen.** The tools work on their own, but a chat does not know which one to use
when. `ria init` installs the MCP config plus seven roles: instruction files that say which RIA tools to call in
which order, when to stop, and what to report. Six are specialists; the seventh, the **Autopilot**, runs a whole
task by itself (see below). You do not pick a role: it follows from what you type (see "How the role is chosen").

```powershell
node dist/index.js init --host claude --hooks --root C:/path/to/your/repo           # preview: writes nothing
node dist/index.js init --host claude --hooks --root C:/path/to/your/repo --apply   # write the files
node dist/index.js init --host both --root C:/path/to/your/repo --apply             # Copilot as well, without hooks
```

| Host | What is written |
|---|---|
| `--host claude` | the `ria` entry in `.mcp.json`, and `.claude/skills/ria-<role>/SKILL.md` |
| `--host claude --hooks` | also `.claude/settings.local.json` with two hooks: the one that picks the role for each request, and the one that holds the chat to the gate (both described below). The file is personal: keep it out of git |
| `--host copilot` | the `ria` entry in `.vscode/mcp.json`, and `.github/agents/ria-<role>.agent.md` |

| Role | Use it to | Edits | RIA tools |
|---|---|---|---|
| Autopilot | do a whole task start to finish, or several kinds of work at once, or when the request is unclear; asks only when a decision is needed | yes | everything, including the gate |
| Reader | understand or explain code, find where something lives, see who uses it | no | the navigation tools |
| Analyser | judge size and risk before a change, compare approaches | no | the navigation tools and `plan_score` |
| Extractor | move, split or rename code without changing behaviour | yes | everything, including the gate |
| Writer | create something new (a file, a folder, a feature, a test) or change how something works on purpose | yes | everything, including the gate |
| Fixer | fix a bug or a failing check, and prove it | yes | the navigation tools and the gate |
| Reviewer | review someone else's change | no | the navigation tools |

The navigation tools are `start_task`, `repo_map`, `context_for`, `find_path` and `impact`. What makes each role
stronger than a bare instruction is what it makes the chat do before and after the edit: the Writer copies the
closest existing example, places the file beside its siblings, never overwrites an existing path, finds where new
code is registered, and expects its new tests to show up in the gate's test count; the Fixer reproduces the failure
through the gate's baseline, states the cause with evidence, adds a test that fails without the fix, and looks for the
same bug in coupled files; the Extractor insists on a test that pins the behaviour before it moves anything and
searches the text for the old names that import matching cannot see; the Analyser always includes the smallest plan
and says plainly that the score is evidence, not proof; the Reviewer labels findings blocker, major, minor or nit
with `path:line`. Every role also carries the same rules for working with few calls and few tokens (one `context_for`
call replaces many searches, read big files by line range, batch `impact` over many files, never repeat a call), and
a section on switching role when the next request is a different kind of task.

**How the role is chosen.** Three channels carry the same decision, so it works in whichever chat you use:

1. **The `start_task` tool, in any MCP chat** (Claude Code, Copilot Chat, others). The server's own instructions tell
   the chat to call it first with your request in your words. It returns the role, why, and the role's whole playbook.
   It also checks whether the files your request names exist: "create `src/new.ts`" for a file that is not there
   supports the Writer, and "explain `src/nope.ts`" for a file that is not there is flagged as a likely typo.
2. **A Claude Code hook that runs on every request** (`ria hook prompt`, installed by `ria init --hooks`). It adds
   a short note to the request: the role, why, and the role's brief. It reads only the text, writes nothing into
   the repository and answers in milliseconds; it never blocks a request. For "yes", "continue" or "commit this" it adds
   nothing, so the chat keeps the role it has. It routes only what a person typed: not the messages Claude Code
   delivers itself (a finished subagent's report), not a subagent's prompt, and not the editor's context in front
   of your text.
3. **The skills and agents themselves.** Each carries a description in the words people type ("fix this", "where
   is", "refactor", "review my changes"), which is what Claude Code matches a request against, and each has a section on
   switching role when the request changes kind.

The router (`ria route "<request>"` shows its decision) is a set of weighted word and phrase rules with no model in it,
so the same request always gets the same role and the reason is shown. It stems words, tolerates a swapped or
missing letter ("creaet", "chnage", "implment"), reads a verb after "the" as a name ("the add function"), treats
a question that gives no order ("how risky is it to move X?") as a request for information that can never go to a role
that edits, honours "don't change anything", sends a request with two kinds of work ("add dark mode and fix the sidebar")
to the Autopilot, and treats a fix plus a test for it as one fix. When it is not sure which role that edits fits, it
says so and picks the Autopilot, whose first step is to name the role itself, rather than inject the wrong playbook.
A role that only reads does no harm when it is a guess, so those keep their answer.

How well it chooses, on prompts written by hand (the author's, in sets written at different times; the router
was tuned on A, B and D, and E was measured once before anything was changed for it). "Right" is the role you wanted
or another that fits; "fallback" is no role or the Autopilot for a real request (the chat then uses its own judgement);
"wrong" is any other role:

| Set | Prompts | First look, before tuning on it | Now |
|---|---|---|---|
| A: simple phrasing | 106 | 96% right | 97% right, 0% wrong |
| B: polite, long, pasted errors | 71 | 77% right | 96% right, 1% wrong |
| D: other verbs ("hook up", "spin up", "port") | 62 | 65% right, about 13% wrong | 95% right, 0% wrong |
| E: issue titles, chatty, Stack Overflow style | 40 | 80% right, 8% wrong | 85% right, 0% wrong |
| The author's own typed messages from this project's earlier sessions (not stored in the repository) | 25 | 84% right, 16% wrong | 96% right, 0% wrong |

The honest reading is the first-look column: on wording it has not seen, expect about 80% right, a few percent
wrong, and the rest a safe fallback. The gap between the first look and now is the cost of an English phrasing
heuristic: it learns the verbs it was given, and each real misreading (in the author's messages, "what developed" for
"what has been developed", and "VS code" read as "versus") was a missing general rule. Tests keep each set above a
floor so a change cannot quietly make it worse. It reads English only.

How it behaves: it previews unless `--apply` is given; it keeps a role file you edited (`--force` replaces
it); it adds the `ria` server to an existing MCP config and keeps your other servers (a config with comments
is not rewritten: it prints what to add by hand); `--roles reader,fixer` installs only some roles. The
config names the RIA folder on this machine, so for a repository you share, put `ria` on the PATH and use
`--on-path`. It is a command-line tool only and not an MCP tool, so a chat cannot rewrite its own
configuration, and it never indexes the repository.

What is enforced and what is not:

- **Copilot Chat** can only be instructed, and a model can ignore a role's steps. What VS Code does enforce is
  the agent's `tools` list: the Reader, Analyser and Reviewer are given no edit tool and no gate tool. The
  list uses `ria/<tool>` names. VS Code's own reference documents `ria/*`; the per-tool form comes from
  GitHub's custom agent reference, so if your VS Code version ignores it, replace the names with `ria/*`.
- **Claude Code** skills are instructions too, and RIA writes no permission rules: tool approval stays in
  your own settings. The routing hook is advice: it tells the chat which role the request needs, and the chat can
  still skip that role's steps. What Claude Code hooks can enforce is the end of the loop: see "Make Claude Code
  finish only when the gate agrees" below.

**Make Claude Code finish only when the gate agrees.** `ria hook stop` is a Claude Code `Stop` hook. When the chat is
about to finish and the latest gate run (the one it started with `gate_begin`) says its change made things worse
(`regressed` or `mixed`), the hook keeps it working and hands it the gate report as its next instruction. Put this
in `.claude/settings.json` (shared with the project) or `.claude/settings.local.json` (yours only), or let
`ria init --host claude --hooks --apply` write it for you, together with the routing hook (it merges into an
existing file, keeps your own hooks, and does nothing if RIA's hooks are already there):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["C:/path/to/repository-intelligence-assistant/dist/index.js", "hook", "stop"],
            "timeout": 1200
          }
        ]
      }
    ]
  }
}
```

- `command` plus `args` is Claude Code's exec form: no shell, so a path with spaces needs no quoting, which matters
  on Windows. The repository is read from `CLAUDE_PROJECT_DIR`, which Claude Code sets for hooks. `timeout` is in
  seconds (the default is 600): the hook re-runs the gate's commands, so give it longer than your slowest suite.
- It enforces only a gate run the chat itself started. With no run, it lets the chat finish and writes nothing into
  the repository. A run older than 12 hours (`--max-age-hours`) is ignored, because it is probably another task's.
  When nothing differs from the baseline it answers at once.
- It holds the chat back at most twice in a row (`--max-blocks`), the Autopilot's limit on fix attempts. The second
  report says it is the last, and tells the chat to stop and show the user the rollback preview if it is still not
  fixed. Then the chat is let go. A fixed change, or a fresh stop, starts the count again. Claude Code has its own
  cap of 8 in a row behind that.
- It blocks with the JSON form (`{"decision":"block","reason":...}` on stdout, exit code 0), not exit code 2: Claude
  Code treats an exit-2 block whose stderr mentions a missing file as a plain error, and a gate report quotes
  failing tests. If the hook itself breaks (no git, an unreadable run) it exits 1, which Claude Code treats as a
  non-blocking error, so a broken hook cannot trap the chat.
- Like `gate_check`, it runs the project's own commands. It does not make the chat call `gate_begin`: without a
  baseline there is nothing to compare with, so a chat that edits without a baseline is not held to anything.

**The Autopilot.** Hand it a task and it works out what kind of task it is (a question, a change or a review),
finds the files, checks the impact, compares approaches with `plan_score` when there is more than one, records a
baseline with `gate_begin`, makes the change, runs `gate_check`, fixes what it reports (two attempts), and reports,
all without asking permission for routine steps. The AI work (reading, reasoning, writing code) is done by the chat
model you already have; RIA supplies the evidence and the safety net, so there is still no model inside RIA and
no API key.

It stops and asks, one question at a time with its recommendation first, only when:

- the task is unclear, has two reasonable readings, or names a file that does not exist or is ambiguous;
- the right behaviour depends on a preference or a business rule that no file or test settles;
- `plan_score` calls it a close call, or RIA's confidence is low;
- `gate_begin` finds no build or test command, so the change could not be verified;
- the change needs files beyond the plan, or changes a public signature it cannot update everywhere;
- something cannot be undone or leaves the repository (deleting files it did not create, installing packages,
  network calls, credentials);
- two fix attempts did not pass the gate: it shows the rollback preview and asks what to do.

It never commits, pushes, opens a pull request or applies a rollback on its own, and never makes a check pass by
weakening a test. Two honest limits: it is an instruction file, so a model can still ignore it; and how
"automatic" it feels depends on the host, which may show its own approval prompts for each tool or command
(RIA writes no permission rules, and the syntax for pre-approving the RIA tools has not been checked).

**From a terminal**

```powershell
node dist/index.js map
node dist/index.js context src/server.ts
node dist/index.js context --query "retry logic for webhooks" --max-tokens 6000
node dist/index.js path src/index.ts src/repo/graph.ts
node dist/index.js impact src/repo/graph.ts --depth 3
node dist/index.js plan --plan "Small=src/repo/graph.ts" --plan "Both=src/repo/graph.ts,src/repo/resolve.ts"
```

**Measure it** (nothing is written to the repository):

```powershell
node dist/index.js eval history --root C:/path/to/your/repo                       # how well do the tools predict real commits?
node dist/index.js eval history --root C:/path/to/your/repo --min-recall 0.3      # exit code 1 below 30%, for CI
npm run eval                                                                      # the gate against injected faults (about 40 s)
```

`--json` prints machine-readable output, `--root <dir>` points at another repository, and
`--no-cache` (or `RIA_NO_CACHE=1`) stops RIA writing to the repository. `RIA_ROOT` sets the
default root.

---

## How the analysis works

1. **Index.** Files come from `git ls-files` (so `.gitignore` is respected), or from a directory
   walk outside git or when git reports nothing. Lockfiles, binaries, minified files and anything
   over 1 MB are skipped. Each file gets symbols and import statements from per-language regex rows in
   [src/repo/extract.ts](src/repo/extract.ts); adding a language is a few lines.
2. **Graph.** Imports are resolved to repo files per language
   ([src/repo/resolve.ts](src/repo/resolve.ts)): TS/JS (relative, `@/` `~/` `#/` aliases, root-based paths,
   `.js` to `.ts`, index files), Python (relative and absolute), Go (through `go.mod`), Rust (`mod`,
   `crate::`), Java/Kotlin/Scala, C# (namespaces), C/C++, Ruby, PHP, shell. A relative import that does not
   resolve is recorded as a gap and lowers confidence; a package or standard-library import is simply external.
3. **History.** The last 1,500 non-merge commits give co-change coupling: how often two files change in the
   same commit. Commits touching more than 40 files are ignored. A pair needs at least 2 shared commits.
4. **Cache.** The index is saved to `.ria/index.json` and refreshed on every call by re-reading only files
   whose size or mtime changed.

**How answers are computed**

- `context_for` picks seeds (the target, plus the top 5 files whose path or symbol names match the query
  words, rare words weighted higher, test files discounted). It then adds what is connected to each seed:
  dependencies (weight 0.6 to the power of the hop count), dependents (0.5 to the power of the hop count; both
  up to 2 hops), co-change partners (0.8 x confidence, from 30%), and tests (0.45). Each seed contributes its
  strongest link to a file once. Output is cut by file count
  and token budget; symbols that matched the query are listed first. The best file (or the requested target) is
  always returned; when it alone is over the budget and has at least two symbols, it is returned as an outline
  (up to 40 symbols in file order with line numbers, the query's matches always among them, the rest spread over
  the file) and only the outline counts against the budget.
- `impact` follows importers up to `depth` hops, adds co-change partners that do not import the file, ties tests
  by name or import, and scores risk transparently: 1 point per non-test dependent (max 20) + 2 per strong
  hidden coupling + 4 if no test is tied. Under 5 is low, under 12 medium, otherwise high.
- `find_path` runs Dijkstra over the import graph: following an import costs 1, walking against one costs 1.25.
- `plan_score` gives each plan points per factor and adds them up; lower is better. The factors are
  **scope** (1 point per source file changed or created, half for non-code files, max 20), **blast radius**
  (dependents outside the plan: 1 point direct, 0.5 at two hops, 0.25 further, max 20), **missing tests**
  (per source file: 0 with a test named after it, importing it, or added by the plan; 1 if a test reaches it
  only through other files; 3 if none, max 15), **ignored coupling** (files that change with the plan's files
  in at least 30% of commits but are not in the plan: 2 points each from 50%, 1 below, max 15) and **reading
  cost** (1 point per 2,000 tokens of the files, max 10). The recommendation names the factors that separate
  the best plan from the runner-up, what the best plan costs more in, and calls a lead under 2 points a close
  call. Capped figures are marked as capped.
- `start_task` and `ria route` score each sentence of the request against weighted rules: a word list per role
  (stemmed, with a one-slip typo allowance for words of five letters or more), phrase patterns (`should we`, `what
  would break`, `keeps crashing`, `end to end`), a bonus for a sentence that starts with its verb, and a discount for
  the editing roles in a sentence that asks for information. Then: "don't change anything" cuts the editing roles; a
  request that ends in a question mark and gives no order cannot go to an editing role; two kinds of editing work in
  separate clauses mean the Autopilot (a fix plus its test, or a rename plus its imports, count as one); the highest
  score wins and a tie goes to the more specific role; confidence is high from 5 points, medium from 3, and one level
  lower when the runner-up is within 1 point; an editing role at low confidence becomes the Autopilot; with no signal
  at all, a reply or short remark gets no role (judged by how much of it is small words) and a longer request gets the
  Autopilot. Every figure is in `src/tools/route.ts`, and `ria route "..." --json` prints the scores.

---

## Roadmap: what is left to build

Each step lists the goal, the design, and how it will be verified. Steps 3 to 5 are the ones
that make RIA different from other repo assistants.

### Step 3: `plan_score` (done)

**Goal.** Choose between several ways to do a task using data, not a hunch. This is the
"traverse several paths and pick the best one" part of the vision.

**Built.** The chat proposes candidate plans, each with the files it will touch. RIA scores each plan
deterministically from the graph and history it already has (see "How answers are computed" for the
points) and returns a ranking with reasons, the tests to run for each plan, the overlap between plans and
a recommendation. The output always says that the score is a heuristic over plans the chat wrote.

**Still open.** The eval harness (step 6) is where the weights get checked: higher-scored plans should
regress less under the gate. Until then they are judgement.

### Step 4: role pack and `ria init` (done)

**Goal.** One set of roles that work in both Copilot Chat and Claude Code: Reader, Analyser, Extractor,
Writer, Fixer, Reviewer, and an Autopilot that runs the whole loop and asks only when a decision is needed.

**Built.** A role is configuration, not a program: instructions plus which RIA tools to use in which order
plus stop conditions and what to report. The seven roles are defined once in `src/init/roles.ts` and rendered
as Claude Code skills and VS Code custom agents. `ria init` previews and then writes them with the MCP
config (see "Roles and `ria init`" for what it writes, what it will not overwrite and what is enforced).

**Still open.**

- The role files have been loaded by Claude Code (see "Checked in a real host") but not by Copilot Chat. Whether a
  model follows a role well (does the Autopilot really ask only when it should?) can only be seen by trying it in the
  host; the real-host checks so far are a handful of runs on one model.
- The two small tools the Extractor might need (list a file's exports, search symbols by name) were not added:
  `context_for` and the public surface in `impact` cover it so far. Revisit if real use shows a gap.
- The Claude Code `Stop` hook that enforces the loop (`ria hook stop`) and the hook that routes each request
  (`ria hook prompt`) are built, and `ria init --hooks` installs both.

### Step 5: skill forge

**Goal.** Let the chat learn from the web into reusable skills safely.

**Design.** The chat does the browsing. RIA supplies the safe parts: `fetch_source` (fetch a page with its
URL, fetch time and SHA-256 recorded, scripts stripped, size and time limits, prompt-injection patterns
flagged), `skill_scaffold` (create a skill folder with `SKILL.md` and `provenance.json`), `skill_test` (run the
skill's declared checks with a timeout in a temporary copy, secrets removed from the environment), and
`skill_register` (enable only after explicit user approval, pinned to a hash, re-approval when a source changes).

**Verify.** Fixture pages with hostile instructions must be flagged and never obeyed; provenance
round-trips; approval is required and cannot be skipped by a tool argument.
**Honest limit.** Process sandboxing on Windows is weak. Treat it as a safety net, with human approval as the real boundary.

### Step 6: eval harness (done)

**Goal.** Measure whether the tools help, so quality is shown and not assumed, and guard against regressions in RIA itself.

**Built.** `ria eval history` replays a repository's own git history against the tools without writing to it:
`impact` by holding out one file of a commit, `context_for` with the commit subject as the task, and an exploratory
check of `plan_score`. Each case sees only the commits older than the one tested, and each rate is printed next to a
baseline of the same size (files from the same folders, files at random). `--min-recall` and `--min-context-hit`
make it exit with code 1 below a rate, so a team can gate its own CI. `ria eval gate` (also `npm run eval`) builds
13 throwaway projects, injects one fault or fix into each, and exits with code 1 if a verdict or a byte-exact
rollback is wrong. See "Measured so far" for what it found.

**Still open.**

- The roles cannot be measured without a model: whether a chat follows them, and what it reads with and without
  them. That needs a driver that calls a model, which RIA deliberately does not contain.
- `plan_score` has not been shown to predict trouble better than counting files, and its weights remain
  judgement. A repository with more fix commits, or several repositories, would tell.
- Only one repository has been measured. Run `ria eval history --root <repo>` on others before trusting a rate.

### Step 7 (optional): VS Code extension

Auto-register the MCP server, a status bar item, a panel showing the latest gate and impact report, and
commands for start, check and rollback.

### Backlog (not scheduled)

| Idea | Why |
|---|---|
| Parser (tree-sitter) behind the same extraction interface | Methods, multi-line signatures, and `import` text inside strings are the main source of wrong edges (this repository's own tests create 24 false gaps) |
| Resolve `tsconfig` paths, monorepo workspace packages, Python `src` layouts, wide C# namespaces | Fewer unresolved imports, better impact |
| Content search inside `context_for` | Today it matches names only |
| Targeted tests for the runners not covered yet: mocha, cargo, dotnet, maven, and `pnpm`, `yarn` and `bun` projects | jest, vitest, `node --test` and pytest are narrowed without a template (see "The change gate"). The rest need the command in `ria.config.json`; `pnpm`/`yarn`/`bun` need `pnpm exec`/`yarn exec`/`bunx` checked on a real project first, and mocha merges `.mocharc`'s spec list with the command line, so a subset needs care |
| Skip the full baseline when the tree already matches a recent green run | The baseline still re-runs everything; in the plain-versus-RIA comparison that was the larger half of the gate's cost |
| `scope: "tied"` on a red baseline, reporting regressions only | A red baseline now forces the full run, which is why the Writer job took 3.7 times as long with RIA in the failing-tests comparison. Failures can be compared by name, so a narrowed run could still catch new failures; it could not claim "improved" |
| Background gate runs with a status call | Very long suites and host timeouts |
| A Claude Code `PreToolUse` hook that refuses an edit until `gate_begin` has run, for the roles that edit | The routing hook only advises, and in the real-host runs a chat on the smallest model sometimes skipped the gate (see "Checked in a real host"). Costs a baseline run before every edit, which is slow on a big suite |
| Routing in Copilot Chat on every request | Copilot has no per-request hook that RIA uses: there it relies on the `start_task` tool, the server's instructions and the agent you pick |
| Router: more languages than English, and learning from the roles you correct | It reads English only; each real misreading so far was a missing general rule |
| PR review mode (`ria review <range>`) | Impact and optional gate on a diff, as a markdown comment |
| `explain_why` from git history and PR or issue references | Intent provenance: why a file is the way it is |
| Several roots and per-package commands | Monorepos |
| Faster warm refresh (file watcher or `git status` fast path) | About 1 s per call at 4,700 files on OneDrive |
| `context_for`: outline a related file (not only the best one or the target) that alone is over the budget | Today such a file is dropped; an outline would cost about 300 tokens and show where to read |
| `impact`: show more of the tied tests | Showing all of them found 17% of held-out files instead of 11%, but the lists that matter have a median of 155 tests; ranking them did not help (see "Measured so far"), so this is a question of output size |
| Run `ria eval history` on more repositories | One repository is an anecdote; the plan weights in particular need more fix commits |

---

## Known limits

- Extraction is heuristic, not a parser. Class methods are best-effort, multi-line signatures are missed, and
  import-like text inside strings can create false edges. Treat the confidence section of `impact` and
  `gate_check` as part of the answer.
- Not resolved yet: `tsconfig` path aliases other than `@/`, `~/`, `#/`, monorepo workspace packages, and C#
  namespaces shared by more than 25 files (no edge is added for those).
- `context_for` queries match file paths and symbol names, not file contents. Pair it with a content search
  when the task is about specific text. A highly relevant file that does not fit the token budget is dropped,
  unless it is the best match or the requested target, which come back as an outline. An outline's cost is what
  counts against the budget, not the file's: the chat is told to read only the part it needs, but RIA cannot make
  it, and a file with a single huge symbol has no outline and is charged in full.
- Coupling is blind to history before a rename, and needs git.
- First index of a large repository is I/O-bound (about 6 s for 4,700 files on OneDrive); later starts use the
  cache, and each call re-checks the file list (about 1 s at that size).
- `plan_score` ranks the plans the chat proposes; it cannot find a better plan nobody wrote. It sees which files
  a plan touches, not what changes inside them, so a plan that keeps a file's public API stable scores the same as
  one that rewrites it. A file name that is not in the index is scored as a new file, so a typo is under-scored (the
  output says which names it treated as new). The caps mean two very large plans can tie on a factor, and reading
  cost counts whole files even though a large file can be read in part. Weights are judgement, not fitted;
  step 6 is where they get checked against gate outcomes.
- The roles are instructions. They tell a chat how to use RIA; they cannot make it. Only the Copilot tool allow-list
  is enforced (see "Roles and `ria init`"). The generated files follow the host documentation as fetched on
  2026-10-23, and both hosts have renamed these features before, so re-check the format after a major VS Code or
  Claude Code update. Built-in Copilot tool names (`read`, `search`, `edit`, `execute`) are ignored by a VS Code
  version that does not know them.
- The router chooses a role from the wording of one request, in English, with word and phrase rules. On wording it has
  not seen, expect about 80% right, a few percent wrong and the rest a fallback to the Autopilot or to no role (see
  "How the role is chosen"). It sees one request, not the conversation: "yes" keeps the role the chat already has, but
  a request that only makes sense in context ("do the other one too") can be misread. It cannot tell a joke or a
  quotation from an order. The chat is told to use its own judgement and say which role it chose, and the hook only
  advises: a chat can ignore the role's steps.
- `ria eval history` measures whether the tools predict what developers did, not whether what they did was right,
  and it uses today's import graph with the history as it was. Commit subjects are often too short to be a task
  (102 of 150 on the measured repository). The `plan_score` check treats "a fix, bug or revert commit touched the
  same files soon after" as the outcome, which is noisy. The gate matrix tests cases the gate was built for.
- The gate is only as strong as the project's tests. With no test command it can check imports and exports only,
  and it says its confidence is low.
- The gate needs git and a writable repository. Gate runs block until the commands finish.

---

## Develop

```powershell
npm run typecheck   # src and tests
npm test            # 307 tests, about 1 min: parsers, graph, history, plan scoring, roles and install, evaluation, snapshots, gate flows, MCP over stdio
npm run eval        # the gate against 13 injected faults; exit code 1 if a verdict or a rollback is wrong
npm run build       # rebuild before trying `node dist/index.js`; dist/ is not rebuilt by tests
```

**CI.** [.github/workflows/ci.yml](.github/workflows/ci.yml) runs `npm ci`, typecheck, build, tests and `npm run eval` on
every push to `main` and every pull request, on `windows-latest` with Node 24: the one combination this project was
built and checked on. It has run on GitHub twice, both green (the pull request and the push to `main`, 2026-10-26).
Before that, its steps were run in a fresh clone of the committed code with no git identity configured, as on a runner:
all passed, in about 2 minutes. Linux and macOS have not been tried (WSL is not installed here and Docker is in
Windows-container mode), so they are not in the workflow; add them to a matrix after the suite has run there.

**Add a language.** A row in `extract.ts` (symbol rules, import rule), an entry in `languages.ts`, a
resolver case in `resolve.ts`, and tests in `tests/extract.test.ts` and `tests/graph.test.ts`.
**Add a gate parser.** Test counts go in `COUNT_PARSERS`, failed-test names in `FAILED_TEST_PATTERNS`, and
diagnostic shapes in `parseDiagnostics`, all in `src/gate/parse.ts`, with a sample of real output in
`tests/gate-parse.test.ts`.
**Add a tool.** Write the logic in `src/tools/`, register it in `src/server.ts` with a description the chat can act
on, add the CLI case in `src/index.ts`, and cover it in `tests/server.test.ts`.

**Conventions.** Keep RIA language- and domain-agnostic, with no LLM calls. Gate commands never come from tool
arguments. Bump `CACHE_SCHEMA` in `src/repo/repo-index.ts` whenever the content of a cached file record changes.
Tests build throwaway git repositories under the OS temp directory and clean up after themselves.
Small fixtures alone missed several real problems, so for ranking and parser changes also run the tools on a
real repository (`--no-cache` keeps it read-only).

**Gotchas**

- TypeScript 7 does not load `@types/*` by itself, so `tsconfig.json` sets `"types": ["node"]`.
- On Windows, git needs `core.longpaths` in deep folders (set on every git call here), and `core.autocrlf=true`
  rewrites line endings unless snapshots bypass it (they do).
- A nested `node --test` inherits `NODE_TEST_CONTEXT` and misbehaves, so the gate runner removes it.
- `git add` with the user's index would reuse line-ending-normalised blobs, so snapshots use their own index.
- PowerShell shows a child process's stderr as an error record even when the exit code is 0; RIA's progress
  lines go to stderr on purpose, because stdout carries the MCP protocol.
- `npm install` prints a warning about an unapproved `esbuild` install script (a `tsx` dependency); tests and
  the CLI work regardless.
