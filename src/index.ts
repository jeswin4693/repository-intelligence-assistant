#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { gateBegin, gateCheck, gateRollback } from "./gate/gate";
import { RepoIndex } from "./repo/repo-index";
import { serve } from "./server";
import { contextFor, formatContext } from "./tools/context";
import { findPath, formatPath } from "./tools/find-path";
import { formatImpact, impact } from "./tools/impact";
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
  gate begin                  Before editing: record the tree, run the project's checks   [--label <text>] [--commands a,b]
  gate check                  After editing: compare with the baseline (exit code 1 if worse)  [--id <id>] [--commands a,b]
  gate rollback               Preview undoing everything since the baseline; add --apply to do it

Options:
  --root <dir>                Repository to analyse (default: $RIA_ROOT or the current directory)
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
      "max-tokens": { type: "string" },
      "max-files": { type: "string" },
      label: { type: "string" },
      commands: { type: "string" },
      id: { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const root = path.resolve(values.root ?? process.env.RIA_ROOT ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const indexOptions = { cache: !values["no-cache"] && !process.env.RIA_NO_CACHE };
  if (command === "serve") return serve(root, indexOptions);

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
