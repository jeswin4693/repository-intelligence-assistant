import { playbook } from "../init/render";
import { Role, RoleId, roleById } from "../init/roles";
import { RepoIndex } from "../repo/repo-index";

/**
 * Works out which RIA role a request calls for, from its words alone: no model, so the same request always gets
 * the same answer and the answer says what it was based on. It is a heuristic over English phrasing; the chat
 * may know better and is told to say so when it does.
 */

export type Confidence = "high" | "medium" | "low";

export interface Route {
  /** "none" for a follow-up or a remark that is not a new task ("yes", "continue", "commit this"). */
  role: RoleId | "none";
  confidence: Confidence;
  /** What decided it, in the request's own words. */
  signals: string[];
  /** Other roles that could also fit, strongest first. */
  alternatives: RoleId[];
  notes: string[];
  scores: Record<RoleId, number>;
}

/** What the repository says about the paths a request names. Only `start_task` has it; the per-prompt hook does not index. */
export interface Evidence {
  existing: string[];
  missing: string[];
}

const SPECIALISTS: RoleId[] = ["writer", "fixer", "extractor", "reader", "analyser", "reviewer"];
const EDITING: RoleId[] = ["writer", "fixer", "extractor"];
/** Who wins a tie: the more specific request first. */
const PRIORITY: RoleId[] = ["reviewer", "fixer", "extractor", "writer", "analyser", "reader"];

// ---------------------------------------------------------------- words

/** `creating`, `created`, `creates`, `create` all become `creat`; the same function is applied to the rules and to the request. */
export function stem(word: string): string {
  let s = word.toLowerCase().replace(/'s$/, "");
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  s = s.replace(/e$/, "");
  return s.replace(/([a-z])\1$/, "$1");
}

/**
 * One slip of the fingers: a swap of two neighbouring letters (`creaet`), a missing letter (`implment`) or an extra one.
 * A single wrong letter only counts in a long word: `sqlite` is not a typo of `split`.
 */
function nearBy1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length && diff.length < 3; i++) if (a[i] !== b[i]) diff.push(i);
    return (diff.length === 1 && a.length >= 7) || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  return long.slice(i + 1) === short.slice(i);
}

interface WordRule {
  role: RoleId;
  weight: number;
  words: string[];
}

const WORD_RULES: WordRule[] = [
  { role: "writer", weight: 3, words: ["create", "scaffold", "generate", "implement"] },
  { role: "writer", weight: 2, words: ["build", "write", "add", "make", "introduce", "develop", "document", "hook", "wire", "spin", "port", "bootstrap", "initialize", "initialise", "draft", "compose", "prototype"] },
  // changing something on purpose: the writer's steps (follow the conventions, wire in, test, check) fit
  { role: "writer", weight: 2, words: ["update", "change", "modify", "improve", "optimize", "optimise", "enhance", "adjust", "tweak", "replace", "enable", "disable", "configure"] },
  { role: "fixer", weight: 4, words: ["fix", "debug", "troubleshoot"] },
  { role: "fixer", weight: 3, words: ["repair", "patch", "bug", "exception", "crash", "broken", "broke", "regression", "traceback", "segfault", "malfunction"] },
  { role: "fixer", weight: 2, words: ["error", "fail", "failure", "wrong", "incorrect", "resolve", "hang", "freeze", "leak", "flaky", "defect"] },
  { role: "fixer", weight: 2, words: ["throw", "unexpected", "weird", "stuck", "die", "dies", "oom", "disconnect", "slow", "overflow", "glitch", "flicker", "misalign", "typo", "mismatch"] },
  { role: "fixer", weight: 1.5, words: ["issue", "problem"] },
  { role: "reader", weight: 4, words: ["explain", "walkthrough"] },
  { role: "reader", weight: 3, words: ["describe", "understand", "summarize", "summarise", "overview", "tour", "read", "locate"] },
  { role: "reader", weight: 2, words: ["show", "find", "list", "trace", "look", "check", "tell"] },
  { role: "analyser", weight: 3, words: ["compare", "estimate", "assess", "evaluate", "recommend", "alternative", "feasibility", "risk", "risky"] },
  { role: "extractor", weight: 4, words: ["refactor", "extract", "restructure", "reorganize", "reorganise", "decouple", "dedupe", "deduplicate", "modularize", "modularise", "consolidate"] },
  { role: "extractor", weight: 3, words: ["rename", "split", "inline", "dry"] },
  { role: "extractor", weight: 2, words: ["move", "tidy", "cleanup", "simplify", "separate"] },
  { role: "reviewer", weight: 4, words: ["review"] },
  { role: "reviewer", weight: 3, words: ["critique", "diff"] },
  { role: "autopilot", weight: 5, words: ["autopilot"] },
  { role: "autopilot", weight: 2.5, words: ["migrate", "migration", "upgrade"] },
  { role: "autopilot", weight: 2, words: ["ticket"] },
  // a change that is not obviously new code, a fix or a move: the generalist decides
  { role: "autopilot", weight: 1.5, words: ["remove", "delete", "drop"] },
];

interface Entry {
  role: RoleId;
  weight: number;
  stem: string;
}
const LEXICON = new Map<string, Entry>();
for (const r of WORD_RULES) for (const w of r.words) LEXICON.set(stem(w), { role: r.role, weight: r.weight, stem: stem(w) });
const LONG_STEMS = [...LEXICON.keys()].filter((s) => s.length >= 5);
const FIX_VERBS = new Set(["fix", "debug", "troubleshoot", "repair", "patch"].map(stem));

/** The rule a stemmed word belongs to, exactly or by one slip of the fingers (only for words of five letters or more). */
function lookup(s: string): { hit: Entry; typo: boolean } | undefined {
  const exact = LEXICON.get(s);
  if (exact) return { hit: exact, typo: false };
  if (s.length < 5) return undefined;
  const near = LONG_STEMS.find((l) => nearBy1(s, l));
  return near ? { hit: LEXICON.get(near) as Entry, typo: true } : undefined;
}

const CREATION = new Set(["creat", "scaffold", "generat", "implement", "build", "write", "add", "make", "introduc"].map(stem));
const OBJECTS = new Set(
  "file folder directory component endpoint page screen class function module script test feature command route service handler model table migration readme doc document config button form api cli widget hook util helper middleware schema field column query view".split(" ").map(stem),
);
const CODE_NOUNS = new Set("function class method helper module file folder code logic constant util component test".split(" ").map(stem));

// ---------------------------------------------------------------- phrases

interface PhraseRule {
  role: RoleId;
  weight: number;
  re: RegExp;
}

const ERROR_TEXT =
  /\b(?:type|reference|syntax|value|key|attribute|name|import|runtime|assertion|index)error\b|\bnull ?pointer\b|\bundefined is not\b|\bcannot read propert|\bsegmentation fault\b|\benoent\b|\beconnrefused\b|\berror ts\d+\b|\bnpm err\b|\bstack ?trace\b|\bexit code [1-9]\b|\b(?:is|are) (?:red|failing|broken)\b/;

const PHRASES: PhraseRule[] = [
  { role: "writer", weight: 1.5, re: /\bnew\b/ },
  { role: "writer", weight: 3, re: /\b(?:i|we) (?:need|want|would like|wanna) (?:you to )?(?:a |an |the |some )?new\b/ },
  { role: "writer", weight: 1.5, re: /\bfrom scratch\b/ },
  { role: "writer", weight: 2, re: /\bset ?up\b|\bput together\b/ },
  { role: "writer", weight: 3, re: /\b(?:i|we) (?:need|want|would like) (?:a|an|some)\b/ },
  { role: "fixer", weight: 3.5, re: /\b(?:not|isn't|isnt|doesn't|doesnt|don't|dont|won't|wont|didn't|didnt|stopped|stops?) (?:working|work|running|loading|starting|responding)\b/ },
  { role: "fixer", weight: 3.5, re: /\bdoes(?:n't| not)? (?:do )?nothing\b|\bnothing happens\b/ },
  { role: "fixer", weight: 3.5, re: ERROR_TEXT },
  { role: "fixer", weight: 2, re: /\b(?:why|how come) .{0,40}\b(?:fail|fails|failing|crash|crashes|crashing|broken|wrong|error)/ },
  { role: "fixer", weight: 3, re: /\b(?:status|code|returns?|gets?|getting|got|throws?|receiv\w+|responds? with|response)\s+(?:a |an )?[45]\d\d\b/ },
  { role: "fixer", weight: 3.5, re: /\bexpected\b.{0,30}\b(?:received|got|actual|but)\b/ },
  { role: "fixer", weight: 3, re: /\bsomething (?:is |seems |looks )?(?:off|wrong|broken|weird|odd|strange)\b|\boff by\b|\btoo (?:low|high|many|few|much|little)\b/ },
  { role: "fixer", weight: 3, re: /\bsort (?:this|it|that) out\b|\btrack (?:it|this|that) down\b/ },
  { role: "fixer", weight: 3.5, re: /\bfailed [\w/.-]+::\w+|\bassert\b.{0,40}==|\b(?:test|tests|build|job|pipeline|step|check) (?:failed|fails|is failing|are failing)\b/ },
  { role: "fixer", weight: 2.5, re: /\b(?:can't|cant|cannot|can not|won't|wont|unable to) [a-z]{3,}/ },
  { role: "fixer", weight: 3, re: /\b(?:breaks|broke|breaking) (?:after|when|on|again|down|every|whenever)\b|\bkeeps? breaking\b/ },
  { role: "fixer", weight: 3, re: /\bnever (?:ends?|finish(?:es)?|loads?|stops?|returns?)\b|\bkeeps? (?:failing|crashing|disconnecting|restarting|timing out|dying)\b|\bdies? with\b/ },
  { role: "fixer", weight: 2, re: /\b(?:can't|cant|cannot|unable to|can not) (?:\w+ ){0,2}(?:push|pull|run|build|start|open|install|log ?in|connect|load)\b/ },
  { role: "reader", weight: 2, re: /\bwhat (?:does|is|are|do)\b/ },
  { role: "reader", weight: 2, re: /\b(?:look(?:ing)? (?:into|at)|check(?:ing)? out)\b/ },
  { role: "reader", weight: 2, re: /^(?:does|do|did|is|are|can|will) (?:this|that|the|it|my|our|these|those)\b/ },
  { role: "reader", weight: 3, re: /\bhow (?:does|do|is|are)\b/ },
  { role: "reader", weight: 3, re: /\bwhere (?:is|are|does|do)\b/ },
  { role: "reader", weight: 3, re: /\bwhich (?:files?|functions?|classes|modules?|folders?|methods?)\b/ },
  { role: "reader", weight: 3.5, re: /\b(?:who|what|which \w+) (?:calls|uses|imports|depends on)\b/ },
  { role: "reader", weight: 4, re: /\bwalk me through\b/ },
  { role: "reader", weight: 3, re: /\btell me (?:about|what|how|where|which|who)\b/ },
  { role: "reader", weight: 2.5, re: /\bshow me\b/ },
  { role: "reader", weight: 3, re: /\b(?:list|show|name) (?:all|every)\b/ },
  { role: "reader", weight: 3, re: /\bwhat(?:'s| is) in\b/ },
  { role: "reader", weight: 3, re: /\bhow many\b|\b(?:the )?difference between\b/ },
  { role: "analyser", weight: 4, re: /\bshould (?:we|i)\b|^(?:(?:so|and|well|ok|but) )?should\b/ },
  { role: "analyser", weight: 4, re: /\b(?:is it|would it be|is that) worth\b|\bworth (?:it|doing|migrating|switching|using|the)\b/ },
  { role: "analyser", weight: 3, re: /\b(?:versus|vs\.?)\s(?!code\b|studio\b)/ },
  { role: "analyser", weight: 4, re: /\b(?:safest|best|right|easiest|simplest|cleanest|fastest|recommended) (?:way|approach|option|method|strategy|practice)\b/ },
  { role: "analyser", weight: 4, re: /\b(?:downsides?|drawbacks?|pitfalls?|implications?|consequences?|risks?|trade ?offs?)\b/ },
  { role: "analyser", weight: 3.5, re: /\b(?:effort|timeline|complexity)\b|\bdo you think\b|\bwould you (?:recommend|suggest)\b|\bin your opinion\b|\bhow would you\b/ },
  { role: "analyser", weight: 3, re: /\bwithout breaking\b/ },
  { role: "analyser", weight: 2.5, re: /^(?:can|could) (?:we|i) /i },
  { role: "analyser", weight: 4, re: /\bwhich (?:approach|option|way|library|tool|design|pattern|method|strategy)\b/ },
  { role: "analyser", weight: 4, re: /\bpros and cons\b|\btrade-?offs?\b/ },
  { role: "analyser", weight: 4, re: /\bblast radius\b/ },
  { role: "analyser", weight: 4, re: /\bwhat (?:would|will|could|might) (?:break|happen|change|be affected|need to change)\b|\bwhat breaks\b/ },
  { role: "analyser", weight: 4, re: /\bhow (?:big|hard|long|risky|complex|difficult|much work|many files|safe)\b/ },
  { role: "analyser", weight: 4, re: /\b(?:is it|would it be|is that) (?:safe|risky|ok|okay)\b|\bsafe to\b/ },
  { role: "analyser", weight: 4, re: /\b(?:what are|what's) (?:my|the|our) (?:options|choices|alternatives)\b/ },
  { role: "analyser", weight: 3.5, re: /\bwhich tests\b/ },
  { role: "analyser", weight: 4, re: /\btell me which\b|\bwhich one (?:to|should|is)\b/ },
  { role: "analyser", weight: 4, re: /\bwhat (?:code|files?|tests?|modules?|services?|parts?|else) (?:would|will|could|might|is|are|uses?|calls?|depends?)\b/ },
  { role: "analyser", weight: 3, re: /\bnext (?:plan|step|steps|thing|things)\b|\bwhat (?:we|i|to) (?:can |should |could )?(?:do|develop|build|work on)(?: next)?\b/ },
  { role: "extractor", weight: 4, re: /\bwithout (?:changing|altering|modifying|breaking) (?:the )?(?:existing )?(?:behaviou?r|logic|functionality|api|interface)\b/ },
  { role: "extractor", weight: 3, re: /\bpull .{1,30} out\b|\bpull .{1,40} into\b|\b(?:break|split) .{1,40} (?:up|into|apart|off)\b/ },
  { role: "extractor", weight: 3.5, re: /\b(?:keep(?:ing)?|still) (?:everything |it |things )?(?:working|the same)\b|\bsame behaviou?r\b|\bnothing (?:should )?change\b/ },
  { role: "extractor", weight: 2, re: /\bclean ?up\b/ },
  { role: "extractor", weight: 3, re: /\bduplicat(?:e|ed|es|ion)\b|\bdry\b/ },
  { role: "extractor", weight: 2, re: /\bmove .{1,40} (?:to|into|from|out of)\b/ },
  { role: "reviewer", weight: 5, re: /\bcode review\b/ },
  { role: "reviewer", weight: 3, re: /\baudit(?:ing)?\b(?! (?:log|trail|event|record|table))/ },
  { role: "reviewer", weight: 3, re: /\bpull request\b|\bpr ?#?\d+\b|\bpr\b/ },
  { role: "reviewer", weight: 4, re: /\bcheck (?:my|the|this|these|our) (?:changes?|code|commits?|branch|work|diff|patch|pr)\b/ },
  { role: "reviewer", weight: 3, re: /\blook over\b|\bbefore (?:i|we) (?:commit|merge|push|submit)\b/ },
  { role: "reviewer", weight: 3.5, re: /\b(?:double[- ]?check|sanity[- ]?check|once-?over|go(?:ing)? through (?:the|my|this) (?:diff|changes|commit|pr|patch))\b/ },
  { role: "reviewer", weight: 3, re: /\b(?:any|anything|something) (?:problems?|issues?|wrong|mistakes?|bugs?)\b.{0,40}\b(?:commit|diff|changes?|branch|pr|patch|code i)\b/ },
  { role: "reviewer", weight: 3.5, re: /\b(?:okay|ok|safe|good|fine) to merge\b/ },
  { role: "reviewer", weight: 3, re: /\b(?:last|latest) commit\b|\buncommitted\b|\bfeedback on\b/ },
  { role: "reviewer", weight: 2.5, re: /\b(?:my|this|these|our) (?:diff|changes|commits?|patch|pr|branch)\b/ },
  { role: "reviewer", weight: 2.5, re: /\bwhat do you think (?:about|of)\b/ },
  { role: "autopilot", weight: 4, re: /\bend[- ]to[- ]end\b|\bstart to finish\b/ },
  { role: "autopilot", weight: 4, re: /\b(?:do|handle) (?:everything|all of it|the rest|it all)\b|\bjust do it\b|\bi trust you\b|\bwhatever it takes\b|\bhandle whatever\b/ },
  { role: "autopilot", weight: 3, re: /\btake care of\b/ },
  { role: "autopilot", weight: 4, re: /\b(?:handle|own|run with|finish|complete|deliver) (?:the |this |that |all |our )?(?:whole|entire|full)\b/ },
  { role: "autopilot", weight: 3, re: /\b(?:whole|entire|full) (?:\w+ ){0,2}(?:integration|redesign|rewrite|implementation|system|flow|process)\b/ },
  { role: "autopilot", weight: 3.5, re: /\buntil (?:it'?s?|it is|they are|everything is) (?:done|finished|complete|working|passing)\b|\bask me (?:only )?(?:if|when)\b|\bget .{1,30} (?:finished|done)\b/ },
  { role: "autopilot", weight: 2.5, re: /\b(?:whole|entire|complete) (?:task|feature|ticket|migration|project|thing)\b/ },
  { role: "autopilot", weight: 2, re: /\bensure (?:everything|it|all|nothing)\b/ },
];

/** The user says the work must not change anything: only the roles that read may run. */
const READ_ONLY = [
  /\b(?:do not|don't|dont|never|no need to)\s+(?:\w+\s+){0,2}?(?:change|edit|modify|touch|write|alter|commit|push)\b/,
  /\bjust (?:read|look|explain|tell|show)\b|\bonly (?:read|look|explain|tell|show|analy[sz]e)\b|\bread[- ]only\b|\bno changes\b/,
];
/** `without changing the behaviour` is the extractor's brief, not a ban on editing. */
const NOT_A_BAN = /\bwithout (?:changing|altering|modifying|breaking) (?:the )?(?:existing )?(?:behaviou?r|logic|functionality|api|interface|public \w+)\b/g;

// ---------------------------------------------------------------- scoring

const emptyScores = (): Record<RoleId, number> => ({ writer: 0, fixer: 0, extractor: 0, reader: 0, analyser: 0, reviewer: 0, autopilot: 0 });

/** A sentence that asks for information, not for work: `how do I add a route?`, `why does it fail?`. "Can you add X" is a request, not this. */
const QUESTION = /^(?:(?:so|and|also|ok|okay|hey|hi|now|well) )*(?:what|where|which|who|whom|when|why|how|is|are|does|did|was|were)\b/;
const POLITE = /^(?:(?:please|pls|kindly|now|then|also|and|ok|okay|so|just) )*(?:(?:can|could|would|will) you (?:please )?|i (?:want|need|would like) you to |i'd like you to |let'?s |lets )?/;

/** Words that carry no kind of work: articles, pronouns, prepositions, auxiliaries and the small words of a reply ("yes", "thanks"). */
const FUNCTION_WORDS = new Set(
  ("a an the this that these those it its i me my we our you your he she they them is are was were be been am do does did has have had will would can could should may might to of in on at for from with by as up out and or but so if then than not no yes yep yeah yup nope ok okay sure thanks thank please go ahead proceed continue start stop wait perfect great good nice cool fine done correct right sorry hi hello hey morning later tomorrow today now all just also one other another next last first again more some any what whats that's let's i'm it's don't why how when where who which there here about meant mean commit push pull merge rebase stash tag repo ah oh hmm see sense makes got understood noted agreed alright cancel thx").split(" "),
);

/** Whether a sentence asks for an edit outright: a command ("add a test"), or "can you / please / just" and then a verb that edits. */
function asksForEdit(sentence: string): boolean {
  const base = (w: string | undefined) => {
    if (!w || /(?:s|ed|ing)$/.test(w)) return false;
    const hit = LEXICON.get(stem(w));
    return hit !== undefined && (EDITING as string[]).includes(hit.role);
  };
  if (base(sentence.replace(POLITE, "").match(/^[a-z][a-z'-]*/)?.[0])) return true;
  for (const m of sentence.matchAll(/\b(?:(?:can|could|would|will) you|please|pls|just|then|and) (?:please )?([a-z][a-z'-]*)/g)) if (base(m[1])) return true;
  return false;
}

function scoreSentence(sentence: string, scores: Record<RoleId, number>, signals: Map<string, number>): void {
  const local = emptyScores();
  const seen = new Set<string>();
  const note = (label: string, weight: number) => signals.set(label, Math.max(signals.get(label) ?? 0, weight));
  const words = sentence.match(/[a-z][a-z'-]*/g) ?? [];
  const stems = new Set<string>();

  // "fix" with no problem described ("rename it and fix all imports") is a weaker sign of a bug than "fix the crash"
  let fixerEvidence = false;
  for (const w of words) {
    const s = stem(w);
    stems.add(s);
    const found = lookup(s);
    if (!found || seen.has(`w:${found.hit.stem}`)) continue;
    const { hit, typo } = found;
    seen.add(`w:${hit.stem}`);
    let weight = typo ? hit.weight * 0.9 : hit.weight;
    // "what has been developed" describes work that is done; a command uses the bare verb ("develop", "add")
    if ((hit.role === "writer" || hit.role === "extractor") && /ed$/.test(w)) weight *= 0.5;
    if (hit.role === "fixer" && !FIX_VERBS.has(hit.stem)) fixerEvidence = true;
    local[hit.role] += weight;
    note(`"${w}"`, weight);
  }

  for (const p of PHRASES) {
    const m = p.re.exec(sentence);
    if (!m) continue;
    if (p.role === "fixer") fixerEvidence = true;
    local[p.role] += p.weight;
    note(`"${m[0].trim()}"`, p.weight);
  }
  if (local.fixer > 0 && !fixerEvidence) local.fixer = Math.min(local.fixer, 2.5);

  // a command starts with its verb ("add pagination to the list"); a question about it does not
  const first = sentence.replace(POLITE, "").match(/^[a-z][a-z'-]*/)?.[0];
  // the bare verb only (a mistyped one counts too): "looks good" and "added it" are not commands
  if (first && !/(?:s|ed|ing)$/.test(first)) {
    const hit = lookup(stem(first))?.hit;
    if (hit && hit.role !== "autopilot") local[hit.role] += 1.5;
  }
  const creating = [...stems].some((s) => CREATION.has(s));
  if (creating && [...stems].some((s) => OBJECTS.has(s))) local.writer += 1;
  if (stems.has(stem("move")) && [...stems].some((s) => CODE_NOUNS.has(s))) local.extractor += 1.5;

  if (QUESTION.test(sentence.replace(/^\W+/, ""))) {
    // "how do I add a route?" asks for information; "why is the build failing?" usually asks for a diagnosis
    for (const r of ["writer", "extractor", "autopilot"] as RoleId[]) local[r] *= 0.4;
    local.fixer *= 0.7;
    local.reader += 1.5;
    note("a question", 1.5);
  }
  for (const r of Object.keys(local) as RoleId[]) scores[r] += local[r];
}

const ordered = (scores: Record<RoleId, number>, among: RoleId[]) =>
  [...among].sort((a, b) => scores[b] - scores[a] || PRIORITY.indexOf(a) - PRIORITY.indexOf(b));

/** What a "fix" mends as a side effect of other work: the imports a move broke, the names a rename left behind. */
const SUPPORTING_FIX = /\bfix(?:ing|es|ed)?\s+(?:up\s+)?(?:all\s+|the\s+|any\s+|every\s+|those\s+|these\s+)?(?:\w+\s+)?(?:imports?|references?|usages?|callers?|links?|paths?|names?|call sites?)\b/;

/** The parts of a request that can each be a task of their own: "add a cache, fix the flaky test, and tidy up". */
const CLAUSES = /\s*(?:[:;,]| and then | then | and also | and | also | plus )\s*/;

/**
 * The kind of editing work one clause asks for, if it is a kind of its own. A clause that only adds a test, or only
 * changes something existing, is part of the work around it ("fix the bug and add a test for it" is one task).
 */
function clauseKind(clause: string): RoleId | undefined {
  const local = emptyScores();
  scoreSentence(clause, local, new Map());
  const [top] = ordered(local, EDITING);
  if (local[top] < 2.5) return undefined;
  if (top === "fixer" && SUPPORTING_FIX.test(clause)) {
    // "fix all the imports" after a rename is part of the rename; it is a kind of its own only when something is wrong
    const rest = emptyScores();
    scoreSentence(clause.replace(/\b(?:fix|fixing|fixed|fixes|debug|repair|patch|troubleshoot)\w*\b/g, " "), rest, new Map());
    if (rest.fixer < 2) return undefined;
  }
  if (top === "writer") {
    const stems = (clause.match(/[a-z][a-z'-]*/g) ?? []).map(stem);
    const creates = stems.some((s) => CREATION.has(s)) || /\bnew\b/.test(clause);
    const objects = stems.filter((s) => OBJECTS.has(s));
    const testOnly = objects.length > 0 && objects.every((s) => s === stem("test")) && !/\bnew\b/.test(clause);
    if (!creates || testOnly) return undefined;
  }
  return top;
}

/** Words that are verbs of work, and also the names of things: "the add function", "the build", "the list". */
const NOUN_USES = new Set(["add", "build", "write", "make", "create", "generate", "implement", "develop", "document", "hook", "wire", "port", "draft", "compose", "show", "find", "list", "trace", "look", "check", "move", "split", "inline", "extract", "rename", "separate", "update", "change", "modify", "improve", "replace", "enable", "disable", "configure", "adjust", "tweak"].map(stem));
const DETERMINER_THEN_WORD = /\b(?:the|a|an|this|that|these|those|my|our|your|its|his|her|their|each|every|any|no)\s+([a-z][a-z'-]*)/g;

/** After a determiner, a verb of work is a name ("the add function"), so it carries no kind of work. */
const nounsOut = (text: string): string => text.replace(DETERMINER_THEN_WORD, (m, w: string) => (NOUN_USES.has(stem(w)) ? m.slice(0, m.length - w.length) + "thing" : m));

export function routeTask(prompt: string, evidence?: Evidence): Route {
  const text = nounsOut(
    prompt
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/\bmake sure\b/g, "ensure"),
  );
  const scores = emptyScores();
  const signals = new Map<string, number>();
  const notes: string[] = [];
  const wordCount = (text.match(/[a-z]+/g) ?? []).length;

  if (text.trim().startsWith("/")) {
    return { role: "none", confidence: "high", signals: ["a typed command"], alternatives: [], notes: [], scores };
  }

  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) scoreSentence(sentence, scores, signals);
  const kinds = new Set<RoleId>();
  for (const sentence of sentences) for (const clause of sentence.split(CLAUSES)) {
    const kind = clauseKind(clause);
    if (kind) kinds.add(kind);
  }

  const stripped = text.replace(NOT_A_BAN, "");
  const readOnly = READ_ONLY.some((re) => re.test(stripped));
  if (readOnly) {
    for (const r of EDITING) scores[r] *= 0.1;
    scores.autopilot *= 0.1;
    scores.reader += 3;
    signals.set("read-only wording", 3);
  }

  // A question that gives no order ("how risky is it to move X?") is not a request to edit, whatever verbs it mentions.
  const asking = /\?\s*$/.test(text.trim()) && !sentences.some(asksForEdit);
  if (asking) {
    for (const r of EDITING) scores[r] *= 0.15;
    scores.autopilot *= 0.15;
    signals.set("asked as a question", 1);
  }

  if (evidence && evidence.missing.length > 0) {
    const verbs = text.split(/\W+/).some((w) => CREATION.has(stem(w)));
    if (verbs && !readOnly) {
      scores.writer += 2;
      signals.set(`names ${evidence.missing[0]}, which is not in the repository`, 2);
    }
  }

  const topEdit = Math.max(...EDITING.map((r) => scores[r]));
  if (topEdit >= 2.5 && !readOnly) scores.reader *= 0.5; // reading is a means to the change, not the task

  const signalList = [...signals].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 4);
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const best = ordered(scores, SPECIALISTS)[0];

  const strongest = Math.max(...Object.values(scores));
  if (total < 1.5 || strongest < 2.5) {
    // a reply or a remark ("looks good", "sorry, I meant the other file") is mostly small words; a request is not
    const words = text.match(/[a-z][a-z'-]*/g) ?? [];
    const small = words.filter((w) => FUNCTION_WORDS.has(w)).length / Math.max(1, words.length);
    if (wordCount <= 3 || (wordCount <= 12 && small >= 0.6)) return { role: "none", confidence: "high", signals: [], alternatives: [], notes: [], scores };
    // a real request in words the router does not know: the generalist works out the kind itself
    notes.push("The request does not match any kind of work RIA recognises: work out which kind it is, and ask the user if it is unclear.");
    return { role: "autopilot", confidence: "low", signals: [], alternatives: [], notes, scores };
  }

  // two different kinds of editing work in one request: one role cannot do both well
  const [a, b] = ordered(scores, EDITING);
  const compound = !readOnly && !asking && kinds.size >= 2;
  // the generalist wins when asked for explicitly, and when it is the only one with anything to say
  const autopilotWins = (scores.autopilot >= 4 && scores.autopilot >= 0.85 * scores[best]) || scores.autopilot > scores[best];

  let role: RoleId;
  let alternatives: RoleId[];
  if (compound || autopilotWins) {
    role = "autopilot";
    const pair = kinds.size >= 2 ? ordered(scores, [...kinds]).slice(0, 2) : [a, b];
    alternatives = compound ? pair : [best];
    if (compound) signalList.unshift(`more than one kind of work (${pair.join(" and ")})`);
  } else {
    role = best;
    alternatives = ordered(scores, SPECIALISTS)
      .filter((r) => r !== best && scores[r] >= 0.6 * scores[best] && scores[r] >= 1.5)
      .slice(0, 2);
  }

  const top = scores[role] > 0 ? scores[role] : scores[best];
  const second = Math.max(...SPECIALISTS.filter((r) => r !== role).map((r) => scores[r]));
  let level = top >= 5 ? 2 : top >= 3 ? 1 : 0;
  if (!compound && top - second < 1) level = Math.max(0, level - 1);
  const confidence: Confidence = (["low", "medium", "high"] as const)[level];

  // Not sure which role that edits: the Autopilot names the role itself, so a wrong editing playbook is not injected
  // on thin evidence. A wrong role that only reads does no harm, so those keep their answer.
  if (confidence === "low" && (EDITING as string[]).includes(role)) {
    notes.push(`Not sure of the kind of work: it looks most like ${(roleById(role) as Role).title}, but check before following that role.`);
    return { role: "autopilot", confidence: "low", signals: signalList, alternatives: [role, ...alternatives].slice(0, 3), notes, scores };
  }

  if (evidence) {
    for (const p of evidence.missing) if (role !== "writer" && role !== "autopilot") notes.push(`"${p}" is not in the repository: a typo, or a file to create?`);
    for (const p of evidence.existing.slice(0, 3)) if (role === "writer") notes.push(`"${p}" already exists: do not overwrite it without asking.`);
  }
  return { role, confidence, signals: signalList, alternatives, notes, scores };
}

// ---------------------------------------------------------------- output

/** Paths the request names, split by whether the repository has them. */
export function pathEvidence(index: RepoIndex, prompt: string): Evidence {
  const found = new Set(prompt.match(/(?:[\w.@-]+\/)+[\w.-]+\.\w{1,6}\b|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|md|json|ya?ml|sh|css|html|sql|toml)\b/g) ?? []);
  const existing: string[] = [];
  const missing: string[] = [];
  for (const p of found) {
    const r = index.resolve(p);
    ("path" in r || "candidates" in r ? existing : missing).push(p);
  }
  return { existing, missing };
}

/** For the Claude Code hook: short, because it is added to every request that gets a role. */
export function hookContext(route: Route): string | undefined {
  if (route.role === "none") return undefined;
  const role = roleById(route.role) as Role;
  const why = route.signals.length ? ` (${route.signals.join(", ")})` : "";
  const unsure = route.confidence === "low" ? " I am not sure of this: if the request is really something else, follow the role that fits it." : "";
  const alt = route.alternatives.length ? ` It could also be: ${route.alternatives.map((a) => (roleById(a) as Role).title).join(" or ")}.` : "";
  return [
    `RIA routing: this request looks like work for the ${role.title} role, confidence ${route.confidence}${why}.${alt}${unsure}`,
    `As the ${role.title}: ${role.brief}`,
    `The full steps are in the skill ria-${role.id}, or call the RIA tool start_task. When the next request is a different kind of task, switch to the role that fits it; a short reply such as "yes" keeps this one.`,
  ].join("\n");
}

/** For the `start_task` tool and `ria route`: the decision, why, and the whole playbook. */
export function formatRoute(route: Route): string {
  if (route.role === "none") {
    return "RIA routing: this does not look like a new task (a follow-up, a remark or a typed command), so no role is needed. Carry on with what you were doing.";
  }
  const role = roleById(route.role) as Role;
  const out = [
    `RIA routing: ${role.title} (${route.role}), confidence ${route.confidence}`,
    route.signals.length ? `Because: ${route.signals.join(", ")}` : "Because: no strong wording, so the Autopilot is the safe choice",
  ];
  if (route.alternatives.length) out.push(`Could also be: ${route.alternatives.map((a) => (roleById(a) as Role).title).join(", ")}. If you can tell from the conversation, use that role instead and say so.`);
  for (const n of route.notes) out.push(`Note: ${n}`);
  out.push(
    role.edits ? "This role edits files, with a gate baseline." : "This role does not edit files.",
    "",
    `${role.title}: ${role.brief}`,
    "",
    playbook(role),
    "RIA chose this role from the wording of the request alone; it is a heuristic. If the request is really another kind of task, follow the role that fits it and say so in one line.",
  );
  return out.join("\n");
}

/** `start_task` with the repository's evidence about the paths the request names. */
export function startTask(index: RepoIndex, task: string): string {
  return formatRoute(routeTask(task, pathEvidence(index, task)));
}
