import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_DESCRIPTION, NOT_ONE_LINE, Provenance } from "./scaffold";
import { sanitize } from "./sanitize";
import { SkillError, SourceRecord, draftPath, loadRecheck, loadSource, sha256 } from "./store";

/**
 * `skill_test`: static checks on a draft skill. Nothing from the draft is run.
 *
 * A draft is written by a chat, so it can hold anything: a front matter with extra keys (`allowed-tools`), text that
 * tells the next reader what to do, a provenance that no longer matches RIA's record of the fetches. These checks look for
 * those, in files only. They do not run commands the draft declares, because a command that the chat wrote and RIA
 * executes is exactly what the gate's rule forbids (a tool caller picks, it never supplies a command), and a process
 * sandbox on Windows is weak. A pass is not proof that a skill is safe: it tells a person where not to worry, and the
 * person who approves is still the boundary.
 */

/** RIA writes at most about 20 KB of body, so a larger file was edited by someone else. */
const MAX_SKILL_FILE = 64 * 1024;
const MAX_LISTED = 20;
const DRAFT_FILES = new Set(["SKILL.md", "provenance.json"]);

export interface CheckFinding {
  level: "fail" | "note";
  text: string;
}

export interface FlagSummary {
  kind: string;
  severity: string;
  where: string;
  count: number;
}

export interface SourceSummary {
  id: string;
  url: string;
  flags: FlagSummary[];
}

export interface SkillCheck {
  name: string;
  /** Repository-relative, with forward slashes. */
  dir: string;
  verdict: "pass" | "pass with notes" | "fail";
  findings: CheckFinding[];
  /** The SKILL.md that was checked, as read, so that approval shows and installs exactly this text. Null when it could not be read. */
  skill: string | null;
  skillSha256: string | null;
  sources: SourceSummary[];
  /** Every high-severity flag on a source: what a person must look at before approving. */
  highFlags: { id: string; kind: string; where: string; count: number }[];
  /** The report, without its closing line: the tools add their own next step. */
  text: string;
  /** What to do next, as one line. */
  next: string;
}

/** Why the first lines are not the three RIA writes, or undefined when they are. */
function frontMatterProblem(skill: string, name: string): string | undefined {
  const lines = skill.split(/\r?\n/);
  if (lines[0] !== "---" || lines[3] !== "---") return "the front matter is not the three lines RIA writes (name, description, between two --- lines), so it may carry other keys such as allowed-tools";
  if (lines[1] !== `name: ${name}`) return `the name line is not "name: ${name}"`;
  const m = /^description: (".*")$/.exec(lines[2]);
  if (!m) return "the description line is not one quoted string";
  let description: unknown;
  try {
    description = JSON.parse(m[1]);
  } catch {
    return "the description line is not a valid quoted string";
  }
  if (typeof description !== "string" || !description.trim() || description.length > MAX_DESCRIPTION || NOT_ONE_LINE.test(description)) return `the description is not one line of 1 to ${MAX_DESCRIPTION} characters`;
  return undefined;
}

export function parseProvenance(file: string, name: string): { provenance?: Provenance; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { problem: "provenance.json is missing or cannot be read" };
  }
  const p = raw as Partial<Provenance> | null;
  if (!p || typeof p !== "object" || p.schema !== 1 || p.name !== name || !Array.isArray(p.sources) || p.sources.some((s) => !s || typeof s.id !== "string" || !Array.isArray(s.flags))) {
    return { problem: `provenance.json is not the record RIA writes for "${name}"` };
  }
  return { provenance: p as Provenance };
}

const flagKey = (f: FlagSummary): string => `${f.kind}|${f.severity}|${f.where}|${f.count}`;

/** Compares the provenance entry of one source with RIA's own record of the fetch, and says what differs. */
function disagreement(entry: Provenance["sources"][number], record: SourceRecord): string[] {
  const out: string[] = [];
  if (entry.url !== record.url) out.push("url");
  if (entry.sha256 !== record.sha256) out.push("sha256");
  if (entry.textSha256 !== record.textSha256) out.push("textSha256");
  if ([...entry.flags].map(flagKey).sort().join("\n") !== [...record.flags].map(flagKey).sort().join("\n")) out.push("flags");
  return out;
}

function flagLine(f: FlagSummary): string {
  return `${f.severity.toUpperCase()}: ${f.kind} (${f.where}${f.count > 1 ? `, ${f.count} times` : ""})`;
}

export function skillTest(root: string, nameInput: string): SkillCheck {
  const dir = draftPath(root, nameInput);
  const name = path.basename(dir);
  const rel = path.relative(root, dir).replace(/\\/g, "/");
  const findings: CheckFinding[] = [];
  const fail = (text: string): void => void findings.push({ level: "fail", text });
  const note = (text: string): void => void findings.push({ level: "note", text });

  // SKILL.md: read once, and everything after works on this text
  let skill: string | null = null;
  const skillFile = path.join(dir, "SKILL.md");
  try {
    const stat = fs.statSync(skillFile);
    if (!stat.isFile()) fail("SKILL.md is not a file");
    else if (stat.size > MAX_SKILL_FILE) fail(`SKILL.md is ${stat.size} bytes, over the ${MAX_SKILL_FILE} that a draft made by RIA can reach: it was edited or replaced`);
    else skill = fs.readFileSync(skillFile, "utf8");
  } catch {
    fail("SKILL.md is missing");
  }
  const skillSha256 = skill === null ? null : sha256(skill);

  const { provenance, problem } = parseProvenance(path.join(dir, "provenance.json"), name);
  if (problem) fail(problem);
  if (provenance?.approval) note(`already approved: ${provenance.approval.installedTo} (see "ria skill status")`);

  if (skill !== null) {
    const fm = frontMatterProblem(skill, name);
    if (fm) fail(`SKILL.md: ${fm}`);
    if (provenance && provenance.skillSha256 !== skillSha256 && !provenance.approval) note("SKILL.md was edited after it was scaffolded; approval is pinned to the text as it is now");

    const scanned = sanitize(skill, "text/markdown");
    for (const f of scanned.flags) {
      // text nobody can see is what a person cannot review, so it blocks; visible text is the person's to judge
      if (f.where === "hidden" && f.severity === "high") fail(`SKILL.md has text a reader would not see: ${f.kind} (${f.count} time${f.count > 1 ? "s" : ""})`);
      else note(`SKILL.md text, ${flagLine(f)}: read the skill around it`);
    }
    if (scanned.invisibleChars > 0) note(`SKILL.md has ${scanned.invisibleChars} invisible character(s) that no reader sees`);
  }

  // sources: provenance.json against RIA's own record of each fetch
  const sources: SourceSummary[] = [];
  const highFlags: SkillCheck["highFlags"] = [];
  for (const entry of provenance?.sources ?? []) {
    let flags: FlagSummary[] = entry.flags;
    let record: SourceRecord | undefined;
    try {
      record = loadSource(root, entry.id);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      fail(`source ${entry.id}: ${e.message.startsWith("No fetched source") ? "RIA's record of the fetch is gone, so nothing vouches for what provenance.json says about it, flags included. Fetch the page again and scaffold the draft again" : e.message}`);
    }
    if (record) {
      const differs = disagreement(entry, record);
      if (differs.length) fail(`source ${entry.id}: provenance.json disagrees with RIA's record of the fetch (${differs.join(", ")}): one of them was edited`);
      flags = record.flags;
    }
    sources.push({ id: entry.id, url: entry.url, flags: flags.map((f) => ({ kind: f.kind, severity: f.severity, where: f.where, count: f.count })) });
    for (const f of flags) if (f.severity === "high") highFlags.push({ id: entry.id, kind: f.kind, where: f.where, count: f.count });
  }
  if (provenance && provenance.sources.length === 0) fail("the draft names no source: a skill learned from the web must say which pages it came from");

  // a page that changed after the skill was learned from it: only ids and states are taken from the stored re-check
  const rechecked = loadRecheck(root, name);
  for (const s of rechecked?.sources ?? []) {
    if (s.state === "changed" && sources.some((x) => x.id === s.id)) note(`source ${s.id} had changed when it was re-checked on ${rechecked?.checkedAt.slice(0, 10)}: the skill may be out of date (skill_recheck shows how)`);
  }

  const extra = fs.readdirSync(dir).filter((f) => !DRAFT_FILES.has(f));
  if (extra.length) note(`other files in the draft (${extra.length}): ${extra.slice(0, MAX_LISTED).join(", ")}${extra.length > MAX_LISTED ? ", ..." : ""}. RIA installs only SKILL.md and runs nothing`);

  const verdict: SkillCheck["verdict"] = findings.some((f) => f.level === "fail") ? "fail" : findings.length ? "pass with notes" : "pass";
  const out = [`Skill check for draft "${name}": ${verdict.toUpperCase()}`, `  ${rel}/SKILL.md sha256: ${skillSha256 ?? "(not read)"}`];
  for (const f of findings) out.push(`  ${f.level === "fail" ? "FAIL" : "note"}: ${f.text}`);
  if (sources.length) {
    out.push("", `Sources (${sources.length}):`);
    for (const s of sources) out.push(`  ${s.id} ${s.url}: ${s.flags.length ? s.flags.map(flagLine).join("; ") : "no flags"}`);
  }
  if (highFlags.length) out.push("", `${highFlags.length} high-severity flag(s) on the sources: read SKILL.md for anything that could have come from the flagged text.`);
  out.push("", "These are static checks of the files: nothing in the draft was run. A pass is not proof that the skill is safe, because the checks are patterns and a person has to read SKILL.md.");
  const next =
    verdict === "fail"
      ? "Next: fix what failed. A draft is never overwritten, so scaffold it again under another name, then check that one."
      : `Next: skill_register "${name}" to hand it to the user for approval.`;
  return { name, dir: rel, verdict, findings, skill, skillSha256, sources, highFlags, text: out.join("\n"), next };
}
