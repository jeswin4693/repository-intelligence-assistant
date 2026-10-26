import { hookContext, routeTask } from "../tools/route";

/**
 * The Claude Code `UserPromptSubmit` hook: it runs on every request the user types, and the JSON it prints is added to
 * what the chat sees alongside that request. Here it says which RIA role the request calls for, and the role's short
 * brief, so the chat changes role from the wording of the request without being asked.
 *
 * It looks at the text only: no index, nothing written into the repository, and it answers in a few milliseconds
 * (Claude Code gives a prompt hook 30 seconds). It never blocks a request. For a follow-up that is not a new task
 * ("yes", "continue", "commit this") it prints nothing, so the chat keeps the role it has.
 *
 * It must only route what a person typed. Claude Code also runs the hook for messages it delivers itself, such as the
 * `<task-notification>` that reports a finished subagent, and a report full of "fixed" and "extracts" is not a request.
 */

/** Messages Claude Code puts into the conversation itself, wrapped in a tag; never a request from the user. */
const DELIVERED_BY_CLAUDE_CODE = /^\s*<(?:task-notification|system-reminder|local-command-[a-z]+|command-(?:name|message|args)|bash-(?:input|stdout|stderr))\b/;

/** The editor adds what is open or selected in front of the typed text, as `<ide_opened_file>...</ide_opened_file>`. */
const EDITOR_CONTEXT = /<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g;

/**
 * The text the user submitted, from the hook's stdin; empty when there is none, so a broken input adds nothing.
 * Also empty for a prompt that comes from a subagent (newer Claude Code versions say so with `agent_id`).
 */
export function parsePromptInput(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return "";
    const input = v as { prompt?: unknown; agent_id?: unknown; agent_type?: unknown };
    if (input.agent_id || input.agent_type) return "";
    return typeof input.prompt === "string" ? input.prompt : "";
  } catch {
    return "";
  }
}

/** What to print on stdout, or undefined to print nothing. */
export function promptHookOutput(prompt: string): string | undefined {
  if (DELIVERED_BY_CLAUDE_CODE.test(prompt)) return undefined;
  const typed = prompt.replace(EDITOR_CONTEXT, "").trim();
  if (!typed) return undefined;
  const context = hookContext(routeTask(typed));
  if (!context) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
}
