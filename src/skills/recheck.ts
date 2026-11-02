import * as path from "node:path";
import { parseProvenance } from "./check";
import { FetchOptions, fetchSource } from "./fetch-source";
import { SkillError, SourceRecheck, SourceRecord, draftPath, loadSource, saveRecheck } from "./store";

/**
 * `skill_recheck`: fetch again each page a skill was learned from and say whether it changed since.
 *
 * An approval pins the text of the skill, not the pages it came from, so a page that changes later (a tutorial that now
 * tells readers to run something else) would go unnoticed. This looks. It fetches only the addresses in RIA's own checksummed
 * records of the first fetches, never one a caller names, through the same `fetchSource` and so the same public-address
 * rules. It compares with those records, not with `provenance.json`. It shows no page text, changes no skill and installs
 * nothing: a changed page means a person should read the new version and approve a new draft. The result is saved under
 * `.ria/skills/rechecks/` so that `skill_test` and `ria skill status` can say it.
 */

export interface RecheckResult {
  name: string;
  checkedAt: string;
  sources: SourceRecheck[];
  /** True when any source changed. A source that could not be checked is not a change, and not proof of none. */
  changed: boolean;
  text: string;
}

const MAX_REASON = 200;
const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, MAX_REASON);
const highKinds = (r: SourceRecord): Set<string> => new Set(r.flags.filter((f) => f.severity === "high").map((f) => f.kind));

async function recheckOne(root: string, id: string, opts: FetchOptions): Promise<SourceRecheck> {
  let before: SourceRecord;
  try {
    before = loadSource(root, id);
  } catch (e) {
    // without RIA's own record there is no address RIA vouches for, so nothing is fetched
    return { id, url: "(unknown)", state: "not checked", reason: reasonOf(e) };
  }
  let now: SourceRecord;
  try {
    now = await fetchSource(root, before.url, opts);
  } catch (e) {
    return { id, url: before.url, state: "not checked", reason: reasonOf(e) };
  }
  if (now.sha256 === before.sha256) return { id, url: before.url, state: "unchanged" };

  // text that nobody sees can change while the visible text does not: a flag that is new counts as a change
  const known = highKinds(before);
  const newHighFlags = [...highKinds(now)].filter((k) => !known.has(k));
  if (now.textSha256 === before.textSha256 && newHighFlags.length === 0) return { id, url: before.url, state: "same text", newId: now.id };
  const sameText = now.textSha256 === before.textSha256;
  return {
    id,
    url: before.url,
    state: "changed",
    newId: now.id,
    ...(newHighFlags.length ? { newHighFlags } : {}),
    ...(sameText ? { reason: "the visible text is the same, but the page raises a flag it did not raise before" } : {}),
  };
}

function line(s: SourceRecheck): string {
  const head = `  ${s.id} ${s.url}: `;
  switch (s.state) {
    case "unchanged":
      return `${head}unchanged`;
    case "same text":
      return `${head}the page was reissued but its text is the same (new source id ${s.newId})`;
    case "not checked":
      return `${head}not checked: ${s.reason}`;
    case "changed": {
      const flags = s.newHighFlags?.length ? `; now raises ${s.newHighFlags.length} high-severity flag(s) it did not before: ${s.newHighFlags.join("; ")}` : "";
      return `${head}CHANGED${s.reason ? ` (${s.reason})` : ": the text is different from what the skill was learned from"} (new source id ${s.newId}${flags})`;
    }
  }
}

export async function skillRecheck(root: string, nameInput: string, opts: FetchOptions = {}): Promise<RecheckResult> {
  const dir = draftPath(root, nameInput);
  const name = path.basename(dir);
  const { provenance, problem } = parseProvenance(path.join(dir, "provenance.json"), name);
  if (!provenance) throw new SkillError(`Cannot re-check "${name}": ${problem}.`);
  if (provenance.sources.length === 0) throw new SkillError(`"${name}" names no source, so there is nothing to re-check.`);

  const ids = [...new Set(provenance.sources.map((s) => s.id))];
  const checkedAt = new Date().toISOString();
  const sources = await Promise.all(ids.map((id) => recheckOne(root, id, opts)));
  saveRecheck(root, { schema: 1, name, checkedAt, sources });

  const changed = sources.some((s) => s.state === "changed");
  const unchecked = sources.filter((s) => s.state === "not checked").length;
  const out = [`Source re-check for skill "${name}" (${sources.length} source${sources.length > 1 ? "s" : ""}, ${checkedAt}):`, ...sources.map(line), ""];
  if (changed) {
    out.push(
      "Result: a page this skill was learned from has changed, so the skill may be out of date or no longer say what the page says.",
      "Next: read the new version (fetch_source on the address), and if the skill should follow it, scaffold a new draft from the new source id, run skill_test, and have the user approve it. This skill was not changed and stays installed until the user removes it.",
    );
  } else if (unchecked) {
    out.push(`Result: no source was seen to change, but ${unchecked} could not be checked, so this does not show that none changed.`);
  } else {
    out.push("Result: no source changed. The skill still matches the pages it was learned from.");
  }
  out.push("This shows no page text. The skill itself was not touched.");
  return { name, checkedAt, sources, changed, text: out.join("\n") };
}
