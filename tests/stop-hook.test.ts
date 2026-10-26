import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { gateBegin } from "../src/gate/gate";
import { newId, saveRun } from "../src/gate/store";
import { RunState } from "../src/gate/types";
import { decideStop, parseStopInput } from "../src/hooks/stop";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, commit, gitInit, makeRepo, writeFiles } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

/** A repository with a gate run on disk; the unit tests replace the check, so only `id` and `createdAt` matter. */
function withRun(createdAt = new Date()): { dir: string; id: string } {
  const dir = makeRepo({ "a.txt": "x\n" });
  dirs.push(dir);
  const id = newId(createdAt);
  saveRun(dir, { id, label: "t", createdAt: createdAt.toISOString() } as unknown as RunState);
  return { dir, id };
}

const verdicts = (...vs: string[]) => {
  const calls: string[] = [];
  const check = async (_root: string, id: string) => {
    calls.push(id);
    return { verdict: vs[Math.min(calls.length - 1, vs.length - 1)], text: `REPORT ${calls.length}` };
  };
  return { check, calls };
};

describe("parseStopInput", () => {
  it("reads stop_hook_active and tolerates anything else", () => {
    assert.equal(parseStopInput(`{"hook_event_name":"Stop","stop_hook_active":true}`).stopHookActive, true);
    assert.equal(parseStopInput(`{"stop_hook_active":false}`).stopHookActive, false);
    for (const odd of ["", "not json", "null", "[]", "3", `{"stop_hook_active":"yes"}`, "{}"]) {
      assert.equal(parseStopInput(odd).stopHookActive, false, odd);
    }
  });
});

describe("the Stop hook decision", () => {
  it("lets the chat finish, and writes nothing, when no gate run was started", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    dirs.push(dir);
    const { check, calls } = verdicts("regressed");
    const d = await decideStop(dir, { stopHookActive: false }, { check });
    assert.equal(d.block, false);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false, "no .ria/ appeared");
  });

  it("lets the chat finish when the change did not make things worse", async () => {
    for (const verdict of ["improved", "unchanged", "unverified"]) {
      const { dir, id } = withRun();
      const { check, calls } = verdicts(verdict);
      const d = await decideStop(dir, { stopHookActive: false }, { check });
      assert.equal(d.block, false, verdict);
      assert.deepEqual(calls, [id]);
    }
  });

  it("holds the chat back, with the report as the reason, when the verdict is regressed or mixed", async () => {
    for (const verdict of ["regressed", "mixed"]) {
      const { dir, id } = withRun();
      const { check } = verdicts(verdict);
      const d = await decideStop(dir, { stopHookActive: false }, { check });
      assert.equal(d.block, true, verdict);
      assert.match(d.reason!, new RegExp(`change gate \\(run ${id}\\)`));
      assert.match(d.reason!, /Held back 1 of 2/);
      assert.match(d.reason!, /REPORT 1/);
      assert.match(d.reason!, /call gate_check again, or call gate_rollback without apply/);
      assert.doesNotMatch(d.reason!, /last time/);
    }
  });

  it("holds the chat back at most twice in a row, says the second time is the last, then lets it go", async () => {
    const { dir } = withRun();
    const { check, calls } = verdicts("regressed");
    const first = await decideStop(dir, { stopHookActive: false }, { check });
    const second = await decideStop(dir, { stopHookActive: true }, { check });
    const third = await decideStop(dir, { stopHookActive: true }, { check });
    assert.equal(first.block, true);
    assert.equal(second.block, true);
    assert.match(second.reason!, /Held back 2 of 2/);
    assert.match(second.reason!, /last time the gate holds you back/);
    assert.match(second.reason!, /show the rollback preview/);
    assert.equal(third.block, false);
    assert.match(third.note!, /held back 2 times for it and is let go/);
    assert.equal(calls.length, 2, "the gate is not re-run once the chat is let go");
  });

  it("starts the count again when the stop was not caused by the hook", async () => {
    const { dir } = withRun();
    const { check } = verdicts("regressed");
    await decideStop(dir, { stopHookActive: false }, { check });
    const again = await decideStop(dir, { stopHookActive: false }, { check });
    assert.equal(again.block, true);
    assert.match(again.reason!, /Held back 1 of 2/);
  });

  it("starts the count again after a pass", async () => {
    const { dir } = withRun();
    const { check } = verdicts("regressed", "improved", "regressed");
    assert.equal((await decideStop(dir, { stopHookActive: false }, { check })).block, true);
    assert.equal((await decideStop(dir, { stopHookActive: true }, { check })).block, false);
    const later = await decideStop(dir, { stopHookActive: true }, { check });
    assert.equal(later.block, true);
    assert.match(later.reason!, /Held back 1 of 2/);
  });

  it("honours --max-blocks", async () => {
    const { dir } = withRun();
    const { check } = verdicts("regressed");
    const d = await decideStop(dir, { stopHookActive: false }, { check, maxBlocks: 1 });
    assert.equal(d.block, true);
    assert.match(d.reason!, /Held back 1 of 1/);
    assert.match(d.reason!, /last time the gate holds you back/);
  });

  it("ignores a baseline that is older than the limit, unless the limit is raised", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const { dir } = withRun(new Date("2026-10-25T23:00:00Z")); // 13 hours earlier
    const { check, calls } = verdicts("regressed");
    const stale = await decideStop(dir, { stopHookActive: false }, { check, now });
    assert.equal(stale.block, false);
    assert.match(stale.note!, /older than 12 hours/);
    assert.equal(calls.length, 0);
    const raised = await decideStop(dir, { stopHookActive: false }, { check, now, maxAgeHours: 24 });
    assert.equal(raised.block, true);
  });

  it("does not enforce a run whose date cannot be read", async () => {
    const { dir, id } = withRun();
    saveRun(dir, { id, label: "t", createdAt: "not a date" } as unknown as RunState);
    const { check, calls } = verdicts("regressed");
    assert.equal((await decideStop(dir, { stopHookActive: false }, { check })).block, false);
    assert.equal(calls.length, 0);
  });

  it("cuts a very long report", async () => {
    const { dir } = withRun();
    const check = async () => ({ verdict: "regressed", text: "x".repeat(20_000) });
    const d = await decideStop(dir, { stopHookActive: false }, { check });
    assert.ok(d.reason!.length < 7_500, `reason is ${d.reason!.length} characters`);
    assert.match(d.reason!, /\(cut; call gate_check for the whole report\)/);
  });

  it("does not turn a failing gate into a pass or a block", async () => {
    const { dir } = withRun();
    const check = async () => {
      throw new Error("git is not available");
    };
    await assert.rejects(decideStop(dir, { stopHookActive: false }, { check }), /git is not available/);
  });
});

describe("ria hook stop, run the way Claude Code runs it", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const cliEntry = path.join(projectRoot, "src", "index.ts");
  // the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
  const requireMath = (spec: string) => `const { add, sub } = require("${spec}");\n`;
  const MATH_OK = `exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n`;
  const MATH_BAD = `exports.add = (a, b) => a - b;\nexports.sub = (a, b) => a - b;\n`;
  const MATH_TEST = `const test = require("node:test");\nconst assert = require("node:assert/strict");\n${requireMath("../src/math")}test("adds", () => assert.equal(add(1, 2), 3));\ntest("subtracts", () => assert.equal(sub(3, 1), 2));\n`;
  const CONFIG = JSON.stringify({ gate: { commands: { test: "node --test test/math.test.js" } } });

  /** Claude Code starts the hook in its own directory with the project root in the environment, JSON on stdin. */
  function runHook(root: string, stopHookActive: boolean, ...extra: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
    delete env.NODE_TEST_CONTEXT;
    delete env.RIA_ROOT;
    const r = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "hook", "stop", ...extra], {
      cwd: projectRoot,
      env,
      input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: stopHookActive, cwd: root }),
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("blocks a regressed change as JSON on stdout, then lets the chat finish once it is fixed", async () => {
    const dir = makeRepo({ "src/math.js": MATH_OK, "test/math.test.js": MATH_TEST, "ria.config.json": CONFIG });
    dirs.push(dir);
    gitInit(dir);
    commit(dir, "initial");

    // nothing to enforce yet: the chat has not begun a gate
    const none = runHook(dir, false);
    assert.equal(none.status, 0);
    assert.equal(none.stdout, "");
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false, "the hook wrote nothing into a repository without a gate run");

    await gateBegin({ index: new RepoIndex(dir) }, { label: "fix subtraction" });
    writeFiles(dir, { "src/math.js": MATH_BAD });

    const first = runHook(dir, false);
    assert.equal(first.status, 0, first.stderr);
    const decision = JSON.parse(first.stdout) as { decision: string; reason: string };
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /REGRESSED/);
    assert.match(decision.reason, /new failing tests: adds/);
    assert.match(decision.reason, /Held back 1 of 2/);
    assert.doesNotMatch(decision.reason, /ria: running test/, "progress lines must not leak into the chat's instructions");

    const second = runHook(dir, true);
    assert.match((JSON.parse(second.stdout) as { reason: string }).reason, /Held back 2 of 2/);

    const third = runHook(dir, true);
    assert.equal(third.status, 0);
    assert.equal(third.stdout, "", "after two holds the chat is let go");
    assert.match(third.stderr, /let go/);

    writeFiles(dir, { "src/math.js": MATH_OK });
    const fixed = runHook(dir, false);
    assert.equal(fixed.status, 0);
    assert.equal(fixed.stdout, "", "a fixed change is not held back");
  });
});
