import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InitOptions, InitPlan, applyInit, formatInit, planInit } from "../src/init/init";
import { claudeSkill, claudeSkillPath, copilotAgent, copilotAgentPath } from "../src/init/render";
import { ROLES, Role } from "../src/init/roles";
import { RepoIndex } from "../src/repo/repo-index";
import { createServer } from "../src/server";
import { cleanup, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
const cliEntry = path.join(projectRoot, "src", "index.ts");
const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

const repo = (files: Record<string, string> = { "src/a.ts": `export const a = 1;\n` }) => {
  const dir = makeRepo(files);
  dirs.push(dir);
  return dir;
};

const FAKE_ENTRY = "C:/ria/dist/index.js";
function plan(root: string, opts: Partial<InitOptions> & { host: InitOptions["host"] }): InitPlan {
  const p = planInit(root, { entry: FAKE_ENTRY, ...opts });
  assert.ok(!("error" in p), "error" in p ? p.error : "");
  return p;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const readJson = (root: string, rel: string) => JSON.parse(read(root, rel));
const kinds = (p: InitPlan) => p.actions.map((a) => a.kind);

function listFiles(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, child) : [child];
  });
}

/** Header of a generated file: `key: <json value>` lines between two --- lines, starting on line 1. */
function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "the frontmatter must start on the first line");
  return Object.fromEntries(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(": ");
      return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
    }),
  );
}

async function serverToolNames(): Promise<string[]> {
  const server = createServer(new RepoIndex(repo(), { cache: false }));
  const client = new Client({ name: "init-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

const textOf = (r: Role) => [...r.steps, ...r.stop, ...r.report].join("\n");

describe("roles", () => {
  it("defines the six roles, each with steps, a stop condition and a report", () => {
    assert.deepEqual(ROLES.map((r) => r.id), ["reader", "analyser", "extractor", "writer", "fixer", "reviewer"]);
    for (const r of ROLES) {
      assert.ok(r.steps.length >= 3, `${r.id} steps`);
      assert.ok(r.stop.length >= 1 && r.report.length >= 1, `${r.id} stop and report`);
      assert.match(r.description, /^Use /, `${r.id} description says when to use it`);
    }
  });

  it("only name real RIA tools, and only the ones the role is allowed to call", async () => {
    const real = await serverToolNames();
    for (const r of ROLES) {
      for (const t of r.tools) assert.ok(real.includes(t), `${r.id} lists ${t}, which the server does not register`);
      for (const t of real) {
        if (new RegExp(`\\b${t}\\b`).test(textOf(r))) assert.ok(r.tools.includes(t as Role["tools"][number]), `${r.id} mentions ${t} but may not call it`);
      }
    }
  });

  it("gives the roles that edit the gate, and the ones that only read neither the gate nor an edit tool", () => {
    for (const r of ROLES) {
      const gate = r.tools.filter((t) => t.startsWith("gate_"));
      if (r.edits) assert.deepEqual(gate, ["gate_begin", "gate_check", "gate_rollback"], r.id);
      else assert.deepEqual(gate, [], r.id);
    }
    assert.deepEqual(ROLES.filter((r) => !r.edits).map((r) => r.id), ["reader", "analyser", "reviewer"]);
  });

  it("expects the right gate verdict from each role that edits, and always says when to roll back and what unverified means", () => {
    const by = (id: string) => ROLES.find((r) => r.id === id)!;
    assert.match(by("extractor").stop[0], /ends with `unchanged` \(behaviour must not change\)/);
    assert.match(by("fixer").stop[0], /ends with `improved`.*If it ends `unchanged`, no existing check proves the fix/);
    assert.match(by("writer").stop[0], /`unchanged` or `improved`/);
    for (const r of ROLES.filter((x) => x.edits)) {
      assert.ok(r.stop.some((s) => /`regressed` or `mixed`.*`gate_rollback`/.test(s)), `${r.id} says when to roll back`);
      assert.ok(r.stop.some((s) => /`unverified`.*do not describe the change as verified/.test(s)), `${r.id} says what unverified means`);
    }
  });

  it("puts a hard rule under Limits, not among the stop conditions", () => {
    const [beforeLimits, limits] = claudeSkill(ROLES.find((r) => r.id === "fixer")!).split("## Limits");
    assert.match(limits, /Never make a check pass by deleting or weakening a test/);
    assert.doesNotMatch(beforeLimits, /Never make a check pass/);
  });

  it("stays free of language and domain specifics", () => {
    const all = JSON.stringify(ROLES);
    assert.doesNotMatch(all, /Business Central|Made2Manage|M2M|\bAL\b/);
  });
});

describe("rendering", () => {
  it("writes a Claude Code skill whose name matches its folder and whose header starts on line 1", () => {
    for (const r of ROLES) {
      const text = claudeSkill(r);
      const head = frontmatter(text);
      assert.equal(head.name, `ria-${r.id}`);
      assert.equal(claudeSkillPath(r), `.claude/skills/${head.name}/SKILL.md`);
      assert.equal(head.description, r.description);
      assert.ok((head.description as string).length <= 400, "the picker truncates long descriptions");
      assert.match(text, new RegExp(`\\n# ${r.title} \\(RIA role\\)\\n`));
      for (const heading of ["## Steps", "## Stop when", "## Report", "## Limits"]) assert.ok(text.includes(heading), `${r.id} ${heading}`);
    }
  });

  it("writes a VS Code agent whose tools are an allow-list: read-only roles get no edit tool and no gate", () => {
    const by = (id: string) => ROLES.find((r) => r.id === id)!;
    const reader = frontmatter(copilotAgent(by("reader")));
    assert.equal(reader.name, "RIA Reader");
    assert.deepEqual(reader.tools, ["read", "search", "ria/repo_map", "ria/context_for", "ria/find_path"]);

    const writer = frontmatter(copilotAgent(by("writer"))).tools as string[];
    assert.ok(writer.includes("edit") && writer.includes("ria/gate_begin") && writer.includes("ria/plan_score"));

    for (const r of ROLES.filter((x) => !x.edits)) {
      const tools = frontmatter(copilotAgent(r)).tools as string[];
      assert.ok(!tools.includes("edit") && !tools.includes("execute"), `${r.id} must not edit`);
      assert.ok(!tools.some((t) => t.startsWith("ria/gate_")), `${r.id} must not use the gate`);
    }
    // an agent with only MCP tools fails on some backends in VS Code
    for (const r of ROLES) assert.ok((frontmatter(copilotAgent(r)).tools as string[]).includes("read"), r.id);
    assert.equal(copilotAgentPath(by("fixer")), ".github/agents/ria-fixer.agent.md");
  });

  it("quotes headers so a colon or a quote in a description cannot break them", () => {
    const tricky: Role = { ...ROLES[0], description: `Use when: "a: b" # not a comment` };
    assert.equal(frontmatter(claudeSkill(tricky)).description, tricky.description);
    assert.equal(frontmatter(copilotAgent(tricky)).description, tricky.description);
  });
});

describe("planInit and applyInit", () => {
  it("previews without writing anything, then writes the MCP config and all twelve role files", () => {
    const dir = repo();
    const before = listFiles(dir);
    const p = plan(dir, { host: "both" });
    assert.equal(p.actions.length, 14);
    assert.ok(kinds(p).every((k) => k === "create"));
    assert.deepEqual(listFiles(dir), before, "planning writes nothing");

    assert.equal(applyInit(dir, p), 14);
    assert.ok(fs.existsSync(path.join(dir, ".claude/skills/ria-reviewer/SKILL.md")));
    assert.ok(fs.existsSync(path.join(dir, ".github/agents/ria-reviewer.agent.md")));
    assert.deepEqual(readJson(dir, ".mcp.json"), { mcpServers: { ria: { type: "stdio", command: "node", args: [FAKE_ENTRY, "serve"] } } });
    assert.deepEqual(readJson(dir, ".vscode/mcp.json"), {
      servers: { ria: { type: "stdio", command: "node", args: [FAKE_ENTRY, "serve", "--root", "${workspaceFolder}"] } },
    });
  });

  it("does nothing the second time", () => {
    const dir = repo();
    applyInit(dir, plan(dir, { host: "both" }));
    const again = plan(dir, { host: "both" });
    assert.ok(kinds(again).every((k) => k === "unchanged"));
    assert.equal(applyInit(dir, again), 0);
  });

  it("writes only the host that was asked for, and only the roles that were asked for", () => {
    const dir = repo();
    applyInit(dir, plan(dir, { host: "claude", roles: ["reader", "fixer"] }));
    assert.deepEqual(listFiles(dir).filter((f) => !f.startsWith("src/")).sort(), [".claude/skills/ria-fixer/SKILL.md", ".claude/skills/ria-reader/SKILL.md", ".mcp.json"]);

    const copilot = repo();
    assert.equal(plan(copilot, { host: "copilot", roles: ["analyser"] }).actions.length, 2);
  });

  it("keeps a role file the user edited, and replaces it only with --force", () => {
    const dir = repo();
    applyInit(dir, plan(dir, { host: "claude" }));
    const file = ".claude/skills/ria-writer/SKILL.md";
    fs.writeFileSync(path.join(dir, file), "my own writer role\n");

    const kept = plan(dir, { host: "claude" });
    const keptAction = kept.actions.find((a) => a.path === file)!;
    assert.equal(keptAction.kind, "skip");
    assert.match(keptAction.detail, /your version is kept/);
    applyInit(dir, kept);
    assert.equal(read(dir, file), "my own writer role\n");

    const forced = plan(dir, { host: "claude", force: true });
    assert.equal(forced.actions.find((a) => a.path === file)!.kind, "update");
    applyInit(dir, forced);
    assert.equal(read(dir, file), claudeSkill(ROLES.find((r) => r.id === "writer")!));
  });

  it("treats a file with other line endings as unchanged", () => {
    const dir = repo();
    applyInit(dir, plan(dir, { host: "claude", roles: ["reader"] }));
    const file = path.join(dir, ".claude/skills/ria-reader/SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    assert.ok(kinds(plan(dir, { host: "claude", roles: ["reader"] })).every((k) => k === "unchanged"));
  });

  it("adds the ria server to an existing MCP config and keeps everything else in it", () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n", ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }) });
    const p = plan(dir, { host: "claude", roles: ["reader"] });
    assert.equal(p.actions[0].kind, "update");
    assert.match(p.actions[0].detail, /next to your other servers/);
    applyInit(dir, p);
    const merged = readJson(dir, ".mcp.json");
    assert.deepEqual(merged.mcpServers.other, { command: "x" });
    assert.equal(merged.extra, 1);
    assert.equal(merged.mcpServers.ria.command, "node");
  });

  it("keeps a differently configured ria server unless --force, and leaves the other servers alone either way", () => {
    const original = JSON.stringify({ mcpServers: { ria: { command: "custom" }, other: { command: "x" } } });
    const dir = repo({ "src/a.ts": "export const a = 1;\n", ".mcp.json": original });
    const kept = plan(dir, { host: "claude", roles: ["reader"] }).actions[0];
    assert.equal(kept.kind, "skip");

    const forced = plan(dir, { host: "claude", roles: ["reader"], force: true });
    applyInit(dir, forced);
    const after = readJson(dir, ".mcp.json");
    assert.equal(after.mcpServers.ria.command, "node");
    assert.deepEqual(after.mcpServers.other, { command: "x" });
  });

  it("does not rewrite a config it cannot read as plain JSON, and shows what to add by hand", () => {
    const jsonc = `{\n  // my servers\n  "servers": {}\n}\n`;
    const dir = repo({ "src/a.ts": "export const a = 1;\n", ".vscode/mcp.json": jsonc });
    const p = plan(dir, { host: "copilot", roles: ["reader"] });
    const mcp = p.actions.find((a) => a.path === ".vscode/mcp.json")!;
    assert.equal(mcp.kind, "manual");
    assert.match(mcp.detail, /Add this by hand/);
    assert.match(mcp.detail, /"servers"/);
    assert.match(mcp.detail, /\$\{workspaceFolder\}/);
    applyInit(dir, p);
    assert.equal(read(dir, ".vscode/mcp.json"), jsonc);
    assert.ok(fs.existsSync(path.join(dir, ".github/agents/ria-reader.agent.md")), "the role files are still written");
  });

  it("can register ria from the PATH so a committed config works on other machines", () => {
    const dir = repo();
    const p = plan(dir, { host: "both", roles: ["reader"], onPath: true });
    applyInit(dir, p);
    assert.deepEqual(readJson(dir, ".mcp.json").mcpServers.ria, { type: "stdio", command: "ria", args: ["serve"] });
    assert.deepEqual(readJson(dir, ".vscode/mcp.json").servers.ria.args, ["serve", "--root", "${workspaceFolder}"]);
    assert.ok(!p.notes.some((n) => /names this machine/.test(n)));
  });

  it("warns that the config names this machine, and when the build is missing", () => {
    const dir = repo();
    const missing = plan(dir, { host: "claude", roles: ["reader"] });
    assert.ok(missing.notes.some((n) => /does not exist yet.*npm run build/.test(n)));
    assert.ok(missing.notes.some((n) => /names this machine's RIA folder.*--on-path/.test(n)));

    const built = path.join(dir, "built.js");
    fs.writeFileSync(built, "");
    const ok = plan(dir, { host: "claude", roles: ["reader"], entry: built.replace(/\\/g, "/") });
    assert.ok(!ok.notes.some((n) => /does not exist/.test(n)));
  });

  it("is honest in its notes that Copilot can only be instructed", () => {
    const notes = plan(repo(), { host: "copilot" }).notes.join("\n");
    assert.match(notes, /can only be instructed/);
    assert.match(notes, /trust an MCP server/);
    assert.doesNotMatch(plan(repo(), { host: "claude" }).notes.join("\n"), /can only be instructed/);
  });

  it("rejects an unknown host or role, and refuses to write outside the repository", () => {
    const dir = repo();
    const badHost = planInit(dir, { host: "emacs" as InitOptions["host"] });
    assert.ok("error" in badHost);
    assert.match(badHost.error, /Use claude, copilot or both/);

    const badRole = planInit(dir, { host: "claude", roles: ["reader", "poet"] });
    assert.ok("error" in badRole);
    assert.match(badRole.error, /Unknown role "poet"\. Roles: reader, analyser, extractor, writer, fixer, reviewer/);

    assert.throws(
      () => applyInit(dir, { actions: [{ path: "../escape.txt", kind: "create", detail: "x", content: "x" }], notes: [] }),
      /outside the repository/,
    );
    assert.ok(!fs.existsSync(path.join(dir, "..", "escape.txt")));
  });

  it("reports a preview and an applied run in the right tense", () => {
    const dir = repo();
    const p = plan(dir, { host: "both" });
    const preview = formatInit(p, dir, false);
    assert.match(preview, /preview only, nothing was written\. Add --apply/);
    assert.match(preview, /14 to create, 0 to update, 0 unchanged/);
    assert.match(preview, /create +\.mcp\.json {2}\(registers the ria server\)/);
    assert.match(preview, /create +\.claude\/skills\/ria-reader\/SKILL\.md\n/);

    applyInit(dir, p);
    const applied = formatInit(p, dir, true);
    assert.match(applied, /: applied/);
    assert.match(applied, /14 created, 0 updated/);
    assert.match(applied, /created +\.mcp\.json/);
  });
});

describe("the written configuration starts a working RIA server", () => {
  const connect = async (command: string[], env?: Record<string, string>) => {
    const client = new Client({ name: "init-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", ...command], cwd: projectRoot, stderr: "ignore", ...(env ? { env } : {}) }));
    return client;
  };

  it("with the arguments written for VS Code and for Claude Code", async () => {
    const dir = repo({ "src/a.ts": `import { b } from "./b";\nexport const a = b;\n`, "src/b.ts": `export const b = 1;\n` });
    const entry = cliEntry.replace(/\\/g, "/");
    applyInit(dir, plan(dir, { host: "both", roles: ["reader"], entry }));

    const vscode = readJson(dir, ".vscode/mcp.json").servers.ria;
    const claude = readJson(dir, ".mcp.json").mcpServers.ria;
    const sessions: [Client, string][] = [
      [await connect(vscode.args.map((a: string) => a.replace("${workspaceFolder}", dir))), "VS Code"],
      [await connect(claude.args, { RIA_ROOT: dir }), "Claude Code"],
    ];
    try {
      for (const [client, host] of sessions) {
        const names = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes("plan_score") && names.includes("impact"), host);
        const r = (await client.callTool({ name: "repo_map", arguments: {} })) as { content: { text: string }[] };
        assert.match(r.content[0].text, /src\/b\.ts {2}\(typescript, 1 lines, imported by 1/, host);
      }
    } finally {
      await Promise.all(sessions.map(([c]) => c.close()));
    }
  });
});

describe("ria init (command line)", () => {
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cliEntry, ...args], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const stderrOf = (...args: string[]) => {
    try {
      run(...args);
    } catch (e) {
      return (e as { stderr: string }).stderr;
    }
    return assert.fail("expected a non-zero exit");
  };

  it("previews by default, writes with --apply, and never creates a .ria folder in the repository", () => {
    const dir = repo();
    const preview = run("init", "--host", "claude", "--roles", "reader,fixer", "--root", dir);
    assert.match(preview, /preview only/);
    assert.match(preview, /3 to create/);
    assert.deepEqual(listFiles(dir), ["src/a.ts"]);

    const applied = run("init", "--host", "claude", "--roles", "reader,fixer", "--on-path", "--apply", "--root", dir);
    assert.match(applied, /: applied/);
    assert.equal(readJson(dir, ".mcp.json").mcpServers.ria.command, "ria");
    assert.ok(fs.existsSync(path.join(dir, ".claude/skills/ria-fixer/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(dir, ".ria")), "init must not index the repository");
  });

  it("prints JSON, and explains what is missing or wrong", () => {
    const dir = repo();
    const json = JSON.parse(run("init", "--host", "copilot", "--roles", "reader", "--json", "--root", dir));
    assert.equal(json.applied, 0);
    assert.deepEqual(json.actions.map((a: { path: string }) => a.path), [".vscode/mcp.json", ".github/agents/ria-reader.agent.md"]);

    assert.match(stderrOf("init", "--root", dir), /init needs --host claude, copilot or both/);
    assert.match(stderrOf("init", "--host", "claude", "--roles", "poet", "--root", dir), /Unknown role "poet"/);
  });
});
