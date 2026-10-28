/**
 * Turns a fetched page into plain text a chat can read, and looks for text that tries to give the chat orders.
 *
 * A web page is untrusted: the chat that reads it must treat it as data to learn from, never as instructions. This
 * file does two things toward that. It removes what a reader of the page would not see or what is code (scripts,
 * styles, frames, comments, elements hidden by style, invisible characters), so hidden text never reaches the chat as
 * if it were part of the page. And it flags text that looks like an attack on the chat (ignore your instructions,
 * hide this from the user, send your keys somewhere), in what is shown and in what was removed.
 *
 * The flags are patterns, not understanding: a page with no flags is not known to be safe, and a flagged page is
 * often a legitimate one (an install guide really does say `curl ... | sh`). They tell a human reviewer where to look.
 */

export type FlagSeverity = "high" | "medium";

export interface InjectionFlag {
  /** What the pattern looks for, in words. */
  kind: string;
  severity: FlagSeverity;
  /** `visible` is text a reader of the page sees; `hidden` is text that was removed from it (comments, hidden elements, invisible characters). */
  where: "visible" | "hidden";
  /** How many times it matched. */
  count: number;
  /** The first match with a little context, whitespace collapsed. */
  excerpt: string;
}

export interface Sanitized {
  title?: string;
  text: string;
  /** Characters of text that a reader would not see because style hides them. */
  hiddenChars: number;
  /** Zero-width, bidirectional-control and tag characters that were removed from the text. */
  invisibleChars: number;
  flags: InjectionFlag[];
}

// ---------------------------------------------------------------- HTML to text

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Elements whose content is text up to the closing tag, and may contain a `<` that is not a tag. */
const RAW = new Set(["script", "style", "title"]);
/** Elements whose content is dropped whole. */
const DROP = new Set(["noscript", "iframe", "object", "embed", "template", "svg", "canvas", "head", "math"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead", "tr", "ul",
]);

/** Inline style or attributes that hide an element from a reader while leaving it in the page. */
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:[;"']|$)|text-indent\s*:\s*-\d{3,}|(?:left|top)\s*:\s*-\d{4,}|color\s*:\s*transparent/i;
/** The bare `hidden` attribute. Tested with the quoted values removed, so `class="hidden md:block"` is not read as one. */
const HIDDEN_ATTRIBUTE = /(?:^|\s)hidden(?=\s|=|$)/i;
/** A tag's attributes are looked at up to this length: past it, a tag is not worth judging. */
const MAX_ATTRS = 20_000;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", copy: "\u00a9",
  laquo: "\u00ab", raquo: "\u00bb", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", middot: "\u00b7", bull: "\u2022",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return ENTITIES[(name as string).toLowerCase()] ?? all;
  });
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "tag"; name: string; closing: boolean; attrs: string }
  | { kind: "other" };

const TAG_NAME = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const QUOTE_OR_END = /[>"']/g;

/**
 * Reads HTML one token at a time. It is written by hand and not as one regular expression because the page is hostile: a
 * pattern that scans to the end of the document for every unterminated quote, comment or tag takes time quadratic in the
 * page, and a megabyte of `<a x="` would hold the server for minutes. Here every character is looked at a bounded number of
 * times: a quote or `>` that has no partner after some point is remembered as having none after any later point.
 */
class Scanner {
  pos = 0;
  private noGt = false;
  private noDouble = false;
  private noSingle = false;

  constructor(private readonly s: string) {}

  /** The index of the `>` that ends a tag whose attributes start at `from`, skipping quoted values, or -1. */
  private tagEnd(from: number): number {
    if (this.noGt) return -1;
    const s = this.s;
    let i = from;
    for (;;) {
      QUOTE_OR_END.lastIndex = i;
      const m = QUOTE_OR_END.exec(s);
      if (!m) {
        this.noGt = true;
        return -1;
      }
      if (m[0] === ">") return m.index;
      const unpaired = m[0] === '"' ? this.noDouble : this.noSingle;
      const partner = unpaired ? -1 : s.indexOf(m[0], m.index + 1);
      if (partner === -1) {
        if (m[0] === '"') this.noDouble = true;
        else this.noSingle = true;
        i = m.index + 1;
      } else {
        i = partner + 1;
      }
    }
  }

  private closeAngle(from: number): number {
    if (this.noGt) return -1;
    const j = this.s.indexOf(">", from);
    if (j === -1) this.noGt = true;
    return j;
  }

  next(): Token | undefined {
    const s = this.s;
    const n = s.length;
    const start = this.pos;
    if (start >= n) return undefined;
    if (s.charCodeAt(start) !== 60) {
      const j = s.indexOf("<", start);
      this.pos = j === -1 ? n : j;
      return { kind: "text", text: s.slice(start, this.pos) };
    }
    if (s.startsWith("<!--", start)) {
      // an unterminated comment hides the rest of the page, as it does in a browser
      const j = s.indexOf("-->", start + 4);
      this.pos = j === -1 ? n : j + 3;
      return { kind: "comment", text: s.slice(start + 4, j === -1 ? n : j) };
    }
    const after = s.charCodeAt(start + 1);
    if (after === 33 || after === 63) {
      // a doctype, a CDATA section or a processing instruction
      const j = this.closeAngle(start + 2);
      this.pos = j === -1 ? n : j + 1;
      return { kind: "other" };
    }
    TAG_NAME.lastIndex = start;
    const m = TAG_NAME.exec(s);
    if (!m) {
      this.pos = start + 1;
      return { kind: "text", text: "<" };
    }
    const end = this.tagEnd(start + m[0].length);
    if (end === -1) {
      // a tag that never ends takes the rest of the page with it, as in a browser
      this.pos = n;
      return { kind: "other" };
    }
    this.pos = end + 1;
    return { kind: "tag", name: m[2].toLowerCase(), closing: m[1] === "/", attrs: s.slice(start + m[0].length, end) };
  }

  /** After the opening tag of a raw-text element: its text up to the closing tag, and the position moved past that tag. */
  rawText(name: string): string {
    const from = this.pos;
    const re = new RegExp(`</${name}\\b`, "ig");
    re.lastIndex = from;
    const m = re.exec(this.s);
    if (!m) {
      this.pos = this.s.length;
      return this.s.slice(from);
    }
    const j = this.closeAngle(m.index);
    this.pos = j === -1 ? this.s.length : j + 1;
    return this.s.slice(from, m.index);
  }
}

interface Walked {
  title?: string;
  text: string;
  /** Text removed because style hides it. */
  styleHidden: string;
  /** Text of comments. */
  comments: string;
}

const trailingNewlines = (s: string): number => {
  let i = s.length;
  while (i > 0 && s.charCodeAt(i - 1) === 10) i--;
  return s.length - i;
};

function htmlToText(html: string): Walked {
  const sc = new Scanner(html);
  const parts: string[] = [];
  /** How many `\n` end the output so far. Kept up to date so that nothing has to look back over the output. */
  let newlines = 0;
  let title: string | undefined;
  let styleHidden = "";
  let comments = "";
  let skip: { name: string; depth: number } | undefined;
  let hide: { name: string; depth: number } | undefined;
  let inPre = 0;

  const emit = (s: string): void => {
    if (!s) return;
    parts.push(s);
    const k = trailingNewlines(s);
    newlines = k === s.length ? newlines + k : k;
  };
  const newline = (n = 1): void => {
    // spaces before a line break are dropped
    while (parts.length > 0) {
      const last = parts[parts.length - 1];
      const trimmed = last.replace(/[ \t]+$/, "");
      if (trimmed === last) break;
      if (trimmed) {
        parts[parts.length - 1] = trimmed;
        break;
      }
      parts.pop();
    }
    newlines = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const k = trailingNewlines(parts[i]);
      newlines += k;
      if (k < parts[i].length) break;
    }
    if (parts.length > 0 && newlines < n) emit("\n".repeat(n - newlines));
  };
  const track = (state: { name: string; depth: number }, name: string, closing: boolean, selfClosing: boolean): boolean => {
    if (name !== state.name) return true;
    state.depth += closing ? -1 : selfClosing ? 0 : 1;
    return state.depth > 0;
  };

  for (let t = sc.next(); t; t = sc.next()) {
    if (t.kind === "comment") {
      comments += `${t.text}\n`;
      continue;
    }
    if (t.kind === "other") continue;
    if (t.kind === "text") {
      if (skip) continue;
      const decoded = decodeEntities(t.text);
      if (hide) styleHidden += `${decoded}\n`;
      else if (inPre) emit(decoded);
      else {
        const collapsed = decoded.replace(/\s+/g, " ");
        emit((parts.length === 0 || newlines > 0) && collapsed.startsWith(" ") ? collapsed.slice(1) : collapsed);
      }
      continue;
    }

    const { name, closing } = t;
    const attrs = t.attrs.length > MAX_ATTRS ? t.attrs.slice(0, MAX_ATTRS) : t.attrs;
    const selfClosing = VOID.has(name) || /\/\s*$/.test(attrs);

    if (name === "title" && !closing && !selfClosing && skip?.name !== "svg") {
      const text = sc.rawText("title");
      if (title === undefined) title = decodeEntities(text).replace(/\s+/g, " ").trim() || undefined;
      continue;
    }
    if (skip) {
      if (!track(skip, name, closing, selfClosing)) skip = undefined;
      continue;
    }
    if (RAW.has(name)) {
      if (!closing && !selfClosing) sc.rawText(name);
      continue;
    }
    if (DROP.has(name)) {
      if (!closing && !selfClosing) skip = { name, depth: 1 };
      continue;
    }
    if (hide) {
      if (!track(hide, name, closing, selfClosing)) hide = undefined;
      continue;
    }
    if (!closing && (HIDDEN_STYLE.test(attrs) || HIDDEN_ATTRIBUTE.test(attrs.replace(/"[^"]*"|'[^']*'/g, '""')))) {
      if (!selfClosing) hide = { name, depth: 1 };
      continue;
    }

    if (name === "pre") inPre = Math.max(0, inPre + (closing ? -1 : 1));
    if (/^h[1-6]$/.test(name)) {
      newline(2);
      if (!closing) emit(`${"#".repeat(Number(name[1]))} `);
    } else if (name === "li") {
      newline();
      if (!closing) emit("- ");
    } else if (name === "td" || name === "th") {
      emit(" ");
    } else if (BLOCK.has(name)) {
      newline(name === "p" || name === "pre" || name === "table" ? 2 : 1);
    }
  }
  return { title, text: parts.join(""), styleHidden, comments };
}

// ---------------------------------------------------------------- invisible characters

/** Tag characters (U+E0000 to U+E007F) are invisible and map onto ASCII: a way to smuggle a message past a reader. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Zero-width and bidirectional-control characters. A joiner or two is ordinary in emoji; a run of them is not. */
const OTHER_INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stripInvisible(text: string): { text: string; tags: number; other: number; smuggled: string } {
  const tagMatches = text.match(TAG_CHARS) ?? [];
  const smuggled = tagMatches
    .map((c) => (c.codePointAt(0) as number) - 0xe0000)
    .filter((n) => n >= 0x20 && n <= 0x7e)
    .map((n) => String.fromCharCode(n))
    .join("");
  const other = (text.match(OTHER_INVISIBLE) ?? []).length;
  return { text: text.replace(TAG_CHARS, "").replace(OTHER_INVISIBLE, "").replace(CONTROL, ""), tags: tagMatches.length, other, smuggled };
}

// ---------------------------------------------------------------- what looks like an attack on the chat

interface Rule {
  kind: string;
  severity: FlagSeverity;
  re: RegExp;
}

const SECRET_NOUN = String.raw`(?:api[ _-]?keys?|secrets?|credentials?|passwords?|access tokens?|auth tokens?|private keys?|ssh keys?|session cookies?)`;

const RULES: Rule[] = [
  {
    kind: "tells the reader to ignore its instructions",
    severity: "high",
    re: /\b(?:ignore|disregard|override|bypass)\b[^.\n]{0,50}\b(?:previous|prior|above|earlier|preceding|all|any|your|the|these|those)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|guidelines|directives)\b|\b(?:forget|disregard) (?:everything|all|what)\b[^.\n]{0,40}\b(?:above|before|said|told)\b/i,
  },
  {
    kind: "gives the reader a new role",
    severity: "high",
    re: /\byou are now (?:an? |the )?(?:[a-z-]+ ){0,3}(?:assistant|ai|agent|bot|model|llm|chatbot)\b|\bfrom now on,? you (?:must|will|are|should)\b|\bnew (?:system )?(?:instructions?|prompt|persona)\s*:|\bact as (?:an? )?(?:unrestricted|jailbroken|uncensored|different|new)\b|\bpretend (?:to be|you are)\b/i,
  },
  {
    kind: "imitates a chat's own markers",
    severity: "medium",
    re: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|^[ \t]*(?:system|developer) (?:prompt|message|instructions?)[ \t]*:/im,
  },
  {
    kind: "tells the reader to hide something from the user",
    severity: "high",
    re: /\b(?:do not|don't|never|without)\b[^.\n]{0,40}\b(?:tell|inform|notify|alert|mention|reveal|show|disclose)(?:ing)?\b[^.\n]{0,30}\b(?:the |your )?(?:user|human|operator|owner)\b/i,
  },
  {
    kind: "reads or sends local secrets",
    severity: "high",
    re: /\b(?:cat|read|send|upload|post|curl|copy|exfiltrate|print|echo|type|get-content)\b[^\n]{0,80}(?:~\/\.ssh|\.ssh\/|id_rsa|\.aws\/credentials|\.npmrc|\.git-credentials|\/etc\/passwd)/i,
  },
  {
    kind: "tells the reader to send a secret to an address",
    severity: "medium",
    re: new RegExp(String.raw`\b(?:send|post|upload|transmit|leak|exfiltrate|forward|email)\b[^.\n]{0,60}\b${SECRET_NOUN}\b[^.\n]{0,60}(?:https?:\/\/|\bto\b[^.\n]{0,20}@)`, "i"),
  },
  {
    kind: "installs or enables something without the user's approval",
    severity: "high",
    re: /\b(?:register|enable|install|activate|approve|add)\b[^.\n]{0,40}\b(?:skill|tool|plugin|hook|extension|mcp server)\b[^.\n]{0,60}\b(?:without|no need for|skip(?:ping)?|automatically|silently)\b/i,
  },
  {
    kind: "tells the reader to skip a check or a confirmation",
    severity: "medium",
    re: /\b(?:skip|bypass|disable|avoid|turn off)\b[^.\n]{0,40}\b(?:approval|permission prompts?|confirmation|human review|safety checks?|guardrails?|the gate)\b/i,
  },
  {
    kind: "changes an agent's own configuration",
    severity: "medium",
    re: /\b(?:add|append|edit|modify|write|insert|overwrite)\b[^.\n]{0,60}(?:settings(?:\.local)?\.json|\.claude\/|\.mcp\.json|CLAUDE\.md|\.vscode\/mcp\.json)/i,
  },
  {
    kind: "pipes a download into a shell or decodes and runs code",
    severity: "medium",
    re: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|python3?|node|powershell|pwsh)\b|\bpowershell(?:\.exe)?\s+(?:-\w+\s+)*-enc(?:odedcommand)?\b|\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:sh|bash)\b/i,
  },
  {
    kind: "a destructive command",
    severity: "medium",
    re: /\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\$HOME|\*)(?:\s|$)|\bRemove-Item\b[^\n]{0,40}-Recurse[^\n]{0,40}(?:[A-Za-z]:\\|~|\$HOME)|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=[^\n]{0,40}of=\/dev\//i,
  },
  {
    kind: "a long encoded blob",
    severity: "medium",
    re: /[A-Za-z0-9+/=]{300,}/,
  },
];

const EXCERPT_CONTEXT = 30;
const MAX_EXCERPT = 160;

function scan(text: string, where: InjectionFlag["where"], flags: InjectionFlag[]): void {
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    let count = 0;
    let excerpt = "";
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      if (count++ === 0) {
        const from = Math.max(0, (m.index ?? 0) - EXCERPT_CONTEXT);
        excerpt = text.slice(from, (m.index ?? 0) + m[0].length + EXCERPT_CONTEXT).replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
      }
    }
    // an instruction in text nobody can see is worse than the same words on the page
    if (count > 0) flags.push({ kind: rule.kind, severity: where === "hidden" ? "high" : rule.severity, where, count, excerpt });
  }
}

/** Looks for text that tries to give the chat orders, in what a reader sees and in what was removed from the page. */
export function flagInjection(visible: string, hidden: string): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  scan(visible, "visible", flags);
  if (hidden.trim()) scan(hidden, "hidden", flags);
  return flags;
}

// ---------------------------------------------------------------- the whole job

/** The kinds of content that are read as HTML. */
export function isHtml(contentType: string, body: string): boolean {
  return /\bx?html\b/i.test(contentType) || (!/json/i.test(contentType) && /^\s*(?:<!doctype html|<html[\s>])/i.test(body));
}

/**
 * Plain text from a fetched body, with what was hidden or removed accounted for. HTML is flattened to text; other text
 * (plain, Markdown, JSON) is kept as it is, except that comments, which a rendered Markdown page does not show, are moved
 * out of the text and scanned like other hidden text.
 */
export function sanitize(body: string, contentType: string): Sanitized {
  let title: string | undefined;
  let text: string;
  let styleHidden = "";
  let comments = "";
  if (isHtml(contentType, body)) {
    const walked = htmlToText(body);
    ({ title, text, styleHidden, comments } = walked);
  } else if (/json/i.test(contentType)) {
    text = body;
  } else {
    text = body.replace(/<!--([\s\S]*?)(?:-->|$)/g, (_all, c: string) => {
      comments += `${c}\n`;
      return "";
    });
  }

  const cleaned = stripInvisible(text);
  const hiddenText = [styleHidden, comments, cleaned.smuggled].filter((s) => s.trim()).join("\n");
  const out = cleaned.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const flags = flagInjection(out, hiddenText);
  if (cleaned.tags > 0) {
    flags.push({ kind: "invisible tag characters spell out a hidden message", severity: "high", where: "hidden", count: cleaned.tags, excerpt: cleaned.smuggled.slice(0, MAX_EXCERPT) });
  }
  if (cleaned.other >= 8) {
    flags.push({ kind: "many zero-width or direction-control characters", severity: "medium", where: "hidden", count: cleaned.other, excerpt: "" });
  }
  const styled = styleHidden.replace(/\s+/g, " ").trim();
  if (styled.length >= 20) {
    flags.push({ kind: "text hidden from readers by style", severity: "medium", where: "hidden", count: 1, excerpt: styled.slice(0, MAX_EXCERPT) });
  }
  return { title, text: out, hiddenChars: styled.length, invisibleChars: cleaned.tags + cleaned.other, flags };
}
