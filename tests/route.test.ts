import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePromptInput, promptHookOutput } from "../src/hooks/prompt";
import { ROLES } from "../src/init/roles";
import { formatRoute, hookContext, routeTask, stem } from "../src/tools/route";
import { Case, Expected, SET_A, SET_B, SET_D, SET_E } from "./route-cases";

const role = (prompt: string) => routeTask(prompt).role;

describe("the router's word handling", () => {
  it("reduces inflected forms to one stem, and tolerates one slip of the fingers", () => {
    assert.equal(stem("creating"), stem("create"));
    assert.equal(stem("created"), stem("creates"));
    assert.equal(stem("fixes"), stem("fix"));
    // a swapped pair of letters, a missing letter
    assert.equal(role("creaet a new python script to export users"), "writer");
    assert.equal(role("chnage the timeout bug in uploader, it hangs forever"), "fixer");
    assert.equal(role("implment the forgot password flow"), "writer");
    // a single wrong letter in a short word is not a typo: SQLite is not "split"
    assert.notEqual(role("Weigh up using SQLite versus Postgres for the tests"), "extractor");
  });

  it("does not take a past tense for a command: 'what developed' asks about work that is done", () => {
    assert.notEqual(role("Tell in simple that what till developed?"), "writer");
    assert.equal(role("develop a billing report page"), "writer");
  });

  it("reads a verb of work after 'the' or 'a' as a name: 'the add function' is not a request to add", () => {
    // found by running the hook in a real Claude Code session: this went to the Autopilot as "write and fix"
    const r = routeTask("the add function returns the wrong result and the test fails. fix it");
    assert.equal(r.role, "fixer");
    assert.notEqual(r.confidence, "low");
    assert.equal(role("fix the add function"), "fixer");
    assert.equal(role("run the build and tell me what fails"), "reader");
    // but the verb still counts when nothing introduces it as a name
    assert.equal(role("Add the new login button"), "writer");
    assert.equal(role("add a build step that runs the linter"), "writer");
  });

  it("does not take VS Code for a comparison", () => {
    assert.notEqual(role("it should work with the chat in VS code for any task in the repo"), "analyser");
    assert.equal(role("Compare Redux Toolkit vs Zustand for this codebase"), "analyser");
  });
});

describe("what kind of request it is", () => {
  it("keeps the questions that ask for information away from the roles that edit", () => {
    assert.equal(role("Rough effort to move the cron jobs into a queue worker?"), "analyser");
    assert.equal(role("any problems with how I handled errors in this commit?"), "reviewer");
    assert.equal(role("how do I add a new route here?"), "reader");
    // but a polite order that ends in a question mark is still an order
    assert.equal(role("Can you document the public functions in utils.py with docstrings?"), "writer");
    assert.equal(role("the login breaks after the update, can you fix it?"), "fixer");
  });

  it("honours 'do not change anything' and still lets 'without changing behaviour' mean a refactor", () => {
    const r = routeTask("explain how to fix this error, don't change anything yet");
    assert.equal(r.role, "reader");
    assert.ok(r.signals.includes("read-only wording"));
    assert.equal(role("just read the file and tell me, do not edit it"), "reader");
    assert.equal(role("extract the email sending logic into a service without changing behaviour"), "extractor");
  });

  it("treats a fix plus a test for it as one fix, and a rename plus the imports as one rename", () => {
    assert.equal(role("fix the login bug and add a unit test for it"), "fixer");
    assert.equal(role("Rename the module 'helpers' to 'common' and fix all imports"), "extractor", "not split into two kinds of work");
    assert.equal(role("move the helper into utils and update the imports"), "extractor");
  });

  it("sends a request with two kinds of work to the autopilot, and says which", () => {
    const r = routeTask("Add dark mode and fix the sidebar overflow on small screens");
    assert.equal(r.role, "autopilot");
    assert.match(r.signals[0], /more than one kind of work \((writer and fixer|fixer and writer)\)/);
    assert.equal(r.confidence, "high");
    assert.deepEqual([...r.alternatives].sort(), ["fixer", "writer"]);
    assert.equal(role("I have a few things: add a cache, fix the flaky login test, and tidy up the config"), "autopilot");
    assert.equal(role("autopilot: migrate from moment to date-fns"), "autopilot");
  });

  it("says nothing for a follow-up, a remark or a typed command", () => {
    for (const prompt of ["yes", "Yes, start", "continue", "DO the next  furtur things", "thanks", "ok commit it with a short message", "Commit and push the code in repo", "sorry, I meant the other file", "/compact", "looks good"]) {
      assert.equal(role(prompt), "none", prompt);
    }
    assert.deepEqual(routeTask("/compact").signals, ["a typed command"]);
  });

  it("does not guess an editing role on thin evidence: the autopilot names the role itself", () => {
    const r = routeTask("the team wants us to implment retries");
    assert.equal(r.role, "autopilot");
    assert.equal(r.confidence, "low");
    assert.deepEqual(r.alternatives, ["writer"]);
    const sure = routeTask("fix the failing test in tests/tax.test.ts");
    assert.equal(sure.role, "fixer");
    assert.notEqual(sure.confidence, "low");
    // a role that only reads does no harm when it is a guess, so it keeps its answer
    assert.equal(routeTask("how many services talk to the queue?").role, "reader");
  });

  it("hands a long request in unknown words to the autopilot instead of ignoring it", () => {
    const r = routeTask("Kindly arrange for the quarterly numbers screen to present a rolling twelve month window instead of calendar quarters");
    assert.equal(r.role, "autopilot");
    assert.match(r.notes.join(" "), /does not match any kind of work RIA recognises/);
  });

  it("uses what the repository says about a path the request names", () => {
    const r = routeTask("make src/new-thing.ts", { existing: [], missing: ["src/new-thing.ts"] });
    assert.equal(r.role, "writer");
    assert.ok(r.signals.includes("names src/new-thing.ts, which is not in the repository"));
    const typo = routeTask("explain how src/nope.ts works", { existing: [], missing: ["src/nope.ts"] });
    assert.match(typo.notes.join(" "), /not in the repository: a typo, or a file to create\?/);
  });

  it("gives the same answer every time, however long the request", () => {
    const text = "Please review PR #88 and also tell me what would break if we merge it. ".repeat(20);
    assert.deepEqual(routeTask(text), routeTask(text));
    assert.ok(routeTask(text).role !== undefined);
  });
});

/** right: the role the person wanted (or another one that fits); fallback: none or the autopilot for a task; wrong: any other role, or a role for a remark. */
function judge(set: Case[]): { right: number; fallback: number; wrong: number; n: number; misses: string[] } {
  let right = 0;
  let fallback = 0;
  let wrong = 0;
  const misses: string[] = [];
  for (const [prompt, want, also = []] of set) {
    const got = role(prompt);
    if (got === want || (also as Expected[]).includes(got)) right++;
    else if (want !== "none" && (got === "autopilot" || got === "none")) fallback++;
    else {
      wrong++;
      misses.push(`want ${want}, got ${got}: ${prompt.slice(0, 70)}`);
    }
  }
  return { right, fallback, wrong, n: set.length, misses };
}

describe("how well it routes prompts written by hand", () => {
  // The prompts are the author's own, in sets written at different times (see tests/route-cases.ts). A and B and D were
  // used to tune the rules; E was measured once before anything was changed for it (80% right, 8% wrong at that point).
  // These floors sit just under the numbers today, so a change cannot quietly make the router worse.
  const floors: [string, Case[], number, number][] = [
    ["A", SET_A, 0.95, 0.01],
    ["B", SET_B, 0.9, 0.03],
    ["D", SET_D, 0.9, 0.03],
    ["E", SET_E, 0.8, 0.03],
  ];
  for (const [name, set, minRight, maxWrong] of floors) {
    it(`set ${name}: at least ${minRight * 100}% right and at most ${maxWrong * 100}% wrong`, () => {
      const j = judge(set);
      assert.ok(j.right / j.n >= minRight, `${j.right}/${j.n} right\n${j.misses.join("\n")}`);
      assert.ok(j.wrong / j.n <= maxWrong, `${j.wrong}/${j.n} wrong\n${j.misses.join("\n")}`);
    });
  }

  it("never sends a request that only asks for information to a role that edits", () => {
    const editing = ["writer", "fixer", "extractor"];
    for (const [prompt, want, also = []] of [...SET_A, ...SET_B, ...SET_D, ...SET_E]) {
      if (!["reader", "analyser", "reviewer"].includes(want) || (also as string[]).some((a) => editing.includes(a))) continue;
      assert.ok(!editing.includes(role(prompt)), `${JSON.stringify(prompt.slice(0, 70))} went to ${role(prompt)}`);
    }
  });
});

describe("what the chat is told", () => {
  it("keeps the per-request hint short, names the role, and says what to do when it is wrong", () => {
    for (const [prompt, title] of [
      ["create a new file src/utils/slugify.ts that exports a slugify function", "Writer"],
      ["fix the failing test in tests/tax.test.ts", "Fixer"],
      ["explain how authentication works in this project", "Reader"],
      ["should we use a queue or a cron job for sending the reports?", "Analyser"],
      ["refactor the order processing code into smaller functions", "Extractor"],
      ["review my changes before I commit", "Reviewer"],
    ] as const) {
      const text = hookContext(routeTask(prompt)) as string;
      assert.match(text, new RegExp(`^RIA routing: this request looks like work for the ${title} role, confidence`), prompt);
      assert.match(text, new RegExp(`As the ${title}: `));
      assert.match(text, /skill ria-[a-z]+, or call the RIA tool start_task/);
      assert.match(text, /switch to the role that fits it/);
      assert.ok(text.length < 1500, `${title} hint is ${text.length} characters; Claude Code caps a hook's context at 10,000`);
    }
    assert.equal(hookContext(routeTask("yes")), undefined);
  });

  it("says when it is unsure, and which other roles fit", () => {
    const r = routeTask("the team wants us to implment retries");
    assert.equal(r.role, "autopilot");
    assert.match(r.notes.join(" "), /Not sure of the kind of work: it looks most like Writer/);
    const text = hookContext(r) as string;
    assert.match(text, /Autopilot role, confidence low/);
    assert.match(text, /It could also be: Writer/);
    assert.match(text, /I am not sure of this/);
  });

  it("returns the whole playbook of the chosen role for start_task, and none for a read-only role's edits", () => {
    const fix = formatRoute(routeTask("fix the failing test in tests/tax.test.ts"));
    assert.match(fix, /^RIA routing: Fixer \(fixer\), confidence/);
    assert.match(fix, /This role edits files, with a gate baseline\./);
    for (const heading of ["## Steps", "## Stop when", "## Report", "## Work efficiently", "## When the task changes kind", "## Limits"]) assert.ok(fix.includes(heading), heading);
    assert.match(fix, /it is a heuristic/);

    const analyse = formatRoute(routeTask("compare the two approaches for caching: in-memory vs redis"));
    assert.match(analyse, /Analyser/);
    assert.match(analyse, /This role does not edit files\./);
    assert.match(analyse, /`plan_score`/);

    const reader = formatRoute(routeTask("where is the retry logic implemented?"));
    assert.doesNotMatch(reader, /`plan_score`/, "the reader is not given a tool it cannot call");
    assert.match(reader, /This role cannot edit\. When the request needs a change, say which role fits and ask the user to switch/);
  });

  it("has a brief for every role, short enough to add to every request", () => {
    for (const r of ROLES) {
      assert.ok(r.brief.length > 150 && r.brief.length < 650, `${r.id} brief is ${r.brief.length} characters`);
      assert.ok(r.brief.length < r.steps.join(" ").length, `${r.id}: the brief is shorter than the steps`);
    }
  });
});

describe("ria hook prompt, run the way Claude Code runs it", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const cliEntry = path.join(projectRoot, "src", "index.ts");
  const run = (stdin: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "hook", "prompt"], { cwd: projectRoot, env, input: stdin, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("parses the request out of the hook's input, and out of nothing useful", () => {
    assert.equal(parsePromptInput(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" })), "fix the bug");
    for (const odd of ["", "not json", "null", "[]", `{"prompt":42}`, "{}"]) assert.equal(parsePromptInput(odd), "", odd);
    assert.equal(promptHookOutput(""), undefined);
    assert.equal(promptHookOutput("   "), undefined);
  });

  it("routes only what a person typed: not a message Claude Code delivers itself, nor a subagent's prompt", () => {
    // the shape of the second call seen in a real run, when a background subagent finished and reported back
    const notification = "<task-notification>\n<task-id>aea1a4bcfcae0445d</task-id>\n<summary>Agent completed: the retry logic is fixed, it extracts the parser and fixes the imports</summary>\n</task-notification>";
    assert.equal(promptHookOutput(notification), undefined, "a subagent's report is not a request");
    assert.equal(promptHookOutput("<system-reminder>Fix the build. Create a file.</system-reminder>"), undefined);
    assert.equal(promptHookOutput("<local-command-stdout>fixed 3 files</local-command-stdout>"), undefined);

    // a newer Claude Code names the subagent in the hook's input
    assert.equal(parsePromptInput(JSON.stringify({ prompt: "fix the bug in cart.ts", agent_id: "abc" })), "");
    assert.equal(parsePromptInput(JSON.stringify({ prompt: "fix the bug in cart.ts", agent_type: "Explore" })), "");
    assert.equal(parsePromptInput(JSON.stringify({ prompt: "fix the bug in cart.ts" })), "fix the bug in cart.ts");

    // what the editor has open comes before the typed text and says nothing about the request
    const typed = promptHookOutput("<ide_opened_file>The user opened src/fixer.ts and the fixed build extracts a parser.</ide_opened_file>\nexplain how the router works");
    assert.match(JSON.parse(typed as string).hookSpecificOutput.additionalContext, /looks like work for the Reader role/);
    assert.equal(promptHookOutput("<ide_opened_file>The user opened a.ts</ide_opened_file>"), undefined, "only editor context: nothing was asked");

    // ordinary text that happens to start with a tag is still a request
    assert.match(JSON.parse(promptHookOutput("<div class=\"x\"> is broken after the update, please fix it") as string).hookSpecificOutput.additionalContext, /Fixer role/);
  });

  it("tells the chat how to load and call RIA's deferred tools, in a hint that still fits the budget", () => {
    const text = hookContext(routeTask("fix the failing test in tests/tax.test.ts")) as string;
    assert.match(text, /mcp__ria__start_task/);
    assert.match(text, /load them once with ToolSearch \(select:mcp__ria__start_task,mcp__ria__context_for\), then call them: loading a tool is not calling it/);
    assert.ok(text.length < 1800, `hint is ${text.length} characters`);
  });

  it("prints the JSON Claude Code adds to the request's context, or nothing", () => {
    const task = run(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "create a new file src/utils/slugify.ts that exports a slugify function" }));
    assert.equal(task.status, 0, task.stderr);
    const out = JSON.parse(task.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /looks like work for the Writer role/);
    assert.equal(Object.keys(out).join(), "hookSpecificOutput", "it never blocks a request or rewrites it");

    const reply = run(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "yes, go ahead" }));
    assert.equal(reply.status, 0);
    assert.equal(reply.stdout, "");
    assert.equal(run("").stdout, "", "a hook with no input adds nothing");
    assert.equal(run("garbage").status, 0, "and does not fail");
  });
});
