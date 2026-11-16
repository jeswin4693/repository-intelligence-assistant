import * as fs from "node:fs";
import * as path from "node:path";
import { loadRun } from "../gate/store";
import { DEFAULT_MAX_AGE_HOURS } from "./stop";

/**
 * The Claude Code `PreToolUse` hook, opt-in (`ria init --hooks --enforce`): it refuses an edit to a file of the
 * project until the chat has started a change-gate run with `gate_begin`. The routing hook only advises and a chat
 * can skip the gate; this is the part that does not depend on the chat's goodwill. Without a baseline the gate
 * has nothing to compare with, and the stop hook enforces nothing.
 *
 * Claude Code runs it before each Edit, Write, MultiEdit or NotebookEdit and sends JSON on stdin. To refuse, it
 * prints a `permissionDecision` of `deny` with the reason, which Claude Code hands to the chat. To let an edit
 * through it prints NOTHING: an explicit `allow` would skip the user's own permission prompts, and this hook has
 * no business deciding that. A hook that cannot decide (unreadable input, no git, a file outside the project)
 * lets the edit through, and one that breaks exits 1, which Claude Code treats as a non-blocking error: a broken
 * hook must not trap the chat.
 */

/** The tools the hook is registered for. */
export const PRETOOL_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const EDIT_TOOLS = new Set(PRETOOL_MATCHER.split("|"));

/** RIA's own state, Claude Code's settings and skills, and git's files: not the user's work, and the chat may need them to get a baseline. */
const EXEMPT_TOP_LEVEL = new Set([".ria", ".git", ".claude"]);

export interface PretoolInput {
  tool?: string;
  /** `file_path`, or `notebook_path` for a notebook, as the tool was called with it. */
  file?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads the hook's stdin leniently: input it cannot read is input it does not act on. */
export function parsePretoolInput(raw: string): PretoolInput {
  try {
    const v: unknown = JSON.parse(raw);
    if (!isObject(v)) return {};
    const input = isObject(v.tool_input) ? v.tool_input : {};
    const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : undefined;
    return { tool: typeof v.tool_name === "string" ? v.tool_name : undefined, file };
  } catch {
    return {};
  }
}

export interface PretoolOptions {
  maxAgeHours?: number;
  now?: Date;
}

export interface PretoolDecision {
  deny: boolean;
  /** For the chat; present only when refusing. */
  reason?: string;
  /** For the person: why an edit was let through without a check, or nothing. */
  note?: string;
}

const allow = (note?: string): PretoolDecision => ({ deny: false, note });

/** `file` relative to `root` with forward slashes, or undefined when it is outside (or is the root itself). */
function insideRoot(root: string, file: string): string | undefined {
  const rel = path.relative(path.resolve(root), path.resolve(root, file));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

const HOW =
  "Call the RIA tool `gate_begin` first: it records the files as they are now and runs the project's own checks, and it takes seconds when nothing changed since a recent passing run. Then repeat this edit; after it, `gate_check` compares with that baseline. If the RIA tools are not loaded yet, load `gate_begin` first (in Claude Code, ToolSearch with `select:mcp__ria__gate_begin`).";

/** Reads only `.ria/gate`: with no run, nothing is indexed or written. */
export function decidePretool(root: string, input: PretoolInput, opts: PretoolOptions = {}): PretoolDecision {
  if (!input.tool || !EDIT_TOOLS.has(input.tool)) return allow();
  if (!input.file) return allow();
  const rel = insideRoot(root, input.file);
  if (rel === undefined) return allow(); // a scratch file, a memory file, anything that is not this project's
  if (EXEMPT_TOP_LEVEL.has(rel.split("/")[0])) return allow();
  // the gate needs git (its snapshots are git objects): where it cannot run, there is nothing to ask for
  if (!fs.existsSync(path.join(root, ".git"))) return allow("ria: this folder is not a git repository, so the gate cannot run and no baseline is required");

  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const run = loadRun(root);
  if (!run) {
    return { deny: true, reason: `Do not edit \`${rel}\` yet: no change-gate baseline has been recorded for this task. ${HOW}` };
  }
  const ageMs = (opts.now ?? new Date()).getTime() - Date.parse(run.createdAt);
  if (!(ageMs <= maxAgeHours * 3_600_000)) {
    return {
      deny: true,
      reason: `Do not edit \`${rel}\` yet: the latest gate run (${run.id}) is older than ${maxAgeHours} hours, so it is probably another task's and would blame this change for work it did not do. ${HOW}`,
    };
  }
  return allow();
}

/** What the hook prints: JSON to refuse, nothing to let the edit through (see the top of this file for why never `allow`). */
export function pretoolOutput(d: PretoolDecision): string | undefined {
  if (!d.deny) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
}
