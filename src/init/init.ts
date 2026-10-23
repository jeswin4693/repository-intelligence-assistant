import * as fs from "node:fs";
import * as path from "node:path";
import { SERVER_NAME, claudeSkill, claudeSkillPath, copilotAgent, copilotAgentPath } from "./render";
import { ROLES, ROLE_IDS, Role } from "./roles";

export type Host = "claude" | "copilot" | "both";

export interface InitOptions {
  host: Host;
  /** Role ids to install. Default: all. */
  roles?: string[];
  /** Register `ria` from the PATH instead of this install's absolute path (for a config that is committed and shared). */
  onPath?: boolean;
  /** Replace role files and a `ria` server entry that differ from what RIA would write. */
  force?: boolean;
  /** Path of this install's `dist/index.js`. Default: found from this file. Mainly for tests. */
  entry?: string;
}

export interface InitAction {
  /** Repository-relative, forward slashes. */
  path: string;
  kind: "create" | "update" | "unchanged" | "skip" | "manual";
  detail: string;
  /** The full file content, for `create` and `update`. */
  content?: string;
}

export interface InitPlan {
  actions: InitAction[];
  notes: string[];
}

/** `dist/index.js` of the RIA install that is running, with forward slashes so the config is the same on every OS. */
function installedEntry(): string {
  let dir = __dirname;
  for (let i = 0; i < 6 && !fs.existsSync(path.join(dir, "package.json")); i++) dir = path.dirname(dir);
  return path.join(dir, "dist", "index.js").replace(/\\/g, "/");
}

function serverEntry(host: "claude" | "copilot", opts: InitOptions, entry: string): Record<string, unknown> {
  const launch = opts.onPath ? { command: "ria", args: ["serve"] } : { command: "node", args: [entry, "serve"] };
  const args = host === "copilot" ? [...launch.args, "--root", "${workspaceFolder}"] : launch.args;
  return { type: "stdio", command: launch.command, args };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function planFile(root: string, rel: string, content: string, force: boolean): InitAction {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { path: rel, kind: "create", detail: "new file", content };
  let current: string;
  try {
    current = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    return { path: rel, kind: "manual", detail: `could not read the existing file (${e instanceof Error ? e.message : String(e)})` };
  }
  if (current === content) return { path: rel, kind: "unchanged", detail: "already as RIA would write it" };
  if (force) return { path: rel, kind: "update", detail: "replaces the existing copy", content };
  return { path: rel, kind: "skip", detail: "exists and differs, so your version is kept (--force replaces it)" };
}

/** Adds the `ria` server to an MCP config file, keeping everything else in it. */
function planMcp(root: string, rel: string, key: "mcpServers" | "servers", entry: Record<string, unknown>, force: boolean): InitAction {
  const abs = path.join(root, rel);
  const snippet = JSON.stringify({ [key]: { [SERVER_NAME]: entry } }, null, 2);
  if (!fs.existsSync(abs)) return { path: rel, kind: "create", detail: `registers the ${SERVER_NAME} server`, content: snippet + "\n" };

  const manual = (why: string): InitAction => ({ path: rel, kind: "manual", detail: `${why}. Add this by hand:\n${snippet.replace(/^/gm, "      ")}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8").replace(/^﻿/, ""));
  } catch {
    return manual("could not read it as plain JSON (VS Code allows comments in this file, which RIA will not rewrite)");
  }
  if (!isObject(parsed) || (parsed[key] !== undefined && !isObject(parsed[key]))) return manual(`it has no usable "${key}" object`);

  const servers = (parsed[key] ?? {}) as Record<string, unknown>;
  const have = servers[SERVER_NAME];
  if (have !== undefined) {
    if (JSON.stringify(have) === JSON.stringify(entry)) return { path: rel, kind: "unchanged", detail: `the ${SERVER_NAME} server is already registered this way` };
    if (!force) return { path: rel, kind: "skip", detail: `a "${SERVER_NAME}" server is already configured differently, so it is kept (--force replaces only that entry)` };
  }
  const next = { ...parsed, [key]: { ...servers, [SERVER_NAME]: entry } };
  return {
    path: rel,
    kind: "update",
    detail: have === undefined ? `adds the ${SERVER_NAME} server next to your other servers (the file is rewritten with 2-space indentation)` : `replaces the ${SERVER_NAME} entry`,
    content: JSON.stringify(next, null, 2) + "\n",
  };
}

/** Works out what `ria init` would do. Writes nothing. */
export function planInit(root: string, opts: InitOptions): InitPlan | { error: string } {
  if (!["claude", "copilot", "both"].includes(opts.host)) return { error: `Unknown host "${opts.host}". Use claude, copilot or both.` };
  let roles: Role[] = ROLES;
  if (opts.roles) {
    const unknown = opts.roles.filter((r) => !ROLE_IDS.includes(r));
    if (unknown.length) return { error: `Unknown role ${unknown.map((r) => `"${r}"`).join(", ")}. Roles: ${ROLE_IDS.join(", ")}.` };
    roles = ROLES.filter((r) => opts.roles!.includes(r.id));
  }
  const force = opts.force === true;
  const entry = opts.entry ?? installedEntry();
  const claude = opts.host !== "copilot";
  const copilot = opts.host !== "claude";

  const actions: InitAction[] = [];
  if (claude) {
    actions.push(planMcp(root, ".mcp.json", "mcpServers", serverEntry("claude", opts, entry), force));
    for (const r of roles) actions.push(planFile(root, claudeSkillPath(r), claudeSkill(r), force));
  }
  if (copilot) {
    actions.push(planMcp(root, ".vscode/mcp.json", "servers", serverEntry("copilot", opts, entry), force));
    for (const r of roles) actions.push(planFile(root, copilotAgentPath(r), copilotAgent(r), force));
  }

  const notes: string[] = [];
  if (!opts.onPath) {
    if (!fs.existsSync(entry)) notes.push(`Warning: ${entry} does not exist yet. Run "npm run build" in the RIA folder before the chat starts the server.`);
    notes.push(`The MCP config names this machine's RIA folder (${entry}). If the repository is shared, install RIA so that \`ria\` is on the PATH and run this again with --on-path.`);
  }
  if (claude) notes.push("Claude Code asks you to approve a project .mcp.json server the first time. The roles are skills under .claude/skills.");
  if (copilot) {
    notes.push("VS Code asks you to review and trust an MCP server before it runs. The roles appear in the agents dropdown; read-only roles are not given an edit tool.");
    notes.push("Copilot Chat can only be instructed: a model can ignore a role's steps. The allow-list of tools is the part that is enforced.");
  }
  return { actions, notes };
}

/** Writes the files of a plan. Returns how many were written. */
export function applyInit(root: string, plan: InitPlan): number {
  let written = 0;
  for (const a of plan.actions) {
    if ((a.kind !== "create" && a.kind !== "update") || a.content === undefined) continue;
    const abs = path.resolve(root, a.path);
    if (path.relative(root, abs).startsWith("..")) throw new Error(`Refusing to write outside the repository: ${a.path}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, a.content);
    written++;
  }
  return written;
}

export function formatInit(plan: InitPlan, root: string, applied: boolean): string {
  const past: Record<string, string> = { create: "created", update: "updated" };
  const label = (a: InitAction) => (applied ? past[a.kind] : undefined) ?? a.kind;
  const out: string[] = [applied ? `RIA init for ${root}: applied` : `RIA init for ${root}: preview only, nothing was written. Add --apply to write these.`, ""];
  for (const a of plan.actions) out.push(`  ${label(a).padEnd(9)} ${a.path}${a.kind === "create" && a.detail === "new file" ? "" : `  (${a.detail})`}`);
  const count = (k: InitAction["kind"]) => plan.actions.filter((a) => a.kind === k).length;
  const [made, changed] = applied ? ["created", "updated"] : ["to create", "to update"];
  out.push("", `${count("create")} ${made}, ${count("update")} ${changed}, ${count("unchanged")} unchanged, ${count("skip")} kept as they are, ${count("manual")} to do by hand.`);
  if (plan.notes.length) out.push("", ...plan.notes.map((n) => `Note: ${n}`));
  return out.join("\n");
}
