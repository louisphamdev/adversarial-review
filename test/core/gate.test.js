import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  evaluateGate,
  classifyLevel,
  allow,
  block,
  advisory,
  canonicalizePath,
  citationVariants,
} from "../../src/core/gate.js";
import { captureBaseline, buildReviewDiff } from "../../src/core/diff.js";
import { mergeConfig } from "../../src/core/config.js";
import { readSessionState } from "../../src/core/state.js";
import { sha256, stableJson } from "../../src/core/hash.js";

// ---------------------------------------------------------------------------
// Helpers: build a real filesystem baseline + workspace so buildReviewDiff
// produces a genuine diff (no git required).
// ---------------------------------------------------------------------------

// Create a temp workspace, write the given `before` files, capture a filesystem
// baseline, then write/overwrite the `after` files. Returns { cwd, baseline }.
async function makeWorkspace(before, after) {
  const cwd = await mkdtemp(join(tmpdir(), "ar-gate-"));
  for (const [rel, body] of Object.entries(before || {})) {
    const abs = join(cwd, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  const baseline = await captureBaseline(cwd);
  for (const [rel, body] of Object.entries(after || {})) {
    const abs = join(cwd, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return { cwd, baseline };
}

// Minimal transcript with one Edit tool_use so edit evidence exists.
function editTranscript(filePath = "src/x.js", ts = "2026-06-13T10:00:00Z") {
  return JSON.stringify({
    timestamp: ts,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Edit", id: "t1", input: { file_path: filePath } }],
    },
  });
}

// A reviewerRunner stub returning a fixed result.
function stubRunner(result) {
  return async () => result;
}

// Build a valid verdict object matching a job. The gate computes payloadHash as
// sha256(stableJson({ diff, level, changedFiles })) — replicate that here.
function makeVerdict(job, { verdict = "pass", coverage, payloadHash } = {}) {
  return {
    job_id: job.jobId,
    diff_hash: job.diffHash,
    payload_hash: payloadHash ?? job.payloadHash,
    reviewer: job.reviewer,
    level: job.level,
    verdict,
    findings: [],
    coverage: coverage ?? { files_examined: job.changedFiles },
    dimensions: { Correctness: "ok", Security: "ok", Tests: "ok" },
  };
}

// Verdict block sentinels (must match src/core/verdict.js).
const VERDICT_START = "<<<ADVERSARIAL-REVIEW-VERDICT>>>";
const VERDICT_END = "<<<END>>>";

// Wrap a verdict object in the verdict-block sentinels exactly as parseVerdict
// expects (start marker, JSON body, end marker, no trailing output).
function wrapVerdict(verdictObj) {
  return `${VERDICT_START}\n${JSON.stringify(verdictObj)}\n${VERDICT_END}`;
}

// Build a transcript: an Edit, then a COMPLETED self-review Task whose
// tool_result OUTPUT contains the given verdict-block text. The Task's input
// carries the gate sentinel only as a pre-filter; acceptance is verdict-based.
function selfReviewTranscript(filePath, outputText, {
  editTs = "2026-06-13T10:00:00Z",
  reviewTs = "2026-06-13T10:05:00Z",
  resultTs = "2026-06-13T10:06:00Z",
  toolId = "rev1",
} = {}) {
  return [
    editTranscript(filePath, editTs),
    JSON.stringify({
      timestamp: reviewTs,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Task",
            id: toolId,
            input: { prompt: "run the adversarial-review-gate self review" },
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: resultTs,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: outputText }],
      },
    }),
  ].join("\n");
}

// Run the gate once with no completed review to obtain the self-review BLOCK,
// which carries the exact { jobId, diffHash, payloadHash } contract. Returns a
// job-shaped object usable by makeVerdict for the "self" reviewer. `changedFiles`
// is the list of reviewable changed-file paths to claim as coverage.
async function selfReviewJobFor(cwd, baseline, filePath, changedFiles, { config } = {}) {
  const decision = await evaluateGate({
    config: config ?? mergeConfig(),
    cwd,
    baseline,
    transcript: editTranscript(filePath),
    host: { reviewerMapping: "none" },
    stateDir: await tmpStateDir(),
  });
  assert.equal(decision.action, "block");
  assert.equal(decision.selfReview, true);
  return {
    jobId: decision.jobId,
    diffHash: decision.diffHash,
    payloadHash: decision.payloadHash,
    reviewer: "self",
    level: decision.level,
    changedFiles,
  };
}

// Capture the job a runner receives so the test can craft a matching verdict.
function capturingRunner(resultFor) {
  const calls = [];
  const runner = async (job) => {
    calls.push(job);
    return resultFor(job);
  };
  runner.calls = calls;
  return runner;
}

let dirs = [];
function track(cwd) {
  dirs.push(cwd);
  return cwd;
}
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tmpStateDir() {
  return track(await mkdtemp(join(tmpdir(), "ar-state-")));
}

// ---------------------------------------------------------------------------
// canonicalizePath / citationVariants (COLLISION-1/2/3a unit coverage)
// ---------------------------------------------------------------------------

describe("canonicalizePath (COLLISION-2)", () => {
  it("collapses leading './/' to a clean relative path (no stray leading /)", () => {
    assert.equal(canonicalizePath(".//src/x.js"), "src/x.js");
  });

  it("collapses a single leading './' to a clean relative path", () => {
    assert.equal(canonicalizePath("./src/x.js"), "src/x.js");
  });

  it("collapses repeated './' and internal '//' runs", () => {
    assert.equal(canonicalizePath("././src//x.js"), "src/x.js");
  });

  it("normalizes backslashes and trims surrounding whitespace", () => {
    assert.equal(canonicalizePath("  src\\x.js  "), "src/x.js");
  });

  it("does NOT strip a leading 'a/' or 'b/' (reviewable-path safety)", () => {
    // canonicalizePath alone must preserve a real top-level 'a/'/'b/' directory.
    assert.equal(canonicalizePath("a/x.js"), "a/x.js");
    assert.equal(canonicalizePath("b/src/x.js"), "b/src/x.js");
  });

  it("does NOT strip a trailing ':<digits>' suffix (real filename safety)", () => {
    assert.equal(canonicalizePath("src/weird:12"), "src/weird:12");
  });
});

describe("citationVariants (COLLISION-1/3a)", () => {
  // HARDENING (audit COLLISION-1/2/3): citationVariants no longer emits a GLOBALLY
  // matchable 'a/'/'b/'-prefix-stripped variant. The git-diff header form is matched
  // PATH-SPECIFICALLY in coverageFailure instead (covered by the evaluateGate tests
  // below), so a 'b/src/x.js' citation can only cover 'src/x.js', never a distinct
  // top-level file.
  it("does NOT manufacture a 'b/'-prefix-stripped global variant", () => {
    const v = citationVariants("b/src/x.js");
    assert.deepEqual(v, ["b/src/x.js"], "no free-floating 'src/x.js' strip");
  });

  it("does NOT manufacture an 'a/'-prefix-stripped global variant", () => {
    const v = citationVariants("a/src/x.js");
    assert.deepEqual(v, ["a/src/x.js"], "no free-floating 'src/x.js' strip");
  });

  it("keeps the exact ':<line>'-bearing form AND its stripped form, exact first", () => {
    const v = citationVariants("src/weird:12");
    assert.equal(v[0], "src/weird:12", "exact form must be preferred (listed first)");
    assert.ok(v.includes("src/weird"));
  });

  it("expands 'src/a.js:3' to include the line-stripped 'src/a.js'", () => {
    const v = citationVariants("src/a.js:3");
    assert.ok(v.includes("src/a.js:3"));
    assert.ok(v.includes("src/a.js"));
  });

  it("does NOT manufacture an 'a/'-stripped form for a plain path", () => {
    const v = citationVariants("src/x.js");
    assert.deepEqual(v, ["src/x.js"]);
  });

  // Finding #4: an 'a/'+':line' citation must NOT yield a malformed prefix-stripped-
  // but-line-retained variant like 'x.js:12', and must NOT emit a global 'x.js' strip.
  it("does NOT emit a malformed prefix-stripped ':line' variant for 'a/x.js:12'", () => {
    const v = citationVariants("a/x.js:12");
    assert.deepEqual(v, ["a/x.js:12", "a/x.js"]);
    assert.ok(!v.includes("x.js:12"), "no malformed prefix-stripped+line variant");
    assert.ok(!v.includes("x.js"), "no free-floating prefix-stripped variant");
  });
});

// ---------------------------------------------------------------------------
// classifyLevel
// ---------------------------------------------------------------------------

describe("classifyLevel", () => {
  const config = mergeConfig();

  it("returns none when no reviewable files", () => {
    const level = classifyLevel({
      config,
      changedFiles: [{ path: "README.md" }],
      diffStats: { lines: 5, fileCount: 1 },
    });
    assert.equal(level, "none");
  });

  it("returns at least single for any reviewable file in all-code", () => {
    const level = classifyLevel({
      config,
      changedFiles: [{ path: "src/x.js" }],
      diffStats: { lines: 3, fileCount: 1 },
    });
    assert.equal(level, "single");
  });

  it("escalates to debate on sensitive change", () => {
    const level = classifyLevel({
      config,
      changedFiles: [{ path: "src/auth/login.js" }],
      diffStats: { lines: 3, fileCount: 1 },
    });
    assert.equal(level, "debate");
  });

  it("escalates to debate on large line count", () => {
    const level = classifyLevel({
      config,
      changedFiles: [{ path: "src/x.js" }],
      diffStats: { lines: 300, fileCount: 1 },
    });
    assert.equal(level, "debate");
  });
});

// ---------------------------------------------------------------------------
// evaluateGate: step-5 list
// ---------------------------------------------------------------------------

describe("evaluateGate basic policy", () => {
  it("allows when there are no edits", async () => {
    const { cwd, baseline } = await makeWorkspace({ "a.txt": "x" }, {});
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: "",
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "no_edits");
  });

  it("allows docs-only changes", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "README.md": "# hello\nmore\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("README.md"),
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "docs_only");
  });

  it("requires review for small code change in enforced (self-review block)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
  });

  it("advisory-allows small code change in soft mode", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const config = mergeConfig({ policy: { mode: "soft", allowSkip: true } });
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      // Latest user msg asks to skip; allowSkip true in soft -> advisory allow.
      transcript:
        editTranscript("src/x.js") +
        "\n" +
        JSON.stringify({
          timestamp: "2026-06-13T10:01:00Z",
          type: "user",
          message: { role: "user", content: "please skip the review now" },
        }),
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.ok(decision.skipped || decision.systemMessage);
  });

  it("escalates sensitive path to debate self-review", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/auth/login.js": "x\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/auth/login.js"),
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.level, "debate");
  });

  it("ignores skip when allowSkip is false", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced, allowSkip false
      cwd,
      baseline,
      transcript:
        editTranscript("src/x.js") +
        "\n" +
        JSON.stringify({
          timestamp: "2026-06-13T10:01:00Z",
          type: "user",
          message: { role: "user", content: "skip the review please" },
        }),
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    // Skip ignored -> still blocks for self-review.
    assert.equal(decision.action, "block");
  });

  it("allows when a VALID self-review verdict completed after the last edit", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    // Obtain the exact self-review contract (jobId/diffHash/payloadHash) the gate
    // requires, then craft a matching verdict block and feed it back.
    const job = await selfReviewJobFor(cwd, baseline, "src/x.js", ["src/x.js"]);
    const verdict = makeVerdict(job, { verdict: "pass" });
    const transcript = selfReviewTranscript("src/x.js", wrapVerdict(verdict));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "already_reviewed");
  });

  // BUG B (forgery): a completed Task whose OUTPUT merely contains the sentinel
  // token but NO valid verdict block must NOT count as a review.
  it("BLOCKS when a completed Task output has the sentinel token but no verdict", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const transcript = selfReviewTranscript(
      "src/x.js",
      "OK (token: adversarial-review-gate)"
    );
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
  });

  // BUG A (freshness): a valid verdict for diff D1, then a NON-Edit change makes
  // the current diffHash D2 != D1, so the stale verdict no longer matches.
  it("BLOCKS when a post-review non-Edit change makes the verdict stale", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    // Valid verdict for the original diff D1.
    const job = await selfReviewJobFor(cwd, baseline, "src/x.js", ["src/x.js"]);
    const verdict = makeVerdict(job, { verdict: "pass" });
    const transcript = selfReviewTranscript("src/x.js", wrapVerdict(verdict));

    // Simulate a NON-Edit change (generator/Bash): add a reviewable file on disk
    // AFTER the review. lastEditKey is unchanged, but the current diffHash is now
    // D2 != D1, so the stale verdict (diff_hash=D1) must be rejected.
    await writeFile(join(cwd, "src", "backdoor.js"), "const evil = 1;\n");

    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
  });

  // Coverage failure: a valid verdict whose coverage omits a reviewable changed
  // file is an operational failure → blocks in enforced.
  it("BLOCKS when a valid self-review verdict omits a reviewable changed file", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/x.js": "const a = 1;\n", "src/y.js": "const b = 2;\n" }
    );
    track(cwd);
    // Build the contract; claim coverage for only ONE of the two reviewable files.
    const job = await selfReviewJobFor(cwd, baseline, "src/x.js", ["src/x.js"]);
    const verdict = makeVerdict(job, {
      verdict: "pass",
      coverage: { files_examined: ["src/x.js"] }, // omits src/y.js
    });
    const transcript = selfReviewTranscript("src/x.js", wrapVerdict(verdict));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
  });

  it("blocks empty diff with edit evidence in enforced (internal error fail-closed)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, {}); // no actual file change
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"), // edit evidence, but empty diff
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
  });

  it("self-review none emits orchestrator instruction (not a pass)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "none" },
      reviewerRunner: undefined,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
    assert.match(decision.reason, /self-review orchestrator/i);
  });

  // Finding #7 (LOW, defense-in-depth): in SOFT mode a self-review pass must still
  // be bound to what was examined. A verdict with empty coverage and a mismatched
  // payload_hash is rejected (deferred checks now run in EVERY mode), so a loosened/
  // non-canonical mode cannot exploit a binding-free soft self-review.
  it("soft self-review with empty coverage + mismatched payload_hash is rejected", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const config = mergeConfig({ policy: { mode: "soft", allowSkip: false } });
    const job = await selfReviewJobFor(cwd, baseline, "src/x.js", ["src/x.js"], { config });
    // Forge: empty coverage + deliberately wrong payload_hash, still a "pass".
    const forged = makeVerdict(job, {
      verdict: "pass",
      coverage: { files_examined: [] },
      payloadHash: "deadbeef-wrong-hash",
    });
    const transcript = selfReviewTranscript("src/x.js", wrapVerdict(forged));
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "soft mode must not accept binding-free self-review");
    assert.equal(decision.selfReview, true);
  });

  // Finding #7: a WELL-FORMED soft self-review (correct payload_hash + coverage of
  // every reviewable file) is still accepted as a pass.
  it("soft self-review with valid payload_hash + full coverage is accepted", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const config = mergeConfig({ policy: { mode: "soft", allowSkip: false } });
    const job = await selfReviewJobFor(cwd, baseline, "src/x.js", ["src/x.js"], { config });
    const verdict = makeVerdict(job, { verdict: "pass" });
    const transcript = selfReviewTranscript("src/x.js", wrapVerdict(verdict));
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript,
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "already_reviewed");
  });
});

// ---------------------------------------------------------------------------
// External reviewer + deferred checks
// ---------------------------------------------------------------------------

describe("evaluateGate external reviewer", () => {
  it("valid fail blocks and does NOT run self-review", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: { ...makeVerdict(job, { verdict: "fail" }), verdict: "fail" },
    }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.notEqual(decision.selfReview, true);
    assert.match(decision.reason, /review FAILED/i);
  });

  it("operational failure blocks in enforced (reviewerErrorAction)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: stubRunner({ ok: false, error: "timeout" }),
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.reviewerError, "timeout");
  });

  it("pass with mismatched payload_hash is operational failure (blocks enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { payloadHash: "deadbeef" }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    // HARDENING (finding: payload_hash is not validated): validateVerdict now binds
    // payload_hash for any job carrying a payloadHash, so the gate's re-validation
    // rejects the mismatch EARLIER (as invalid_verdict:payload_hash_mismatch) than
    // the enforced-only deferred check. Either way it blocks; the binding now also
    // covers the SOFT external path (regression below).
    assert.match(decision.reviewerError, /payload_hash_mismatch/);
  });

  // Finding (payload_hash is not validated): the binding must hold on the SOFT
  // external path too, not only enforced. Previously the deferred check ran only in
  // enforced mode, so a forged payload_hash passed as external_pass in soft mode.
  it("SOFT external pass with mismatched payload_hash is now rejected (blocks)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { payloadHash: "deadbeef-wrong" }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ policy: { mode: "soft", allowSkip: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.notEqual(decision.action, "allow", "forged payload_hash must not pass in soft mode");
    assert.match(decision.reviewerError, /payload_hash_mismatch/);
  });

  it("pass with empty coverage is operational failure (blocks enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: [] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.reviewerError, "empty_coverage");
  });

  it("pass missing coverage for a reviewable file is operational failure", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/x.js": "const a = 1;\n", "src/y.js": "const b = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      // Only examine one of the two reviewable files.
      verdict: makeVerdict(job, { coverage: { files_examined: ["src/x.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reviewerError, /missing_coverage/);
  });

  // FIX A: coverage comparison must be robust to the path FORM the reviewer cites.
  // A real PASS for a changed file `src/x.js` must be ALLOWED when files_examined
  // uses a git "b/" prefix, the bare basename, a "./" prefix, or a ":<line>" suffix.
  for (const [label, examined] of [
    ["b/<path> git-diff prefix", ["b/src/x.js"]],
    ["a/<path> git-diff prefix", ["a/src/x.js"]],
    ["bare basename", ["x.js"]],
    ["./ leading prefix", ["./src/x.js"]],
    [":<line> suffix", ["src/x.js:42"]],
    ["backslash + whitespace", ["  src\\x.js  "]],
  ]) {
    it(`coverage with ${label} still ALLOWS for changed file src/x.js (enforced)`, async () => {
      const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
      track(cwd);
      const runner = capturingRunner((job) => ({
        ok: true,
        verdict: makeVerdict(job, { coverage: { files_examined: examined } }),
      }));
      const decision = await evaluateGate({
        config: mergeConfig(), // enforced
        cwd,
        baseline,
        transcript: editTranscript("src/x.js"),
        host: { reviewerMapping: "codex" },
        reviewerRunner: runner,
        stateDir: await tmpStateDir(),
      });
      assert.equal(decision.action, "allow", `expected allow for ${label}`);
      assert.equal(decision.reason, "external_pass");
    });
  }

  // FIX A: with more reviewable files than the per-file coverage cap, the gate
  // accepts a PASS on NON-EMPTY (not exhaustive) coverage and records a coverage
  // limitation rather than hard-failing on a missing per-file enumeration.
  it("more than the cap reviewable files + partial coverage allows with a limitation note", async () => {
    const CAP = 40;
    const after = {};
    for (let i = 0; i < CAP + 5; i++) {
      after[`src/f${i}.js`] = `const v${i} = ${i};\n`;
    }
    const { cwd, baseline } = await makeWorkspace({}, after);
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      // Examine only a handful of the 45 reviewable files (non-empty, partial).
      verdict: makeVerdict(job, {
        coverage: { files_examined: ["src/f0.js", "src/f1.js", "src/f2.js"] },
      }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/f0.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "external_pass");
    assert.equal(decision.coverageLimited, true);
    assert.match(decision.coverageNote, /coverage limitation/i);
  });

  // FIX A: empty coverage on a non-empty reviewable diff is STILL an operational
  // failure, even when the file count exceeds the per-file cap.
  it("more than the cap reviewable files + EMPTY coverage still blocks (enforced)", async () => {
    const CAP = 40;
    const after = {};
    for (let i = 0; i < CAP + 5; i++) {
      after[`src/f${i}.js`] = `const v${i} = ${i};\n`;
    }
    const { cwd, baseline } = await makeWorkspace({}, after);
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: [] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/f0.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.reviewerError, "empty_coverage");
  });

  // BUG 3 (ambiguous basename): a bare-basename citation may only "cover" a
  // changed file when that basename is UNIQUE among the reviewable changed files.

  // (a) A single changed file cited by its (unique) basename is still allowed.
  it("single changed file cited by its unique basename is allowed (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["x.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow", "unique basename still covers");
    assert.equal(decision.reason, "external_pass");
  });

  // (b) Two distinct files sharing the basename "index.js": a single "index.js"
  // citation is AMBIGUOUS and must NOT cover both → coverage fails → blocks.
  it("ambiguous basename citation fails coverage for two distinct files (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/a/index.js": "const a = 1;\n", "test/b/index.js": "const b = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["index.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/a/index.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "ambiguous basename must not cover distinct files");
    assert.match(decision.reviewerError, /missing_coverage/);
  });

  // (c) The same two files cited by FULL path are allowed.
  it("two distinct same-basename files cited by full path are allowed (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/a/index.js": "const a = 1;\n", "test/b/index.js": "const b = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, {
        coverage: { files_examined: ["b/src/a/index.js", "b/test/b/index.js"] },
      }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/a/index.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow", "full-path citations cover both files");
    assert.equal(decision.reason, "external_pass");
  });

  // COLLISION-1 (HIGH): the reviewable changed paths come from the filesystem and
  // may legitimately start with a real top-level dir named 'a' or 'b'. Stripping
  // 'a/'/'b/' from reviewable paths would collapse 'a/x.js' onto 'x.js', letting a
  // citation of ONE file "cover" a DIFFERENT unexamined file. The reviewable paths
  // must NOT be prefix-stripped.

  // (a) Two changed files 'a/x.js' and 'x.js'; coverage cites ONLY 'x.js'. This
  // must NOT cover 'a/x.js' (no collapse) → blocks with missing_coverage:a/x.js.
  it("COLLISION-1: citing only 'x.js' does NOT cover real top-level 'a/x.js' (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "a/x.js": "const a = 1;\n", "x.js": "const b = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["x.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "a/ prefix must not be stripped from reviewable paths");
    assert.match(decision.reviewerError, /missing_coverage:a\/x\.js/);
  });

  // (b) A reviewable 'src/x.js' cited with a git-diff 'b/' prefix IS covered: the
  // citation accepts both the as-is and the prefix-stripped form.
  it("COLLISION-1: reviewable 'src/x.js' cited as 'b/src/x.js' is covered (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["b/src/x.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow", "b/ prefix citation must cover the reviewable path");
    assert.equal(decision.reason, "external_pass");
  });

  // (c) A real reviewable 'a/x.js' cited exactly as 'a/x.js' IS covered (the
  // as-is citation form matches the un-stripped reviewable path).
  it("COLLISION-1: real reviewable 'a/x.js' cited as 'a/x.js' is covered (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "a/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["a/x.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("a/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "external_pass");
  });

  // COLLISION-3(a): a citation carrying a ':<line>' suffix must cover the matching
  // reviewable file (the suffix-stripped citation form matches 'src/a.js').
  it("COLLISION-3a: citation 'src/a.js:3' covers reviewable 'src/a.js' (enforced)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/a.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["src/a.js:3"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/a.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow", ":line suffix citation must cover src/a.js");
    assert.equal(decision.reason, "external_pass");
  });

  // ---- HARDENING REGRESSIONS (audit findings #1-4, #8, #9) ----

  // Finding #1-4 (CRITICAL): citing a real reviewable 'a/foo.js' must NOT cover a
  // DISTINCT top-level 'foo.js' via the git 'a/'+p header rule. The header rule is
  // suppressed when the prefixed form is itself a reviewable changed path.
  it("CITATION-COLLISION: citing real 'a/foo.js' does NOT cover distinct top-level 'foo.js'", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "a/foo.js": "const benign = 1;\n", "foo.js": "const evil = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["a/foo.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("a/foo.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "a/foo.js citation must not cover top-level foo.js");
    assert.match(decision.reviewerError, /missing_coverage:foo\.js/);
  });

  // Finding #1-4: when BOTH 'a/foo.js' and 'foo.js' are cited in full, coverage passes.
  it("CITATION-COLLISION: citing BOTH 'a/foo.js' and 'foo.js' is fully covered", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "a/foo.js": "const benign = 1;\n", "foo.js": "const ok = 2;\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["a/foo.js", "foo.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("a/foo.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "external_pass");
  });

  // Finding #8 (advisory): above COVERAGE_FILE_CAP, a single JUNK citation that maps
  // to no real reviewable changed path must NOT count as coverage.
  it("COVERAGE-CAP: >cap reviewable files + ONLY a junk citation blocks (no real path)", async () => {
    const files = {};
    for (let i = 0; i < 41; i++) files[`src/f${i}.js`] = `const a = ${i};\n`;
    const { cwd, baseline } = await makeWorkspace({}, files);
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["totally-unrelated-junk.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/f0.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "junk-only coverage over the cap must block");
    assert.match(decision.reviewerError, /coverage_no_real_path/);
  });

  // HARDENING (finding: large diffs can pass with 40+ unexamined reviewable files):
  // above the cap, a SINGLE real citation no longer rubber-stamps the whole diff. A
  // pass must cite a minimum number of DISTINCT real reviewable paths
  // (max(2, ceil(0.05*total))). For 41 files the threshold is 3, so one real
  // citation now BLOCKS as coverage_below_min_ratio.
  it("COVERAGE-CAP: >cap reviewable files + only ONE real citation now BLOCKS (min ratio)", async () => {
    const files = {};
    for (let i = 0; i < 41; i++) files[`src/f${i}.js`] = `const a = ${i};\n`;
    const { cwd, baseline } = await makeWorkspace({}, files);
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, { coverage: { files_examined: ["src/f7.js"] } }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/f0.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "one real citation must not cover 40+ files");
    assert.match(decision.reviewerError, /coverage_below_min_ratio/);
  });

  // Finding (min ratio): above the cap, coverage meeting the minimum ratio of
  // DISTINCT real reviewable paths is still accepted (the cap's usability relaxation
  // is preserved for genuine partial coverage — here 3 real of 41 meets the floor).
  it("COVERAGE-CAP: >cap reviewable files + enough REAL citations still allows", async () => {
    const files = {};
    for (let i = 0; i < 41; i++) files[`src/f${i}.js`] = `const a = ${i};\n`;
    const { cwd, baseline } = await makeWorkspace({}, files);
    track(cwd);
    const runner = capturingRunner((job) => ({
      ok: true,
      verdict: makeVerdict(job, {
        coverage: { files_examined: ["src/f7.js", "src/f8.js", "src/f9.js"] },
      }),
    }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/f0.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "external_pass");
    assert.equal(decision.coverageLimited, true);
  });

  // Finding #9 (advisory): the gate re-validates the runner's verdict. A "pass"
  // verdict that carries a Critical finding is forced to FAIL and blocks.
  it("VERDICT-REVALIDATE: a 'pass' verdict carrying a Critical finding is blocked", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    // A "pass" verdict that nonetheless reports a Critical finding. validateVerdict
    // (re-run by the gate) forces "fail" on any Critical/Important finding.
    const runner = capturingRunner((job) => {
      const v = makeVerdict(job, { verdict: "pass" });
      v.findings = [{ severity: "Critical", title: "backdoor" }];
      return { ok: true, verdict: v };
    });
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "Critical finding must force a fail/block");
    assert.ok(Array.isArray(decision.findings), "block surfaces the findings");
  });

  // Finding #9: a verdict value that is neither "pass" nor "fail" is invalid and is
  // routed through the reviewer-error path (blocks in enforced), never a silent pass.
  it("VERDICT-REVALIDATE: a non-'pass'/'fail' verdict value blocks (invalid_verdict)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => {
      const v = makeVerdict(job, { verdict: "pass" });
      v.verdict = "needs-changes";
      return { ok: true, verdict: v };
    });
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reviewerError, /invalid_verdict/);
  });

  it("valid pass with full coverage allows and caches (second call hits cache)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const stateDir = await tmpStateDir();
    const sessionId = "sess-cache";
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));

    const first = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir,
      sessionId,
    });
    assert.equal(first.action, "allow");
    assert.equal(first.reason, "external_pass");
    assert.equal(runner.calls.length, 1);

    // State should now hold a cache entry.
    const state = await readSessionState(stateDir, sessionId);
    assert.ok(state.cache && Object.keys(state.cache).length === 1);

    // Second identical call: cache hit, runner not invoked again.
    const second = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir,
      sessionId,
    });
    assert.equal(second.action, "allow");
    assert.equal(second.reason, "cached_pass");
    assert.equal(runner.calls.length, 1); // not called again
  });

  it("passes the built diff text to the reviewer runner via job.diffText", async () => {
    // A genuine reviewable change so buildReviewDiff produces a non-empty diff.
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\nconst b = 2;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(runner.calls.length, 1);

    // The job handed to the external reviewer MUST carry the real diff text so
    // the adapters can deliver it. Without it the reviewer sees an empty diff.
    const expected = await buildReviewDiff(cwd, baseline);
    assert.ok(expected.text.length > 0, "test setup: built diff must be non-empty");
    assert.equal(
      runner.calls[0].diffText,
      expected.text,
      "job.diffText must equal the built diff text"
    );
  });
});

// ---------------------------------------------------------------------------
// Privacy gate: externalReview policy + secret scan enforced BEFORE dispatch
// ---------------------------------------------------------------------------

// An obviously FAKE AWS access key id (AKIA + 16 chars) used only to exercise the
// scanner. It is not a real credential.
const FAKE_AWS_KEY = "AKIAABCDEFGH12345678";
// An obviously FAKE PEM private-key header. Not a real key.
const FAKE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----";

describe("evaluateGate privacy gate", () => {
  it("externalReview:deny routes to self-review and NEVER calls the external reviewer", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const config = mergeConfig({ privacy: { externalReview: "deny" } });
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
    assert.equal(decision.privacyReason, "external_review_denied");
    assert.equal(runner.calls.length, 0); // diff never sent externally
  });

  it("externalReview:prompt (non-interactive) fails closed to self-review, reviewer NOT called", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const config = mergeConfig({ privacy: { externalReview: "prompt" } });
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
    assert.equal(decision.privacyReason, "external_review_prompt_non_interactive");
    assert.equal(runner.calls.length, 0);
  });

  it("secretScan:block-external (default) + secret in diff routes to self-review; secret NOT sent or echoed", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/x.js": `const key = "${FAKE_AWS_KEY}";\n` }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const decision = await evaluateGate({
      config: mergeConfig(), // default privacy: allow + block-external, enforced
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
    assert.equal(decision.privacyReason, "secret_detected_block_external");
    // Secret never dispatched to the external reviewer.
    assert.equal(runner.calls.length, 0);
    // Reason mentions secrets but must NOT contain the raw secret value anywhere
    // in the decision payload.
    const serialized = JSON.stringify(decision);
    assert.ok(!serialized.includes(FAKE_AWS_KEY), "raw secret leaked into decision");
  });

  it("secretScan:block-external + PEM private key in diff routes to self-review; key NOT echoed", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": `${FAKE_PEM}\n` });
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.selfReview, true);
    assert.equal(runner.calls.length, 0);
    const serialized = JSON.stringify(decision);
    assert.ok(!serialized.includes("BEGIN RSA PRIVATE KEY"), "raw key leaked into decision");
  });

  it("secretScan:block-all + secret BLOCKS completion (remove-secret message) in enforced", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "src/x.js": `const key = "${FAKE_AWS_KEY}";\n` }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const config = mergeConfig({ privacy: { secretScan: "block-all" } });
    const decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block");
    assert.equal(decision.secretBlocked, true);
    // Not a self-review fallback: this is an operational block to remove secrets.
    assert.notEqual(decision.selfReview, true);
    assert.match(decision.reason, /remove the secret/i);
    assert.equal(runner.calls.length, 0);
    assert.ok(!JSON.stringify(decision).includes(FAKE_AWS_KEY), "raw secret leaked");
  });

  it("no secret + externalReview:allow + valid pass: external reviewer IS called and allow proceeds", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const decision = await evaluateGate({
      config: mergeConfig(), // default allow + block-external, clean diff
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "external_pass");
    assert.equal(runner.calls.length, 1); // normal path still dispatches
  });

  // Finding #5 (HIGH): the path-based secret scan must cover EVERY changed path, not
  // just the classifier-reviewable subset. A sensitive path the classifier drops
  // (e.g. a *.md whose NAME matches a secret pattern) must still be caught before any
  // external dispatch. Here a reviewable code file app.js drives the review while a
  // dropped 'docs/private_key.md' would previously escape the scan.
  it("SECRET-ALLPATHS: a sensitive path the classifier drops is still scanned (not sent externally)", async () => {
    const { cwd, baseline } = await makeWorkspace(
      {},
      { "app.js": "const a = 1;\n", "docs/private_key.md": "placeholder\n" }
    );
    track(cwd);
    const runner = capturingRunner((job) => ({ ok: true, verdict: makeVerdict(job) }));
    const decision = await evaluateGate({
      config: mergeConfig({ thresholds: { debateOnSensitive: false } }),
      cwd,
      baseline,
      transcript: editTranscript("app.js"),
      host: { reviewerMapping: "codex" },
      reviewerRunner: runner,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "dropped sensitive path must route to self-review");
    assert.equal(decision.privacyReason, "secret_detected_block_external");
    assert.equal(runner.calls.length, 0, "secret-bearing change never sent externally");
  });

  // Finding #5: a docs-ONLY change whose path is sensitive (so allDocsOnly is true)
  // must NOT slip through the docs-only early-allow without a secret path scan.
  it("SECRET-ALLPATHS: a docs-only change with a sensitive path blocks (not docs_only allow)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "docs/private_key.md": "placeholder\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("docs/private_key.md"),
      host: { reviewerMapping: "none" },
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "block", "sensitive path in docs-only change must block");
    assert.notEqual(decision.reason, "docs_only");
    assert.equal(decision.secretBlocked, true);
  });
});

// ---------------------------------------------------------------------------
// Block cap
// ---------------------------------------------------------------------------

describe("evaluateGate block cap", () => {
  it("keeps blocking after the cap in enforced", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const stateDir = await tmpStateDir();
    const sessionId = "cap-enforced";
    const config = mergeConfig({ runtime: { blockCap: 2 } });
    let last;
    for (let i = 0; i < 4; i++) {
      last = await evaluateGate({
        config,
        cwd,
        baseline,
        transcript: editTranscript("src/x.js"),
        host: { reviewerMapping: "none" },
        stateDir,
        sessionId,
      });
    }
    assert.equal(last.action, "block");
    assert.equal(last.blockCapReached, true);
  });

  it("releases (advisory allow) after the cap in soft", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const stateDir = await tmpStateDir();
    const sessionId = "cap-soft";
    // In soft mode onBlockCap defaults to "block" unless explicitly relaxed.
    const config = mergeConfig({
      policy: { mode: "soft", onBlockCap: "allow" },
      runtime: { blockCap: 2 },
    });
    let last;
    for (let i = 0; i < 4; i++) {
      last = await evaluateGate({
        config,
        cwd,
        baseline,
        transcript: editTranscript("src/x.js"),
        host: { reviewerMapping: "none" },
        stateDir,
        sessionId,
      });
    }
    assert.equal(last.action, "allow");
    assert.equal(last.blockCapReleased, true);
  });
});

// ---------------------------------------------------------------------------
// Subagent / recursion guard
// ---------------------------------------------------------------------------

describe("evaluateGate guards", () => {
  it("allows subagent transcripts on the authoritative SubagentStop event", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      sessionId: "g-subagent",
      // The gate skips ONLY on the host-set SubagentStop event, not on the
      // untrusted session-id/path heuristics alone (#38).
      hookEventName: "SubagentStop",
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "subagent_transcript");
  });

  it("REVIEWS a subagent-looking transcript on a plain Stop (untrusted fields can't skip the gate)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      sessionId: "g-subagent", // attacker-influencable "subagent" hint
      hookEventName: "Stop",
      stateDir: await tmpStateDir(),
    });
    assert.notEqual(decision.reason, "subagent_transcript", "must not silently skip on untrusted hints");
  });

  // #22: a reviewable file whose diff text is truncated at the per-file size cap
  // hides the post-cap payload from the reviewer. The gate must NOT accept it.
  it("BLOCKS in enforced when a reviewable file's diff is truncated at the size cap", async () => {
    const { cwd, baseline } = await makeWorkspace({}, {});
    track(cwd);
    // Shrink the per-file diff cap so a modest reviewable file is truncated.
    baseline.options = { ...(baseline.options || {}), maxFileBytes: 64 };
    await mkdir(join(cwd, "src"), { recursive: true });
    // A NEW reviewable file larger than the cap; the post-cap bytes are hidden.
    await writeFile(join(cwd, "src/big.js"), "// " + "a".repeat(400) + "\nconst evil = require('child_process');\n");
    let reviewerCalled = false;
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript("src/big.js"),
      stateDir: await tmpStateDir(),
      reviewerRunner: async () => { reviewerCalled = true; return { ok: true, verdict: { verdict: "pass" } }; },
    });
    assert.equal(decision.action, "block", "truncated reviewable content must block in enforced");
    assert.equal(decision.truncated, true);
    assert.ok(decision.truncatedPaths.includes("src/big.js"));
    assert.equal(reviewerCalled, false, "must block before even running the reviewer");
  });

  it("downgrades to advisory in soft mode when a reviewable file's diff is truncated", async () => {
    const { cwd, baseline } = await makeWorkspace({}, {});
    track(cwd);
    baseline.options = { ...(baseline.options || {}), maxFileBytes: 64 };
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/big.js"), "// " + "a".repeat(400) + "\nconst x = 1;\n");
    const decision = await evaluateGate({
      config: mergeConfig({ policy: { mode: "soft" } }),
      cwd,
      baseline,
      transcript: editTranscript("src/big.js"),
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.truncated, true);
    assert.notEqual(decision.action, "block", "soft mode advises, does not hard-block");
  });

  // R3: a reviewable file whose PATH contains " b/" (a directory with a space)
  // must still have its truncation detected — a non-greedy `a/(.+?) b/` header
  // parse would mis-split the path and MISS the truncation (fail-open). The
  // backreference parse handles it.
  it("R3: detects truncation for a reviewable path containing ' b/' (header ambiguity)", async () => {
    const { cwd, baseline } = await makeWorkspace({}, {});
    track(cwd);
    baseline.options = { ...(baseline.options || {}), maxFileBytes: 64 };
    const rel = "src/foo b/bar.js"; // dir name "foo b" -> header has a literal " b/"
    await mkdir(join(cwd, "src", "foo b"), { recursive: true });
    await writeFile(join(cwd, rel), "// " + "a".repeat(400) + "\nconst evil = 1;\n");
    let reviewerCalled = false;
    const decision = await evaluateGate({
      config: mergeConfig(), // enforced
      cwd,
      baseline,
      transcript: editTranscript(rel),
      stateDir: await tmpStateDir(),
      reviewerRunner: async () => { reviewerCalled = true; return { ok: true, verdict: { verdict: "pass" } }; },
    });
    assert.equal(decision.action, "block", "truncation of a ' b/' path must still block");
    assert.ok((decision.truncatedPaths || []).includes(rel), `expected ${rel} in truncatedPaths`);
    assert.equal(reviewerCalled, false);
  });

  it("allows when stop_hook_active recursion guard is set", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      stopHookActive: true,
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "stop_hook_active");
  });
});

// ---------------------------------------------------------------------------
// Decision constructors
// ---------------------------------------------------------------------------

describe("decision constructors", () => {
  it("allow / block / advisory shapes", () => {
    assert.deepEqual(allow({ reason: "x" }), { action: "allow", reason: "x" });
    assert.deepEqual(block("nope"), { action: "block", reason: "nope" });
    const adv = advisory("hi");
    assert.equal(adv.action, "allow");
    assert.equal(adv.systemMessage, "hi");
  });
});
