import * as fs from "node:fs";
import * as path from "node:path";
import { gateCheck } from "../gate/gate";
import { loadRun, runDir } from "../gate/store";
import { RepoIndex } from "../repo/repo-index";

/**
 * The Claude Code `Stop` hook: it keeps the chat from finishing while the change gate says its change made
 * things worse. Claude Code runs it when the chat is about to stop and sends JSON on stdin; printing
 * `{"decision":"block","reason":"..."}` on stdout keeps the chat working and hands it the reason.
 * (The JSON form, not exit code 2: Claude Code treats an exit-2 block whose stderr mentions a missing file as
 * a plain error, and a gate report can quote exactly that from a failing test.)
 *
 * It only enforces a gate run the chat started itself with `gate_begin`. With no run, or a stale one, it lets
 * the chat finish and writes nothing into the repository.
 */

export interface StopInput {
  /** True when Claude Code is already continuing because a stop hook blocked the previous stop. */
  stopHookActive: boolean;
}

/** Reads the hook's stdin leniently: a hook that cannot parse its input must still let the chat finish. */
export function parseStopInput(raw: string): StopInput {
  try {
    const v: unknown = JSON.parse(raw);
    return { stopHookActive: typeof v === "object" && v !== null && (v as { stop_hook_active?: unknown }).stop_hook_active === true };
  } catch {
    return { stopHookActive: false };
  }
}

/** After this many stops in a row, the chat is let go: it has been told twice, which is the Autopilot's limit on fix attempts. */
export const DEFAULT_MAX_BLOCKS = 2;
/** A baseline older than this is probably another task's, and would blame the chat for work it did not do. */
export const DEFAULT_MAX_AGE_HOURS = 12;
const REASON_LIMIT = 6000;

export interface StopOptions {
  maxBlocks?: number;
  maxAgeHours?: number;
  now?: Date;
  /** Replaced in tests; the real one re-runs the baseline's commands. */
  check?: (root: string, id: string) => Promise<{ text: string; verdict: string }>;
}

export interface StopDecision {
  block: boolean;
  /** For the chat; present only when blocking. */
  reason?: string;
  /** For the person: why the chat was let go, or nothing. Claude Code does not show it to the chat. */
  note?: string;
}

const allow = (note?: string): StopDecision => ({ block: false, note });

const stateFile = (root: string, id: string) => path.join(runDir(root, id), "stop-hook.json");

function readBlocks(root: string, id: string): number {
  try {
    const n = (JSON.parse(fs.readFileSync(stateFile(root, id), "utf8")) as { blocks?: unknown }).blocks;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeBlocks(root: string, id: string, blocks: number): void {
  try {
    fs.writeFileSync(stateFile(root, id), JSON.stringify({ blocks }));
  } catch {
    // Claude Code's own cap on consecutive stop-hook continuations is the backstop
  }
}

// No progress callback: whatever is printed while it runs would end up in the chat's instructions.
async function realCheck(root: string, id: string): Promise<{ text: string; verdict: string }> {
  const index = new RepoIndex(root);
  index.refresh();
  return gateCheck({ index }, { id });
}

export async function decideStop(root: string, input: StopInput, opts: StopOptions = {}): Promise<StopDecision> {
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;

  // reads only .ria/gate: with no run, nothing is indexed or written
  const run = loadRun(root);
  if (!run) return allow();
  const ageMs = (opts.now ?? new Date()).getTime() - Date.parse(run.createdAt);
  if (!(ageMs <= maxAgeHours * 3_600_000)) {
    return allow(`ria: gate run ${run.id} is older than ${maxAgeHours} hours, so it is not enforced`);
  }

  // consecutive stops: a fresh stop (not caused by this hook) starts the count again
  const before = input.stopHookActive ? readBlocks(root, run.id) : 0;
  if (before >= maxBlocks) {
    return allow(`ria: the gate still reports a problem for run ${run.id}; the chat was held back ${before} times for it and is let go`);
  }

  const result = await (opts.check ?? realCheck)(root, run.id);
  if (result.verdict !== "regressed" && result.verdict !== "mixed") {
    writeBlocks(root, run.id, 0);
    return allow();
  }

  const blocks = before + 1;
  writeBlocks(root, run.id, blocks);
  const report = result.text.length > REASON_LIMIT ? `${result.text.slice(0, REASON_LIMIT)}\n... (cut; call gate_check for the whole report)` : result.text;
  const last =
    blocks >= maxBlocks
      ? "This is the last time the gate holds you back for this run. If it is still not fixed, stop and tell the user plainly what is wrong, and show the rollback preview (gate_rollback without apply)."
      : "Fix the problems above and call gate_check again, or call gate_rollback without apply to preview the undo and ask the user.";
  return {
    block: true,
    reason: `Do not finish yet: the change gate (run ${run.id}) says this change made things worse. Held back ${blocks} of ${maxBlocks}.\n\n${report}\n\n${last}`,
  };
}
