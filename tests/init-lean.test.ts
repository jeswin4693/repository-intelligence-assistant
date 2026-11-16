import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InitPlan, applyInit, planInit } from "../src/init/init";
import { cleanup, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
const ENTRY = "C:/Program Files/ria/dist/index.js";
const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

// the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
const importNamed = (name: string, from: string) => `import { ${name} } from "${from}";\n`;

const repo = () => {
  const d = makeRepo({ "src/a.ts": `export const a = 1;\n`, "src/b.ts": `${importNamed("a", "./a")}export const b = a;\n` });
  dirs.push(d);
  return d;
};
const plan = (dir: string, opts: Partial<Parameters<typeof planInit>[1]> = {}): InitPlan => {
  const p = planInit(dir, { host: "claude", entry: ENTRY, lean: true, ...opts });
  assert.ok(!("error" in p), "error" in p ? p.error : "");
  return p;
};

describe("ria init --lean", () => {
  it("writes only the MCP entry, started with --lean, and no role files and no hooks", () => {
    const p = plan(repo());
    assert.deepEqual(p.actions.map((a) => a.path), [".mcp.json"]);
    assert.deepEqual(JSON.parse(p.actions[0].content!).mcpServers.ria, { type: "stdio", command: "node", args: [ENTRY, "serve", "--lean"] });
    assert.match(p.notes.join("\n"), /--lean: only the MCP server entry is written/);
    assert.doesNotMatch(p.notes.join("\n"), /roles are skills/, "there are no roles to mention");
  });

  it("does the same for Copilot, after the workspace root, and for both hosts", () => {
    const dir = repo();
    const copilot = plan(dir, { host: "copilot" });
    assert.deepEqual(copilot.actions.map((a) => a.path), [".vscode/mcp.json"]);
    assert.deepEqual(JSON.parse(copilot.actions[0].content!).servers.ria.args, [ENTRY, "serve", "--root", "${workspaceFolder}", "--lean"]);
    const both = plan(dir, { host: "both" });
    assert.deepEqual(both.actions.map((a) => a.path).sort(), [".mcp.json", ".vscode/mcp.json"]);
    const onPath = JSON.parse(plan(dir, { onPath: true }).actions[0].content!).mcpServers.ria;
    assert.deepEqual(onPath, { type: "stdio", command: "ria", args: ["serve", "--lean"] });
  });

  it("is refused with roles, hooks or enforcement, which assume the tools a lean server does not have", () => {
    const dir = repo();
    for (const extra of [{ hooks: true }, { hooks: true, enforce: true }, { roles: ["reader"] }]) {
      const p = planInit(dir, { host: "claude", entry: ENTRY, lean: true, ...extra });
      assert.ok("error" in p && /--lean cannot be combined with --hooks, --enforce or --roles/.test(p.error), JSON.stringify(extra));
    }
  });

  it("leaves the default install exactly as it was: no --lean, all the role files", () => {
    const dir = repo();
    const p = planInit(dir, { host: "claude", entry: ENTRY });
    assert.ok(!("error" in p));
    const mcp = p.actions.find((a) => a.path === ".mcp.json")!;
    assert.deepEqual(JSON.parse(mcp.content!).mcpServers.ria.args, [ENTRY, "serve"]);
    assert.equal(p.actions.filter((a) => a.path.startsWith(".claude/skills/")).length, 7);
  });

  it("keeps an existing full-tool entry unless --force, so a person's setup is not switched by accident", () => {
    const dir = repo();
    applyInit(dir, planInit(dir, { host: "claude", entry: ENTRY }) as InitPlan);
    const lean = plan(dir);
    assert.equal(lean.actions[0].kind, "skip");
    assert.equal(plan(dir, { force: true }).actions[0].kind, "update");
  });

  it("writes an entry that really starts a lean server, the way a chat starts it", async () => {
    const dir = repo();
    gitInit(dir);
    const entry = path.join(projectRoot, "src", "index.ts").replace(/\\/g, "/");
    applyInit(dir, plan(dir, { entry }));
    const written = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.ria as { command: string; args: string[] };
    assert.deepEqual(written.args, [entry, "serve", "--lean"]);

    const client = new Client({ name: "ria-init-lean", version: "0.0.0" });
    // tsx stands in for the build in tests, and it is found from the project folder; the arguments are the ones init wrote
    const env: NodeJS.ProcessEnv = { ...process.env, RIA_NO_CACHE: "1" };
    delete env.NODE_TEST_CONTEXT;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", ...written.args], cwd: projectRoot, stderr: "ignore", env: env as Record<string, string> }));
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["context_for", "find_path", "impact", "repo_map"]);
    } finally {
      await client.close();
    }
  });

  it("works from the command line: preview, refusal with --hooks, and --apply", () => {
    const dir = repo();
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const cli = path.join(projectRoot, "src", "index.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, "init", "--host", "claude", "--lean", "--on-path", "--root", dir, ...args], { env, encoding: "utf8", cwd: projectRoot });
    const refused = run("--hooks");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /--lean cannot be combined/);
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(fs.existsSync(path.join(dir, ".mcp.json")), false, "no --apply, nothing written");
    assert.equal(run("--apply").status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers.ria.args, ["serve", "--lean"]);
    assert.equal(fs.existsSync(path.join(dir, ".claude")), false, "no role files, no hooks");
  });
});
