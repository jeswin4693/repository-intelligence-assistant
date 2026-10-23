import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandSpec {
  /** typecheck, build, lint, test, or a name from ria.config.json */
  name: string;
  command: string;
  /** Where RIA found it, shown in reports so nobody wonders what ran and why. */
  source: string;
}

export interface GateConfig {
  commands?: Record<string, string | null>;
  timeoutSeconds?: number;
}

export const DEFAULT_TIMEOUT_SECONDS = 600;

/** Order matters: quick structural checks first, the slow suite last. */
const KNOWN_ORDER = ["typecheck", "build", "lint", "test"];

const read = (root: string, rel: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return undefined;
  }
};
const has = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
const safeList = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** `ria.config.json` -> `{ "gate": { "commands": { "test": "npm run test:unit", "lint": null } } }` */
export function loadGateConfig(root: string): GateConfig {
  const text = read(root, "ria.config.json");
  if (!text) return {};
  try {
    const gate = JSON.parse(text)?.gate;
    return gate && typeof gate === "object" ? (gate as GateConfig) : {};
  } catch {
    return {};
  }
}

function nodeCommands(root: string): CommandSpec[] {
  const text = read(root, "package.json");
  if (!text) return [];
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  const run = has(root, "pnpm-lock.yaml") ? "pnpm run" : has(root, "yarn.lock") ? "yarn run" : has(root, "bun.lockb") || has(root, "bun.lock") ? "bun run" : "npm run";
  const out: CommandSpec[] = [];
  const add = (name: string, script: string) => out.push({ name, command: `${run} ${script}`, source: `package.json scripts.${script}` });

  const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
  if (typecheck) add("typecheck", typecheck);
  else if (has(root, "tsconfig.json") && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) {
    out.push({ name: "typecheck", command: "npx --no-install tsc --noEmit", source: "tsconfig.json + typescript dependency" });
  }
  if (scripts.build) add("build", "build");
  if (scripts.lint) add("lint", "lint");
  // the default `npm init` placeholder is not a test suite
  if (scripts.test && !/no test specified/.test(scripts.test)) add("test", "test");
  return out;
}

function pythonCommands(root: string): CommandSpec[] {
  const pyproject = read(root, "pyproject.toml") ?? "";
  const entries = safeList(root);
  const out: CommandSpec[] = [];
  const hasTests =
    has(root, "pytest.ini") ||
    has(root, "conftest.py") ||
    /\[tool\.pytest/.test(pyproject) ||
    /\[tool:pytest\]/.test(read(root, "setup.cfg") ?? "") ||
    /\[pytest\]/.test(read(root, "tox.ini") ?? "") ||
    entries.some((e) => /^test_.*\.py$|_test\.py$/.test(e)) ||
    (has(root, "tests") && safeList(path.join(root, "tests")).some((e) => /^test_.*\.py$|_test\.py$/.test(e)));
  const isPython = pyproject || has(root, "setup.py") || has(root, "requirements.txt") || entries.some((e) => e.endsWith(".py"));
  if (!isPython) return out;
  if (has(root, "mypy.ini") || /\[tool\.mypy/.test(pyproject)) out.push({ name: "typecheck", command: "python -m mypy .", source: "mypy configuration" });
  if (has(root, "ruff.toml") || has(root, ".ruff.toml") || /\[tool\.ruff/.test(pyproject)) out.push({ name: "lint", command: "python -m ruff check .", source: "ruff configuration" });
  if (hasTests) out.push({ name: "test", command: "python -m pytest -q", source: "pytest tests or configuration" });
  return out;
}

function otherCommands(root: string): CommandSpec[] {
  const entries = safeList(root);
  const out: CommandSpec[] = [];
  if (has(root, "go.mod")) {
    out.push({ name: "build", command: "go build ./...", source: "go.mod" });
    out.push({ name: "lint", command: "go vet ./...", source: "go.mod" });
    out.push({ name: "test", command: "go test ./...", source: "go.mod" });
  }
  if (has(root, "Cargo.toml")) {
    out.push({ name: "build", command: "cargo build", source: "Cargo.toml" });
    out.push({ name: "test", command: "cargo test", source: "Cargo.toml" });
  }
  if (entries.some((e) => /\.(sln|csproj)$/.test(e))) {
    out.push({ name: "build", command: "dotnet build --nologo", source: ".sln/.csproj" });
    out.push({ name: "test", command: "dotnet test --nologo", source: ".sln/.csproj" });
  }
  if (has(root, "pom.xml")) {
    out.push({ name: "build", command: "mvn -B -q test-compile", source: "pom.xml" });
    out.push({ name: "test", command: "mvn -B test", source: "pom.xml" });
  } else if (has(root, "gradlew") || has(root, "gradlew.bat")) {
    const gradle = process.platform === "win32" ? "gradlew" : "./gradlew";
    out.push({ name: "build", command: `${gradle} build -x test`, source: "gradle wrapper" });
    out.push({ name: "test", command: `${gradle} test`, source: "gradle wrapper" });
  }
  const makefile = read(root, "Makefile");
  if (makefile) {
    for (const target of ["build", "lint", "test"]) {
      if (new RegExp(`^${target}\\s*:`, "m").test(makefile)) out.push({ name: target, command: `make ${target}`, source: `Makefile target ${target}` });
    }
  }
  return out;
}

/**
 * The project's own build, typecheck, lint and test commands, found from its
 * manifest files at the repository root, then adjusted by `ria.config.json`.
 * Commands only ever come from project files, never from the caller of the tool.
 */
export function detectCommands(root: string, config: GateConfig = loadGateConfig(root)): CommandSpec[] {
  const byName = new Map<string, CommandSpec>();
  for (const spec of [...nodeCommands(root), ...pythonCommands(root), ...otherCommands(root)]) {
    if (!byName.has(spec.name)) byName.set(spec.name, spec);
  }
  for (const [name, command] of Object.entries(config.commands ?? {})) {
    if (command === null || command === "") byName.delete(name);
    else if (typeof command === "string") byName.set(name, { name, command, source: "ria.config.json" });
  }
  const rank = (n: string) => {
    const i = KNOWN_ORDER.indexOf(n);
    return i === -1 ? KNOWN_ORDER.length : i;
  };
  return [...byName.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
