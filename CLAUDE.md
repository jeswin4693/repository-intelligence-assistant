# CLAUDE.md: Repository Intelligence Assistant (RIA)

RIA is an MCP server and CLI that gives AI chats repo navigation (`repo_map`, `context_for`, `find_path`, `impact`),
plan scoring (`plan_score`), a change gate (`gate_begin`, `gate_check`, `gate_rollback`) and a skill forge
(`fetch_source`, `skill_scaffold`, `skill_test`, `skill_register`, `skill_recheck`; `ria skill approve` installs). No LLM, no API key, any language.
**The full plan, architecture, status and roadmap are in [README.md](README.md). Read it before changing anything.**

Status: steps 1 (navigation), 2 (change gate), 3 (`plan_score`), 4 (role pack and `ria init`), 5 (skill forge) and 6 (eval harness) are built. Step 7 (VS Code extension) is optional; the backlog is in README.md.

## Commands

```powershell
npm run typecheck   # src and tests
npm test            # 546 tests, about 1.5 min
npm run eval        # gate against injected faults; ria eval history --root <repo> measures the tools on a real history
npm run build       # needed before `node dist/index.js ...` or the MCP configs; tests run from src
```

## Rules for working here

- Keep RIA language- and domain-agnostic. No Business Central/AL or Made2Manage specifics, no LLM or API calls.
- Gate commands come only from project files or `ria.config.json`. Never accept a command string from a tool argument.
- Snapshots must stay byte-exact: do not seed from the user's git index or drop the raw git options in `src/gate/snapshot.ts`.
- `gate_begin` may take a command's result instead of running it only when it is a full pass of the same command on a
  byte-identical git tree inside the window (`src/gate/reuse.ts`). Never reuse a failure or a partial run, and a reused
  result keeps the time the command really ran, so reuse cannot stretch the window.
- The skill forge (`src/skills/`) reaches only public addresses, and nothing a tool argument, the environment or a config
  file says may loosen that: the test hook in `FetchOptions` is a code parameter only. It never installs or enables a skill
  from a tool (approval is a person's: `approveSkill` in `src/skills/register.ts` is called from `src/index.ts` only, behind
  an interactive terminal and a typed phrase, and `src/server.ts` must never import it; a test checks that), `skill_test`
  runs nothing a draft declares, `skill_recheck` fetches only the address in RIA's own source record (never one from an
  argument or from `provenance.json`), and a page it fetched is data, never instructions. Keep the HTML reader one-pass: no regular
  expression that rescans the rest of the page for each tag, quote or comment (the timed hostile-input tests guard this).
- The `PreToolUse` hook (`src/hooks/pretool.ts`) refuses with a `deny` and otherwise prints nothing. Never print an
  explicit `allow` from it: that would skip the user's own permission prompts. A hook that breaks must exit 1 (a
  non-blocking error), never leave an edit blocked, and it reads only `.ria/gate`, so it writes nothing.
- Lean mode (`ria serve --lean`, `LEAN_TOOLS` in `src/server.ts`) offers read-only lookups only: nothing that runs a command,
  writes or reaches the network. Anything added to `LEAN_TOOLS` must be read-only (a test checks the annotation), and its
  instructions must not name a tool a lean server does not have. A change to what a chat is handed (instructions, tool
  descriptions, a tool's output size) can cost or save tokens on every turn: measure it before keeping it (README, "Tokens: a
  plain chat against RIA"); two outline changes that looked right were dropped that way.
- The graph page (`src/tools/graph-html.ts`) shows names that come from a repository that may not be yours. Keep the data in
  `safeJson` (no raw `<`, `>`, `&`, line separators), put every name on screen with `textContent` (never `innerHTML`), and
  keep the page free of any request or library: a test fails on `http`, `fetch`, `eval` and `innerHTML`. A change to how it
  draws needs a look at a real render (Chrome or Edge headless, `--screenshot`): three bugs that a passing test did not
  catch were found that way.
- Bump `CACHE_SCHEMA` in `src/repo/repo-index.ts` when the content of a cached file record changes.
- Every behaviour gets a test. For ranking or parser changes also run the tools on a real repository with `--no-cache`
  (small fixtures alone missed several real problems).
- `src/tools/route.ts` picks the role from the wording of a request. Fix a misrouted request with a general rule, never
  a special case for that sentence; add the prompt to a set in `tests/route-cases.ts` and keep the accuracy floors in
  `tests/route.test.ts`. Set E there was measured once before it was used for anything, so add new prompts to a new set.
  Run `node dist/index.js route "<request>"` to see a decision and why. The hooks run from `dist/`: rebuild before
  trying them in Claude Code.
- Do not write `.ria/` into other repositories while testing; use `--no-cache`.
- Do not commit or push unless asked.

## Traps on this machine (Windows, OneDrive)

- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- Git needs `core.longpaths` in deep folders and `core.autocrlf=true` rewrites line endings; both are handled in the code.
- A nested `node --test` needs `NODE_TEST_CONTEXT` removed from its environment (the gate runner does this).
- stdout carries the MCP protocol: write diagnostics to stderr only.
- No direct outbound internet here (`curl` and plain Node time out, no proxy is set), so nothing can be tried on a live website.
- Writing a source file can turn a `\uXXXX` escape into the literal character (U+2028 inside a regex literal then fails to
  compile). After writing code with escapes, search the new files for non-ASCII characters.
