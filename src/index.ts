#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { evaluateGate, formatGateEval } from "./eval/gate-eval";
import { evaluateHistory, formatHistoryEval } from "./eval/history-eval";
import { gateBegin, gateCheck, gateRollback } from "./gate/gate";
import { decideStop, parseStopInput } from "./hooks/stop";
import { Host, applyInit, formatInit, planInit } from "./init/init";
import { RepoIndex } from "./repo/repo-index";
import { serve } from "./server";
import { contextFor, formatContext } from "./tools/context";
import { findPath, formatPath } from "./tools/find-path";
import { formatImpact, impact } from "./tools/impact";
import { formatPlanScore, parsePlanArg, planScore } from "./tools/plan-score";
import { repoMap } from "./tools/repo-map";

const USAGE = `Repository Intelligence Assistant

Usage: ria <command> [options]

Commands:
  serve                       Start the MCP server on stdio (for VS Code / Claude Code)
  map                         Repository overview            [--focus <dir>] [--max-tokens <n>]
  context <file|symbol>       Files worth reading for a file   [--query <text>] [--max-files <n>] [--max-tokens <n>]
  context --query <text>      ...or for a task described in words
  path <from> <to>            Import chain between two files or symbols
  impact <file...>            What a change would touch        [--depth <n>]
  plan --plan "Name=a.ts,b.ts" --plan "Other=c.ts"   Rank candidate plans (repeat --plan)  [--depth <n>]
  init --host claude|copilot|both   Install the MCP config and the role files into --root; preview unless --apply
                              [--roles reader,fixer] [--on-path] [--force] [--apply]
  eval history                Replay the repository's own git history against the tools (read-only)  [--commits <n>] [--max-files <n>]
                              [--min-recall <0-1>] [--min-context-hit <0-1>]   exit code 1 when a rate is below the threshold
  eval gate                   Run the gate against injected faults in throwaway projects (exit code 1 if a verdict is wrong)
  gate begin                Before editing: record the tree, run the project's checks   [--label <text>] [--commands a,b]
  gate check                  After editing: compare with the baseline (exit code 1 if worse)  [--id <id>] [--commands a,b]
  gate rollback               Preview undoing everything since the baseline; add --apply to do it
  hook stop                   Claude Code Stop hook: keeps the chat working while the gate says its change made things worse
                              (reads the hook JSON on stdin)  [--max-blocks <n>] [--max-age-hours <n>]

Options:
  --root <dir>                Repository to analyse (default: $RIA_ROOT, for "hook" $CLAUDE_PROJECT_DIR, or the current directory)
  --json                      Print machine-readable output instead of text
  --no-cache                  Do not write .ria/ into the repository (also: RIA_NO_CACHE=1)
  -h, --help                  Show this help
`;

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function ratioOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--${name} must be a number from 0 to 1`);
  return n;
}

/** A hook gets its input on stdin; run by hand in a terminal, or with stdin closed, it simply has none. */
function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void | Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean" },
      "no-cache": { type: "boolean" },
      focus: { type: "string" },
      query: { type: "string" },
      depth: { type: "string" },
      plan: { type: "string", multiple: true },
      commits: { type: "string" },
      "min-recall": { type: "string" },
      "min-context-hit": { type: "string" },
      host: { type: "string" },
      roles: { type: "string" },
      "on-path": { type: "boolean" },
      force: { type: "boolean" },
      "max-tokens": { type: "string" },
      "max-files": { type: "string" },
      label: { type: "string" },
      commands: { type: "string" },
      id: { type: "string" },
      "max-blocks": { type: "string" },
      "max-age-hours": { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  // a hook runs in whatever directory the chat is in, so it reads the project root Claude Code exports
  const root = path.resolve(values.root ?? process.env.RIA_ROOT ?? (command === "hook" ? process.env.CLAUDE_PROJECT_DIR : undefined) ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const indexOptions = { cache: !values["no-cache"] && !process.env.RIA_NO_CACHE };
  if (command === "serve") return serve(root, indexOptions);
  if (command === "eval" && args[0] === "gate") {
    // builds its own throwaway projects: --root is not used
    return evaluateGate(undefined, (name) => void process.stderr.write(`ria: ${name}\n`)).then((r) => {
      process.stdout.write((values.json ? JSON.stringify(r, null, 2) : formatGateEval(r)) + "\n");
      if (r.results.some((x) => !x.ok)) process.exitCode = 1;
    });
  }
  if (command === "eval") {
    if (args[0] !== "history") throw new Error("eval needs a subcommand: history or gate");
    // measuring must never write into the repository being measured, so the cache is off whatever the flags say
    const evalIndex = new RepoIndex(root, { cache: false });
    evalIndex.refresh();
    const r = evaluateHistory(evalIndex, { commits: intOption(values.commits, "commits"), maxFiles: intOption(values["max-files"], "max-files") });
    if ("error" in r) throw new Error(r.error);
    process.stdout.write((values.json ? JSON.stringify(r, null, 2) : formatHistoryEval(r)) + "\n");
    // optional thresholds, so a team can fail its own CI when the tools stop helping on its repository
    const below: string[] = [];
    const minRecall = ratioOption(values["min-recall"], "min-recall");
    const minContext = ratioOption(values["min-context-hit"], "min-context-hit");
    if (minRecall !== undefined && (r.impact?.rates.union ?? 0) < minRecall) below.push(`impact found the held-out file in ${Math.round((r.impact?.rates.union ?? 0) * 100)}% of cases, below --min-recall ${minRecall}`);
    if (minContext !== undefined && (r.context?.anyHit ?? 0) < minContext) below.push(`context_for found a file of the commit in ${Math.round((r.context?.anyHit ?? 0) * 100)}% of cases, below --min-context-hit ${minContext}`);
    if (below.length) {
      for (const b of below) process.stderr.write(`ria: ${b}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "init") {
    // before the index exists: indexing would write a .ria/ cache into the repository being set up
    if (!values.host) throw new Error("init needs --host claude, copilot or both");
    const plan = planInit(root, {
      host: values.host as Host,
      roles: values.roles?.split(",").map((s) => s.trim()).filter(Boolean),
      onPath: values["on-path"],
      force: values.force,
    });
    if ("error" in plan) throw new Error(plan.error);
    const written = values.apply ? applyInit(root, plan) : 0;
    process.stdout.write((values.json ? JSON.stringify({ applied: written, ...plan }, null, 2) : formatInit(plan, root, values.apply === true)) + "\n");
    return;
  }

  if (command === "hook") {
    if (args[0] !== "stop") throw new Error("hook needs a subcommand: stop");
    // before the index exists: with no gate run to enforce, the hook must not write a .ria/ cache into the repository
    const raw = readStdin();
    return decideStop(root, parseStopInput(raw), {
      maxBlocks: intOption(values["max-blocks"], "max-blocks"),
      maxAgeHours: intOption(values["max-age-hours"], "max-age-hours"),
    }).then((d) => {
      if (d.note) process.stderr.write(`${d.note}\n`);
      if (d.block) process.stdout.write(`${JSON.stringify({ decision: "block", reason: d.reason })}\n`);
    });
  }

  const index = new RepoIndex(root, indexOptions);
  index.refresh();
  const maxTokens = intOption(values["max-tokens"], "max-tokens");
  const print = (data: unknown, text: string): void => {
    process.stdout.write((values.json ? JSON.stringify(data, null, 2) : text) + "\n");
  };
  const fail = (message: string) => {
    throw new Error(message);
  };

  switch (command) {
    case "map": {
      const text = repoMap(index, { focus: values.focus, maxTokens });
      return print({ map: text }, text);
    }
    case "context": {
      if (args.length === 0 && !values.query) fail("context needs a file/symbol, --query, or both");
      const opts = { target: args[0], query: values.query, maxFiles: intOption(values["max-files"], "max-files"), maxTokens };
      const r = contextFor(index, opts);
      if ("error" in r) return fail(r.error);
      return print(r, formatContext(r, [opts.target, opts.query && `"${opts.query}"`].filter(Boolean).join(" + "), maxTokens ?? 8000));
    }
    case "path": {
      if (args.length !== 2) fail("path needs exactly two arguments: <from> <to>");
      const r = findPath(index, args[0], args[1]);
      if ("error" in r) return fail(r.error);
      return print(r, formatPath(r));
    }
    case "impact": {
      if (args.length === 0) fail("impact needs at least one file");
      const depth = intOption(values.depth, "depth");
      const r = impact(index, { files: args, depth });
      if ("error" in r) return fail(r.error);
      return print(r, formatImpact(r, depth ?? 3));
    }
    case "plan": {
      if (!values.plan?.length) fail('plan needs at least one --plan "Name=file1,file2"');
      const r = planScore(index, { plans: (values.plan ?? []).map(parsePlanArg), depth: intOption(values.depth, "depth") });
      if ("error" in r) return fail(r.error);
      return print(r, formatPlanScore(r));
    }
    case "gate": {
      const env = { index, progress: (m: string) => void process.stderr.write(`ria: ${m}\n`) };
      const names = values.commands?.split(",").map((s) => s.trim()).filter(Boolean);
      switch (args[0]) {
        case "begin":
          return gateBegin(env, { label: values.label, commands: names }).then((r) => print(r, r.text));
        case "check":
          return gateCheck(env, { id: values.id, commands: names }).then((r) => {
            print(r, r.text);
            // lets a hook or CI step stop on a change that made things worse
            if (r.verdict === "regressed" || r.verdict === "mixed") process.exitCode = 1;
          });
        case "rollback":
          return gateRollback(env, { id: values.id, apply: values.apply }).then((text) => print({ text }, text));
        default:
          return fail("gate needs a subcommand: begin, check or rollback");
      }
    }
    default:
      fail(`Unknown command "${command}". Run "ria --help".`);
  }
}

Promise.resolve()
  .then(main)
  .catch((e: unknown) => {
    process.stderr.write(`ria: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
