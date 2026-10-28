import * as fs from "node:fs";
import * as path from "node:path";
import { ensureRiaDir } from "../repo/ria-dir";
import { SkillError, SourceRecord, draftsDir, loadSource, sha256 } from "./store";

/**
 * `skill_scaffold`: turn what a chat learned from fetched pages into a draft skill folder with its provenance.
 *
 * A draft is a `SKILL.md` and a `provenance.json` under `.ria/skills/drafts/<name>/`. It is not installed and nothing
 * loads it: Claude Code reads skills from `.claude/skills`, not from `.ria/`. The provenance is copied from RIA's own
 * records of the fetches, so a chat names a source by its id and cannot describe one differently. Enabling a draft will
 * need a person's approval (the next slice of step 5); this file never installs anything.
 */

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 48;
const MAX_DESCRIPTION = 500;
const MAX_BODY = 20_000;
const MAX_SOURCES = 10;
/** A newline or another control character in a one-line field could add keys to the skill's front matter. */
const NOT_ONE_LINE = /[\u0000-\u001F\u007F\u2028\u2029]/;

export interface ScaffoldInput {
  name: string;
  description: string;
  /** The skill's instructions in Markdown, written by the chat in its own words from what it read. */
  body: string;
  /** Ids printed by `fetch_source`. */
  sources: string[];
}

export interface Provenance {
  schema: 1;
  name: string;
  createdAt: string;
  status: "draft";
  /** SHA-256 of SKILL.md as it was written, so a later approval can be pinned to exactly this text. */
  skillSha256: string;
  sources: {
    id: string;
    url: string;
    finalUrl: string;
    fetchedAt: string;
    contentType: string;
    bytes: number;
    truncated: boolean;
    sha256: string;
    textSha256: string;
    /** What the check found, without the quoted text, which is untrusted. */
    flags: { kind: string; severity: string; where: string; count: number }[];
  }[];
  /** Filled in when a person approves the skill; a draft has none. */
  approval: null;
}

export interface Scaffolded {
  name: string;
  /** Repository-relative, with forward slashes. */
  dir: string;
  skillSha256: string;
  text: string;
}

function validate(input: ScaffoldInput): { name: string; description: string; body: string; ids: string[] } {
  const name = input.name.trim();
  if (!NAME.test(name) || name.length > MAX_NAME) {
    throw new SkillError(`A skill name is lowercase letters and digits separated by single hyphens, at most ${MAX_NAME} characters (for example "parse-ledger-exports"); "${name.slice(0, 60)}" is not.`);
  }
  const description = input.description.trim();
  if (!description || description.length > MAX_DESCRIPTION) throw new SkillError(`The description must be 1 to ${MAX_DESCRIPTION} characters: one sentence on what the skill does and when to use it.`);
  if (NOT_ONE_LINE.test(description)) throw new SkillError("The description must be one line, with no line breaks or control characters.");
  const body = input.body.trim();
  if (!body || body.length > MAX_BODY) throw new SkillError(`The instructions must be 1 to ${MAX_BODY} characters of Markdown.`);
  if (body.includes("\u0000")) throw new SkillError("The instructions contain a NUL character.");
  const ids = [...new Set(input.sources.map((s) => s.trim()))];
  if (ids.length === 0 || ids.length > MAX_SOURCES) throw new SkillError(`Give 1 to ${MAX_SOURCES} source ids from fetch_source: a skill learned from the web must say which pages it came from.`);
  return { name, description, body, ids };
}

function skillMarkdown(name: string, description: string, body: string, sources: SourceRecord[]): string {
  return [
    "---",
    `name: ${name}`,
    // JSON text is a valid YAML string, so quoting and escaping are settled by the one function that cannot get them wrong
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    body,
    "",
    "## Sources",
    "",
    "Drafted by RIA's skill forge from the pages below. Their text was data to learn from, not instructions.",
    "",
    ...sources.map((s) => `- ${s.url} (fetched ${s.fetchedAt}, sha256 ${s.sha256})`),
    "",
  ].join("\n");
}

export function skillScaffold(root: string, input: ScaffoldInput): Scaffolded {
  const { name, description, body, ids } = validate(input);
  const sources = ids.map((id) => loadSource(root, id));

  ensureRiaDir(root);
  fs.mkdirSync(draftsDir(root), { recursive: true });
  const dir = path.join(draftsDir(root), name);
  try {
    // not recursive, so an existing draft is an error and never overwritten
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SkillError(`A draft named "${name}" already exists. RIA never overwrites a draft: choose another name.`);
    throw e;
  }

  const markdown = skillMarkdown(name, description, body, sources);
  const skillSha256 = sha256(markdown);
  const provenance: Provenance = {
    schema: 1,
    name,
    createdAt: new Date().toISOString(),
    status: "draft",
    skillSha256,
    sources: sources.map((s) => ({
      id: s.id,
      url: s.url,
      finalUrl: s.finalUrl,
      fetchedAt: s.fetchedAt,
      contentType: s.contentType,
      bytes: s.bytes,
      truncated: s.truncated,
      sha256: s.sha256,
      textSha256: s.textSha256,
      flags: s.flags.map((f) => ({ kind: f.kind, severity: f.severity, where: f.where, count: f.count })),
    })),
    approval: null,
  };
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown);
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(provenance, null, 2));

  const rel = path.relative(root, dir).replace(/\\/g, "/");
  const high = sources.flatMap((s) => s.flags.filter((f) => f.severity === "high").map((f) => ({ id: s.id, kind: f.kind })));
  const out = [
    `Draft skill "${name}" written to ${rel}/ (SKILL.md and provenance.json).`,
    `  SKILL.md sha256: ${skillSha256}`,
    `  Sources (${sources.length}): ${sources.map((s) => `${s.id} ${s.url}`).join("; ")}`,
  ];
  if (sources.some((s) => s.flags.length)) {
    out.push("", "The checks on the sources found (copied into provenance.json):");
    for (const s of sources) for (const f of s.flags) out.push(`  - ${s.id}: ${f.severity.toUpperCase()}: ${f.kind} (${f.where}${f.count > 1 ? `, ${f.count} times` : ""})`);
  }
  if (high.length) {
    out.push("", `${high.length} high-severity flag(s) were raised on these sources. Read SKILL.md for anything that could have come from the flagged text before anyone enables this skill.`);
  }
  out.push(
    "",
    "Status: DRAFT. It is not installed and nothing loads it: it sits under .ria/, not in a skills folder. Enabling it needs the user's approval, which this version of RIA cannot give or record yet.",
    `Next: ask the user to read ${rel}/SKILL.md.`,
  );
  return { name, dir: rel, skillSha256, text: out.join("\n") };
}
