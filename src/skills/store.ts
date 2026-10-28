import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureRiaDir, riaDir } from "../repo/ria-dir";
import { InjectionFlag } from "./sanitize";

/** A problem the caller can act on (a bad URL, a name that is taken); the tools report its message as it is. */
export class SkillError extends Error {}

/**
 * What RIA saw when it fetched one page. It is written by `fetch_source` and read by `skill_scaffold`, so a skill's
 * provenance comes from RIA's own record of the fetch and never from what the chat says about it.
 */
export interface SourceRecord {
  /** First 16 hex digits of a SHA-256 over the URL and the bytes read: the same page gives the same id, a changed page a new one. */
  id: string;
  url: string;
  /** Where the request ended up after redirects. */
  finalUrl: string;
  fetchedAt: string;
  status: number;
  /** Without parameters, for example `text/html`. */
  contentType: string;
  /** Bytes read, after decompression. The SHA-256 covers exactly these. */
  bytes: number;
  /** True when the page was longer than the size limit and only its start was kept. */
  truncated: boolean;
  sha256: string;
  title?: string;
  /** The page as plain text, in full. */
  text: string;
  textSha256: string;
  hiddenChars: number;
  invisibleChars: number;
  flags: InjectionFlag[];
}

export const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

const SOURCE_ID = /^[0-9a-f]{16}$/;

export const skillsDir = (root: string): string => path.join(riaDir(root), "skills");
export const sourcesDir = (root: string): string => path.join(skillsDir(root), "sources");
export const draftsDir = (root: string): string => path.join(skillsDir(root), "drafts");

/** An id that came from a tool argument must match the exact pattern before it can become part of a path. */
export function sourcePath(root: string, id: string): string {
  if (!SOURCE_ID.test(id)) throw new SkillError(`"${id.slice(0, 40)}" is not a source id: it is 16 hex digits, as printed by fetch_source.`);
  return path.join(sourcesDir(root), `${id}.json`);
}

export function saveSource(root: string, record: SourceRecord): void {
  const file = sourcePath(root, record.id);
  ensureRiaDir(root);
  fs.mkdirSync(sourcesDir(root), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

export function loadSource(root: string, id: string): SourceRecord {
  const file = sourcePath(root, id);
  if (!fs.existsSync(file)) throw new SkillError(`No fetched source "${id}". Fetch the page with fetch_source first and use the id it prints.`);
  let record: SourceRecord;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8")) as SourceRecord;
  } catch {
    throw new SkillError(`The record of source "${id}" cannot be read. Fetch the page again.`);
  }
  // a record is plain JSON under .ria/, so check it is what fetch_source wrote before a skill cites it
  if (record.id !== id || typeof record.url !== "string" || typeof record.sha256 !== "string" || typeof record.text !== "string" || sha256(record.text) !== record.textSha256) {
    throw new SkillError(`The record of source "${id}" does not match its own checksum, so it was changed after the fetch. Fetch the page again.`);
  }
  return record;
}
