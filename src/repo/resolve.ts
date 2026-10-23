import * as path from "node:path";
import { Language } from "./languages";
import { RawImport } from "./extract";

const p = path.posix;

export interface ResolveEnv {
  has(file: string): boolean;
  /** Files whose path is, or ends with `/` + suffix. */
  bySuffix(suffix: string): string[];
  dirFiles(dir: string): string[];
  /** Directories whose path is, or ends with `/` + suffix. */
  dirsBySuffix(suffix: string): string[];
  namespaceFiles(ns: string): string[];
  goModules: { dir: string; module: string }[];
}

export interface Resolution {
  targets: string[];
  /**
   * True when the specifier points outside the repo (a package, the stdlib).
   * A non-external import with no targets is a genuine miss and lowers the
   * confidence of any analysis that touches the file.
   */
  external: boolean;
}

/** More files than this behind one namespace means the edge says nothing useful. */
const MAX_NAMESPACE_FANOUT = 25;

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function joinNorm(dir: string, rel: string): string | undefined {
  const r = p.normalize(p.join(dir, rel));
  return r.startsWith("..") ? undefined : r;
}

/** Of several candidates, the one sharing the longest directory prefix with `from`. */
function closest(from: string, candidates: string[]): string[] {
  if (candidates.length <= 1) return candidates;
  const fromDir = p.dirname(from).split("/");
  const score = (c: string) => {
    const d = p.dirname(c).split("/");
    let i = 0;
    while (i < fromDir.length && i < d.length && fromDir[i] === d[i]) i++;
    return i;
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const s = score(c);
    if (s > bestScore || (s === bestScore && c.length < best.length)) {
      best = c;
      bestScore = s;
    }
  }
  return [best];
}

function jsCandidates(base: string): string[] {
  const out = [base];
  const m = /\.(?:m|c)?jsx?$/.exec(base);
  if (m) {
    const stem = base.slice(0, -m[0].length);
    out.push(stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".cts");
  }
  for (const ext of JS_EXTS) out.push(base + ext, p.join(base, "index" + ext));
  return out;
}

function resolveJs(from: string, spec: string, env: ResolveEnv): Resolution {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const base = joinNorm(p.dirname(from), spec);
    const hit = base ? jsCandidates(base).find((c) => env.has(c)) : undefined;
    return { targets: hit ? [hit] : [], external: false };
  }
  if (spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#/")) {
    for (const c of jsCandidates(spec.slice(2))) {
      const hits = env.bySuffix(c);
      if (hits.length) return { targets: closest(from, hits), external: false };
    }
    return { targets: [], external: true };
  }
  if (spec.includes("/") && !spec.startsWith("@")) {
    const hit = jsCandidates(spec).find((c) => env.has(c));
    if (hit) return { targets: [hit], external: false };
  }
  return { targets: [], external: true };
}

function resolvePython(from: string, imp: RawImport, env: ResolveEnv): Resolution {
  const spec = imp.spec;
  const names = imp.names ?? [];
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
  const asModule = (base: string) => [base + ".py", p.join(base, "__init__.py")].find((c) => env.has(c));
  const targets: string[] = [];

  if (dots > 0) {
    let dir = p.dirname(from);
    for (let i = 1; i < dots; i++) dir = p.dirname(dir);
    const base = rest ? joinNorm(dir, rest) : p.normalize(dir);
    if (base === undefined) return { targets, external: false };
    const pkg = rest ? asModule(base) : env.has(p.join(base, "__init__.py")) ? p.join(base, "__init__.py") : undefined;
    const subs = names.map((n) => asModule(p.join(base, n))).filter((x): x is string => !!x);
    if (subs.length) targets.push(...subs);
    else if (pkg) targets.push(pkg);
    return { targets, external: false };
  }

  if (!rest.includes("/")) {
    // a bare name may be stdlib or third-party, so only accept it next to the importer or at the roots
    for (const dir of [p.dirname(from), ".", "src"]) {
      const base = p.join(dir, rest);
      const hit = asModule(base);
      if (!hit) continue;
      const subs = names.map((n) => asModule(p.join(base, n))).filter((x): x is string => !!x);
      return { targets: subs.length ? subs : [hit], external: false };
    }
    return { targets: [], external: true };
  }
  const direct = closest(from, [...env.bySuffix(rest + ".py"), ...env.bySuffix(rest + "/__init__.py")]);
  targets.push(...direct);
  for (const n of names) {
    targets.push(...closest(from, [...env.bySuffix(`${rest}/${n}.py`), ...env.bySuffix(`${rest}/${n}/__init__.py`)]));
  }
  return { targets: [...new Set(targets)], external: targets.length === 0 };
}

function resolveGo(from: string, spec: string, env: ResolveEnv): Resolution {
  const goFiles = (dir: string) => env.dirFiles(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  for (const mod of env.goModules) {
    if (spec === mod.module || spec.startsWith(mod.module + "/")) {
      const rest = spec.slice(mod.module.length).replace(/^\//, "");
      return { targets: goFiles(p.normalize(p.join(mod.dir, rest))), external: false };
    }
  }
  if (env.goModules.length > 0) return { targets: [], external: true };
  const segs = spec.split("/");
  for (let i = 0; i <= segs.length - 2; i++) {
    const dirs = env.dirsBySuffix(segs.slice(i).join("/"));
    if (dirs.length) {
      const best = closest(from, dirs.map((d) => p.join(d, "x.go")))[0];
      return { targets: goFiles(p.dirname(best)), external: false };
    }
  }
  return { targets: [], external: true };
}

function resolveRust(from: string, imp: RawImport, env: ResolveEnv): Resolution {
  const asModule = (base: string) => [base + ".rs", p.join(base, "mod.rs")].find((c) => env.has(c));
  if (imp.kind === "mod") {
    const dir = p.dirname(from);
    const base = p.basename(from);
    const moduleDir = ["mod.rs", "lib.rs", "main.rs"].includes(base) ? dir : p.join(dir, base.replace(/\.rs$/, ""));
    const hit = asModule(p.join(moduleDir, imp.spec));
    return { targets: hit ? [hit] : [], external: false };
  }
  const segs = imp.spec.split("::");
  if (segs[0] !== "crate") return { targets: [], external: true };
  const parts = from.split("/");
  const srcAt = parts.indexOf("src");
  const root = srcAt >= 0 ? parts.slice(0, srcAt + 1).join("/") : p.dirname(from);
  const rest = segs.slice(1);
  for (let n = rest.length; n >= 1; n--) {
    const hit = asModule(p.join(root, ...rest.slice(0, n)));
    if (hit) return { targets: [hit], external: false };
  }
  return { targets: [], external: false };
}

function resolveJvm(from: string, spec: string, env: ResolveEnv): Resolution {
  const segs = spec.split(".");
  for (let drop = 0; drop <= 2 && segs.length - drop >= 2; drop++) {
    const suffix = segs.slice(0, segs.length - drop).join("/");
    const hits = [".java", ".kt", ".scala"].flatMap((e) => env.bySuffix(suffix + e));
    if (hits.length) return { targets: closest(from, hits), external: false };
  }
  return { targets: [], external: true };
}

function resolveInclude(from: string, imp: RawImport, env: ResolveEnv): Resolution {
  const base = joinNorm(p.dirname(from), imp.spec);
  if (base && env.has(base)) return { targets: [base], external: false };
  const hits = env.bySuffix(imp.spec);
  if (hits.length) return { targets: closest(from, hits), external: false };
  return { targets: [], external: imp.kind === "system" };
}

function resolveRelativePath(from: string, spec: string, exts: string[], env: ResolveEnv): Resolution {
  const base = joinNorm(p.dirname(from), spec);
  const hit = base ? [base, ...exts.map((e) => base + e)].find((c) => env.has(c)) : undefined;
  return { targets: hit ? [hit] : [], external: false };
}

export function resolveImport(from: string, language: Language, imp: RawImport, env: ResolveEnv): Resolution {
  switch (language) {
    case "typescript":
    case "javascript":
      return resolveJs(from, imp.spec, env);
    case "python":
      return resolvePython(from, imp, env);
    case "go":
      return resolveGo(from, imp.spec, env);
    case "rust":
      return resolveRust(from, imp, env);
    case "java":
    case "kotlin":
    case "scala":
      return resolveJvm(from, imp.spec, env);
    case "csharp": {
      const files = env.namespaceFiles(imp.spec).filter((f) => f !== from);
      return { targets: files.length <= MAX_NAMESPACE_FANOUT ? files : [], external: files.length === 0 };
    }
    case "c":
    case "cpp":
      return resolveInclude(from, imp, env);
    case "ruby":
      return imp.kind === "relative"
        ? resolveRelativePath(from, imp.spec, [".rb"], env)
        : (() => {
            const hits = env.bySuffix(imp.spec.endsWith(".rb") ? imp.spec : imp.spec + ".rb");
            return { targets: closest(from, hits), external: hits.length === 0 };
          })();
    case "php":
    case "shell":
      return resolveRelativePath(from, imp.spec, [], env);
    default:
      return { targets: [], external: true };
  }
}
