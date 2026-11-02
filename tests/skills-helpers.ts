import * as fs from "node:fs";
import * as path from "node:path";
import { skillScaffold } from "../src/skills/scaffold";
import { SourceRecord, saveSource, sha256 } from "../src/skills/store";
import { makeRepo } from "./helpers";

export const ID_A = "0123456789abcdef";
export const ID_B = "fedcba9876543210";

export function record(id: string, over: Partial<SourceRecord> = {}): SourceRecord {
  const text = over.text ?? `text of ${id}`;
  return {
    id,
    url: `https://docs.example.com/${id}`,
    finalUrl: `https://docs.example.com/${id}`,
    fetchedAt: "2026-10-28T12:00:00.000Z",
    status: 200,
    contentType: "text/html",
    bytes: 1234,
    truncated: false,
    sha256: sha256(`raw ${id}`),
    title: "A page",
    text,
    textSha256: sha256(text),
    hiddenChars: 0,
    invisibleChars: 0,
    flags: [],
    ...over,
  };
}

export interface DraftProject {
  dir: string;
  name: string;
  /** Absolute path of the draft folder. */
  draft: string;
  skillFile: string;
  provenanceFile: string;
}

/** A throwaway repository with fetched sources and one draft skill made by the real `skillScaffold`. */
export function draftProject(over: { records?: SourceRecord[]; name?: string; body?: string; sources?: string[] } = {}): DraftProject {
  const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  const records = over.records ?? [record(ID_A)];
  for (const r of records) saveSource(dir, r);
  const name = over.name ?? "parse-ledger-exports";
  const scaffolded = skillScaffold(dir, {
    name,
    description: "Parse the ledger export files. Use when a task reads an export.",
    body: over.body ?? "# Parse exports\n\nRead the header row first.",
    sources: over.sources ?? records.map((r) => r.id),
  });
  const draft = path.join(dir, scaffolded.dir);
  return { dir, name, draft, skillFile: path.join(draft, "SKILL.md"), provenanceFile: path.join(draft, "provenance.json") };
}

/** Rewrites a draft file through `edit`, as a person or a chat with file tools could. */
export function editFile(file: string, edit: (text: string) => string): void {
  fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
}

export function editJson(file: string, edit: (json: any) => void): void {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(json);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** Every file under a folder with its content, to show that a call changed nothing. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).replace(/\\/g, "/")] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
