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
orient  ->  find the right files  ->  compare plans  ->  gate_begin  ->  edit  ->  gate_check  ->  fix or gate_rollback
repo_map    context_for / impact      plan_score         baseline        chat     better/worse     undo if needed
```

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
| Roles as configuration | Reader, Analyser, Extractor, Writer, Fixer, Reviewer are instruction files that tell the chat which RIA tools to use in which order; `ria init` installs them for Claude Code and Copilot | **Built** |

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

 Planned on top: skill forge, eval harness, VS Code extension.
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
| Gate | `src/gate/snapshot.ts` | Byte-exact snapshots in git, diff between snapshots, restore |
| | `src/gate/detect.ts`, `runner.ts` | Find the project's commands; run them with timeout and heartbeat |
| | `src/gate/parse.ts`, `compare.ts` | Read test and compiler output; compare with baseline; verdict and confidence |
| | `src/gate/store.ts`, `gate.ts`, `types.ts` | Run state on disk, pruning; begin / check / rollback and the report |
| Roles | `src/init/roles.ts`, `render.ts`, `init.ts` | The six roles written once; rendered as Claude Code skills and VS Code agents; `ria init` plans and applies the install (CLI only, not an MCP tool) |
| Tests | `tests/*.test.ts`, `tests/helpers.ts` | 198 tests: parsers, graph, git history, plan scoring, roles and install, snapshots, full gate flows, real MCP client over stdio |

### What happens on a call

- **Navigation tool** (`impact`, for example): refresh the index (re-read only files whose size or
  mtime changed) -> build the graph if anything changed -> resolve the file or symbol the caller
  named -> compute dependents, co-change partners, tests and a risk score -> return a text report.
- **`plan_score`**: resolve every file of every plan (files not in the index count as files the plan
  creates) -> run `impact` on each plan's files -> turn the result into five point components -> sort
  by total, with ties broken by content so the order never depends on how the plans were listed.
- **`ria init`** (command line only): work out every file to write (one MCP config entry and six role files per
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
| Run ids end in milliseconds plus random hex and are matched against an exact pattern | Runs sort in creation order, and an id from tool input can never become a path |
| `core.longpaths=true` on every git call, short scratch file names | Deep folders (OneDrive) pass Windows' 260-character limit once git adds `.lock` files |
| Git `HEAD` is read once per refresh, not once per history lookup | `impact` and `plan_score` ask for history once per file, and every lookup spawned a git process |
| `plan_score` returns points per factor, not one opaque number, and says when a figure was capped | The chat (and you) can see why a plan won, and a saturated figure does not look exact |
| Plans that name files outside the index are scored as creating them; ambiguous names and directories are errors | A typo would score as a new file, so the output says so; guessing between two files would change the ranking silently |
| The six roles are written once and rendered per host | Claude Code skills and VS Code agents differ only in their header, so one edit changes both and a test checks both against the real tool list |
| `ria init` previews unless `--apply`, keeps a role file you edited unless `--force`, merges into an existing MCP config, and is not an MCP tool | Your edits and other servers survive; a chat must not be able to rewrite its own configuration |
| On Copilot, read-only roles are given no edit tool and no gate tool | The agent's tool list is an allow-list VS Code enforces, so "does not edit" is real there, unlike the role's steps |

---

## Status: what is built

Steps 1 to 4 are done. About 4,200 lines of source and 2,400 lines of tests. All 198 tests
pass, typecheck and build are clean.

| Step | What | State |
|---|---|---|
| 1 | MCP server and navigation tools: `repo_map`, `context_for`, `find_path`, `impact` | Done |
| 2 | Change gate: `gate_begin`, `gate_check`, `gate_rollback` | Done |
| 3 | Plan scoring: `plan_score` | Done |
| 4 | Role pack for Claude Code and Copilot Chat, installed by `ria init` | Done |
| 5 | Skill forge | To do |
| 6 | Eval harness | To do |
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

**Not verified yet:** use inside the real Copilot Chat or Claude Code interface (only a test client, and the role
files have never been loaded by either host), and behaviour against those hosts' tool-call timeouts.

---

## Tools

| Tool | Parameters | Use it to |
|---|---|---|
| `repo_map` | `max_tokens` (500-20000, default 4000), `focus` (directory) | Orient in an unfamiliar repo: languages, entry points, structure, most depended-on files and their symbols |
| `context_for` | `target` (file or symbol), `query` (task in words), `max_files` (12), `max_tokens` (8000), `include_tests` (true) | Get the smallest ranked set of files to read, each with the reason it matters and a token estimate |
| `find_path` | `from`, `to` (file, suffix or symbol) | See the cheapest chain of imports between two things, with direction; falls back to co-change evidence |
| `impact` | `files` (1-50), `depth` (1-6, default 3) | Before changing files: dependents, hidden coupling, tests, public symbols, risk score, confidence |
| `plan_score` | `plans` (1-8, each a `name` and `files`; files not in the index count as new), `depth` (1-6, default 3) | When a task can be done several ways: rank the candidate plans by files changed, blast radius, missing tests, ignored coupling and reading cost, with the reasons, the tests to run and the confidence |
| `gate_begin` | `label`, `commands` (names) | Before the first edit: record the tree and run the project's checks as a baseline |
| `gate_check` | `id`, `commands` | After editing: re-run, compare, verdict |
| `gate_rollback` | `id`, `apply` | Undo everything since `gate_begin` (preview unless `apply` is true) |

Symbols in `context_for` and `impact` carry line numbers (`function auth (L120)`) so a large file
can be read in part. Navigation tools are marked read-only; the gate tools are not, and
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

**Undo.** Files are stored and restored byte for byte: line endings are never converted, and
`.gitattributes` filters are bypassed too on git 2.40 or newer. `gate_rollback` restores only what
changed since `gate_begin`; work that was already uncommitted then is kept. It previews by default
and needs `apply` to act.

**From a terminal or CI**

```powershell
node dist/index.js gate begin --label "fix tax rounding"
# ... edit ...
node dist/index.js gate check          # exit code 1 when the verdict is regressed or mixed
node dist/index.js gate rollback       # preview; add --apply to do it
```

**Gate limits.** It needs git and a writable repository (not `--no-cache`). `gate_begin` and
`gate_check` run the whole commands, so a slow test suite makes them slow; progress messages are
sent while they run. Output parsers cover node:test, jest, vitest, mocha, pytest, go, cargo, dotnet
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

**Roles and `ria init`.** The tools work on their own, but a chat does not know which one to use when.
`ria init` installs the MCP config plus six roles: instruction files that say which RIA tools to call in
which order, when to stop, and what to report.

```powershell
node dist/index.js init --host both --root C:/path/to/your/repo           # preview: writes nothing
node dist/index.js init --host both --root C:/path/to/your/repo --apply   # write the files
```

| Host | What is written |
|---|---|
| `--host claude` | the `ria` entry in `.mcp.json`, and `.claude/skills/ria-<role>/SKILL.md` |
| `--host copilot` | the `ria` entry in `.vscode/mcp.json`, and `.github/agents/ria-<role>.agent.md` |

| Role | Use it to | Edits | RIA tools |
|---|---|---|---|
| Reader | understand or explain code, find where something lives | no | `repo_map`, `context_for`, `find_path` |
| Analyser | judge size and risk before a change, compare approaches | no | the navigation tools and `plan_score` |
| Extractor | move or split code without changing behaviour | yes | everything, including the gate |
| Writer | add a feature or new code | yes | everything, including the gate |
| Fixer | fix a bug or a failing check, and prove it | yes | the navigation tools and the gate |
| Reviewer | review someone else's change | no | the navigation tools |

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
  your own settings. Claude Code hooks can enforce a loop: its documentation says a `Stop` hook that exits
  with code 2 keeps Claude from finishing and shows its stderr to Claude. A hook that runs `ria gate check`
  is not written or tested yet (see the backlog).

**From a terminal**

```powershell
node dist/index.js map
node dist/index.js context src/server.ts
node dist/index.js context --query "retry logic for webhooks" --max-tokens 6000
node dist/index.js path src/index.ts src/repo/graph.ts
node dist/index.js impact src/repo/graph.ts --depth 3
node dist/index.js plan --plan "Small=src/repo/graph.ts" --plan "Both=src/repo/graph.ts,src/repo/resolve.ts"
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
  and token budget; symbols that matched the query are listed first.
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
Writer, Fixer, Reviewer.

**Built.** A role is configuration, not a program: instructions plus which RIA tools to use in which order
plus stop conditions and what to report. The six roles are defined once in `src/init/roles.ts` and rendered
as Claude Code skills and VS Code custom agents. `ria init` previews and then writes them with the MCP
config (see "Roles and `ria init`" for what it writes, what it will not overwrite and what is enforced).

**Still open.**

- The role files have never been loaded by Copilot Chat or Claude Code themselves. Whether a model follows
  them well is for step 6 to measure (tokens read and tool order with and without a role).
- The two small tools the Extractor might need (list a file's exports, search symbols by name) were not added:
  `context_for` and the public surface in `impact` cover it so far. Revisit if real use shows a gap.
- The Claude Code hook that enforces the loop (see the backlog).

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

### Step 6: eval harness

**Goal.** Measure whether the tools help, so quality is shown and not assumed, and guard against regressions in RIA itself.

**Design.** Fixture repositories with known tasks and injected faults. Metrics: `context_for` recall at k and
tokens saved against reading everything; `impact` precision and recall by leave-one-out on real git history
(hide one file of a past commit, see whether the others predict it); gate verdict accuracy on injected faults;
`plan_score` ranking against actual gate outcomes. Output a report and a threshold that fails CI.

### Step 7 (optional): VS Code extension

Auto-register the MCP server, a status bar item, a panel showing the latest gate and impact report, and
commands for start, check and rollback.

### Backlog (not scheduled)

| Idea | Why |
|---|---|
| Parser (tree-sitter) behind the same extraction interface | Methods, multi-line signatures, and `import` text inside strings are the main source of wrong edges (this repository's own tests create 24 false gaps) |
| Resolve `tsconfig` paths, monorepo workspace packages, Python `src` layouts, wide C# namespaces | Fewer unresolved imports, better impact |
| Content search inside `context_for` | Today it matches names only |
| Gate mode that runs only the tests tied to changed files | Large suites make the gate slow |
| Background gate runs with a status call | Very long suites and host timeouts |
| Claude Code hook recipe that runs `ria gate check` | Real enforcement. Hook exit codes were checked in the Claude Code docs on 2026-10-23 (a `Stop` hook with exit code 2 keeps Claude working; other non-zero codes do not block), but the recipe is not written or tested |
| PR review mode (`ria review <range>`) | Impact and optional gate on a diff, as a markdown comment |
| `explain_why` from git history and PR or issue references | Intent provenance: why a file is the way it is |
| Several roots and per-package commands | Monorepos |
| Faster warm refresh (file watcher or `git status` fast path) | About 1 s per call at 4,700 files on OneDrive |

---

## Known limits

- Extraction is heuristic, not a parser. Class methods are best-effort, multi-line signatures are missed, and
  import-like text inside strings can create false edges. Treat the confidence section of `impact` and
  `gate_check` as part of the answer.
- Not resolved yet: `tsconfig` path aliases other than `@/`, `~/`, `#/`, monorepo workspace packages, and C#
  namespaces shared by more than 25 files (no edge is added for those).
- `context_for` queries match file paths and symbol names, not file contents. Pair it with a content search
  when the task is about specific text. A highly relevant file that does not fit the token budget is dropped.
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
- The gate is only as strong as the project's tests. With no test command it can check imports and exports only,
  and it says its confidence is low.
- The gate needs git and a writable repository. Gate runs block until the commands finish.

---

## Develop

```powershell
npm run typecheck   # src and tests
npm test            # 198 tests: parsers, graph, history, plan scoring, roles and install, snapshots, gate flows, MCP over stdio
npm run build       # rebuild before trying `node dist/index.js`; dist/ is not rebuilt by tests
```

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
