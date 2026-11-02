import * as fs from "node:fs";
import * as path from "node:path";
import { SkillCheck, skillTest } from "./check";
import { Approval, Provenance } from "./scaffold";
import { SkillError, draftPath, draftsDir, sha256 } from "./store";

/**
 * `skill_register`: handing a checked draft to a person, and installing it only on that person's approval.
 *
 * Two halves with a wall between them. `reviewSkill` reads, writes nothing, and is what the MCP tool and
 * `ria skill register` return: the check, where the skill would go, and the command the person runs. `approveSkill` is the
 * only code that writes into a skills folder. It is called from the command line only (`ria skill approve`), and it needs a
 * `confirm` function that returns what the person typed. Nothing in the MCP server, a tool argument, the environment or a
 * config file can reach it or supply that answer: the command line asks at an interactive terminal, which a chat's shell
 * does not have. The tests pass their own `confirm`, as a code parameter that nothing outside the process can set.
 *
 * What is pinned is the exact text the person was shown: it is read once, shown, and that same text is written, so the draft
 * cannot change between the person reading it and the install.
 */

export type SkillHost = "claude" | "copilot";

/** Where each host loads a project skill from: `<dir>/<name>/SKILL.md`. Claude Code reads `.claude/skills`; VS Code's Copilot reads `.github/skills`. */
const HOST_DIRS: Record<SkillHost, string> = { claude: ".claude/skills", copilot: ".github/skills" };

export function parseHost(value: string | undefined): SkillHost {
  if (value === undefined || value === "claude") return "claude";
  if (value === "copilot") return "copilot";
  throw new SkillError(`A skill is installed for claude or copilot, not "${value.slice(0, 40)}".`);
}

export type TargetState =
  /** Nothing there yet. */
  | { kind: "new" }
  /** The same text is already installed, by an approval. */
  | { kind: "same" }
  /** A skill RIA installed and nobody edited: a re-approved draft may replace it. */
  | { kind: "replace" }
  /** Something else is there, or the path leads outside the repository: RIA will not write. */
  | { kind: "blocked"; reason: string };

export interface Review {
  check: SkillCheck;
  host: SkillHost;
  /** Repository-relative, with forward slashes. */
  target: string;
  state: TargetState;
  /** What the person types to approve: it names the skill and the first digits of the text's hash. */
  phrase: string;
  approvable: boolean;
  /** What was checked and where the skill would go: the part of `text` a person also reads. */
  summary: string;
  /** For a chat: the summary and how a person approves. Never the confirmation phrase. */
  text: string;
}

export interface Approved {
  name: string;
  host: SkillHost;
  installedTo: string;
  skillSha256: string;
  /** False when the same text was already installed and nothing was written. */
  wrote: boolean;
  text: string;
}

function readProvenance(dir: string): Provenance | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8")) as Provenance;
  } catch {
    return undefined;
  }
}

/** Whether `dir` (which may not exist yet) is really inside the repository once links are followed. */
function insideRoot(root: string, dir: string): boolean {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(probe));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const targetFile = (root: string, host: SkillHost, name: string): string => path.join(root, ...HOST_DIRS[host].split("/"), name, "SKILL.md");

function targetState(root: string, host: SkillHost, name: string, skillSha256: string, provenance: Provenance | undefined): TargetState {
  // one approval is recorded per draft, so a second host would overwrite the pin of the first
  if (provenance?.approval && provenance.approval.host !== host) return { kind: "blocked", reason: `this draft was already approved for ${provenance.approval.host}, and one host is recorded per draft: scaffold it again under another name for ${host}` };
  const file = targetFile(root, host, name);
  const folder = path.dirname(file);
  if (!insideRoot(root, folder)) return { kind: "blocked", reason: `${HOST_DIRS[host]} leads outside the repository (a link or a junction), so RIA will not write there` };
  if (!fs.existsSync(folder)) return { kind: "new" };
  const rel = path.relative(root, file).replace(/\\/g, "/");
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { kind: "blocked", reason: `${path.relative(root, folder).replace(/\\/g, "/")} already exists and has no SKILL.md: RIA writes only into a folder it made` };
  }
  if (!stat.isFile()) return { kind: "blocked", reason: `${rel} is not a plain file` };
  const have = sha256(fs.readFileSync(file, "utf8"));
  const a = provenance?.approval;
  if (a && a.host === host && a.installedTo === rel && a.skillSha256 === have) return have === skillSha256 ? { kind: "same" } : { kind: "replace" };
  return { kind: "blocked", reason: `${rel} already exists and RIA did not install it (or it was edited since). RIA replaces only a skill it installed itself and nobody edited: remove it, or choose another name` };
}

function command(root: string, name: string, host: SkillHost): string {
  return `ria skill approve ${name} --host ${host} --root "${root}"`;
}

/** The check, where the skill would go and how a person approves it. Writes nothing. */
export function reviewSkill(root: string, nameInput: string, host: SkillHost = "claude"): Review {
  const check = skillTest(root, nameInput);
  const target = path.relative(root, targetFile(root, host, check.name)).replace(/\\/g, "/");
  const provenance = readProvenance(draftPath(root, check.name));
  const state: TargetState = check.skillSha256 === null ? { kind: "blocked", reason: "SKILL.md could not be read" } : targetState(root, host, check.name, check.skillSha256, provenance);
  const approvable = check.verdict !== "fail" && state.kind !== "blocked";
  const phrase = `approve ${check.name}@${(check.skillSha256 ?? "").slice(0, 8)}`;

  const where =
    state.kind === "new" ? "a new file" : state.kind === "same" ? "already installed with this exact text" : state.kind === "replace" ? "it would replace the copy RIA installed earlier" : `BLOCKED: ${state.reason}`;
  const summary = [`Registration request for draft "${check.name}" (host: ${host})`, "", check.text, "", `Would install: ${target} (${where})`].join("\n");
  const out = [summary, ""];
  if (check.verdict === "fail") out.push("Not ready: the check failed, so the user cannot approve it yet.");
  else if (state.kind === "blocked") out.push("Not ready: see BLOCKED above.");
  else if (state.kind === "same") out.push("Nothing to do: this text is already installed.");
  else {
    out.push(
      "Nothing was installed, and this tool cannot install anything: approval is the user's.",
      `Tell the user to run this in a terminal of their own:  ${command(root, check.name, host)}`,
      "(`node <RIA folder>/dist/index.js` stands in for `ria` when it is not on the PATH.) It shows them the whole SKILL.md and every high flag on the sources, and installs only after they type the confirmation themselves. It refuses to run without an interactive terminal.",
      "Do not install the skill any other way: do not copy it into a skills folder and do not run that command through a shell.",
    );
  }
  return { check, host, target, state, phrase, approvable, summary, text: out.join("\n") };
}

/** What the person at the terminal reads before typing the approval: everything a chat would have summarised. */
export function formatForPerson(review: Review): string {
  const c = review.check;
  const out = [review.summary, ""];
  if (c.highFlags.length) {
    out.push("HIGH-SEVERITY FLAGS on the pages this skill was learned from. Read the skill for anything that could have come from them:");
    for (const f of c.highFlags) out.push(`  - ${f.id}: ${f.kind} (${f.where}${f.count > 1 ? `, ${f.count} times` : ""})`);
    out.push("");
  }
  const skill = c.skill ?? "";
  out.push(`----- ${c.dir}/SKILL.md (the whole file, ${skill.length} characters; this exact text is what will be installed) -----`, skill.replace(/\s+$/, ""), "----- end of SKILL.md -----");
  return out.join("\n");
}

/**
 * Installs a checked draft after a person approved it. `confirm` receives the review and must return what the person typed:
 * the approval is that string being exactly `review.phrase`. It is a required parameter with no default.
 */
export async function approveSkill(
  root: string,
  nameInput: string,
  options: { host?: SkillHost; confirm: (review: Review) => Promise<string> | string },
): Promise<Approved> {
  const host = options.host ?? "claude";
  const review = reviewSkill(root, nameInput, host);
  const { check, target, state } = review;
  if (check.verdict === "fail") throw new SkillError(`Not approvable: the check failed. Nothing was installed.\n${check.findings.filter((f) => f.level === "fail").map((f) => `  FAIL: ${f.text}`).join("\n")}`);
  if (state.kind === "blocked") throw new SkillError(`Not approvable: ${state.reason}. Nothing was installed.`);
  // the text the person is shown is the text that is written
  const skill = check.skill as string;
  const skillSha256 = check.skillSha256 as string;
  if (state.kind === "same") return { name: check.name, host, installedTo: target, skillSha256, wrote: false, text: `"${check.name}" is already installed at ${target} with exactly this text. Nothing was written.` };

  const typed = await options.confirm(review);
  if (typeof typed !== "string" || typed.trim() !== review.phrase) throw new SkillError("Not approved: the confirmation did not match. Nothing was installed.");

  const file = targetFile(root, host, check.name);
  // the answer took a while: look again at where it is going before writing
  const again = targetState(root, host, check.name, skillSha256, readProvenance(draftPath(root, check.name)));
  if (again.kind === "blocked") throw new SkillError(`Not installed: ${again.reason}.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, skill);
  if (sha256(fs.readFileSync(file, "utf8")) !== skillSha256) throw new SkillError(`${target} does not read back as the approved text. Remove it and try again.`);

  const dir = draftPath(root, check.name);
  const provenance = readProvenance(dir) as Provenance;
  const approval: Approval = { approvedAt: new Date().toISOString(), host, installedTo: target, skillSha256 };
  provenance.status = "approved";
  provenance.approval = approval;
  fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify(provenance, null, 2));

  const text = [
    `Installed "${check.name}" for ${host}: ${target}`,
    `  Pinned to SKILL.md sha256 ${skillSha256}; "ria skill status" says when the installed file stops matching it.`,
    "  It is a new file in your working tree: commit it if you want to share the skill, delete the folder to remove it.",
    `  Sources it was learned from: ${check.sources.map((s) => s.url).join(", ")}. If a page changes, read the skill again.`,
  ].join("\n");
  return { name: check.name, host, installedTo: target, skillSha256, wrote: true, text };
}

/** Each draft and whether it was approved, and whether the installed file is still the approved text. Read-only. */
export function skillStatus(root: string): string {
  const dir = draftsDir(root);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  if (names.length === 0) return "No draft skills under .ria/skills/drafts/.";
  const out = [`Skills under .ria/skills/drafts/ (${names.length}):`];
  for (const name of names) {
    const p = readProvenance(path.join(dir, name));
    if (!p) {
      out.push(`  ${name}: UNREADABLE (provenance.json is missing or broken)`);
      continue;
    }
    const a = p.approval;
    if (!a) {
      out.push(`  ${name}: draft, not installed`);
      continue;
    }
    const file = path.join(root, ...a.installedTo.split("/"));
    let state: string;
    if (!fs.existsSync(file)) state = "the installed file is MISSING";
    else state = sha256(fs.readFileSync(file, "utf8")) === a.skillSha256 ? "intact: the installed file is the approved text" : "CHANGED after approval: the installed file is no longer the approved text, so read it again";
    out.push(`  ${name}: approved ${a.approvedAt.slice(0, 10)} for ${a.host}, ${a.installedTo}: ${state}`);
  }
  return out.join("\n");
}
