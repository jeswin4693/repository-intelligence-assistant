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
    assert.deepEqual(tools.map((t) => t.name).sort(), ["context_for", "find_path", "gate_begin", "gate_check", "gate_rollback", "impact", "repo_map"]);
    for (const t of tools) {
      assert.ok((t.description ?? "").length > 40, `${t.name} needs a real description`);
      const navigation = ["context_for", "find_path", "impact", "repo_map"].includes(t.name);
      assert.equal(t.annotations?.readOnlyHint, navigation, t.name);
    }
    const rollback = tools.find((t) => t.name === "gate_rollback");
    assert.equal(rollback?.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "gate_begin")?.annotations?.destructiveHint, false);
    assert.match(client.getInstructions() ?? "", /gate_begin/);
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
