import * as fs from "node:fs";
import * as path from "node:path";

export const riaDir = (root: string) => path.join(root, ".ria");

/**
 * Creates `.ria/` with a catch-all .gitignore, so RIA's files never show up in
 * `git status` or get captured by a snapshot, even in repos that do not ignore it.
 */
export function ensureRiaDir(root: string): string {
  const dir = riaDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  return dir;
}
