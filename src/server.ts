import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GateError, gateBegin, gateCheck, gateRollback } from "./gate/gate";
import { RepoIndex, RepoIndexOptions } from "./repo/repo-index";
import { contextFor, formatContext } from "./tools/context";
import { findPath, formatPath } from "./tools/find-path";
import { formatImpact, impact } from "./tools/impact";
import { formatPlanScore, planScore } from "./tools/plan-score";
import { repoMap } from "./tools/repo-map";
import { startTask } from "./tools/route";

const INSTRUCTIONS = `RIA gives you a precomputed map of the repository: symbols, an import graph and git co-change history. Prefer it to opening many files.
- At the start of every new request from the user: start_task with the request in their own words. It works out what kind of task it is (writer: something new; fixer: a bug or failing check; reader: understand or find; analyser: options or risk; extractor: move or restructure without changing behaviour; reviewer: check a diff; autopilot: a whole task or several kinds) and returns that role's steps. Follow them. When the next request is a different kind of task, switch role. A short reply such as "yes" or "continue" keeps the current role.
- Orient in an unfamiliar repo: repo_map.
- Before reading or editing for a task: context_for with the task text and/or a file, then read only what it returns.
- Before changing a file: impact, and re-read the files and tests it lists after the change.
- To see how two files or symbols relate: find_path.
- When there are several ways to do a task: write each as a plan with the files it would change and call plan_score, then follow the ranking or say why you chose differently.
- Around an edit session: gate_begin before the first edit (it runs the project's own build/test commands for a baseline), gate_check after editing, and if the verdict is regressed or mixed either fix the listed problems and check again, or gate_rollback.
All paths are relative to the repository root. Results come from regex-based analysis of source files, so check the confidence notes in impact and gate_check output. The gate only runs commands found in the project's own files or ria.config.json; you cannot supply commands.`;

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function guarded(index: RepoIndex, fn: () => string | { error: string }) {
  try {
    index.refresh();
    const r = fn();
    return typeof r === "string" ? reply(r) : reply(r.error, true);
  } catch (e) {
    return reply(`RIA failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function guardedAsync(index: RepoIndex, fn: () => Promise<string>) {
  try {
    index.refresh();
    return reply(await fn());
  } catch (e) {
    if (e instanceof GateError) return reply(e.message, true);
    return reply(`RIA failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

type ProgressContext = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ServerNotification) => Promise<void>;
};

/**
 * Turns progress messages into MCP progress notifications when the client asked
 * for them. They double as keep-alives: a long test run would otherwise look like
 * a hung request to clients that time out on silence.
 */
function progressOf(extra: ProgressContext): ((message: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let step = 0;
  return (message) => {
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message } }).catch(() => {});
  };
}

export function createServer(index: RepoIndex): McpServer {
  const server = new McpServer({ name: "ria", version: version() }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const runsCommands = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool(
    "start_task",
    {
      title: "Pick the role for a task",
      description:
        "Call this FIRST for every new request from the user, with their request in their own words. It works out what kind of task it is (something new to create, a bug or failing check to fix, code to understand or find, options or risk to judge, code to move or restructure without changing behaviour, a diff to review, or a whole task or several kinds at once) and returns the role to act as, why, and that role's steps, stop conditions and report. Follow them. Skip it for a short follow-up such as \"yes\" or \"continue\", which keeps the current role. It reads the wording of the request and checks whether the paths it names exist; that is a heuristic, so use your own judgement when the conversation says the request is something else, and say which role you chose.",
      inputSchema: {
        task: z.string().min(1).max(4000).describe("The user's request, in their own words."),
      },
      annotations: readOnly,
    },
    async ({ task }) => guarded(index, () => startTask(index, task)),
  );

  server.registerTool(
    "repo_map",
    {
      title: "Repository map",
      description:
        "Orientation for a repository: languages, entry points, directory structure, and the most depended-on files with their top-level symbols. Call it first in an unfamiliar repo, or with `focus` to zoom into one directory. Much cheaper than listing and reading files.",
      inputSchema: {
        max_tokens: z.number().int().min(500).max(20000).optional().describe("Approximate size budget for the answer. Default 4000."),
        focus: z.string().optional().describe("Repo-relative directory to restrict the map to, e.g. src/api."),
      },
      annotations: readOnly,
    },
    async ({ max_tokens, focus }) => guarded(index, () => repoMap(index, { maxTokens: max_tokens, focus })),
  );

  server.registerTool(
    "context_for",
    {
      title: "Files worth reading for a task",
      description:
        "Returns the smallest ranked set of files to read for a task, each with the reason it matters (imports it, imported by it, changes with it in git history, test for it) and a token estimate. Give a `target` file or symbol, a `query` describing the task, or both. Query matching covers file paths and symbol names, not file contents, so follow up with a content search when the query is about specific text. A file that alone is bigger than the budget comes back as an outline of its symbols with line numbers: read only the part you need.",
      inputSchema: {
        target: z.string().optional().describe("A file path, unique path suffix, or symbol name to centre the context on."),
        query: z.string().optional().describe("Task or topic in plain words, e.g. 'retry logic for payment webhooks'."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum files to return. Default 12."),
        max_tokens: z.number().int().min(500).max(100000).optional().describe("Approximate total size of the returned files. Default 8000."),
        include_tests: z.boolean().optional().describe("Include tests tied to the files. Default true."),
      },
      annotations: readOnly,
    },
    async ({ target, query, max_files, max_tokens, include_tests }) =>
      guarded(index, () => {
        if (!target && !query) return { error: "Provide `target`, `query`, or both." };
        const maxTokens = max_tokens ?? 8000;
        const r = contextFor(index, { target, query, maxFiles: max_files, maxTokens, includeTests: include_tests });
        return "error" in r ? r : formatContext(r, [target, query && `"${query}"`].filter(Boolean).join(" + "), maxTokens);
      }),
  );

  server.registerTool(
    "find_path",
    {
      title: "Dependency path between two files",
      description:
        "Cheapest chain of import relationships between two files or symbols, with the direction of each step. Use it to understand how a change in one place can reach another, or to find the route from an entry point to the code you are debugging. When no chain exists it says so and reports whether the files still change together.",
      inputSchema: {
        from: z.string().describe("File path, unique path suffix, or symbol name."),
        to: z.string().describe("File path, unique path suffix, or symbol name."),
      },
      annotations: readOnly,
    },
    async ({ from, to }) =>
      guarded(index, () => {
        const r = findPath(index, from, to);
        return "error" in r ? r : formatPath(r);
      }),
  );

  server.registerTool(
    "impact",
    {
      title: "Impact of changing files",
      description:
        "Call before changing files. Lists what depends on them (with distance), files that change together with them in git history but do not import them, the tests tied to them, their public symbols, a transparent risk score, and how much to trust the analysis. After the change, re-check the listed dependents and run the listed tests.",
      inputSchema: {
        files: z.array(z.string()).min(1).max(50).describe("Files (or symbols) that will change."),
        depth: z.number().int().min(1).max(6).optional().describe("How many import hops to follow. Default 3."),
      },
      annotations: readOnly,
    },
    async ({ files, depth }) =>
      guarded(index, () => {
        const r = impact(index, { files, depth });
        return "error" in r ? r : formatImpact(r, depth ?? 3);
      }),
  );

  server.registerTool(
    "plan_score",
    {
      title: "Rank candidate plans",
      description:
        "Call when a task can be done in more than one way, before editing. Give each candidate plan as a short name and the files it would change (files it will create may be listed too). Scores every plan from the import graph and git history: how many files it changes, how many dependents it affects, how many of its files lack tests, which files that usually change together with them it leaves out, and how much has to be read. Returns a ranking with the reasons, the tests to run for each plan and how far to trust it. The score is a heuristic over the plans you propose, not a prediction: it does not know what changes inside a file.",
      inputSchema: {
        plans: z
          .array(
            z.object({
              name: z.string().max(80).optional().describe("Short label for the plan, e.g. 'patch the retry in client.ts'."),
              files: z.array(z.string()).min(1).max(50).describe("Files (or symbols) the plan would change; new files may be included."),
            }),
          )
          .min(1)
          .max(8)
          .describe("The candidate plans to compare. Give at least two to get a ranking."),
        depth: z.number().int().min(1).max(6).optional().describe("How many import hops to follow for dependents. Default 3."),
      },
      annotations: readOnly,
    },
    async ({ plans, depth }) =>
      guarded(index, () => {
        const r = planScore(index, { plans, depth });
        return "error" in r ? r : formatPlanScore(r);
      }),
  );

  server.registerTool(
    "gate_begin",
    {
      title: "Start a change gate",
      description:
        "Call BEFORE the first edit of a task. Records the working tree and runs the project's own build, typecheck, lint and test commands to get a baseline, so gate_check can later say what your change fixed or broke. The commands come from the project's files (package.json, pyproject.toml, go.mod, Cargo.toml, .sln/.csproj, pom.xml, Makefile) or ria.config.json; you cannot supply commands. Can take minutes on a large test suite, and you must make no edits until it returns.",
      inputSchema: {
        label: z.string().max(100).optional().describe("Short name for this task, shown in reports."),
        commands: z.array(z.string()).max(10).optional().describe('Run only these named commands, e.g. ["typecheck", "test"]. Default: all that were found.'),
      },
      annotations: runsCommands,
    },
    async ({ label, commands }, extra) =>
      guardedAsync(index, async () => (await gateBegin({ index, progress: progressOf(extra) }, { label, commands })).text),
  );

  server.registerTool(
    "gate_check",
    {
      title: "Check a change against the gate baseline",
      description:
        "Call AFTER editing. Re-runs the baseline's commands and compares: what now passes or fails, new failing tests, new compiler/lint errors, imports that no longer resolve, exports that disappeared, and which untouched files and tests may be affected. Ends with a verdict (regressed, mixed, improved, unchanged, unverified) and how far to trust it. Changes no files; safe to call repeatedly while you fix problems. When the gate_begin report offers faster checks, scope \"tied\" runs only the tests tied to the changed files; finish with a check without a scope.",
      inputSchema: {
        id: z.string().optional().describe("Run id from gate_begin. Default: the latest run."),
        commands: z.array(z.string()).max(10).optional().describe("Re-run only these named commands from the baseline."),
        scope: z
          .enum(["full", "tied"])
          .optional()
          .describe('"tied": run only the tests tied to the changed files, when RIA knows how to narrow the test command (jest, vitest, node --test, pytest, or ria.config.json) and the baseline was green; otherwise the whole command runs and the report says why. Faster while iterating, so finish with a check without a scope. Default: full.'),
      },
      annotations: runsCommands,
    },
    async ({ id, commands, scope }, extra) =>
      guardedAsync(index, async () => (await gateCheck({ index, progress: progressOf(extra) }, { id, commands, scope })).text),
  );

  server.registerTool(
    "gate_rollback",
    {
      title: "Undo everything since gate_begin",
      description:
        "Puts every file changed since gate_begin back exactly as it was, and removes files added since. Work that was already uncommitted when gate_begin ran is kept. By default this is only a preview; pass apply=true to actually do it, and only after the user wants the changes undone.",
      inputSchema: {
        id: z.string().optional().describe("Run id from gate_begin. Default: the latest run."),
        apply: z.boolean().optional().describe("false or omitted: preview only. true: perform the rollback."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, apply }) => guardedAsync(index, () => gateRollback({ index }, { id, apply })),
  );

  return server;
}

export async function serve(root: string, options: RepoIndexOptions = {}): Promise<void> {
  const index = new RepoIndex(root, options);
  const server = createServer(index);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so diagnostics go to stderr
  process.stderr.write(`ria: serving ${index.root}\n`);
}
