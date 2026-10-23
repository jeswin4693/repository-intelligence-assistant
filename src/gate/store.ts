import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureRiaDir, riaDir } from "../repo/ria-dir";
import { dropRef } from "./snapshot";
import { RunState } from "./types";

/** Older runs are dropped when a new one starts, along with their snapshot refs. */
export const KEEP_RUNS = 5;

/** date-time to the millisecond, so ids sort in creation order even for runs started in the same second */
const ID_PATTERN = /^\d{8}-\d{9}-[0-9a-f]{4}$/;

export const gateRoot = (root: string) => path.join(riaDir(root), "gate");
export const runDir = (root: string, id: string) => path.join(gateRoot(root), id);
export const refFor = (id: string) => `refs/ria/gate/${id}`;

export function newId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}`;
  return `${date}-${time}-${crypto.randomBytes(2).toString("hex")}`;
}

export function listRunIds(root: string): string[] {
  try {
    return fs.readdirSync(gateRoot(root)).filter((n) => ID_PATTERN.test(n)).sort();
  } catch {
    return [];
  }
}

export function saveRun(root: string, run: RunState): void {
  ensureRiaDir(root);
  const dir = runDir(root, run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2));
}

/** `id` comes from tool input, so it is matched against the exact id format before it touches a path. */
export function loadRun(root: string, id?: string): RunState | undefined {
  const target = id ?? listRunIds(root).pop();
  if (!target || !ID_PATTERN.test(target)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(root, target), "run.json"), "utf8")) as RunState;
  } catch {
    return undefined;
  }
}

export function pruneRuns(root: string, keep: number): void {
  const ids = listRunIds(root);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    fs.rmSync(runDir(root, id), { recursive: true, force: true });
    dropRef(root, refFor(id));
  }
}
