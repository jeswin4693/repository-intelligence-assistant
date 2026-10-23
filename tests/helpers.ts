import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ria-test-"));
  writeFiles(dir, files);
  return dir;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=ria-test", "-c", "user.email=ria@test.invalid", "-c", "commit.gpgsign=false", "-c", "core.longpaths=true", ...args],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function gitInit(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
}

export function commit(dir: string, message: string, files: Record<string, string> = {}): void {
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
