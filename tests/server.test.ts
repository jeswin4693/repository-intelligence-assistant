import assert from "node:assert/strict";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, commit, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
let dir: string;
let client: Client;

const text = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content[0].text);

before(async () => {
  dir = makeRepo({
    "src/a.ts": `import { b } from "./b";\nexport function a() { return b(); }\n`,
    "src/b.ts": `export function b() { return 1; }\n`,
    "tests/a.test.ts": `import { a } from "../src/a";\n`,
  });
  gitInit(dir);
  commit(dir, "initial");

  client = new Client({ name: "ria-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(projectRoot, "src", "index.ts"), "serve", "--root", dir],
      cwd: projectRoot,
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client?.close();
  cleanup(dir);
});

describe("MCP server over stdio", () => {
  it("advertises the tools, marking only the navigation ones read-only, with guidance for the model", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["context_for", "find_path", "gate_begin", "gate_check", "gate_rollback", "impact", "plan_score", "repo_map", "start_task"]);
    for (const t of tools) {
      assert.ok((t.description ?? "").length > 40, `${t.name} needs a real description`);
      const navigation = ["context_for", "find_path", "impact", "plan_score", "repo_map", "start_task"].includes(t.name);
      assert.equal(t.annotations?.readOnlyHint, navigation, t.name);
    }
    const rollback = tools.find((t) => t.name === "gate_rollback");
    assert.equal(rollback?.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "gate_begin")?.annotations?.destructiveHint, false);
    assert.match(client.getInstructions() ?? "", /gate_begin/);
    assert.match(client.getInstructions() ?? "", /plan_score/);
    assert.match(client.getInstructions() ?? "", /At the start of every new request from the user: start_task/, "the server tells every chat to route first");
  });

  it("start_task picks the role from the request and returns its steps", async () => {
    const fix = text(await client.callTool({ name: "start_task", arguments: { task: "fix the failing test in tests/a.test.ts" } }));
    assert.match(fix, /^RIA routing: Fixer \(fixer\), confidence (high|medium)/);
    assert.match(fix, /Because: .*fix/);
    assert.match(fix, /## Steps/);
    assert.match(fix, /`gate_begin` before the first edit/);
    assert.match(fix, /## When the task changes kind/);

    const read = text(await client.callTool({ name: "start_task", arguments: { task: "explain how src/a.ts uses src/b.ts" } }));
    assert.match(read, /^RIA routing: Reader \(reader\)/);
    assert.match(read, /This role does not edit files\./);
    assert.doesNotMatch(read, /gate_begin/, "a read-only role is not told to start a gate");
  });

  it("start_task checks the paths a request names against the repository", async () => {
    const create = text(await client.callTool({ name: "start_task", arguments: { task: "create src/brand-new.ts with a helper" } }));
    assert.match(create, /Writer/);
    assert.match(create, /names src\/brand-new\.ts, which is not in the repository/);

    const typo = text(await client.callTool({ name: "start_task", arguments: { task: "explain how src/nope.ts works" } }));
    assert.match(typo, /"src\/nope\.ts" is not in the repository: a typo, or a file to create\?/);

    const existing = text(await client.callTool({ name: "start_task", arguments: { task: "create src/a.ts with a helper" } }));
    assert.match(existing, /"src\/a\.ts" already exists: do not overwrite it without asking/);
  });

  it("start_task says when a request is not a new task", async () => {
    const r = text(await client.callTool({ name: "start_task", arguments: { task: "yes, go ahead" } }));
    assert.match(r, /does not look like a new task/);
    assert.doesNotMatch(r, /## Steps/);
  });

  it("repo_map describes the served repository", async () => {
    const r = await client.callTool({ name: "repo_map", arguments: {} });
    assert.match(text(r), /Files: 3 indexed/);
    assert.match(text(r), /src\/b\.ts/);
  });

  it("impact reports dependents and tests", async () => {
    const r = await client.callTool({ name: "impact", arguments: { files: ["src/b.ts"] } });
    assert.ok(!r.isError);
    assert.match(text(r), /src\/a\.ts/);
    assert.match(text(r), /tests\/a\.test\.ts/);
  });

  it("find_path and context_for answer", async () => {
    const p = await client.callTool({ name: "find_path", arguments: { from: "src/a.ts", to: "src/b.ts" } });
    assert.match(text(p), /src\/a\.ts imports src\/b\.ts/);
    const c = await client.callTool({ name: "context_for", arguments: { target: "src/a.ts" } });
    assert.match(text(c), /src\/b\.ts/);
  });

  it("plan_score ranks candidate plans and reports bad input as a tool error", async () => {
    const plans = [
      { name: "Edit b only", files: ["src/b.ts"] },
      { name: "Edit a and b", files: ["src/a.ts", "src/b.ts"] },
    ];
    const r = await client.callTool({ name: "plan_score", arguments: { plans } });
    assert.ok(!r.isError);
    assert.match(text(r), /^Plan scores for 2 candidate plans/);
    assert.match(text(r), /Recommended: /);
    assert.match(text(r), /tests\/a\.test\.ts/);

    const bad = await client.callTool({ name: "plan_score", arguments: { plans: [{ name: "Dir", files: ["src"] }] } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /"src" is a directory/);

    const none = await client.callTool({ name: "plan_score", arguments: { plans: [] } }).then(
      (x) => ({ isError: x.isError === true, message: text(x) }),
      (e: Error) => ({ isError: true, message: e.message }),
    );
    assert.equal(none.isError, true);
    assert.match(none.message, /plans/);
  });

  it("sees files changed after the server started", async () => {
    commit(dir, "add c", { "src/c.ts": `import { b } from "./b";\nexport const c = b;\n` });
    const r = await client.callTool({ name: "impact", arguments: { files: ["src/b.ts"] } });
    assert.match(text(r), /src\/c\.ts/);
  });

  it("returns tool errors, not protocol failures, for bad requests", async () => {
    const unknown = await client.callTool({ name: "impact", arguments: { files: ["nope.ts"] } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /not a file or symbol/);

    const empty = await client.callTool({ name: "context_for", arguments: {} });
    assert.equal(empty.isError, true);
    assert.match(text(empty), /target.*query/);

    // schema violations surface as a protocol error or an error result, depending on the SDK version
    const invalid = await client.callTool({ name: "impact", arguments: { files: [] } }).then(
      (r) => ({ isError: r.isError === true, message: text(r) }),
      (e: Error) => ({ isError: true, message: e.message }),
    );
    assert.equal(invalid.isError, true);
    assert.match(invalid.message, /files/);
  });
});
