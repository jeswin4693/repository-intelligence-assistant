import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAULTS, GateEvalResult, evaluateGate, formatGateEval } from "../src/eval/gate-eval";

describe("the gate fault matrix", () => {
  it("covers every verdict the gate can give", () => {
    assert.deepEqual([...new Set(FAULTS.map((f) => f.expect))].sort(), ["improved", "mixed", "regressed", "unchanged", "unverified"]);
    assert.equal(new Set(FAULTS.map((f) => f.name)).size, FAULTS.length, "names are unique");
  });

  it("gets every verdict right and leaves the tree exactly as it was after every rollback", async () => {
    const r = await evaluateGate();
    assert.equal(r.results.length, FAULTS.length);
    assert.deepEqual(r.results.filter((x) => !x.ok), []);
    assert.equal(r.correct, FAULTS.length);
    assert.equal(r.restored, FAULTS.length);
  });

  it("notices a wrong verdict, a missing detail, and does not hide them", async () => {
    const wrongVerdict = { ...FAULTS[0], expect: "improved" as const };
    const wrongDetail = { ...FAULTS[0], expectText: /this text never appears/ };
    const r = await evaluateGate([wrongVerdict, wrongDetail]);
    assert.deepEqual(r.results.map((x) => [x.ok, x.got, x.textOk]), [[false, "regressed", true], [false, "regressed", false]]);
    assert.equal(r.correct, 0);
    assert.equal(r.restored, 2, "the rollback is checked on its own");
    const text = formatGateEval(r);
    assert.match(text, /FAIL a logic bug that breaks a test +regressed \(expected improved\)/);
    assert.match(text, /\[report is missing the expected detail\]/);
  });
});

describe("formatGateEval", () => {
  it("says what was checked and what it does not show", () => {
    const result: GateEvalResult = {
      results: [
        { name: "first", expect: "regressed", got: "regressed", textOk: true, restored: true, ok: true },
        { name: "second case", expect: "improved", got: "improved", textOk: true, restored: false, ok: false },
        { name: "third", expect: "unchanged", got: "unverified", textOk: true, restored: true, ok: false, failure: "boom" },
      ],
      correct: 2,
      restored: 2,
    };
    const text = formatGateEval(result);
    assert.match(text, /^Gate fault matrix: 2 of 3 verdicts correct, 2 of 3 rollbacks left the tree byte for byte as it was/);
    assert.match(text, /ok {3}first {8}regressed\n/);
    assert.match(text, /FAIL second case {2}improved {2}\[rollback did not restore the tree\]/);
    assert.match(text, /FAIL third {8}unverified \(expected unchanged\) {2}\[error: boom\]/);
    assert.match(text, /decided from what the change does, before running it/);
    assert.match(text, /do not measure how it does on a project it has never seen/);
  });
});
