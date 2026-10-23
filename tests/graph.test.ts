import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { reach, shortestPath } from "../src/repo/graph";
import { RepoIndex } from "../src/repo/repo-index";
import { cleanup, makeRepo } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));

function indexOf(files: Record<string, string>): RepoIndex {
  const dir = makeRepo(files);
  dirs.push(dir);
  const index = new RepoIndex(dir);
  index.refresh();
  return index;
}

const edges = (index: RepoIndex, from: string) => [...(index.graph().out.get(from) ?? [])].sort();

describe("import resolution", () => {
  it("typescript: maps .js specifiers to .ts, finds index files, flags real misses", () => {
    const index = indexOf({
      "src/index.ts": `import { run } from "./app";\nimport "./util/index.js";\nimport "./missing";\nimport x from "left-pad";\n`,
      "src/app.ts": `import { helper } from "./util/helper.js";\nexport function run() {}\n`,
      "src/util/helper.ts": `export function helper() {}\n`,
      "src/util/index.ts": `export * from "./helper";\n`,
      "tests/app.test.ts": `import { run } from "../src/app";\n`,
    });
    assert.deepEqual(edges(index, "src/index.ts"), ["src/app.ts", "src/util/index.ts"]);
    assert.deepEqual(edges(index, "src/app.ts"), ["src/util/helper.ts"]);
    assert.deepEqual(edges(index, "src/util/index.ts"), ["src/util/helper.ts"]);
    assert.deepEqual(edges(index, "tests/app.test.ts"), ["src/app.ts"]);
    // a missing relative import is a gap; an npm package is simply external
    assert.deepEqual(index.graph().unresolved.get("src/index.ts"), ["./missing"]);
  });

  it("typescript: resolves @/ aliases by suffix", () => {
    const index = indexOf({
      "src/pages/home.ts": `import { Button } from "@/components/button";\n`,
      "src/components/button.ts": `export const Button = 1;\n`,
    });
    assert.deepEqual(edges(index, "src/pages/home.ts"), ["src/components/button.ts"]);
  });

  it("python: relative imports, packages and submodules", () => {
    const index = indexOf({
      "pkg/__init__.py": ``,
      "pkg/a.py": `from . import b\nfrom .c import thing\n`,
      "pkg/b.py": `X = 1\n`,
      "pkg/c.py": `thing = 1\n`,
      "main.py": `import os\nimport pkg.a\nfrom pkg import b\n`,
    });
    assert.deepEqual(edges(index, "pkg/a.py"), ["pkg/b.py", "pkg/c.py"]);
    assert.deepEqual(edges(index, "main.py"), ["pkg/a.py", "pkg/b.py"]);
    assert.equal(index.graph().unresolved.has("main.py"), false, "os is stdlib, not a gap");
  });

  it("go: uses the go.mod module path, skips test files and the standard library", () => {
    const index = indexOf({
      "go.mod": `module example.com/app\n\ngo 1.22\n`,
      "main.go": `package main\nimport (\n\t"fmt"\n\t"example.com/app/internal/db"\n)\n`,
      "internal/db/db.go": `package db\n`,
      "internal/db/db_test.go": `package db\n`,
      "internal/http/http.go": `package http\n`,
    });
    assert.deepEqual(edges(index, "main.go"), ["internal/db/db.go"]);
  });

  it("java: matches package paths", () => {
    const index = indexOf({
      "src/main/java/com/acme/Foo.java": `package com.acme;\nimport com.acme.util.Bar;\nimport java.util.List;\n`,
      "src/main/java/com/acme/util/Bar.java": `package com.acme.util;\n`,
    });
    assert.deepEqual(edges(index, "src/main/java/com/acme/Foo.java"), ["src/main/java/com/acme/util/Bar.java"]);
  });

  it("c: falls back to a suffix search when the include is not next to the file", () => {
    const index = indexOf({
      "src/a.c": `#include "a.h"\n#include "util/u.h"\n#include <stdio.h>\n`,
      "include/a.h": ``,
      "src/util/u.h": ``,
    });
    assert.deepEqual(edges(index, "src/a.c"), ["include/a.h", "src/util/u.h"]);
  });

  it("c#: links files through namespaces, but not through very wide ones", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 30; i++) wide[`Wide/W${i}.cs`] = `namespace Acme.Wide;\npublic class W${i} {}\n`;
    const index = indexOf({
      "Util/A.cs": `namespace Acme.Util\n{\n  public class A {}\n}\n`,
      "Util/B.cs": `namespace Acme.Util\n{\n  public class B {}\n}\n`,
      "App/P.cs": `using Acme.Util;\nusing Acme.Wide;\nnamespace Acme.App { public class P {} }\n`,
      ...wide,
    });
    assert.deepEqual(edges(index, "App/P.cs"), ["Util/A.cs", "Util/B.cs"]);
  });

  it("rust: mod declarations and crate:: paths", () => {
    const index = indexOf({
      "src/main.rs": `mod util;\nuse crate::util::helper;\n`,
      "src/util.rs": `pub fn helper() {}\n`,
    });
    assert.deepEqual(edges(index, "src/main.rs"), ["src/util.rs"]);
  });

  it("ruby: require_relative", () => {
    const index = indexOf({
      "lib/app.rb": `require_relative "helper"\n`,
      "lib/helper.rb": ``,
    });
    assert.deepEqual(edges(index, "lib/app.rb"), ["lib/helper.rb"]);
  });
});

describe("graph queries", () => {
  const index = indexOf({
    "a.ts": `import "./b";\n`,
    "b.ts": `import "./c";\n`,
    "c.ts": `export const C = 1;\n`,
    "d.ts": `import "./c";\n`,
    "island.ts": `export const I = 1;\n`,
  });
  const graph = () => index.graph();

  it("reach follows dependents with distances and the node it came through", () => {
    const r = reach(graph(), ["c.ts"], "in", 3);
    assert.deepEqual(
      [...r].map(([p, v]) => [p, v.distance, v.via]).sort(),
      [["a.ts", 2, "b.ts"], ["b.ts", 1, "c.ts"], ["d.ts", 1, "c.ts"]],
    );
  });

  it("reach respects the depth limit", () => {
    assert.deepEqual([...reach(graph(), ["c.ts"], "in", 1).keys()].sort(), ["b.ts", "d.ts"]);
  });

  it("shortestPath prefers a forward chain and reports each hop's direction", () => {
    const hops = shortestPath(graph(), "a.ts", "c.ts")!;
    assert.deepEqual(hops.map((h) => [h.from, h.to, h.relation]), [["a.ts", "b.ts", "imports"], ["b.ts", "c.ts", "imports"]]);
  });

  it("shortestPath can walk against imports through a shared dependency", () => {
    const hops = shortestPath(graph(), "a.ts", "d.ts")!;
    assert.deepEqual(hops.map((h) => h.relation), ["imports", "imports", "imported by"]);
  });

  it("shortestPath returns null for unconnected files", () => {
    assert.equal(shortestPath(graph(), "a.ts", "island.ts"), null);
  });
});
