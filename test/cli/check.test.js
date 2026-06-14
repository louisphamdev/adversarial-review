import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

import { checkCommand } from "../../src/cli/check.js";
import { resolveStateDir } from "../../src/core/load-config.js";
import { git } from "../../src/core/git.js";
import { makeIsolatedEnv } from "../helpers/isolated-env.js";

// Collect stdout/stderr into strings; provide an injected io object matching the
// shape main.js passes. The env MUST be an isolated env (see helpers/isolated-env.js)
// so checkCommand's loadEffectiveConfig never reads the real `~/.adversarial-review/`.
function makeIo(cwd, env = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdin: null,
      stdout: { write: (s) => out.push(String(s)) },
      stderr: { write: (s) => err.push(String(s)) },
      env,
      cwd,
    },
    out,
    err,
  };
}

async function tmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

// Reset process.exitCode after each command run (commands set it by contract).
function resetExit() {
  process.exitCode = 0;
}

describe("check command", () => {
  it("--json outputs a machine-readable decision and exits 0 on allow", async () => {
    const cwd = await tmpDir("ar-check-");
    const iso = await makeIsolatedEnv();
    try {
      const { io, out } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      const decision = await checkCommand(["--json"], io);
      // Single JSON line on stdout.
      const printed = JSON.parse(out.join("").trim());
      assert.equal(printed.action, decision.action);
      assert.ok(typeof printed.action === "string");
      assert.equal(process.exitCode, 0);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("--json allows when a clean enforced workspace has no change since baseline", async () => {
    // checkCommand captures the baseline internally and immediately diffs, so a
    // static workspace shows no change -> allow. The block path (real edit
    // evidence vs a recorded baseline) is covered by the hook tests. Here we
    // assert the JSON decision shape under an enforced project config.
    const cwd = await tmpDir("ar-check2-");
    const iso = await makeIsolatedEnv();
    try {
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({ policy: { mode: "enforced" } })
      );
      const { io, out } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      await checkCommand(["--json"], io);
      const printed = JSON.parse(out.join("").trim());
      // No edits between baseline capture and diff -> allow.
      assert.equal(printed.action, "allow");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("fail-closed: when evaluateGate throws with a live edit, block (not fail_open) in enforced (finding 1)", async () => {
    // Repro for the check.js:50 finding: `baseline` was declared INSIDE the try,
    // so the catch could not forward it to failClosedDecision. With an empty
    // transcript AND no forwarded baseline, hasEditEvidence() returned false and
    // the gate FAILED OPEN (`fail_open_no_evidence`) even though the workspace
    // really changed. Here the workspace is a git repo with a committed baseline
    // and an UNTRACKED reviewable code file (a real diff vs HEAD). We force
    // evaluateGate to throw by pointing the state dir at a path whose PARENT is a
    // regular file (writeSessionState's mkdir then throws ENOTDIR), so the
    // fail-closed catch runs while a real edit is present.
    const cwd = await tmpDir("ar-check-failclosed-");
    const iso = await makeIsolatedEnv();
    try {
      // Initialize a git repo with one committed baseline file.
      const runGit = async (...args) => {
        const r = await git(args, cwd);
        assert.equal(r.code, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
      };
      if ((await git(["--version"], cwd)).code !== 0) return; // git unavailable: skip.
      await runGit("init", "-q");
      await runGit("config", "user.email", "t@t.t");
      await runGit("config", "user.name", "t");
      await runGit("config", "commit.gpgsign", "false");
      await writeFile(join(cwd, "base.txt"), "baseline\n");
      await runGit("add", "base.txt");
      await runGit("commit", "-q", "-m", "baseline");

      // Enforced project config + an UNTRACKED reviewable code file (diff vs HEAD).
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({ policy: { mode: "enforced" } })
      );
      await writeFile(
        join(cwd, "feature.js"),
        "export function feature() { return 42; }\n"
      );

      // A regular file standing where the state dir's PARENT should be a dir, so
      // writeSessionState(stateDir) -> mkdir(parent) throws and evaluateGate
      // bubbles the error up into checkCommand's fail-closed catch.
      const stateFileBlocker = join(cwd, "state-blocker");
      await writeFile(stateFileBlocker, "not a directory");
      const badStateDir = join(stateFileBlocker, "state");

      const { io, out } = makeIo(cwd, {
        ...iso.env,
        ADVERSARIAL_REVIEW_STATE_DIR: badStateDir,
      });
      process.exitCode = 0;
      const decision = await checkCommand(["--json"], io);

      // Must FAIL CLOSED: a real edit + enforced mode => block, NOT fail_open.
      assert.equal(decision.action, "block", `expected block, got: ${JSON.stringify(decision)}`);
      assert.notEqual(decision.reason, "fail_open_no_evidence", "must not fail open with a live edit");
      assert.equal(process.exitCode, 1);
      const printed = JSON.parse(out.join("").trim());
      assert.equal(printed.action, "block");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("ROUND5 finding 1: evaluateGate threw AND a corrupted git baseline yields a vacuous empty diff => BLOCK, not fail_open (enforced)", async () => {
    // Repro for fail-closed.js: when evaluateGate throws AND edit-evidence
    // DETECTION also fails, hasEditEvidence used to return false UNCONDITIONALLY so
    // the gate FAILED OPEN (`fail_open_no_evidence`) even in enforced. The subtle
    // case: a CORRUPTED git repo does NOT make buildReviewDiff throw — git resolves
    // non-zero with EMPTY stdout, so the diff comes back vacuously empty (no text,
    // no changedFiles) while the baseline is still a valid `type:"git"` baseline.
    // The old hasEditEvidence treated that empty diff as "no evidence" and allowed.
    //
    // We capture a REAL git baseline (so baseline.type==="git" with a valid HEAD),
    // THEN corrupt .git so the baseline-range diff is unbuildable, then drive
    // failClosedDecision directly (the surface check.js relies on). Detection failed
    // + enforced => must BLOCK, never fail_open.
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const { captureBaseline } = await import("../../src/core/diff.js");
    const cwd = await tmpDir("ar-check-fc-corrupt-");
    try {
      const runGit = async (...args) => {
        const r = await git(args, cwd);
        assert.equal(r.code, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
      };
      if ((await git(["--version"], cwd)).code !== 0) return; // git unavailable: skip.
      await runGit("init", "-q");
      await runGit("config", "user.email", "t@t.t");
      await runGit("config", "user.name", "t");
      await runGit("config", "commit.gpgsign", "false");
      await writeFile(join(cwd, "base.txt"), "baseline\n");
      await runGit("add", "base.txt");
      await runGit("commit", "-q", "-m", "baseline");

      // Capture a VALID git baseline (HEAD resolves) BEFORE corrupting the repo.
      const baseline = await captureBaseline(cwd);
      assert.equal(baseline.type, "git", "precondition: a git baseline was captured");

      // Now corrupt .git so the baseline-range diff is unbuildable (git resolves
      // non-zero with empty stdout => a vacuous empty diff, NOT a throw).
      const { rm: rmFs } = await import("node:fs/promises");
      await rmFs(join(cwd, ".git"), { recursive: true, force: true });
      await writeFile(join(cwd, ".git"), "corrupted");

      const config = { policy: { mode: "enforced" } };
      const out = [];
      const io = { stderr: { write: (s) => out.push(String(s)) } };
      const decision = await failClosedDecision({
        config,
        cwd,
        baseline,
        transcript: "",
        err: new Error("simulated evaluateGate failure"),
        io,
      });

      assert.equal(decision.action, "block", `expected block, got: ${JSON.stringify(decision)}`);
      assert.notEqual(decision.reason, "fail_open_no_evidence", "must not fail open when detection failed");
      assert.equal(decision.detectionFailed, true, "decision must be flagged as a detection failure");
      assert.match(out.join(""), /detection FAILED/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ROUND5 finding 1 (control): a clean git baseline with genuinely no edits still ALLOWS fail_open_no_evidence", async () => {
    // Guards against over-blocking: when the git repo is HEALTHY and there are
    // genuinely no edits since the baseline, an evaluateGate throw must still
    // produce the legitimate `fail_open_no_evidence` allow (detection SUCCEEDED and
    // found nothing). Only a FAILED detection blocks.
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const { captureBaseline } = await import("../../src/core/diff.js");
    const cwd = await tmpDir("ar-check-fc-clean-");
    try {
      const runGit = async (...args) => {
        const r = await git(args, cwd);
        assert.equal(r.code, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
      };
      if ((await git(["--version"], cwd)).code !== 0) return;
      await runGit("init", "-q");
      await runGit("config", "user.email", "t@t.t");
      await runGit("config", "user.name", "t");
      await runGit("config", "commit.gpgsign", "false");
      await writeFile(join(cwd, "base.txt"), "baseline\n");
      await runGit("add", "base.txt");
      await runGit("commit", "-q", "-m", "baseline");

      const baseline = await captureBaseline(cwd); // healthy git baseline, no edits after
      const config = { policy: { mode: "enforced" } };
      const decision = await failClosedDecision({
        config,
        cwd,
        baseline,
        transcript: "",
        err: new Error("boom"),
        io: { stderr: { write() {} } },
      });
      assert.equal(decision.action, "allow", `clean no-edits must allow, got ${JSON.stringify(decision)}`);
      assert.equal(decision.reason, "fail_open_no_evidence");
      assert.notEqual(decision.detectionFailed, true, "a clean detection is NOT a failure");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ROUND5 finding 2: a baseline-capture failure (baselineError) => BLOCK, not fail_open (enforced)", async () => {
    // Repro for check.js + fail-closed.js: when captureBaseline ITSELF throws,
    // `baseline` stays undefined. Previously failClosedDecision received
    // baseline:undefined and, with no transcript, hasEditEvidence returned false
    // => FAIL OPEN (`fail_open_no_evidence`). check.js now forwards a
    // `baselineError` so fail-closed routes through the DETECTION-FAILED path and
    // BLOCKS in enforced. (captureBaseline is hardened against throwing on normal
    // FS errors — snapshotWorkspace swallows per-dir failures — so this latent
    // fail-open is exercised here at the failClosedDecision contract level, which
    // is the exact surface check.js relies on.)
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const cwd = await tmpDir("ar-check-fc-baselineerr-");
    try {
      const config = { policy: { mode: "enforced" } };
      const err = new Error("evaluateGate failed (and baseline was never captured)");
      const out = [];
      const io = { stderr: { write: (s) => out.push(String(s)) } };
      const decision = await failClosedDecision({
        config,
        cwd,
        baseline: undefined,
        baselineError: new Error("captureBaseline threw"),
        transcript: "",
        err,
        io,
      });
      assert.equal(decision.action, "block", `expected block, got: ${JSON.stringify(decision)}`);
      assert.notEqual(decision.reason, "fail_open_no_evidence", "captureBaseline failure must not fail open");
      assert.equal(decision.detectionFailed, true, "baseline-capture failure must be a detection failure");
      assert.match(out.join(""), /detection FAILED/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ROUND5 finding 2 (soft): a baseline-capture failure follows soft onInternalError (advisory, no block)", async () => {
    // The detection-failed path must respect policy: in SOFT mode the default
    // onInternalError is "allow", so a detection failure yields an advisory allow
    // (with detectionFailed flagged) rather than a hard block. This proves the fix
    // never weakens enforced while not over-blocking soft.
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const cwd = await tmpDir("ar-check-fc-baselineerr-soft-");
    try {
      const config = { policy: { mode: "soft" } };
      const decision = await failClosedDecision({
        config,
        cwd,
        baseline: undefined,
        baselineError: new Error("captureBaseline threw"),
        transcript: "",
        err: new Error("boom"),
        io: { stderr: { write() {} } },
      });
      assert.equal(decision.action, "allow", "soft onInternalError=allow => advisory allow");
      assert.equal(decision.detectionFailed, true, "still flagged as a detection failure");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("HARDENING #1: resolveStateDir is outside cwd", () => {
    const cwd = process.cwd();
    // Default (no override) must be user-level, never under cwd.
    const def = resolveStateDir({ HOME: "/home/someuser" });
    const rel = relative(cwd, def);
    assert.ok(rel.startsWith("..") || isAbsolute(rel));
    assert.match(def, /\.adversarial-review[\\/]state$/);
  });
});
