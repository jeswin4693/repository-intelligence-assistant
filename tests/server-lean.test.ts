import assert from "node:assert/strict";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RepoIndex } from "../src/repo/repo-index";
import { LEAN_TOOLS, ServerOptions, createServer } from "../src/server";
import { cleanup, commit, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
let dir: string;

// the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
const importNamed = (name: string, from: string) => `import { ${name} } from "${from}";\n`;

before(() => {
  dir = makeRepo({
    "src/a.ts": `${importNamed("b", "./b")}export function a() { return b(); }\n`,
    "src/b.ts": `export function b() { return 1; }\n`,
    "tests/a.test.ts": importNamed("a", "../src/a"),
  });
  gitInit(dir);
  commit(dir, "initial");
});
after(() => cleanup(dir));

const text = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0].text;
const tokens = (s: string) => Math.ceil(s.length / 4);

/** A client connected to a server made in this process, so the lean option can be passed straight in. */
async function connect(options?: ServerOptions): Promise<Client> {
  const index = new RepoIndex(dir, { cache: false });
  index.refresh();
  const server = createServer(index, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ria-lean-test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** What a chat is handed just for having the server connected: its instructions and every tool definition, as characters / 4. */
async function handedOver(client: Client): Promise<number> {
  const { tools } = await client.listTools();
  return tokens(client.getInstructions() ?? "") + tools.reduce((n, t) => n + tokens(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema })), 0);
}

describe("ria serve --lean (createServer with lean: true)", () => {
  it("offers only the four lookup tools, all read-only, and the full server still offers everything", async () => {
    const lean = await connect({ lean: true });
    const full = await connect();
    const leanTools = (await lean.listTools()).tools;
    const fullNames = (await full.listTools()).tools.map((t) => t.name);

    assert.deepEqual(leanTools.map((t) => t.name).sort(), ["context_for", "find_path", "impact", "repo_map"]);
    assert.deepEqual([...LEAN_TOOLS].sort(), ["context_for", "find_path", "impact", "repo_map"]);
    for (const t of leanTools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} reads and writes nothing`);
      assert.ok((t.description ?? "").length > 40, `${t.name} keeps its real description`);
    }
    assert.equal(fullNames.length, 14, "the default server is unchanged");
    assert.ok(leanTools.every((t) => fullNames.includes(t.name)));
    assert.equal((await connect({ lean: false }).then((c) => c.listTools())).tools.length, 14, "lean: false is the default");
  });

  it("hands a chat well under a third of what the full server does, and says so in four lines of guidance", async () => {
    const lean = await connect({ lean: true });
    const full = await connect();
    const [l, f] = [await handedOver(lean), await handedOver(full)];
    assert.ok(l < 1300, `lean hands over ${l} tokens`);
    assert.ok(l * 3 < f, `lean ${l} against full ${f}`);

    const instructions = lean.getInstructions() ?? "";
    for (const name of ["repo_map", "context_for", "impact", "find_path"]) assert.match(instructions, new RegExp(`\\b${name}\\b`), name);
    for (const gone of ["gate_begin", "gate_check", "start_task", "plan_score", "fetch_source", "skill_scaffold"]) {
      assert.doesNotMatch(instructions, new RegExp(`\\b${gone}\\b`), `a lean chat is not told about ${gone}, which it does not have`);
    }
    assert.match(instructions, /file paths and symbol names, not file contents/, "the limit that matters is still said");
  });

  it("refuses a tool it does not offer, so a chat cannot reach the gate or the web through it", async () => {
    const lean = await connect({ lean: true });
    for (const name of ["gate_begin", "fetch_source", "skill_scaffold", "start_task", "plan_score"]) {
      let refused = false;
      try {
        const r = await lean.callTool({ name, arguments: { task: "x", url: "https://example.com", label: "x", plans: [], name: "x", description: "x", body: "x", sources: [] } });
        refused = (r as { isError?: boolean }).isError === true;
      } catch {
        refused = true;
      }
      assert.equal(refused, true, `${name} must not run on a lean server`);
    }
  });

  it("answers the lookups exactly as the full server does", async () => {
    const lean = await connect({ lean: true });
    const full = await connect();
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: "context_for", arguments: { query: "a b", max_tokens: 3000 } },
      { name: "impact", arguments: { files: ["src/b.ts"] } },
      { name: "find_path", arguments: { from: "src/a.ts", to: "src/b.ts" } },
      { name: "repo_map", arguments: { max_tokens: 800 } },
    ];
    for (const c of calls) assert.equal(text(await lean.callTool(c)), text(await full.callTool(c)), c.name);
    assert.match(text(await lean.callTool({ name: "impact", arguments: { files: ["src/b.ts"] } })), /src\/a\.ts/);
  });
});

describe("ria serve --lean, started the way a chat starts it", () => {
  async function stdio(...extra: string[]): Promise<Client> {
    const client = new Client({ name: "ria-lean-stdio", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.join(projectRoot, "src", "index.ts"), "serve", "--root", dir, ...extra], cwd: projectRoot, stderr: "ignore" }));
    return client;
  }

  it("lists four tools with --lean and fourteen without, and the lean ones work", async () => {
    const lean = await stdio("--lean");
    try {
      assert.deepEqual((await lean.listTools()).tools.map((t) => t.name).sort(), ["context_for", "find_path", "impact", "repo_map"]);
      assert.match(text(await lean.callTool({ name: "context_for", arguments: { target: "src/a.ts" } })), /src\/b\.ts/);
    } finally {
      await lean.close();
    }
    const full = await stdio();
    try {
      assert.equal((await full.listTools()).tools.length, 14);
    } finally {
      await full.close();
    }
  });
});
