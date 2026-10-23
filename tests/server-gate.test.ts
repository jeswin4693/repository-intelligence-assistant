import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, commit, git, gitInit, makeRepo, writeFiles } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
let dir: string;
let client: Client;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

before(async () => {
  dir = makeRepo({
    "src/a.js": `exports.a = 1;\n`,
    // a "test suite" that fails as soon as a file named BROKEN exists, with output no parser knows
    "ria.config.json": JSON.stringify({ gate: { commands: { test: `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"` } } }),
  });
  gitInit(dir);
  commit(dir, "initial");
  client = new Client({ name: "ria-gate-test", version: "0.0.0" });
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

describe("the gate over MCP", () => {
  it("runs the whole loop: baseline, a regression, a preview, a rollback", async () => {
    const progress: string[] = [];
    const begin = await client.callTool({ name: "gate_begin", arguments: { label: "demo" } }, undefined, {
      onprogress: (p) => void progress.push(String(p.message)),
    });
    assert.ok(!begin.isError, text(begin));
    assert.match(text(begin), /Gate started: run \d{8}-\d{9}-[0-9a-f]{4} \(demo\)/);
    assert.match(text(begin), /test\s+passed/);
    assert.ok(progress.some((m) => /running test/.test(m)), `progress was ${JSON.stringify(progress)}`);

    writeFiles(dir, { BROKEN: "x" });
    const check = await client.callTool({ name: "gate_check", arguments: {} });
    assert.ok(!check.isError, text(check));
    assert.match(text(check), /REGRESSED/);
    assert.match(text(check), /test\s+passed -> FAILED/);
    assert.match(text(check), /added BROKEN/);
    assert.match(text(check), /output format not recognised/, "unrecognised output is admitted, not hidden");

    const preview = await client.callTool({ name: "gate_rollback", arguments: {} });
    assert.match(text(preview), /Rollback preview/);
    assert.match(text(preview), /delete BROKEN/);
    assert.ok(fs.existsSync(path.join(dir, "BROKEN")), "a preview changes nothing");

    const applied = await client.callTool({ name: "gate_rollback", arguments: { apply: true } });
    assert.match(text(applied), /Verified/);
    assert.equal(fs.existsSync(path.join(dir, "BROKEN")), false);
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  });

  it("returns readable errors instead of failing the protocol", async () => {
    const unknown = await client.callTool({ name: "gate_check", arguments: { id: "20200101-000000000-abcd" } });
    assert.equal(unknown.isError, true);
    assert.match(text(unknown), /No gate run/);

    const badCommand = await client.callTool({ name: "gate_begin", arguments: { commands: ["deploy"] } });
    assert.equal(badCommand.isError, true);
    assert.match(text(badCommand), /Unknown command name\(s\): deploy\. Available: test/);
  });

  it("does not let the caller supply a command to run", async () => {
    const r = await client.callTool({ name: "gate_begin", arguments: { commands: ["echo pwned > pwned.txt"] } }).then(
      (x) => ({ isError: x.isError === true, message: text(x) }),
      (e: Error) => ({ isError: true, message: e.message }),
    );
    assert.equal(r.isError, true);
    assert.equal(fs.existsSync(path.join(dir, "pwned.txt")), false);
  });
});
