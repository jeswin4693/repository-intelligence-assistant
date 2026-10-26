import { Role } from "./roles";

/** The MCP server name hosts show to the model; the config written by `ria init` registers it under this name. */
export const SERVER_NAME = "ria";

// A JSON string is also a valid YAML double-quoted scalar, so no YAML library is needed for the headers.
const q = (value: unknown) => JSON.stringify(value);

/** How to spend few tokens and few calls; the same for every role, minus the tool a role does not have. */
function efficiency(role: Role): string[] {
  const batch = `\`impact\` takes up to 50 files in one call${role.tools.includes("plan_score") ? " and `plan_score` up to 8 plans" : ""}, and independent tool calls can go in the same turn.`;
  return [
    "One `context_for` call replaces many searches: give it the task in words and/or a target, and read only what it returns.",
    "Symbols carry line numbers: read a big file by range, not whole. A file shown as an outline is too big to read whole.",
    `Batch: ${batch}`,
    "Do not repeat a call whose answer you already have, and pass a smaller `max_tokens` when a quick look is enough.",
    "RIA matches names, not text: to find a string, a message or a literal, search the text yourself, then use RIA to place what you found.",
    "Quote evidence as `path:line`, and say which files you did not read.",
  ];
}

/** What to do when the next request is not the kind of task the role was started for. */
function switching(role: Role): string[] {
  return [
    "Your next request may be a different kind of task. Follow the role that fits it and say so in one line: something new (a file, a folder, a feature, a test) is the Writer; a bug, an error or a failing check is the Fixer; moving, splitting or renaming without changing behaviour is the Extractor; understanding or finding something is the Reader; judging size, risk or options is the Analyser; checking a diff or a pull request is the Reviewer; a whole task or several kinds at once is the Autopilot.",
    "If the RIA tool `start_task` is available, call it with the request to get the role and its steps. A short reply such as \"yes\" or \"continue\" keeps the current role.",
    ...(role.edits
      ? []
      : ["This role cannot edit. When the request needs a change, say which role fits and ask the user to switch to it (in Copilot Chat pick that agent; in Claude Code the skill is `ria-<role>`)."]),
  ];
}

/** Everything a role says about how to work, from its steps to its limits; the same text a skill, an agent and `start_task` carry. */
export function playbook(role: Role): string {
  const limits = [
    "RIA works from imports, symbol names and git history by pattern matching, not a compiler. Treat its confidence notes as part of the answer.",
    ...(role.edits
      ? ["The gate runs only the project's own commands; you cannot add or change them.", "Do not call a change done until `gate_check` has run."]
      : ["This role does not edit files."]),
    ...(role.rules ?? []),
  ];
  return [
    "## Steps",
    "",
    ...role.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    ...(role.ask
      ? [
          "## Ask the user",
          "",
          "Do everything else yourself without asking permission: reading files, calling RIA tools, choosing between files, editing inside the plan, running the gate and fixing what it reports. Stop and ask only when one of these is true:",
          "",
          ...role.ask.map((s) => `- ${s}`),
          "",
          "How to ask: one question at a time. Say what you found, offer two or three options with your recommendation first, and wait for the answer. Never ask something you can find out from the files or from RIA.",
          "",
        ]
      : []),
    "## Stop when",
    "",
    ...role.stop.map((s) => `- ${s}`),
    "",
    "## Report",
    "",
    ...role.report.map((s) => `- ${s}`),
    "",
    "## Work efficiently",
    "",
    ...efficiency(role).map((s) => `- ${s}`),
    "",
    "## When the task changes kind",
    "",
    ...switching(role).map((s) => `- ${s}`),
    "",
    "## Limits",
    "",
    ...limits.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

function body(role: Role): string {
  return [
    `# ${role.title} (RIA role)`,
    "",
    role.description,
    "",
    `Use the RIA tools from the MCP server \`${SERVER_NAME}\`. If they are not available in this chat, say so and fall back to ordinary search. Do not pretend you used them.`,
    "",
    playbook(role),
  ].join("\n");
}

export const claudeSkillPath = (role: Role) => `.claude/skills/ria-${role.id}/SKILL.md`;

/** A Claude Code skill. Tool permissions are left to the user's own settings. */
export function claudeSkill(role: Role): string {
  return ["---", `name: ${q(`ria-${role.id}`)}`, `description: ${q(role.description)}`, "---", "", body(role)].join("\n");
}

export const copilotAgentPath = (role: Role) => `.github/agents/ria-${role.id}.agent.md`;

/**
 * Built-in tools alongside the RIA ones: an agent whose list holds only MCP tools fails on some model backends
 * in VS Code. Names a given VS Code version does not know are ignored, so a role never breaks on them.
 */
const READ_ONLY_BUILTINS = ["read", "search"];
const EDITING_BUILTINS = ["read", "search", "edit", "execute"];

/** A VS Code custom agent. Its `tools` list is a real allow-list: read-only roles are given no edit tool. */
export function copilotAgent(role: Role): string {
  const tools = [...(role.edits ? EDITING_BUILTINS : READ_ONLY_BUILTINS), ...role.tools.map((t) => `${SERVER_NAME}/${t}`)];
  return ["---", `name: ${q(`RIA ${role.title}`)}`, `description: ${q(role.description)}`, `tools: ${q(tools)}`, "---", "", body(role)].join("\n");
}
