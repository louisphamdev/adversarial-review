import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluateGate, classifyLevel, allow, block, advisory } from "../../src/core/gate.js";
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
    assert.equal(decision.reviewerError, "payload_hash_mismatch");
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
  it("allows subagent transcripts", async () => {
    const { cwd, baseline } = await makeWorkspace({}, { "src/x.js": "const a = 1;\n" });
    track(cwd);
    const decision = await evaluateGate({
      config: mergeConfig(),
      cwd,
      baseline,
      transcript: editTranscript("src/x.js"),
      sessionId: "g-subagent",
      stateDir: await tmpStateDir(),
    });
    assert.equal(decision.action, "allow");
    assert.equal(decision.reason, "subagent_transcript");
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
