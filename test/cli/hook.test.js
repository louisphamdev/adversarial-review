import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import { hookCommand } from "../../src/cli/hook.js";
import { git, isGitRepo } from "../../src/core/git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Track isolated home dirs created by isoEnv so they can be removed after each
// test. `hookCommand` -> `loadEffectiveConfig` resolves the user-level base via
// `homeDir(env)`, which falls back to the REAL os.homedir() unless the env sets
// ADVERSARIAL_REVIEW_HOME (or HOME/USERPROFILE). Without this isolation a
// machine-wide enforced+external-reviewer config would make these tests invoke
// the real reviewer. See test/helpers/isolated-env.js for the rationale.
const isoHomes = [];
afterEach(async () => {
  for (const h of isoHomes.splice(0)) {
    await rm(h, { recursive: true, force: true });
  }
});

// Build an isolated env (fresh empty ADVERSARIAL_REVIEW_HOME) merged with the
// caller's explicit overrides (e.g. ADVERSARIAL_REVIEW_STATE_DIR). The explicit
// state dir is preserved so a test's session-start and stop share one state dir.
function isoEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "ar-hook-iso-home-"));
  isoHomes.push(home);
  return {
    ...process.env,
    ADVERSARIAL_REVIEW_HOME: home,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

function makeIo(cwd, stdin, env = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdin,
      stdout: { write: (s) => out.push(String(s)) },
      stderr: { write: (s) => err.push(String(s)) },
      env: isoEnv(env),
      cwd,
    },
    out,
    err,
  };
}

function stdinFrom(obj) {
  return Readable.from([Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))]);
}

async function tmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

// Write a Claude transcript JSONL file with one Edit tool_use (edit evidence).
async function writeEditTranscript(dir, filePath = "src/x.js") {
  const line = JSON.stringify({
    timestamp: "2026-06-13T10:00:00Z",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Edit", id: "t1", input: { file_path: filePath } }],
    },
  });
  const tp = join(dir, "transcript.jsonl");
  await writeFile(tp, line + "\n");
  return tp;
}

// Run `hook --event session-start` to record a baseline.
async function recordBaseline(cwd, stateDir, sessionId) {
  const { io } = makeIo(cwd, stdinFrom({ session_id: sessionId, cwd }), {
    ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
  });
  await hookCommand(["--event", "session-start", "--host", "claude-code"], io);
}

// Parse the single Claude hook JSON the command writes to stdout (or null).
function parseHookJson(out) {
  const text = out.join("").trim();
  if (!text) return null;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hook command", () => {
  it("fails open (allow) on malformed payload with NO edit evidence", async () => {
    const cwd = await tmpDir("ar-hook-mal-");
    const stateDir = await tmpDir("ar-state-mal-");
    try {
      const { io, out } = makeIo(cwd, stdinFrom("{ not json at all"), {
        ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
      });
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      // No edit evidence and empty baseline -> silent allow, no stdout output.
      assert.equal(parseHookJson(out), null);
      assert.equal(process.exitCode, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("session-start records a baseline (state file written) and produces no block", async () => {
    const cwd = await tmpDir("ar-hook-ss-");
    const stateDir = await tmpDir("ar-state-ss-");
    try {
      await writeFile(join(cwd, "a.js"), "export const a = 1;\n");
      const { io, out } = makeIo(cwd, stdinFrom({ session_id: "s1", cwd }), {
        ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
      });
      await hookCommand(["--event", "session-start", "--host", "claude-code"], io);
      // No stdout output (no block).
      assert.equal(out.join("").trim(), "");
      // A session state file was written.
      const files = await readdir(stateDir);
      assert.ok(files.some((f) => f.startsWith("session-") && f.endsWith(".json")));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks a significant edit in enforced (baseline recorded, then code added)", async () => {
    const cwd = await tmpDir("ar-hook-block-");
    const stateDir = await tmpDir("ar-state-block-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      // SessionStart baseline: empty workspace (no src/x.js yet).
      await recordBaseline(cwd, stateDir, "sBlock");
      // The agent adds a code file during the session.
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(cwd, "src/x.js");

      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "sBlock", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a hook JSON decision");
      assert.equal(json.decision, "block");
      assert.match(json.reason, /adversarial review/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores a Windows subagent transcript (\\subagents\\ path) -> allow", async () => {
    const cwd = await tmpDir("ar-hook-sub-");
    const stateDir = await tmpDir("ar-state-sub-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await recordBaseline(cwd, stateDir, "sSub");
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      // A subagent transcript path (Windows-style) must never trigger the gate.
      const subPath = "C:\\Users\\me\\.claude\\subagents\\agent-123.jsonl";
      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "sSub", cwd, transcript_path: subPath }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      assert.equal(parseHookJson(out), null); // silent allow
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stop with edit evidence but NO recorded baseline blocks in enforced", async () => {
    const cwd = await tmpDir("ar-hook-nb-");
    const stateDir = await tmpDir("ar-state-nb-");
    try {
      const tp = await writeEditTranscript(cwd, "src/x.js");
      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "noBaseline", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a block");
      assert.equal(json.decision, "block");
      assert.match(json.reason, /SessionStart/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stop with edit evidence but NO recorded baseline falls back with a disclosed limitation in soft", async () => {
    const cwd = await tmpDir("ar-hook-soft-");
    const stateDir = await tmpDir("ar-state-soft-");
    try {
      // Soft mode with onInternalError:allow — when no baseline was recorded the
      // NOW-baseline fallback cannot see an already-completed change, so the gate
      // surfaces an advisory; the hook then appends the disclosed limitation.
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({ policy: { mode: "soft", onInternalError: "allow" } })
      );
      // A present unreviewed code file (already on disk before the NOW baseline).
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(cwd, "src/x.js");

      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "softNoBaseline", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      // Soft fallback surfaces an advisory systemMessage that discloses the
      // missing-baseline limitation rather than silently blocking.
      assert.ok(json, "expected output in soft fallback");
      assert.ok(json.systemMessage, "expected a systemMessage advisory");
      assert.match(json.systemMessage, /Limitation|SessionStart/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("HARDENING #2: an unwritable state dir during a significant enforced edit still BLOCKS (never allows)", async () => {
    const cwd = await tmpDir("ar-hook-fc-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      // Route stateDir UNDER an existing FILE so every state write throws
      // (mkdir -> ENOTDIR). readSessionState is tolerant (returns {}), so the
      // recorded baseline is absent; combined with edit evidence in enforced
      // this MUST block — the gate must never silently allow when state IO is
      // broken and a real edit happened.
      const occupied = join(cwd, "state-is-a-file");
      await writeFile(occupied, "x");
      const badStateDir = join(occupied, "state");

      const tp = await writeEditTranscript(cwd, "src/x.js");
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");

      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "fc", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: badStateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected output");
      assert.equal(json.decision, "block", "must fail closed (block), never allow");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HARDENING #2 (unit): a genuine throw from evaluateGate fails closed.
// ---------------------------------------------------------------------------

describe("fail-closed decision (HARDENING #2)", () => {
  it("blocks in enforced when the gate throws and edit evidence is present", async () => {
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const { mergeConfig } = await import("../../src/core/config.js");
    const { captureBaseline } = await import("../../src/core/diff.js");

    const cwd = await tmpDir("ar-fc-unit-");
    try {
      // Baseline = empty workspace; then add a code file so buildReviewDiff sees
      // a real change (edit evidence) for the fail-closed evidence probe.
      const baseline = await captureBaseline(cwd);
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "x.js"), "export const z = 1;\n");

      const config = mergeConfig({ policy: { mode: "enforced" } });
      const err = new Error("simulated writeSessionState failure");
      const out = [];
      const io = { stderr: { write: (s) => out.push(String(s)) } };

      const decision = await failClosedDecision({ config, cwd, baseline, err, io });
      assert.equal(decision.action, "block");
      assert.match(out.join(""), /failing closed/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows (fail-open) when the gate throws but there is NO edit evidence", async () => {
    const { failClosedDecision } = await import("../../src/cli/fail-closed.js");
    const { mergeConfig } = await import("../../src/core/config.js");
    const { captureBaseline } = await import("../../src/core/diff.js");

    const cwd = await tmpDir("ar-fc-unit2-");
    try {
      const baseline = await captureBaseline(cwd); // no change after capture
      const config = mergeConfig({ policy: { mode: "enforced" } });
      const decision = await failClosedDecision({
        config,
        cwd,
        baseline,
        err: new Error("boom"),
        io: { stderr: { write() {} } },
      });
      assert.equal(decision.action, "allow");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace baseline-collision (Critical): a baseline recorded in one
// workspace must NEVER be reused to evaluate a different workspace, even when
// the two share a session_id (or both lack one). FAIL CLOSED.
// ---------------------------------------------------------------------------

describe("hook command (cross-workspace baseline isolation)", () => {
  it("same session_id in a DIFFERENT workspace does NOT reuse repo A's baseline (enforced blocks)", async () => {
    const repoA = await tmpDir("ar-xws-A-");
    const repoB = await tmpDir("ar-xws-B-");
    const stateDir = await tmpDir("ar-xws-state-");
    try {
      // Repo A: record a baseline under a shared session_id.
      await mkdir(join(repoA, "src"), { recursive: true });
      await recordBaseline(repoA, stateDir, "sharedSession");

      // Repo B: a brand-new workspace with an unreviewed code file and edit
      // evidence, using the SAME session_id. If the baseline collided on the
      // session_id alone, repo A's (empty) baseline would be used to evaluate
      // repo B and the gate could silently allow. With the composite key +
      // workspaceRoot validation, B has NO baseline for itself -> enforced BLOCK.
      await mkdir(join(repoB, "src"), { recursive: true });
      await writeFile(join(repoB, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(repoB, "src/x.js");

      const { io, out } = makeIo(
        repoB,
        stdinFrom({ session_id: "sharedSession", cwd: repoB, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a hook JSON decision (must not silently allow)");
      assert.equal(json.decision, "block", "cross-workspace baseline must not be reused");
      assert.match(json.reason, /SessionStart/i);
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("missing session_id in two different workspaces does NOT share a baseline (enforced blocks)", async () => {
    const repoA = await tmpDir("ar-xws-nb-A-");
    const repoB = await tmpDir("ar-xws-nb-B-");
    const stateDir = await tmpDir("ar-xws-nb-state-");
    try {
      // Repo A: SessionStart with NO session_id (collapses to the "default" slot
      // under the OLD keying). Record a baseline.
      await mkdir(join(repoA, "src"), { recursive: true });
      {
        const { io } = makeIo(repoA, stdinFrom({ cwd: repoA }), {
          ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
        });
        await hookCommand(["--event", "session-start", "--host", "claude-code"], io);
      }

      // Repo B: also NO session_id, different workspace, unreviewed code + edit
      // evidence. Under the old "default" collapse these would share one slot;
      // with the composite key they do not -> enforced BLOCK.
      await mkdir(join(repoB, "src"), { recursive: true });
      await writeFile(join(repoB, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(repoB, "src/x.js");

      const { io, out } = makeIo(
        repoB,
        stdinFrom({ cwd: repoB, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a hook JSON decision (must not silently allow)");
      assert.equal(json.decision, "block", "missing session_id must not share a baseline across workspaces");
      assert.match(json.reason, /SessionStart/i);
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Git-dependent: review a change committed during the session.
// ---------------------------------------------------------------------------

describe("hook command (git)", () => {
  it("reviews a change committed during the session from the recorded baseline", async (t) => {
    const cwd = await tmpDir("ar-hook-git-");
    const stateDir = await tmpDir("ar-state-git-");
    try {
      if (!(await isGitRepo(cwd))) {
        // Initialize a temp git repo with an initial commit.
        const init = await git(["init"], cwd);
        if (init.code !== 0) {
          t.skip("git not available; skipping git-dependent hook test");
          return;
        }
        await git(["config", "user.email", "t@example.com"], cwd);
        await git(["config", "user.name", "Test"], cwd);
        await writeFile(join(cwd, "README.md"), "# repo\n");
        await git(["add", "-A"], cwd);
        await git(["commit", "-m", "init"], cwd);
      }

      // SessionStart records the baseline (HEAD).
      await recordBaseline(cwd, stateDir, "gitSess");

      // The agent commits a code change during the session.
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "feature.js"), "export function g(){ return 42; }\n");
      await git(["add", "-A"], cwd);
      const commit = await git(["commit", "-m", "add feature"], cwd);
      if (commit.code !== 0) {
        t.skip("git commit failed; skipping git-dependent hook test");
        return;
      }

      const tp = await writeEditTranscript(cwd, "src/feature.js");
      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "gitSess", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a review requirement");
      assert.equal(json.decision, "block");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("SAME workspace + same session_id still pairs the baseline (composite key regression)", async (t) => {
    const cwd = await tmpDir("ar-hook-same-");
    const stateDir = await tmpDir("ar-state-same-");
    try {
      const init = await git(["init"], cwd);
      if (init.code !== 0) {
        t.skip("git not available; skipping git-dependent hook test");
        return;
      }
      await git(["config", "user.email", "t@example.com"], cwd);
      await git(["config", "user.name", "Test"], cwd);
      await writeFile(join(cwd, "README.md"), "# repo\n");
      await git(["add", "-A"], cwd);
      await git(["commit", "-m", "init"], cwd);

      // SessionStart records the baseline (HEAD) for THIS workspace.
      await recordBaseline(cwd, stateDir, "sameSess");

      // A committed code change during the session, evaluated in the SAME cwd.
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "feature.js"), "export function g(){ return 42; }\n");
      await git(["add", "-A"], cwd);
      const commit = await git(["commit", "-m", "add feature"], cwd);
      if (commit.code !== 0) {
        t.skip("git commit failed; skipping git-dependent hook test");
        return;
      }

      const tp = await writeEditTranscript(cwd, "src/feature.js");
      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "sameSess", cwd, transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      // The recorded baseline IS found (composite key matched), so the change is
      // reviewed and blocked — WITHOUT the missing-baseline disclosure note that
      // would appear if the baseline had been rejected.
      assert.ok(json, "expected a review requirement");
      assert.equal(json.decision, "block");
      assert.doesNotMatch(
        json.reason,
        /no SessionStart baseline was recorded/i,
        "the recorded same-workspace baseline must be used, not rejected"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
