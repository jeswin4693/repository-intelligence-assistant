import * as path from "node:path";
import { Language, languageOf } from "./languages";

/**
 * Heuristic, regex-based extraction. It is language-agnostic by design: each
 * language is a row of patterns, so adding one never touches the graph or the
 * tools. A parser (e.g. tree-sitter) can replace a row later without changing
 * anything downstream.
 */

export interface RawImport {
  spec: string;
  /** Names pulled in by the statement (Python `from x import a, b`). */
  names?: string[];
  kind?: "relative" | "mod" | "use" | "system";
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

export interface Extracted {
  symbols: SymbolInfo[];
  imports: RawImport[];
  /** Namespaces declared by the file (C#). */
  namespaces: string[];
  /** Module path declared by a go.mod. */
  moduleName?: string;
  lines: number;
}

type Match = RegExpExecArray;

interface LineRule {
  re: RegExp;
  kind: string | ((m: Match) => string);
  name: number | ((m: Match) => string);
  exported?: (m: Match) => boolean;
  /** Opens a scope (class, module) that later `member`/`prefix` rules attach to. */
  container?: boolean;
  /** Only matches inside a container; the name is prefixed with it. */
  member?: boolean;
  /** Prefixes the container name when there is one, matches either way. */
  prefix?: boolean;
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "sizeof",
  "typeof", "function", "new", "delete", "throw", "await", "case", "default", "with", "when",
]);

const SLASH = ["//", "/*", "*"];
const COMMENT_PREFIX: Partial<Record<Language, string[]>> = {
  typescript: SLASH,
  javascript: SLASH,
  java: SLASH,
  kotlin: SLASH,
  scala: SLASH,
  csharp: SLASH,
  rust: SLASH,
  go: SLASH,
  swift: SLASH,
  c: SLASH,
  cpp: SLASH,
  php: [...SLASH, "#"],
  python: ["#"],
  ruby: ["#"],
  shell: ["#"],
};

const upper = (s: string) => /^[A-Z]/.test(s);
const jsExported = (m: Match) => !!m[1];
const pubExported = (m: Match) => !!m[1];

const JS_RULES: LineRule[] = [
  { re: /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", name: 2, exported: jsExported },
  { re: /^(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 2, exported: jsExported, container: true },
  { re: /^(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", name: 2, exported: jsExported },
  { re: /^(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: "type", name: 2, exported: jsExported },
  { re: /^(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", name: 2, exported: jsExported },
  {
    re: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
    kind: "function",
    name: 2,
    exported: jsExported,
  },
  { re: /^(export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: "const", name: 2, exported: jsExported },
  {
    re: /^[ \t]+(?:(?:public|private|protected|static|readonly|async|abstract|override|get|set)\s+)*(?:\*\s*)?([A-Za-z_$#][\w$]*)\s*(?:<[^>(]*>)?\([^)]*\)\s*(?::\s*[^{;=]+?)?\s*\{\s*$/,
    kind: "method",
    name: 1,
    member: true,
  },
];

const RULES: Partial<Record<Language, LineRule[]>> = {
  typescript: JS_RULES,
  javascript: JS_RULES,
  python: [
    { re: /^class\s+(\w+)/, kind: "class", name: 1, container: true, exported: (m) => !m[1].startsWith("_") },
    { re: /^(?:async\s+)?def\s+(\w+)/, kind: "function", name: 1, exported: (m) => !m[1].startsWith("_") },
    { re: /^[ \t]+(?:async\s+)?def\s+(\w+)/, kind: "method", name: 1, member: true, exported: (m) => !m[1].startsWith("_") },
  ],
  go: [
    { re: /^func\s+\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)/, kind: "method", name: (m) => `${m[1]}.${m[2]}`, exported: (m) => upper(m[2]) },
    { re: /^func\s+(\w+)/, kind: "function", name: 1, exported: (m) => upper(m[1]) },
    { re: /^type\s+(\w+)\s+(struct|interface)/, kind: (m) => m[2], name: 1, exported: (m) => upper(m[1]) },
    { re: /^type\s+(\w+)/, kind: "type", name: 1, exported: (m) => upper(m[1]) },
    { re: /^(?:const|var)\s+(\w+)/, kind: "const", name: 1, exported: (m) => upper(m[1]) },
  ],
  rust: [
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, kind: "function", name: 2, exported: pubExported },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|type)\s+(\w+)/, kind: (m) => m[2], name: 3, exported: pubExported },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>,\s&']+?\s+for\s+)?(\w+)/, kind: "impl", name: 1 },
  ],
  java: [
    { re: /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/, kind: (m) => m[1], name: 2, exported: (m) => /\bpublic\b/.test(m[0]) },
  ],
  kotlin: [
    { re: /^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|inline|suspend|override)\s+)*(class|interface|object|fun)\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)/, kind: (m) => (m[1] === "fun" ? "function" : m[1]), name: 2, exported: (m) => !/\bprivate\b/.test(m[0]) },
  ],
  scala: [
    { re: /^\s*(?:(?:private|protected|final|abstract|sealed|case|implicit|override|lazy)\s+)*(class|object|trait|def)\s+(\w+)/, kind: (m) => (m[1] === "def" ? "function" : m[1]), name: 2, exported: (m) => !/\bprivate\b/.test(m[0]) },
  ],
  csharp: [
    { re: /^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|unsafe|file)\s+)*(class|interface|struct|enum|record)\s+(\w+)/, kind: (m) => m[1], name: 2, exported: (m) => /\bpublic\b/.test(m[0]) },
  ],
  c: [
    { re: /^\s*#\s*define\s+(\w+)/, kind: "macro", name: 1 },
    { re: /^\s*(?:typedef\s+)?(struct|class|enum|union)\s+(\w+)[^;]*$/, kind: (m) => m[1], name: 2 },
    { re: /^(?:[\w:<>,*&]+\s+)+[*&]*([A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\([^;]*$/, kind: "function", name: 1 },
  ],
  ruby: [
    { re: /^\s*(class|module)\s+([\w:]+)/, kind: (m) => m[1], name: 2, container: true },
    { re: /^\s*def\s+(?:self\.)?(\w+[?!=]?)/, kind: "function", name: 1, prefix: true },
  ],
  php: [
    { re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/, kind: (m) => m[1], name: 2, container: true },
    { re: /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?(\w+)/, kind: "function", name: 1, prefix: true },
  ],
  swift: [
    { re: /^\s*(?:(?:public|private|internal|open|final|fileprivate)\s+)*(class|struct|enum|protocol|extension|func)\s+(\w+)/, kind: (m) => (m[1] === "func" ? "function" : m[1]), name: 2 },
  ],
  shell: [
    { re: /^function\s+(\w+)/, kind: "function", name: 1 },
    { re: /^(\w+)\s*\(\)\s*\{?/, kind: "function", name: 1 },
  ],
};
RULES.cpp = RULES.c;

function symbolsOf(language: Language, lines: string[], comments: string[]): SymbolInfo[] {
  const rules = RULES[language];
  if (!rules) return [];
  const out: SymbolInfo[] = [];
  let container: string | undefined;
  let containerExported = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || comments.some((c) => trimmed.startsWith(c))) continue;
    if (trimmed.length === line.length && !/^[})\]@]/.test(trimmed)) container = undefined;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (rule.member && !container) continue;
      const bare = typeof rule.name === "number" ? m[rule.name] : rule.name(m);
      if (!bare || KEYWORDS.has(bare)) continue;
      const kind = typeof rule.kind === "string" ? rule.kind : rule.kind(m);
      const nested = (rule.member || rule.prefix) && !!container;
      const exported: boolean = (rule.exported ? rule.exported(m) : true) && (!nested || containerExported);
      out.push({ name: nested ? `${container}.${bare}` : bare, kind, line: i + 1, exported });
      if (rule.container) {
        container = bare;
        containerExported = exported;
      }
      break;
    }
  }
  return out;
}

const all = (re: RegExp, text: string) => [...text.matchAll(re)];

function jsImports(code: string): RawImport[] {
  const res = [
    /\bimport\s+(?:type\s+)?(?:[\w$*\s{},]+?\s+from\s+)?["']([^"'\n]+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g,
    /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  return res.flatMap((re) => all(re, code).map((m) => ({ spec: m[1] })));
}

function pyImports(code: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of all(/^[ \t]*import[ \t]+([^\n]+)/gm, code)) {
    for (const part of m[1].split(",")) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(mod)) out.push({ spec: mod });
    }
  }
  for (const m of all(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm, code)) {
    const names = m[2]
      .replace(/[()]/g, " ")
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join(" ")
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((n) => /^\w+$/.test(n));
    out.push({ spec: m[1], names });
  }
  return out;
}

function goImports(code: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of all(/^\s*import\s*\(([\s\S]*?)\)/gm, code)) {
    for (const q of all(/"([^"\n]+)"/g, m[1])) out.push({ spec: q[1] });
  }
  for (const m of all(/^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm, code)) out.push({ spec: m[1] });
  return out;
}

function rustImports(code: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm, code)) out.push({ spec: m[1], kind: "mod" });
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm, code)) {
    const spec = m[1]
      .split("{")[0]
      .replace(/\s+as\s+\w+\s*$/, "")
      .replace(/\s+/g, "")
      .replace(/::\*?$/, "");
    out.push({ spec, kind: "use" });
  }
  return out;
}

function jvmImports(code: string): RawImport[] {
  return all(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+?)(?:\.\*)?[ \t]*;?[ \t]*$/gm, code).map((m) => ({ spec: m[1] }));
}

function csharpImports(code: string): RawImport[] {
  return all(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm, code).map((m) => ({ spec: m[1] }));
}

function cImports(code: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of all(/^[ \t]*#[ \t]*include[ \t]+"([^"\n]+)"/gm, code)) out.push({ spec: m[1], kind: "relative" });
  for (const m of all(/^[ \t]*#[ \t]*include[ \t]+<([^>\n]+)>/gm, code)) out.push({ spec: m[1], kind: "system" });
  return out;
}

function rubyImports(code: string): RawImport[] {
  const out: RawImport[] = [];
  for (const m of all(/^[ \t]*require_relative[ \t]*\(?[ \t]*["']([^"'\n]+)["']/gm, code)) out.push({ spec: m[1], kind: "relative" });
  for (const m of all(/^[ \t]*require[ \t]*\(?[ \t]*["']([^"'\n]+)["']/gm, code)) out.push({ spec: m[1] });
  return out;
}

function phpImports(code: string): RawImport[] {
  return all(/^[ \t]*(?:require|include)(?:_once)?[ \t]*\(?[ \t]*["']([^"'\n]+)["']/gm, code).map((m) => ({ spec: m[1], kind: "relative" as const }));
}

function shellImports(code: string): RawImport[] {
  return all(/^[ \t]*(?:source|\.)[ \t]+["']?([^\s"';]+)/gm, code).map((m) => ({ spec: m[1], kind: "relative" as const }));
}

const IMPORTERS: Partial<Record<Language, (code: string) => RawImport[]>> = {
  typescript: jsImports,
  javascript: jsImports,
  python: pyImports,
  go: goImports,
  rust: rustImports,
  java: jvmImports,
  kotlin: jvmImports,
  scala: jvmImports,
  csharp: csharpImports,
  c: cImports,
  cpp: cImports,
  ruby: rubyImports,
  php: phpImports,
  shell: shellImports,
};

function dedupe(imports: RawImport[]): RawImport[] {
  const seen = new Map<string, RawImport>();
  for (const imp of imports) {
    const key = `${imp.kind ?? ""}|${imp.spec}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, imp);
    else if (imp.names) prev.names = [...new Set([...(prev.names ?? []), ...imp.names])];
  }
  return [...seen.values()];
}

export function analyze(file: string, text: string): Extracted {
  const language = languageOf(file);
  const lines = text.split(/\r?\n/);
  // a trailing newline ends the last line, it does not start another one
  const lineCount = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
  const result: Extracted = { symbols: [], imports: [], namespaces: [], lines: lineCount };

  if (path.posix.basename(file) === "go.mod") {
    const m = /^module\s+(\S+)/m.exec(text);
    if (m) result.moduleName = m[1];
    return result;
  }

  const comments = COMMENT_PREFIX[language];
  if (!comments) return result;

  const code = lines.map((l) => (comments.some((c) => l.trimStart().startsWith(c)) ? "" : l)).join("\n");
  result.symbols = symbolsOf(language, lines, comments);
  result.imports = dedupe(IMPORTERS[language]?.(code) ?? []);
  if (language === "csharp") {
    result.namespaces = all(/^[ \t]*namespace[ \t]+([\w.]+)/gm, code).map((m) => m[1]);
  }
  return result;
}
