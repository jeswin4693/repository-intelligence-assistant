import { Diagnostic, TestCounts } from "./types";

/**
 * Best-effort readers for the output of common test runners and compilers.
 * They are deliberately forgiving: when nothing is recognised the gate falls
 * back to exit codes and says so, rather than inventing numbers.
 */

export interface Parsed {
  tests?: TestCounts;
  failedTests: string[];
  diagnostics: Diagnostic[];
  parsed: boolean;
}

const MAX_DIAGNOSTICS = 1000;

const int = (s: string | undefined) => (s ? parseInt(s, 10) : 0);

/** "1 failed, 2 skipped, 71 passed" -> { failed: 1, skipped: 2, passed: 71 } */
function words(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.matchAll(/(\d+)\s+(passed|failed|skipped|pending|todo|total|errors?|passing|failing|xfailed|xpassed|deselected)/gi)) {
    const key = m[2].toLowerCase().replace(/^errors$/, "error");
    out[key] = (out[key] ?? 0) + int(m[1]);
  }
  return out;
}

const counts = (passed: number, failed: number, skipped: number, total = passed + failed + skipped): TestCounts => ({ passed, failed, skipped, total });

function nodeTestCounts(out: string): TestCounts | undefined {
  const get = (k: string) => {
    const m = new RegExp(`^(?:ℹ|#)\\s+${k}\\s+(\\d+)\\s*$`, "m").exec(out);
    return m ? int(m[1]) : undefined;
  };
  const total = get("tests");
  if (total === undefined) return undefined;
  return counts(get("pass") ?? 0, (get("fail") ?? 0) + (get("cancelled") ?? 0), (get("skipped") ?? 0) + (get("todo") ?? 0), total);
}

function jestCounts(out: string): TestCounts | undefined {
  const m = /^Tests:\s+(.+)$/m.exec(out);
  if (!m) return undefined;
  const w = words(m[1]);
  return counts(w.passed ?? 0, w.failed ?? 0, (w.skipped ?? 0) + (w.todo ?? 0), w.total);
}

function vitestCounts(out: string): TestCounts | undefined {
  const m = /^\s*Tests\s+(?!:)(.+)$/m.exec(out);
  if (!m) return undefined;
  const w = words(m[1]);
  const total = /\((\d+)\)/.exec(m[1]);
  if (w.passed === undefined && w.failed === undefined) return undefined;
  return counts(w.passed ?? 0, w.failed ?? 0, w.skipped ?? 0, total ? int(total[1]) : undefined);
}

function pytestCounts(out: string): TestCounts | undefined {
  if (/^=*\s*no tests ran/m.test(out)) return counts(0, 0, 0, 0);
  const m =
    /^=+ (.+?) in [\d.]+s[^=\n]*=+$/m.exec(out) ??
    /^(\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, \d+ [\w ]+?)*) in [\d.]+s/m.exec(out);
  if (!m) return undefined;
  const w = words(m[1]);
  if (w.passed === undefined && w.failed === undefined && w.error === undefined) return undefined;
  return counts(w.passed ?? 0, (w.failed ?? 0) + (w.error ?? 0), (w.skipped ?? 0) + (w.xfailed ?? 0));
}

function cargoCounts(out: string): TestCounts | undefined {
  let found = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const m of out.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)) {
    found = true;
    passed += int(m[1]);
    failed += int(m[2]);
    skipped += int(m[3]);
  }
  return found ? counts(passed, failed, skipped) : undefined;
}

function dotnetCounts(out: string): TestCounts | undefined {
  let found = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  for (const m of out.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/g)) {
    found = true;
    failed += int(m[1]);
    passed += int(m[2]);
    skipped += int(m[3]);
    total += int(m[4]);
  }
  return found ? counts(passed, failed, skipped, total) : undefined;
}

function mavenCounts(out: string): TestCounts | undefined {
  const all = [...out.matchAll(/^\[(?:INFO|WARNING|ERROR)\] Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)];
  const last = all[all.length - 1];
  if (!last) return undefined;
  return counts(int(last[1]) - int(last[2]) - int(last[3]) - int(last[4]), int(last[2]) + int(last[3]), int(last[4]), int(last[1]));
}

function mochaCounts(out: string): TestCounts | undefined {
  const passing = /^\s*(\d+) passing/m.exec(out);
  const failing = /^\s*(\d+) failing/m.exec(out);
  if (!passing && !failing) return undefined;
  const pending = /^\s*(\d+) pending/m.exec(out);
  return counts(int(passing?.[1]), int(failing?.[1]), int(pending?.[1]));
}

const COUNT_PARSERS = [nodeTestCounts, jestCounts, vitestCounts, pytestCounts, cargoCounts, dotnetCounts, mavenCounts, mochaCounts];

const FAILED_TEST_PATTERNS: RegExp[] = [
  /^\s*✖ (?!failing tests)(.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm, // node:test spec reporter
  /^\s*not ok \d+ - (.+?)(?: # .*)?$/gm, // TAP
  /^\s*● (?!Console)(.+?)$/gm, // jest
  /^[ \t]*FAIL[ \t]+(\S+\.(?:[cm]?[jt]sx?|vue|svelte)\b.*?)$/gm, // vitest/jest (jest prints FAIL <file>, just as useful as a name)
  /^(?:FAILED|ERROR) (\S+(?:::|\.py)\S*)/gm, // pytest short summary
  /^\s*--- FAIL: (\S+)/gm, // go test
  /^test (\S+) \.\.\. FAILED/gm, // cargo
  /^\s+Failed (\S+) \[/gm, // dotnet
  /^\[ERROR\]\s{2,}(\S+?)(?::\d+)?\s/gm, // maven surefire
];

/** Timings change on every run; a name that carries one would never match its earlier self. */
const cleanName = (s: string) =>
  s
    .replace(/\s*\(\d[\d.,]*\s*m?s\)\s*$/, "")
    .replace(/\s+\d[\d.]*m?s\s*$/, "")
    .trim();

function failedTestNames(out: string): string[] {
  const names = new Set<string>();
  for (const re of FAILED_TEST_PATTERNS) for (const m of out.matchAll(re)) names.add(cleanName(m[1]));
  // go test separates its fields with tabs (jest and vitest use spaces, and are handled above)
  for (const m of out.matchAll(/^FAIL\t(\S+)/gm)) names.add(`package ${m[1]}`);
  return [...names].filter(Boolean).sort();
}

const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning) ([A-Za-z]+\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) ([A-Za-z]+\d+): (.*)$/;
const GCC = /^(.+?):(\d+):(?:(\d+):)? (error|warning|fatal error)(?:\[[^\]]+\])?: (.*)$/;
const RUFF = /^(.+?\.py):(\d+):(\d+): ([A-Z]{1,4}\d+) (.*)$/;
const GO_BUILD = /^(\.{0,2}[\\/]?[^\s:]+\.go):(\d+):(\d+): (.*)$/;
const BARE_ERROR = /^error ([A-Z]+\d+): (.*)$/;
const RUSTC = /^(error|warning)(?:\[(\w+)\])?: (.+)$/;
const RUST_AT = /^\s*--> (.+?):\d+:\d+/;
const ESLINT_FILE = /^\s*(?:[A-Za-z]:)?[\\/].*\.\w{1,6}\s*$/;
const ESLINT_ROW = /^\s+\d+:\d+\s+(error|warning)\s+(.*?)\s{2,}(\S+)\s*$/;

function normalizePath(p: string, root: string): string {
  let out = p.trim().replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (out.toLowerCase().startsWith(r.toLowerCase() + "/")) out = out.slice(r.length + 1);
  return out.replace(/^\.\//, "");
}

const tidy = (s: string) => s.replace(/\s+\[[^\]]+\.(?:csproj|sln|vbproj|fsproj)\]\s*$/, "").replace(/\s+/g, " ").trim();

function parseDiagnostics(out: string, root: string): Diagnostic[] {
  const seen = new Map<string, Diagnostic>();
  const add = (severity: "error" | "warning", text: string) => {
    const key = `${severity}|${text}`;
    if (!seen.has(key) && seen.size < MAX_DIAGNOSTICS) seen.set(key, { severity, text });
  };
  const lines = out.split(/\r?\n/);
  let eslintFile = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = TSC.exec(line)) ?? (m = TSC_PRETTY.exec(line))) {
      add(m[4] as "error" | "warning", `${normalizePath(m[1], root)}: ${m[4]} ${m[5]}: ${tidy(m[6])}`);
    } else if ((m = GCC.exec(line))) {
      const sev = m[4] === "warning" ? "warning" : "error";
      add(sev, `${normalizePath(m[1], root)}: ${sev}: ${tidy(m[5])}`);
    } else if ((m = RUFF.exec(line))) {
      add("error", `${normalizePath(m[1], root)}: ${m[4]}: ${tidy(m[5])}`);
    } else if ((m = GO_BUILD.exec(line))) {
      add("error", `${normalizePath(m[1], root)}: ${tidy(m[4])}`);
    } else if ((m = BARE_ERROR.exec(line))) {
      add("error", `error ${m[1]}: ${tidy(m[2])}`);
    } else if ((m = RUSTC.exec(line))) {
      const where = RUST_AT.exec(lines[i + 1] ?? "");
      if (where && !/aborting due to|could not compile/.test(m[3])) {
        add(m[1] as "error" | "warning", `${normalizePath(where[1], root)}: ${m[1]}${m[2] ? `[${m[2]}]` : ""}: ${tidy(m[3])}`);
      }
    } else if (ESLINT_ROW.test(line) && eslintFile) {
      const row = ESLINT_ROW.exec(line)!;
      add(row[1] as "error" | "warning", `${eslintFile}: ${row[1]} ${row[3]}: ${tidy(row[2])}`);
    } else if (ESLINT_FILE.test(line)) {
      eslintFile = normalizePath(line, root);
    }
  }
  return [...seen.values()];
}

export function parseOutput(output: string, root: string): Parsed {
  let tests: TestCounts | undefined;
  for (const parse of COUNT_PARSERS) {
    tests = parse(output);
    if (tests) break;
  }
  const failedTests = failedTestNames(output);
  const diagnostics = parseDiagnostics(output, root);
  return { tests, failedTests, diagnostics, parsed: !!tests || failedTests.length > 0 || diagnostics.length > 0 };
}
