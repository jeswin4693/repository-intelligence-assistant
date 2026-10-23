import * as fs from "node:fs";
import * as path from "node:path";
import { RepoIndex } from "../repo/repo-index";
import { plural, previewSymbols } from "./shared";

export interface RepoMapOptions {
  maxTokens?: number;
  /** Repo-relative directory to restrict the listing to. */
  focus?: string;
}

const ENTRY_NAME = /(^|\/)(main|index|app|server|cli|__main__|manage|program)\.[a-z]+$/i;
const OUTLINE_DEPTH = 2;
const OUTLINE_LINES = 40;

function entryPoints(index: RepoIndex, files: string[]): string[] {
  const out: string[] = [];
  const listed = new Set<string>();
  const note = (file: string, why: string) => {
    if (listed.has(file)) return;
    listed.add(file);
    out.push(`${file}  (${why}${index.files.has(file) ? "" : "; not in the index, likely build output"})`);
  };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(index.root, "package.json"), "utf8"));
    if (typeof pkg.main === "string") note(pkg.main, "package.json main");
    const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
    for (const [name, file] of Object.entries(bin)) note(String(file), `package.json bin "${name}"`);
    if (pkg.scripts?.start) out.push(`npm start -> ${pkg.scripts.start}`);
  } catch {
    // no package.json
  }
  const guessed = files
    .filter((f) => {
      const rec = index.files.get(f);
      return ENTRY_NAME.test(f) && f.split("/").length <= 3 && rec?.language !== "other" && !rec?.isTest;
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const f of guessed.slice(0, 6)) note(f, "by name");
  return out.slice(0, 10);
}

function languageSummary(files: string[], index: RepoIndex): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const rec = index.files.get(f)!;
    const key = rec.language === "other" ? path.posix.extname(f) || "(no ext)" : rec.language;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(", ");
}

export function repoMap(index: RepoIndex, opts: RepoMapOptions): string {
  const maxChars = (opts.maxTokens ?? 4000) * 4;
  const graph = index.graph();
  const focus = (opts.focus ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const files = [...index.files.keys()].filter((f) => !focus || f === focus || f.startsWith(focus + "/")).sort();
  if (files.length === 0) {
    return focus ? `No indexed files under "${focus}".` : "No indexable files found.";
  }

  const history = index.history();
  const totalLines = files.reduce((n, f) => n + index.files.get(f)!.lines, 0);
  const out: string[] = [];
  out.push(`Repository: ${path.basename(index.root)}${focus ? ` (focus: ${focus}/)` : ""}`);
  out.push(`Files: ${files.length} indexed, ${totalLines} lines (${languageSummary(files, index)})`);
  out.push(`Git history: ${history ? `${plural(history.commits.length, "commit")} indexed` : "not available"}`);
  const unresolvedFiles = files.filter((f) => graph.unresolved.has(f));
  if (unresolvedFiles.length) {
    const n = unresolvedFiles.reduce((sum, f) => sum + graph.unresolved.get(f)!.length, 0);
    out.push(`Graph gaps: ${n} relative import(s) in ${unresolvedFiles.length} file(s) did not resolve`);
  }

  const entries = entryPoints(index, files);
  if (entries.length) {
    out.push("", "Entry points (heuristic):");
    for (const e of entries) out.push(`  ${e}`);
  }

  const dirCounts = new Map<string, number>();
  const base = focus ? focus.split("/").length : 0;
  for (const f of files) {
    const segs = f.split("/");
    for (let d = base + 1; d <= Math.min(segs.length - 1, base + OUTLINE_DEPTH); d++) {
      const key = segs.slice(0, d).join("/");
      dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
    }
  }
  if (dirCounts.size) {
    out.push("", "Structure:");
    const dirs = [...dirCounts].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [dir, n] of dirs.slice(0, OUTLINE_LINES)) {
      const depth = dir.split("/").length - base;
      out.push(`${"  ".repeat(depth)}${path.posix.basename(dir)}/  (${n})`);
    }
    if (dirs.length > OUTLINE_LINES) out.push(`  ... and ${dirs.length - OUTLINE_LINES} more directories`);
  }

  const key = files
    .filter((f) => index.files.get(f)!.language !== "other" && !index.files.get(f)!.isTest)
    .map((f) => ({ f, rec: index.files.get(f)!, inn: graph.inn.get(f)?.size ?? 0, outd: graph.out.get(f)?.size ?? 0 }))
    .sort((a, b) => b.inn - a.inn || b.outd - a.outd || b.rec.lines - a.rec.lines || a.f.localeCompare(b.f));

  out.push("", "Key files (most depended-on first):");
  let size = out.join("\n").length;
  let shown = 0;
  for (const k of key) {
    const syms = previewSymbols(k.rec, 8);
    const entry = [`  ${k.f}  (${k.rec.language}, ${k.rec.lines} lines, imported by ${k.inn}, imports ${k.outd})`];
    if (syms.length) entry.push(`      ${syms.join(", ")}`);
    const text = entry.join("\n");
    if (size + text.length > maxChars) break;
    out.push(text);
    size += text.length + 1;
    shown++;
  }
  if (shown < key.length) out.push(`  ... ${key.length - shown} more files omitted by the token budget (raise max_tokens or use focus)`);
  return out.join("\n");
}
