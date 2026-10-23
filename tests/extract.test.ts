import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/repo/extract";

const specs = (file: string, text: string) => analyze(file, text).imports.map((i) => i.spec).sort();
const symbol = (file: string, text: string, name: string) => analyze(file, text).symbols.find((s) => s.name === name);

describe("typescript / javascript", () => {
  const src = `
import fs from "node:fs";
import { a, b } from "./a";
import type { T } from '../types';
import {
  multi,
  line,
} from "./multi";
import "./side-effect";
export * from "./barrel";
export { x } from "./x";
const legacy = require("./legacy");
const lazy = await import("./lazy");
// import nope from "./commented";
 * import nope2 from "./starred";

export function foo() {}
export default async function main() {}
export const bar = (x: number) => x;
export class Baz {
  qux(a: number): string {
    return "";
  }
  static make(): Baz {
    return new Baz();
  }
}
function local() {}
interface Hidden {}
export type Alias = string;
export const MAX_SIZE = 3;
`;

  it("finds every import form and ignores commented ones", () => {
    assert.deepEqual(specs("a.ts", src), [
      "../types", "./a", "./barrel", "./lazy", "./legacy", "./multi", "./side-effect", "./x", "node:fs",
    ]);
  });

  it("extracts symbols with kind and export flag", () => {
    assert.deepEqual(symbol("a.ts", src, "foo"), { name: "foo", kind: "function", line: 17, exported: true });
    assert.equal(symbol("a.ts", src, "main")?.exported, true);
    assert.equal(symbol("a.ts", src, "bar")?.kind, "function");
    assert.equal(symbol("a.ts", src, "Baz")?.kind, "class");
    assert.equal(symbol("a.ts", src, "local")?.exported, false);
    assert.equal(symbol("a.ts", src, "Hidden")?.exported, false);
    assert.equal(symbol("a.ts", src, "Alias")?.kind, "type");
    assert.equal(symbol("a.ts", src, "MAX_SIZE")?.kind, "const");
  });

  it("attaches methods to their class and does not mistake control flow for methods", () => {
    assert.equal(symbol("a.ts", src, "Baz.qux")?.kind, "method");
    assert.equal(symbol("a.ts", src, "Baz.make")?.kind, "method");
    const code = `export class A {\n  run() {\n    if (x) {\n    }\n    for (const y of z) {\n    }\n  }\n}\n`;
    const names = analyze("a.ts", code).symbols.map((s) => s.name);
    assert.deepEqual(names, ["A", "A.run"]);
  });

  it("does not export members of a class that is not exported", () => {
    const code = `class Hidden {\n  go() {\n  }\n}\n`;
    assert.equal(symbol("a.ts", code, "Hidden.go")?.exported, false);
  });
});

describe("python", () => {
  const src = `import os, sys as system
import pkg.sub.mod
from . import sibling
from ..core import util, helpers as h
from .models import (
    User,
    Group,  # trailing comment
)
# import commented

class Service:
    def run(self):
        pass

    def _hidden(self):
        pass

def top():
    pass

async def atop():
    pass
`;

  it("extracts plain, relative and parenthesised imports with their names", () => {
    const imports = analyze("m.py", src).imports;
    assert.deepEqual(imports.map((i) => i.spec).sort(), [".", "..core", ".models", "os", "pkg.sub.mod", "sys"].sort());
    assert.deepEqual(imports.find((i) => i.spec === "..core")?.names, ["util", "helpers"]);
    assert.deepEqual(imports.find((i) => i.spec === ".models")?.names, ["User", "Group"]);
    assert.deepEqual(imports.find((i) => i.spec === ".")?.names, ["sibling"]);
  });

  it("extracts classes, methods and functions, treating underscores as private", () => {
    assert.equal(symbol("m.py", src, "Service")?.kind, "class");
    assert.equal(symbol("m.py", src, "Service.run")?.exported, true);
    assert.equal(symbol("m.py", src, "Service._hidden")?.exported, false);
    assert.equal(symbol("m.py", src, "top")?.kind, "function");
    assert.equal(symbol("m.py", src, "atop")?.kind, "function");
  });
});

describe("go", () => {
  const src = `package main

import "fmt"
import (
	"os"
	db "example.com/app/internal/db"
	_ "github.com/lib/pq"
)

type Server struct{}
type Handler interface{}
func (s *Server) Start() {}
func helper() {}
func Exported() {}
const Version = "1"
`;

  it("reads single and block imports including aliased ones", () => {
    assert.deepEqual(specs("main.go", src), ["example.com/app/internal/db", "fmt", "github.com/lib/pq", "os"]);
  });

  it("extracts types, methods and capitalisation-based exports", () => {
    assert.equal(symbol("main.go", src, "Server")?.kind, "struct");
    assert.equal(symbol("main.go", src, "Handler")?.kind, "interface");
    assert.equal(symbol("main.go", src, "Server.Start")?.kind, "method");
    assert.equal(symbol("main.go", src, "helper")?.exported, false);
    assert.equal(symbol("main.go", src, "Exported")?.exported, true);
  });

  it("reads the module path from go.mod", () => {
    assert.equal(analyze("sub/go.mod", "module example.com/app\n\ngo 1.22\n").moduleName, "example.com/app");
  });
});

describe("other languages", () => {
  it("java: imports and class kinds", () => {
    const src = `package com.acme;\nimport com.acme.util.Bar;\nimport static com.acme.util.Maths.square;\nimport java.util.*;\npublic class Foo {}\ninterface Hidden {}\n`;
    assert.deepEqual(specs("Foo.java", src), ["com.acme.util.Bar", "com.acme.util.Maths.square", "java.util"]);
    assert.equal(symbol("Foo.java", src, "Foo")?.exported, true);
    assert.equal(symbol("Foo.java", src, "Hidden")?.exported, false);
  });

  it("c: quoted includes are relative, angle includes are system", () => {
    const src = `#include "a.h"\n#include <stdio.h>\n#define LIMIT 3\nstruct point {\n  int x;\n};\nstatic int add(int a, int b) {\n  return a + b;\n}\nint x = foo(1);\n`;
    const imports = analyze("a.c", src).imports;
    assert.deepEqual(imports, [{ spec: "a.h", kind: "relative" }, { spec: "stdio.h", kind: "system" }]);
    const names = analyze("a.c", src).symbols.map((s) => s.name);
    assert.deepEqual(names, ["LIMIT", "point", "add"]);
  });

  it("rust: mod declarations, use paths and fn kinds", () => {
    const src = `mod util;\npub mod net;\nuse crate::util::helper;\nuse crate::assets::{a, b};\nuse std::fmt as f;\npub fn run() {}\nfn quiet() {}\npub struct Config {}\n`;
    const imports = analyze("main.rs", src).imports;
    assert.deepEqual(imports.filter((i) => i.kind === "mod").map((i) => i.spec), ["util", "net"]);
    assert.deepEqual(imports.filter((i) => i.kind === "use").map((i) => i.spec), ["crate::util::helper", "crate::assets", "std::fmt"]);
    assert.equal(symbol("main.rs", src, "run")?.exported, true);
    assert.equal(symbol("main.rs", src, "quiet")?.exported, false);
    assert.equal(symbol("main.rs", src, "Config")?.kind, "struct");
  });

  it("c#: usings and namespaces", () => {
    const src = `using System;\nusing Acme.Util;\nusing static Acme.Maths;\nnamespace Acme.App\n{\n    public class Program {}\n}\n`;
    const a = analyze("P.cs", src);
    assert.deepEqual(a.imports.map((i) => i.spec), ["System", "Acme.Util", "Acme.Maths"]);
    assert.deepEqual(a.namespaces, ["Acme.App"]);
    assert.equal(a.symbols.find((s) => s.name === "Program")?.exported, true);
  });

  it("ruby: relative requires are marked relative", () => {
    const src = `require "json"\nrequire_relative "lib/helper"\nclass Foo\n  def bar\n  end\nend\n`;
    const imports = analyze("a.rb", src).imports;
    assert.deepEqual(imports, [{ spec: "lib/helper", kind: "relative" }, { spec: "json" }]);
    assert.ok(symbol("a.rb", src, "Foo.bar"));
  });

  it("files of unknown languages yield nothing but a line count", () => {
    const r = analyze("notes.txt", "hello\nworld\n");
    assert.deepEqual([r.symbols, r.imports, r.lines], [[], [], 2]);
  });

  it("counts lines the way an editor does", () => {
    assert.equal(analyze("a.txt", "").lines, 0);
    assert.equal(analyze("a.txt", "one").lines, 1);
    assert.equal(analyze("a.txt", "one\n").lines, 1);
    assert.equal(analyze("a.txt", "one\r\ntwo\r\n").lines, 2);
  });
});
