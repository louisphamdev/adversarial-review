// ROUND7 regression (GPT-5.5-xhigh): buildReviewDiff returned a vacuous EMPTY diff for
// a NON-NULL baseline with an unrecognized shape (a corrupted/forged baseline), which
// evaluateGate would read as a clean, change-free workspace (fail-OPEN). An unrecognized
// non-null baseline must THROW so the gate's diff===null path fails closed. A genuinely
// ABSENT (null/undefined) baseline must still return the empty diff (no over-block).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { buildReviewDiff } from "../../src/core/diff.js";

describe("ROUND7 buildReviewDiff: unrecognized baseline shape fails closed", () => {
  const cwd = tmpdir();

  it("throws on a baseline with an unknown type", async () => {
    await assert.rejects(() => buildReviewDiff(cwd, { type: "bogus" }), /unrecognized_baseline_shape/);
  });

  it("throws on a git baseline missing its head", async () => {
    await assert.rejects(() => buildReviewDiff(cwd, { type: "git" }), /unrecognized_baseline_shape/);
  });

  it("throws on a non-empty object with no type", async () => {
    await assert.rejects(() => buildReviewDiff(cwd, { foo: 1 }), /unrecognized_baseline_shape/);
  });

  it("does NOT throw for a null baseline (returns an empty diff)", async () => {
    const diff = await buildReviewDiff(cwd, null);
    assert.deepEqual(diff.changedFiles, []);
    assert.equal(diff.text, "");
  });

  it("does NOT throw for an undefined baseline (returns an empty diff)", async () => {
    const diff = await buildReviewDiff(cwd, undefined);
    assert.deepEqual(diff.changedFiles, []);
  });
});
