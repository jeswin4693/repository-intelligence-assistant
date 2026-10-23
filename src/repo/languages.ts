import * as path from "node:path";

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "scala"
  | "csharp"
  | "c"
  | "cpp"
  | "ruby"
  | "php"
  | "swift"
  | "shell"
  | "other";

const BY_EXT: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
};

export function languageOf(file: string): Language {
  return BY_EXT[path.posix.extname(file).toLowerCase()] ?? "other";
}

/** Directories never worth indexing, whatever the listing source says. */
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git", ".ria", ".hg", ".svn"]);

/** Extra build/vendor directories skipped only when git cannot tell us what is ignored. */
export const WALK_SKIP_DIRS = new Set([
  ...ALWAYS_SKIP_DIRS,
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "coverage",
  ".gradle",
  ".idea",
  "vendor",
  "obj",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".pdf",
  ".zip", ".gz", ".tgz", ".7z", ".rar", ".tar", ".jar", ".war", ".class",
  ".dll", ".exe", ".so", ".dylib", ".o", ".a", ".obj", ".pdb", ".bin",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi",
  ".wav", ".webm", ".psd", ".sqlite", ".db", ".pbix", ".xlsx", ".docx", ".pptx",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

/** `rel` is a repo-relative posix path. */
export function shouldIndex(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.some((s) => ALWAYS_SKIP_DIRS.has(s))) return false;
  const base = segs[segs.length - 1];
  if (LOCKFILES.has(base)) return false;
  if (/\.min\.(js|css)$/.test(base) || base.endsWith(".map")) return false;
  return !BINARY_EXT.has(path.posix.extname(base).toLowerCase());
}

const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(py|go|rs|cc|cpp|c)$/,
  /Tests?\.(cs|java|kt|scala|swift|php)$/,
  /_spec\.rb$/,
];

export function isTestFile(rel: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(rel));
}
