import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vm from "node:vm";
import { RepoIndex } from "../src/repo/repo-index";
import { GraphData, buildGraphData } from "../src/tools/graph-data";
import { renderGraphHtml, safeJson } from "../src/tools/graph-html";
import { cleanup, commit, gitInit, makeRepo } from "./helpers";

const projectRoot = path.resolve(__dirname, "..");
const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

// the specifier is a variable so RIA's own gate does not read fixture text as a broken import of this repository
const importNamed = (name: string, from: string) => `import { ${name} } from "${from}";\n`;

/**
 * a imports b; the test imports a; c imports nothing. a, b and c change together in four commits, together with the README,
 * which changes with everything.
 */
function project(withGit = true): string {
  const d = makeRepo({
    "src/a.ts": `${importNamed("b", "./b")}export function a1() { return b(); }\nexport class A {\n  run() { return 1; }\n}\n`,
    "src/b.ts": `export function b() { return 1; }\n`,
    "src/c.ts": `export function c() { return 3; }\n${importNamed("gone", "./does-not-exist")}`,
    "tests/a.test.ts": importNamed("a1", "../src/a"),
    "README.md": "# demo\n",
  });
  dirs.push(d);
  if (withGit) {
    gitInit(d);
    commit(d, "initial");
    for (const n of [1, 2, 3]) {
      commit(d, `change ${n}`, {
        "src/a.ts": `${importNamed("b", "./b")}export function a1() { return b() + ${n}; }\nexport class A {\n  run() { return ${n}; }\n}\n`,
        "src/b.ts": `export function b() { return ${n}; }\n`,
        "src/c.ts": `export function c() { return ${n}; }\n${importNamed("gone", "./does-not-exist")}`,
        "README.md": `# demo ${n}\n`,
      });
    }
  }
  return d;
}

const indexOf = (dir: string) => {
  const i = new RepoIndex(dir, { cache: false });
  i.refresh();
  return i;
};
const graphOf = (dir: string, opts = {}) => {
  const data = buildGraphData(indexOf(dir), opts);
  assert.ok(!("error" in data), "error" in data ? data.error : "");
  return data;
};
const at = (data: GraphData, p: string) => data.nodes.findIndex((n) => n.path === p);

describe("buildGraphData", () => {
  it("lists every file in path order, with its size, symbols and who imports whom as indexes", () => {
    const data = graphOf(project());
    assert.deepEqual(data.nodes.map((n) => n.path), ["README.md", "src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts"]);
    assert.equal(data.repo.length > 0, true);
    const a = data.nodes[at(data, "src/a.ts")];
    assert.equal(a.lang, "typescript");
    assert.equal(a.test, false);
    assert.equal(data.nodes[at(data, "tests/a.test.ts")].test, true);
    assert.ok(a.lines >= 4);
    const names = a.syms.map((s) => s[1]);
    assert.ok(names.includes("a1") && names.includes("A"), names.join(","));
    for (const s of a.syms) assert.deepEqual([typeof s[0], typeof s[1], typeof s[2], typeof s[3]], ["string", "string", "number", "number"]);
    const link = (from: string, to: string) => data.links.some(([x, y]) => x === at(data, from) && y === at(data, to));
    assert.ok(link("src/a.ts", "src/b.ts"), "a imports b");
    assert.ok(link("tests/a.test.ts", "src/a.ts"), "the test imports a");
    assert.equal(link("src/b.ts", "src/a.ts"), false, "arrows point from the importer to what it imports");
    assert.equal(data.stats.files, 5);
    assert.equal(data.stats.links, data.links.length);
    assert.equal(data.stats.symbols, data.nodes.reduce((n, f) => n + f.syms.length + f.moreSyms, 0));
    assert.equal(data.stats.lines, data.nodes.reduce((n, f) => n + f.lines, 0));
    assert.equal(data.stats.languages[0][0], "typescript");
    assert.equal(data.commits, 4);
  });

  it("keeps relative imports that did not resolve, so the page can say arrows are missing", () => {
    const data = graphOf(project());
    assert.deepEqual(data.nodes[at(data, "src/c.ts")].gaps, ["./does-not-exist"]);
    assert.equal(data.stats.unresolved, 1);
  });

  it("shows only files that change together without importing each other, and never a document or a config file", () => {
    const data = graphOf(project());
    const pair = (x: string, y: string) => data.co.find(([i, j]) => (i === at(data, x) && j === at(data, y)) || (i === at(data, y) && j === at(data, x)));
    const ac = pair("src/a.ts", "src/c.ts");
    assert.ok(ac, "a and c change together and do not import each other");
    assert.equal(ac[2] >= 3, true, "at least 3 commits");
    assert.equal(ac[3], 100, "confidence in percent");
    assert.ok(pair("src/b.ts", "src/c.ts"));
    assert.equal(pair("src/a.ts", "src/b.ts"), undefined, "a already imports b: that is an arrow, not hidden coupling");
    assert.equal(data.nodes[at(data, "README.md")].lang, "other");
    assert.equal(data.co.some(([i, j]) => i === at(data, "README.md") || j === at(data, "README.md")), false, "a README that changes with everything joins nothing");
  });

  it("says so when there is no git history, and stays quiet when asked not to read it", () => {
    const noGit = graphOf(project(false));
    assert.equal(noGit.commits, null);
    assert.deepEqual(noGit.co, []);
    assert.ok(noGit.notes.some((n) => /No git history/.test(n)));
    const skipped = graphOf(project(), { coChange: false });
    assert.deepEqual(skipped.co, []);
    assert.equal(skipped.commits, null);
    assert.ok(!skipped.notes.some((n) => /No git history/.test(n)), "it was not asked for, so it is not missing");
  });

  it("limits to a folder, and refuses a folder that holds nothing", () => {
    const dir = project();
    const data = graphOf(dir, { focus: "src/" });
    assert.deepEqual(data.nodes.map((n) => n.path), ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.ok(data.links.every(([i, j]) => i < 3 && j < 3), "links stay inside the folder");
    const none = buildGraphData(indexOf(dir), { focus: "nope" });
    assert.ok("error" in none && /No indexed file under "nope"/.test(none.error));
    assert.deepEqual(graphOf(dir, { focus: "./src\\" }).nodes.length, 3, "a pasted path with ./ or a backslash is understood");
  });

  it("shows an even sample of the symbols of a file that has too many, from its start to its end, and counts the rest", () => {
    const many = Array.from({ length: 300 }, (_, i) => `export function f${i}() { return ${i}; }\n`).join("");
    const dir = makeRepo({ "src/big.ts": many, "src/x.ts": "export const x = 1;\n" });
    dirs.push(dir);
    const data = graphOf(dir, { maxSymbolsPerFile: 40 });
    const big = data.nodes[at(data, "src/big.ts")];
    assert.equal(big.syms.length, 40);
    assert.equal(big.moreSyms, 260);
    assert.equal(big.syms[0][2], 1, "the first symbol is there");
    assert.ok(big.syms.at(-1)![2] > 250, "and the sample reaches the end of the file");
    assert.ok(data.notes.some((n) => /even sample/.test(n)));
  });
});

describe("the graph page", () => {
  const data = (): GraphData => graphOf(project());
  const scriptOf = (html: string) => /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)![1];

  it("is one file that loads nothing and does nothing but draw: no request, no library, no way to run text from the repository", () => {
    const html = renderGraphHtml(data());
    for (const banned of ["http://", "https://", "<link", " src=", "@import", "url(", "fetch(", "XMLHttpRequest", "WebSocket", "import(", "eval(", "new Function", "document.write", "innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc"]) {
      assert.equal(html.includes(banned), false, `the page must not contain ${banned}`);
    }
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.length < 200_000, `a small project's page is small (${html.length} bytes)`);
  });

  it("embeds the data as JSON that reads back exactly, and its script is valid JavaScript", () => {
    const d = data();
    const html = renderGraphHtml(d);
    const json = /<script type="application\/json" id="ria-data">([\s\S]*?)<\/script>/.exec(html)![1];
    assert.deepEqual(JSON.parse(json), d);
    assert.doesNotThrow(() => new vm.Script(scriptOf(html)), "the page's script compiles");
  });

  it("cannot be broken out of by a hostile file or symbol name: it stays one script, one set of tags, nothing that runs", () => {
    const hostile = "</script><img src=x onerror=alert(1)><script>alert(2)</script>";
    const d: GraphData = {
      repo: `</title><script>alert(0)</script>`,
      commits: null,
      stats: { files: 1, lines: 1, symbols: 1, links: 0, unresolved: 0, languages: [["typescript", 1]] },
      nodes: [{ path: `src/${hostile}.ts`, lang: "typescript", lines: 1, test: false, syms: [["function", `${hostile}&amp;\u2028x`, 1, 1]], moreSyms: 0, gaps: [hostile] }],
      links: [],
      co: [],
      notes: [hostile],
    };
    const html = renderGraphHtml(d);
    assert.equal(html.match(/<\/script>/g)!.length, 2, "only the page's own two closing tags");
    assert.equal(html.match(/<script/g)!.length, 2);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("alert(0)</script>"), false);
    assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(0\)&lt;\/script&gt; - RIA graph<\/title>/);
    const json = /<script type="application\/json" id="ria-data">([\s\S]*?)<\/script>/.exec(html)![1];
    assert.deepEqual(JSON.parse(json), d, "and the data still reads back exactly");
    assert.equal(/[\u2028\u2029]/.test(json), false, "no raw line separator");
    assert.equal(safeJson({ s: "<>&" }), `{"s":"\\u003c\\u003e\\u0026"}`);
  });

  it("puts every name on screen as text, never as markup", () => {
    const script = scriptOf(renderGraphHtml(data()));
    assert.match(script, /textContent/);
    assert.equal((script.match(/createElement/g) ?? []).length > 0, true);
    assert.equal(/\.innerHTML|\.outerHTML|insertAdjacentHTML/.test(script), false);
  });

  /** A browser, when the machine has one: it is the only way to run the page's own script. */
  function browser(): string | undefined {
    const candidates = [
      process.env.RIA_TEST_BROWSER,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    return candidates.find((c): c is string => !!c && fs.existsSync(c));
  }

  it("runs in a real browser: it draws every file and shows no error (skipped where there is no Chrome or Edge)", { skip: browser() === undefined }, () => {
    const d = data();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ria-graph-"));
    dirs.push(dir);
    const file = path.join(dir, "g.html");
    fs.writeFileSync(file, renderGraphHtml(d));
    const profile = path.join(dir, "profile");
    const dump = (hash: string) =>
      spawnSync(browser()!, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, "--virtual-time-budget=5000", "--dump-dom", `${pathToFileUrl(file)}${hash}`], { encoding: "utf8", timeout: 60_000 }).stdout;
    for (const hash of ["", "#view=folders", "#file=src/a.ts", "#q=a1", "#docs=1"]) {
      const dom = dump(hash);
      assert.match(dom, /data-ready="\d+"/, `the page finished drawing (${hash || "default"})`);
      assert.match(dom, /<div id="error" hidden/, `no error box (${hash || "default"})`);
    }
    const files = dump("#docs=1");
    assert.match(files, new RegExp(`data-ready="${d.nodes.length}"`), "with documents shown, every file is a dot");
    assert.match(dump("#file=src/a.ts"), /<h2>src\/a\.ts/, "a file link opens that file's panel");
    assert.match(dump(""), /<span id="stats">5 files/, "the header counts the files");
  });
});

/** file:// URL for a path, with forward slashes, as a browser wants it on every system. */
function pathToFileUrl(p: string): string {
  const u = p.replace(/\\/g, "/");
  return u.startsWith("/") ? `file://${u}` : `file:///${u}`;
}

describe("ria graph, the command", () => {
  const cli = path.join(projectRoot, "src", "index.ts");
  function run(dir: string, ...args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.RIA_NO_CACHE;
    delete env.RIA_ROOT;
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "graph", "--root", dir, ...args], { env, encoding: "utf8", cwd: projectRoot });
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it("writes the page under .ria/ by default, where git never sees it, and says where", () => {
    const dir = project();
    const r = run(dir);
    assert.equal(r.status, 0, r.err);
    const file = path.join(dir, ".ria", "graph.html");
    assert.ok(fs.existsSync(file));
    assert.match(r.out, /Wrote .*graph\.html/);
    assert.match(r.out, /5 files/);
    assert.match(r.out, /loads nothing from the internet/);
    assert.match(fs.readFileSync(file, "utf8"), /^<!doctype html>/);
    assert.equal(spawnSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" }).stdout.trim(), "", "the page does not show in git status");
  });

  it("writes where --out says, creating the folder, and then writes nothing into the repository, not even with --no-cache", () => {
    const dir = project();
    const target = path.join(os.tmpdir(), `ria-graph-out-${process.pid}`, "deep", "page.html");
    dirs.push(path.dirname(path.dirname(target)));
    const r = run(dir, "--no-cache", "--out", target);
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(target));
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false, "no .ria/ in the repository");
  });

  it("refuses --no-cache without --out, because it would have to write under .ria/", () => {
    const dir = project();
    const r = run(dir, "--no-cache");
    assert.notEqual(r.status, 0);
    assert.match(r.err + r.out, /--no-cache forbids: say where with --out/);
    assert.equal(fs.existsSync(path.join(dir, ".ria")), false);
  });

  it("limits to a folder with --focus, prints machine-readable stats with --json, and leaves out history with --no-history", () => {
    const dir = project();
    const focus = JSON.parse(run(dir, "--focus", "src", "--json").out) as { file: string; stats: { files: number } };
    assert.equal(focus.stats.files, 3);
    assert.ok(fs.existsSync(focus.file));
    const html = fs.readFileSync(focus.file, "utf8");
    assert.match(html, /"co":\[\[/, "the history was read by default");
    const noHistory = run(dir, "--no-history", "--json");
    assert.equal(noHistory.status, 0, noHistory.err);
    assert.match(fs.readFileSync(path.join(dir, ".ria", "graph.html"), "utf8"), /"co":\[\]/);
    const bad = run(dir, "--focus", "nope");
    assert.notEqual(bad.status, 0);
    assert.match(bad.err + bad.out, /No indexed file under "nope"/);
  });
});
