import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { detectCommands } from "../src/gate/detect";
import { cleanup, makeRepo } from "./helpers";

const dirs: string[] = [];
after(() => dirs.forEach(cleanup));
const detect = (files: Record<string, string>) => {
  const dir = makeRepo(files);
  dirs.push(dir);
  return detectCommands(dir);
};
const summary = (specs: ReturnType<typeof detect>) => specs.map((s) => `${s.name}: ${s.command}`);

describe("detectCommands", () => {
  it("node: reads package.json scripts and picks the package manager from the lockfile", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc", lint: "eslint .", test: "vitest run", typecheck: "tsc --noEmit" } });
    assert.deepEqual(summary(detect({ "package.json": pkg })), ["typecheck: npm run typecheck", "build: npm run build", "lint: npm run lint", "test: npm run test"]);
    assert.equal(detect({ "package.json": pkg, "pnpm-lock.yaml": "" })[0].command, "pnpm run typecheck");
    assert.equal(detect({ "package.json": pkg, "yarn.lock": "" })[3].command, "yarn run test");
  });

  it("node: ignores the placeholder test script and falls back to tsc for TypeScript projects", () => {
    const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { typescript: "^5" } });
    assert.deepEqual(summary(detect({ "package.json": pkg, "tsconfig.json": "{}" })), ["typecheck: npx --no-install tsc --noEmit"]);
  });

  it("python: only suggests tools the project is configured for", () => {
    assert.deepEqual(summary(detect({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n" })), [
      "typecheck: python -m mypy .",
      "lint: python -m ruff check .",
      "test: python -m pytest -q",
    ]);
    assert.deepEqual(summary(detect({ "requirements.txt": "flask\n", "tests/test_app.py": "def test_x(): pass\n" })), ["test: python -m pytest -q"]);
    assert.deepEqual(detect({ "requirements.txt": "flask\n" }), []);
  });

  it("go, rust, dotnet, maven and make", () => {
    assert.deepEqual(summary(detect({ "go.mod": "module x\n" })), ["build: go build ./...", "lint: go vet ./...", "test: go test ./..."]);
    assert.deepEqual(summary(detect({ "Cargo.toml": "[package]\n" })), ["build: cargo build", "test: cargo test"]);
    assert.deepEqual(summary(detect({ "App.csproj": "<Project/>" })), ["build: dotnet build --nologo", "test: dotnet test --nologo"]);
    assert.deepEqual(summary(detect({ "pom.xml": "<project/>" })), ["build: mvn -B -q test-compile", "test: mvn -B test"]);
    assert.deepEqual(summary(detect({ Makefile: "test:\n\techo hi\nclean:\n\trm x\n" })), ["test: make test"]);
  });

  it("the project's own manifest wins over a Makefile for the same name", () => {
    const specs = detect({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), Makefile: "test:\n\techo\n" });
    assert.deepEqual(summary(specs), ["test: npm run test"]);
  });

  it("ria.config.json can replace, disable and add commands", () => {
    const specs = detect({
      "package.json": JSON.stringify({ scripts: { build: "tsc", lint: "eslint .", test: "jest" } }),
      "ria.config.json": JSON.stringify({ gate: { commands: { test: "npm run test:unit", lint: null, e2e: "npm run e2e" } } }),
    });
    assert.deepEqual(summary(specs), ["build: npm run build", "test: npm run test:unit", "e2e: npm run e2e"]);
    assert.equal(specs.find((s) => s.name === "e2e")?.source, "ria.config.json");
  });

  it("returns nothing for a project it knows nothing about, and survives a broken config", () => {
    assert.deepEqual(detect({ "notes.txt": "hi" }), []);
    assert.deepEqual(detect({ "ria.config.json": "{ not json" }), []);
  });
});
