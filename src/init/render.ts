import { Role } from "./roles";

/** The MCP server name hosts show to the model; the config written by `ria init` registers it under this name. */
export const SERVER_NAME = "ria";

// A JSON string is also a valid YAML double-quoted scalar, so no YAML library is needed for the headers.
const q = (value: unknown) => JSON.stringify(value);

function body(role: Role): string {
  const limits = [
    "RIA works from imports, symbol names and git history by pattern matching, not a compiler. Treat its confidence notes as part of the answer.",
    ...(role.edits
      ? ["The gate runs only the project's own commands; you cannot add or change them.", "Do not call the change done until `gate_check` has run."]
      : ["This role does not edit files."]),
    ...(role.rules ?? []),
  ];
  return [
    `# ${role.title} (RIA role)`,
    "",
    role.description,
    "",
    `Use the RIA tools from the MCP server \`${SERVER_NAME}\`. If they are not available in this chat, say so and fall back to ordinary search. Do not pretend you used them.`,
    "",
    "## Steps",
    "",
    ...role.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Stop when",
    "",
    ...role.stop.map((s) => `- ${s}`),
    "",
    "## Report",
    "",
    ...role.report.map((s) => `- ${s}`),
    "",
    "## Limits",
    "",
    ...limits.map((s) => `- ${s}`),
    "",
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
