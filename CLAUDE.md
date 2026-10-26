# CLAUDE.md: Repository Intelligence Assistant (RIA)

RIA is an MCP server and CLI that gives AI chats repo navigation (`repo_map`, `context_for`, `find_path`, `impact`),
plan scoring (`plan_score`) and a change gate (`gate_begin`, `gate_check`, `gate_rollback`). No LLM, no API key, any language.
**The full plan, architecture, status and roadmap are in [README.md](README.md). Read it before changing anything.**

Status: steps 1 (navigation), 2 (change gate), 3 (`plan_score`), 4 (role pack and `ria init`) and 6 (eval harness) are built; step 5 (skill forge) is next.

## Commands

```powershell
npm run typecheck   # src and tests
npm test            # 282 tests, about 1 min
npm run eval        # gate against injected faults; ria eval history --root <repo> measures the tools on a real history
npm run build       # needed before `node dist/index.js ...` or the MCP configs; tests run from src
```

## Rules for working here

- Keep RIA language- and domain-agnostic. No Business Central/AL or Made2Manage specifics, no LLM or API calls.
- Gate commands come only from project files or `ria.config.json`. Never accept a command string from a tool argument.
- Snapshots must stay byte-exact: do not seed from the user's git index or drop the raw git options in `src/gate/snapshot.ts`.
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
