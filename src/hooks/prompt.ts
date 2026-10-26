import { hookContext, routeTask } from "../tools/route";

/**
 * The Claude Code `UserPromptSubmit` hook: it runs on every request the user types, and the JSON it prints is added to
 * what the chat sees alongside that request. Here it says which RIA role the request calls for, and the role's short
 * brief, so the chat changes role from the wording of the request without being asked.
 *
 * It looks at the text only: no index, nothing written into the repository, and it answers in a few milliseconds
 * (Claude Code gives a prompt hook 30 seconds). It never blocks a request. For a follow-up that is not a new task
 * ("yes", "continue", "commit this") it prints nothing, so the chat keeps the role it has.
 */

/** The text the user submitted, from the hook's stdin; empty when there is none, so a broken input adds nothing. */
export function parsePromptInput(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    const prompt = typeof v === "object" && v !== null ? (v as { prompt?: unknown }).prompt : undefined;
    return typeof prompt === "string" ? prompt : "";
  } catch {
    return "";
  }
}

/** What to print on stdout, or undefined to print nothing. */
export function promptHookOutput(prompt: string): string | undefined {
  if (!prompt.trim()) return undefined;
  const context = hookContext(routeTask(prompt));
  if (!context) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
}
