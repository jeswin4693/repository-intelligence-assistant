# CLAUDE.md: Repository Intelligence Assistant (RIA)

RIA is an MCP server and CLI that gives AI chats repo navigation (`repo_map`, `context_for`, `find_path`, `impact`)
and a change gate (`gate_begin`, `gate_check`, `gate_rollback`). No LLM, no API key, any language.
**The full plan, architecture, status and roadmap are in [README.md](README.md). Read it before changing anything.**

Status: steps 1 (navigation) and 2 (change gate) are built; step 3 `plan_score` is next. Nothing is committed yet.

## Commands

```powershell
npm run typecheck   # src and tests
npm test            # 149 tests, about 40 s
npm run build       # needed before `node dist/index.js ...` or the MCP configs; tests run from src
```

## Rules for working here

- Keep RIA language- and domain-agnostic. No Business Central/AL or Made2Manage specifics, no LLM or API calls.
- Gate commands come only from project files or `ria.config.json`. Never accept a command string from a tool argument.
- Snapshots must stay byte-exact: do not seed from the user's git index or drop the raw git options in `src/gate/snapshot.ts`.
- Bump `CACHE_SCHEMA` in `src/repo/repo-index.ts` when the content of a cached file record changes.
- Every behaviour gets a test. For ranking or parser changes also run the tools on a real repository with `--no-cache`
  (small fixtures alone missed several real problems).
- Do not write `.ria/` into other repositories while testing; use `--no-cache`.
- Do not commit or push unless asked.

## Traps on this machine (Windows, OneDrive)

- TypeScript 7 needs `"types": ["node"]` in `tsconfig.json`.
- Git needs `core.longpaths` in deep folders and `core.autocrlf=true` rewrites line endings; both are handled in the code.
- A nested `node --test` needs `NODE_TEST_CONTEXT` removed from its environment (the gate runner does this).
- stdout carries the MCP protocol: write diagnostics to stderr only.
