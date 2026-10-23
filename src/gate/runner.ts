import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Called every few seconds while the command runs, to keep the caller's request alive. */
  onHeartbeat?: () => void;
  /** Most output kept; the tail is kept because failures usually end up there. */
  maxOutputBytes?: number;
}

export interface RawRun {
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the command could not be started at all. */
  error?: string;
  durationMs: number;
  output: string;
  truncated: boolean;
}

const HEARTBEAT_MS = 10_000;
const DEFAULT_MAX_OUTPUT = 2_000_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already exited
  }
}

/**
 * Runs a shell command and waits for it. The environment is set up so test
 * runners behave non-interactively (no watch mode, no colours), and variables
 * that would make a nested `node --test` think it is a child worker are removed.
 */
export function runCommand(command: string, opts: RunOptions): Promise<RawRun> {
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.NODE_TEST_CONTEXT;

  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > max) {
        output = output.slice(output.length - max);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    const heartbeat = opts.onHeartbeat ? setInterval(opts.onHeartbeat, HEARTBEAT_MS) : undefined;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      resolve({ exitCode, timedOut, error, durationMs: Date.now() - started, output: stripAnsi(output), truncated });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}
