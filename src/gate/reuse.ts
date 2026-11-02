import { CommandSpec, GateConfig } from "./detect";
import { listRunIds, loadRun } from "./store";
import { CommandResult } from "./types";

/**
 * Reusing a result instead of running a command again.
 *
 * A result is a fact about the files it ran on. When `gate_begin` finds the working tree byte for byte as it was when a
 * command passed a short while ago (same git tree, same command text), the baseline can take that result and skip the
 * run. The usual case is the next task after one the gate already checked: the last `gate_check` ran the whole suite on
 * exactly the files the chat is about to start from.
 *
 * Only a full pass is reused: a failure is run again, and so is a result that covered only part of a suite (scope "tied").
 * A reused result can therefore only be a pass, which errs toward reporting a problem as new, not toward hiding one. The
 * tree does not hold what lives outside it (installed packages, the toolchain, services the tests call), so a result
 * expires after `DEFAULT_REUSE_MINUTES`, can be switched off in `ria.config.json` (`gate.reuseMinutes`: 0), and
 * `gate_begin` can be told to run everything (`fresh`). Whatever was reused is named in the report.
 */

export const DEFAULT_REUSE_MINUTES = 30;
export const MAX_REUSE_MINUTES = 24 * 60;

/** A clock that is a little off must not discard a result, but a record from the future is not believed. */
const CLOCK_SLACK_MS = 60_000;
const TREE = /^[0-9a-f]{40,64}$/;

export interface Reusable {
  /** The result as the new run records it: the old result with `reused` set. */
  result: CommandResult;
  /** When the command really ran. */
  at: string;
}

export function reuseWindowMs(config: GateConfig): number {
  const minutes = config.reuseMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0) return Math.min(minutes, MAX_REUSE_MINUTES) * 60_000;
  return DEFAULT_REUSE_MINUTES * 60_000;
}

const instant = (iso: unknown): number | undefined => {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/**
 * For each spec, the newest result of the same command that passed in full on `tree` within the window. The records
 * are files under `.ria/` that anything with write access could edit, so each field is checked before it is trusted.
 */
export function findReusable(root: string, specs: CommandSpec[], tree: string, windowMs: number, now = Date.now()): Map<string, Reusable> {
  const found = new Map<string, Reusable>();
  if (windowMs <= 0 || specs.length === 0 || !TREE.test(tree)) return found;

  for (const id of listRunIds(root).reverse()) {
    const run = loadRun(root, id);
    if (!run) continue;
    const sources = [
      { ranOn: run.ranOn, at: run.createdAt, results: run.baselineResults },
      { ranOn: run.lastCheck?.ranOn, at: run.lastCheck?.at, results: run.lastCheck?.results },
    ];
    for (const source of sources) {
      if (source.ranOn !== tree || !Array.isArray(source.results)) continue;
      for (const spec of specs) {
        const r = source.results.find((x) => x?.name === spec.name);
        if (!r || r.command !== spec.command || r.status !== "pass" || r.partial) continue;
        // a result that was itself reused keeps the time it really ran, so reusing it again never stretches the window
        const at = instant(r.reused?.at ?? source.at);
        if (at === undefined || at > now + CLOCK_SLACK_MS || now - at > windowMs) continue;
        const known = found.get(spec.name);
        if (known && Date.parse(known.at) >= at) continue;
        const iso = new Date(at).toISOString();
        found.set(spec.name, { at: iso, result: { ...r, logFile: undefined, reused: { run: id, at: iso } } });
      }
    }
  }
  return found;
}

export function agoText(ms: number): string {
  if (ms < 60_000) return "less than a minute ago";
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}
