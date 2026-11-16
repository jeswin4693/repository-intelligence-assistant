import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { newId, saveRun } from "../src/gate/store";
import { RunState } from "../src/gate/types";
import { decidePretool, parsePretoolInput, pretoolOutput } from "../src/hooks/pretool";
import { cleanup, gitInit, makeRepo } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

/** A git repository, with a gate run on disk when `createdAt` is given; only the run's id and time matter to the hook. */
function repo(createdAt?: Date): { dir: string; id?: string } {
  const dir = makeRepo({ "src/a.ts": "export const a = 1;\n", "docs/notes.md": "x\n" });
  dirs.push(dir);
  gitInit(dir);
  if (!createdAt) return { dir };
  const id = newId(createdAt);
  saveRun(dir, { id, label: "t", createdAt: createdAt.toISOString() } as unknown as RunState);
  return { dir, id };
}

const edit = (dir: string, file: string, tool = "Edit") => decidePretool(dir, { tool, file });

describe("parsePretoolInput", () => {
  it("reads the tool and the file, or the notebook, and tolerates anything else", () => {
    assert.deepEqual(parsePretoolInput(`{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/p/a.ts","old_string":"x"}}`), { tool: "Edit", file: "/p/a.ts" });
    assert.deepEqual(parsePretoolInput(`{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/p/n.ipynb"}}`), { tool: "NotebookEdit", file: "/p/n.ipynb" });
    for (const odd of ["", "not json", "null", "[]", "3", `{"tool_input":5}`, `{"tool_name":7,"tool_input":{"file_path":9}}`]) {
      const p = parsePretoolInput(odd);
      assert.equal(p.tool, undefined, odd);
      assert.equal(p.file, undefined, odd);
    }
  });
});

describe("the PreToolUse hook decision", () => {
  it("refuses an edit of a project file while no gate run was started, says what to do, and writes nothing", () => {
    const { dir } = repo();
    const d = edit(dir, path.join(dir, "src", "a.ts"));
    assert.equal(d.deny, true);
    assert.match(d.reason!, /Do not edit `src\/a\.ts` yet: no change-gate baseline has been recorded/);
    assert.match(d.reason!, /`gate_begin`/);
    assert.match(d.reason!, /select:mcp__ria__gate_begin/, "it says how to load the tool when it is not loaded yet");
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false, "no .ria/ appeared");
  });

  it("refuses every tool that edits, a relative path and a notebook included, and nothing else", () => {
    const { dir } = repo();
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(edit(dir, "src/new.ts", tool).deny, true, tool);
    assert.equal(edit(dir, path.join(dir, "docs", "n.ipynb"), "NotebookEdit").deny, true);
    // the tool that gets the baseline, and everything that only reads or runs, are never held back
    for (const tool of ["mcp__ria__gate_begin", "Read", "Bash", "Grep", "Glob", "Task", ""]) assert.equal(edit(dir, "src/a.ts", tool).deny, false, `tool "${tool}"`);
    assert.equal(decidePretool(dir, {}).deny, false, "no tool, nothing to decide");
    assert.equal(decidePretool(dir, { tool: "Edit" }).deny, false, "no file, nothing to decide");
  });

  it("lets an edit through once a gate run is recent, whatever its result, and prints nothing for it", () => {
    const { dir } = repo(new Date(Date.now() - 3_600_000));
    const d = edit(dir, "src/a.ts");
    assert.deepEqual(d, { deny: false, note: undefined });
    assert.equal(pretoolOutput(d), undefined, "an explicit allow would skip the person's own permission prompts");
  });

  it("refuses again when the latest run is older than the limit, because it is probably another task's", () => {
    const { dir, id } = repo(new Date(Date.now() - 13 * 3_600_000));
    const d = edit(dir, "src/a.ts");
    assert.equal(d.deny, true);
    assert.match(d.reason!, new RegExp(`the latest gate run \\(${id}\\) is older than 12 hours`));
    // the limit is an option, as it is for the stop hook
    assert.equal(decidePretool(dir, { tool: "Edit", file: "src/a.ts" }, { maxAgeHours: 24 }).deny, false);
    const young = repo(new Date(Date.now() - 2 * 3_600_000));
    assert.equal(decidePretool(young.dir, { tool: "Edit", file: "src/a.ts" }, { maxAgeHours: 1 }).deny, true);
  });

  it("does not hold back files that are not the project's: outside it, or RIA's, Claude Code's and git's own", () => {
    const { dir } = repo();
    const outside = path.join(path.dirname(dir), "somewhere-else", "scratch.txt");
    assert.equal(edit(dir, outside).deny, false, "an absolute path outside the repository");
    assert.equal(edit(dir, path.join("..", "scratch.txt")).deny, false, "a relative path that leaves it");
    assert.equal(edit(dir, path.join(homeDir(), ".claude", "memory", "m.md")).deny, false, "a memory file");
    for (const inside of [".ria/gate/x/run.json", ".claude/settings.local.json", ".claude/skills/s/SKILL.md", ".git/info/exclude"]) {
      assert.equal(edit(dir, path.join(dir, inside)).deny, false, inside);
    }
    // a name that merely starts like one of them is the project's
    assert.equal(edit(dir, ".github/workflows/ci.yml").deny, true);
    assert.equal(edit(dir, ".riafile").deny, true);
    assert.equal(edit(dir, "..foo").deny, true, "a file whose name starts with two dots is inside");
  });

  it("asks for nothing where the gate cannot run, and says so for the person", () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    dirs.push(dir);
    const d = edit(dir, "a.txt");
    assert.equal(d.deny, false);
    assert.match(d.note!, /not a git repository, so the gate cannot run/);
  });

  it("prints JSON that refuses with the reason, and never an allow", () => {
    const { dir } = repo();
    const out = pretoolOutput(edit(dir, "src/a.ts"))!;
    const v = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(v.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(v.hookSpecificOutput.permissionDecision, "deny");
    assert.match(v.hookSpecificOutput.permissionDecisionReason, /gate_begin/);
    assert.doesNotMatch(out, /"allow"/);
    assert.equal(out.includes("\n"), false, "one line");
  });
});

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? path.parse(process.cwd()).root;
}

describe("ria hook pretool, run the way Claude Code runs it", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const cliEntry = path.join(projectRoot, "src", "index.ts");

  /** Claude Code starts the hook in its own directory with the project root in the environment, JSON on stdin. */
  function runHook(root: string, stdin: string, ...extra: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
    delete env.NODE_TEST_CONTEXT;
    delete env.RIA_ROOT;
    const r = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "hook", "pretool", ...extra], { cwd: projectRoot, env, input: stdin, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const call = (root: string, file: string, tool = "Edit") =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file }, cwd: root });

  it("refuses an edit with no gate run as JSON on stdout and exit code 0, and lets it through, silently, once there is one", () => {
    const { dir } = repo();
    const refused = runHook(dir, call(dir, path.join(dir, "src", "a.ts")));
    assert.equal(refused.status, 0, refused.stderr);
    const v = JSON.parse(refused.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(v.hookSpecificOutput.permissionDecision, "deny");
    assert.match(v.hookSpecificOutput.permissionDecisionReason, /src\/a\.ts/);
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false, "the hook wrote no .ria/ into the repository");

    const started = repo(new Date());
    const allowed = runHook(started.dir, call(started.dir, path.join(started.dir, "src", "a.ts")));
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, "", "nothing on stdout: the person's own permission rules still decide");
  });

  it("lets everything through, with exit code 0, when its input is empty, broken or about another tool", () => {
    const { dir } = repo();
    for (const stdin of ["", "not json", "{}", call(dir, path.join(dir, "src", "a.ts"), "Bash")]) {
      const r = runHook(dir, stdin);
      assert.equal(r.status, 0, `${stdin}: ${r.stderr}`);
      assert.equal(r.stdout, "", stdin);
    }
  });

  it("reads --max-age-hours", () => {
    const { dir } = repo(new Date(Date.now() - 3 * 3_600_000));
    assert.equal(runHook(dir, call(dir, "src/a.ts")).stdout, "");
    assert.match(runHook(dir, call(dir, "src/a.ts"), "--max-age-hours", "1").stdout, /permissionDecision/);
  });
});
