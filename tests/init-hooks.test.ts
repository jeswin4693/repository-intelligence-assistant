import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { HOOKS_FILE, InitPlan, applyInit, formatInit, planInit } from "../src/init/init";
import { cleanup, makeRepo } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const ENTRY = "C:/Program Files/ria/dist/index.js";
const repo = (files: Record<string, string> = {}) => {
  const d = makeRepo({ "src/a.ts": "export const a = 1;\n", ...files });
  dirs.push(d);
  return d;
};
const plan = (dir: string, opts: Partial<Parameters<typeof planInit>[1]> = {}): InitPlan => {
  const p = planInit(dir, { host: "claude", roles: ["reader"], entry: ENTRY, hooks: true, ...opts });
  assert.ok(!("error" in p), "error" in p ? p.error : "");
  return p;
};
const hooksAction = (p: InitPlan) => p.actions.find((a) => a.path === HOOKS_FILE);
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, HOOKS_FILE), "utf8"));

const mine = { type: "command", command: "echo mine" };
const handler = (verb: string, timeout: number, entry = ENTRY) => ({ type: "command", command: "node", args: [entry, "hook", verb], timeout });

describe("ria init --hooks", () => {
  it("writes nothing about hooks unless asked, and only for Claude Code", () => {
    const dir = repo();
    assert.equal(hooksAction(plan(dir, { hooks: false })), undefined);
    const copilot = plan(dir, { host: "copilot" });
    assert.equal(hooksAction(copilot), undefined);
    assert.match(copilot.notes.join("\n"), /--hooks is for Claude Code/);
    assert.ok(hooksAction(plan(dir, { host: "both" })), "both includes Claude Code");
  });

  it("creates a personal settings file with the routing hook and the gate hook, in exec form", () => {
    const dir = repo();
    const p = plan(dir);
    const a = hooksAction(p)!;
    assert.equal(a.kind, "create");
    assert.equal(a.path, ".claude/settings.local.json");
    assert.deepEqual(JSON.parse(a.content!), {
      hooks: {
        UserPromptSubmit: [{ hooks: [handler("prompt", 10)] }],
        Stop: [{ hooks: [handler("stop", 1200)] }],
      },
    });
    assert.match(p.notes.join("\n"), /personal: keep it out of git/);
    assert.equal(fs.existsSync(path.join(dir, ".claude")), false, "a plan writes nothing");

    assert.equal(applyInit(dir, p) >= 2, true);
    assert.deepEqual(read(dir).hooks.Stop[0].hooks[0].args, [ENTRY, "hook", "stop"], "a path with a space stays one argument");
  });

  it("is a no-op the second time", () => {
    const dir = repo();
    applyInit(dir, plan(dir));
    const again = plan(dir);
    assert.equal(hooksAction(again)!.kind, "unchanged");
    assert.match(hooksAction(again)!.detail, /already registered this way/);
  });

  it("adds its hooks next to the settings and hooks that are already there", () => {
    const existing = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: { UserPromptSubmit: [{ hooks: [mine] }], PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo after edit" }] }] },
    };
    const dir = repo({ [HOOKS_FILE]: JSON.stringify(existing) });
    const a = hooksAction(plan(dir))!;
    assert.equal(a.kind, "update");
    const next = JSON.parse(a.content!);
    assert.deepEqual(next.permissions, existing.permissions);
    assert.deepEqual(next.hooks.PostToolUse, existing.hooks.PostToolUse);
    assert.deepEqual(next.hooks.UserPromptSubmit, [{ hooks: [mine] }, { hooks: [handler("prompt", 10)] }], "yours first, RIA's appended");
    assert.deepEqual(next.hooks.Stop, [{ hooks: [handler("stop", 1200)] }]);
  });

  it("keeps a RIA hook you configured differently, unless --force, and then replaces only that handler", () => {
    const old = handler("prompt", 10, "C:/old/ria/dist/index.js");
    const dir = repo({ [HOOKS_FILE]: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [mine, old] }] } }) });

    const kept = hooksAction(plan(dir))!;
    assert.equal(kept.kind, "update", "the Stop hook is still added");
    assert.match(kept.detail, /UserPromptSubmit kept as it was/);
    assert.deepEqual(JSON.parse(kept.content!).hooks.UserPromptSubmit, [{ hooks: [mine, old] }]);

    applyInit(dir, plan(dir));
    const onlyKept = hooksAction(plan(dir))!;
    assert.equal(onlyKept.kind, "skip");
    assert.match(onlyKept.detail, /already configured differently, so it is kept \(--force replaces only that entry\)/);

    const forced = hooksAction(plan(dir, { force: true }))!;
    assert.equal(forced.kind, "update");
    assert.deepEqual(JSON.parse(forced.content!).hooks.UserPromptSubmit, [{ hooks: [mine, handler("prompt", 10)] }]);
  });

  it("recognises a RIA hook written as shell text, and does not add a second one", () => {
    const dir = repo({ [HOOKS_FILE]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/ria/dist/index.js hook stop" }] }] } }) });
    const a = hooksAction(plan(dir))!;
    const next = JSON.parse(a.content!);
    assert.equal(next.hooks.Stop.length, 1, "no duplicate Stop hook");
    assert.equal(next.hooks.UserPromptSubmit.length, 1);
    assert.match(a.detail, /Stop kept as it was/);
  });

  it("registers `ria` from the PATH with --on-path", () => {
    const dir = repo();
    const h = JSON.parse(hooksAction(plan(dir, { onPath: true }))!.content!).hooks;
    assert.deepEqual(h.UserPromptSubmit[0].hooks[0], { type: "command", command: "ria", args: ["hook", "prompt"], timeout: 10 });
    assert.deepEqual(h.Stop[0].hooks[0].args, ["hook", "stop"]);
  });

  it("does not rewrite a file it cannot read as plain JSON, or one whose hooks are not what it expects", () => {
    for (const [content, why] of [
      [`{\n  // my hooks\n  "hooks": {}\n}\n`, /plain JSON/],
      [`{ "hooks": [] }`, /no usable "hooks" object/],
      [`{ "hooks": { "Stop": {} } }`, /"hooks.Stop" is not a list/],
    ] as const) {
      const dir = repo({ [HOOKS_FILE]: content });
      const a = hooksAction(plan(dir))!;
      assert.equal(a.kind, "manual");
      assert.match(a.detail, why);
      assert.match(a.detail, /Add this by hand:/);
      assert.equal(a.content, undefined);
      assert.equal(applyInit(dir, plan(dir)) >= 0, true);
      assert.equal(fs.readFileSync(path.join(dir, HOOKS_FILE), "utf8"), content, "the file is untouched");
    }
  });

  it("shows up in the preview, and writes only with --apply from the command line", () => {
    const dir = repo();
    const preview = formatInit(plan(dir), dir, false);
    assert.match(preview, /create +\.claude\/settings\.local\.json {2}\(registers the routing hook and the gate hook\)/);

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const cli = path.join(path.resolve(__dirname, ".."), "src", "index.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, "init", "--host", "claude", "--roles", "reader", "--hooks", "--on-path", "--root", dir, ...args], { env, encoding: "utf8" });
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /settings\.local\.json/);
    assert.equal(fs.existsSync(path.join(dir, HOOKS_FILE)), false, "no --apply, nothing written");
    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(read(dir).hooks.UserPromptSubmit[0].hooks[0].args, ["hook", "prompt"]);
  });
});
