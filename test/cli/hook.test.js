import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import {
  hookCommand,
  canonicalWorkspaceRoot,
  sessionStateKey,
  readTranscriptFile,
} from "../../src/cli/hook.js";
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

  // ASYNC-3: a stdin pipe that opens but never closes must NOT hang the hook.
  // readStdinJson races the drain against a timeout and yields {} on timeout; with
  // no recorded baseline and no edit evidence the gate then silently allows.
  it("stop with a never-ending stdin stream resolves within the timeout (yields {})", async () => {
    const cwd = await tmpDir("ar-hook-stdin-hang-");
    const stateDir = await tmpDir("ar-state-stdin-hang-");
    try {
      // A Readable that stays open forever: read() never pushes EOF, so the
      // `for await` drain would hang indefinitely without the ASYNC-3 timeout.
      const neverEnding = new Readable({ read() { /* never push, never end */ } });
      // Inject a short stdin timeout so the test is fast; assert it resolves well
      // under a real 5s bound (proving the timeout fired, not a normal close).
      const { io, out } = makeIo(cwd, neverEnding, {
        ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
      });
      io.stdinTimeoutMs = 300;
      const start = Date.now();
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 4000, `hook should not hang on an open stdin pipe, took ${elapsed}ms`);
      // No baseline + no edit evidence -> silent allow (no stdout output).
      assert.equal(parseHookJson(out), null);
      assert.equal(process.exitCode, 0);
      neverEnding.destroy();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // ASYNC-3 (regression): resolving the race is NOT enough — the losing
  // `for await` keeps the open stdin handle ref'd, holding the event loop alive
  // so the hook never exits and the host kills it (fail-OPEN). The fix actively
  // tears the stream down on timeout. Assert the injected stdin is DESTROYED
  // (and paused) once the timeout fires, which is what releases the libuv handle.
  it("actively destroys the stdin stream when the read times out (releases the handle)", async () => {
    const cwd = await tmpDir("ar-hook-stdin-destroy-");
    const stateDir = await tmpDir("ar-state-stdin-destroy-");
    try {
      const neverEnding = new Readable({ read() { /* never push, never end */ } });
      let destroyed = false;
      let paused = false;
      const origDestroy = neverEnding.destroy.bind(neverEnding);
      const origPause = neverEnding.pause.bind(neverEnding);
      neverEnding.destroy = (...a) => { destroyed = true; return origDestroy(...a); };
      neverEnding.pause = (...a) => { paused = true; return origPause(...a); };

      const { io } = makeIo(cwd, neverEnding, { ADVERSARIAL_REVIEW_STATE_DIR: stateDir });
      io.stdinTimeoutMs = 200;
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      assert.equal(destroyed, true, "timed-out stdin must be destroyed so the handle is released");
      assert.equal(paused, true, "timed-out stdin should be paused before destroy");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // ASYNC-3 (definitive wall-clock regression): with a REAL OS stdin pipe held
  // open by a parent and never closed, the hook child must EXIT NATURALLY shortly
  // after the stdin timeout — proving no libuv handle is leaked. Before the fix
  // the child hung until SIGKILL (the host-timeout fail-OPEN). Skipped if the
  // platform cannot spawn (very unlikely).
  it("a child reading a never-closing OS stdin pipe exits naturally after the timeout", async (t) => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const hookUrl = new URL("../../src/cli/hook.js", import.meta.url).href;

    const childDir = await tmpDir("ar-hook-pipe-child-");
    const childScript = join(childDir, "child.mjs");
    await writeFile(
      childScript,
      [
        `import { hookCommand } from ${JSON.stringify(hookUrl)};`,
        `import { mkdtempSync, rmSync } from "node:fs";`,
        `import { tmpdir } from "node:os";`,
        `import { join } from "node:path";`,
        `const cwd = mkdtempSync(join(tmpdir(), "ar-pipe-c-"));`,
        `const stateDir = mkdtempSync(join(tmpdir(), "ar-pipe-c-state-"));`,
        `const home = mkdtempSync(join(tmpdir(), "ar-pipe-c-home-"));`,
        `const io = {`,
        `  stdin: process.stdin,`,
        `  stdout: { write: () => {} },`,
        `  stderr: { write: () => {} },`,
        `  env: { ...process.env, ADVERSARIAL_REVIEW_HOME: home, HOME: home, USERPROFILE: home, ADVERSARIAL_REVIEW_STATE_DIR: stateDir },`,
        `  cwd,`,
        `  stdinTimeoutMs: 300,`,
        `};`,
        `await hookCommand(["--event", "stop", "--host", "claude-code"], io);`,
        `process.on("exit", () => {`,
        `  try { rmSync(cwd, { recursive: true, force: true }); } catch {}`,
        `  try { rmSync(stateDir, { recursive: true, force: true }); } catch {}`,
        `  try { rmSync(home, { recursive: true, force: true }); } catch {}`,
        `});`,
      ].join("\n"),
    );

    try {
      // Parent holds the child's stdin pipe OPEN and never writes/closes it.
      const child = spawn(process.execPath, [fileURLToPath(new URL(`file:///${childScript.replace(/\\/g, "/")}`))], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const exited = await new Promise((resolve) => {
        let done = false;
        child.on("exit", (code) => { if (!done) { done = true; resolve({ code, killed: false }); } });
        const kill = setTimeout(() => {
          if (!done) { done = true; child.kill("SIGKILL"); resolve({ code: null, killed: true }); }
        }, 4000);
        if (typeof kill.unref === "function") kill.unref();
      });
      assert.equal(exited.killed, false, "hook child hung on an open stdin pipe (handle leaked -> fail-open)");
      assert.equal(exited.code, 0, "hook child must exit cleanly after the stdin timeout");
    } finally {
      await rm(childDir, { recursive: true, force: true });
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

  it("ignores a genuine SubagentStop event (authoritative hook_event_name) -> allow", async () => {
    const cwd = await tmpDir("ar-hook-sub-");
    const stateDir = await tmpDir("ar-state-sub-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await recordBaseline(cwd, stateDir, "sSub");
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      // A genuine subagent Stop arrives as hook_event_name === "SubagentStop"
      // (set by Claude Code itself). That authoritative signal — NOT the path —
      // is what lets the gate stand down for a subagent pipeline.
      const subPath = "C:\\Users\\me\\.claude\\subagents\\agent-123.jsonl";
      const { io, out } = makeIo(
        cwd,
        stdinFrom({
          session_id: "sSub",
          cwd,
          transcript_path: subPath,
          hook_event_name: "SubagentStop",
        }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      assert.equal(parseHookJson(out), null); // silent allow
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // SECURITY regression: an UNTRUSTED transcript_path/session_id that LOOKS like a
  // subagent (path under \subagents\, agent-* basename, g- session id) must NOT
  // disable the gate on a plain Stop event. Previously this was a fail-OPEN
  // bypass: a malicious repo could name its transcript to silently skip review.
  it("does NOT skip the gate for a subagent-looking path on a plain Stop (fail-closed)", async () => {
    const cwd = await tmpDir("ar-hook-subspoof-");
    const stateDir = await tmpDir("ar-state-subspoof-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      // Record a baseline (empty src), then the agent adds an unreviewed code file.
      await recordBaseline(cwd, stateDir, "g-spoofed");
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(cwd, "src/x.js");
      // Attacker-influencable fields chosen to hit ALL three old heuristics, but
      // NO authoritative SubagentStop -> the gate must still BLOCK.
      const { io, out } = makeIo(
        cwd,
        stdinFrom({
          session_id: "g-spoofed",
          cwd,
          transcript_path: tp,
          hook_event_name: "Stop",
        }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a hook decision (must not silently allow)");
      assert.equal(json.decision, "block", "subagent-looking untrusted fields must not disarm the gate");
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
    // Soft posture must be set at the TRUSTED USER layer. A project-level
    // config.json can no longer downgrade enforced -> soft (that project
    // self-downgrade was closed as a security floor: with no user policy floor
    // the default enforced baseline is re-applied over the merged config). So we
    // establish soft via the user-level (machine-wide) config in an explicit
    // home dir, which the floor legitimately permits.
    const userHome = await tmpDir("ar-hook-soft-home-");
    try {
      // Soft mode with onInternalError:allow at the USER layer — when no baseline
      // was recorded the NOW-baseline fallback cannot see an already-completed
      // change, so the gate surfaces an advisory; the hook appends the limitation.
      await mkdir(join(userHome, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(userHome, ".adversarial-review", "config.json"),
        JSON.stringify({ policy: { mode: "soft", onInternalError: "allow" } })
      );
      // A present unreviewed code file (already on disk before the NOW baseline).
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(cwd, "src/x.js");

      const { io, out } = makeIo(
        cwd,
        stdinFrom({ session_id: "softNoBaseline", cwd, transcript_path: tp }),
        {
          ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
          // Pin the user-level base to our explicit home (overrides isoEnv's
          // fresh-empty home) so the soft user config above is read.
          ADVERSARIAL_REVIEW_HOME: userHome,
          HOME: userHome,
          USERPROFILE: userHome,
        }
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
      await rm(userHome, { recursive: true, force: true });
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
// Windows case-normalization of the workspace state key. On win32 the FS is
// case-insensitive but realpathSync preserves the caller's casing, so the SAME
// workspace under two casings used to produce two DIFFERENT state keys — a
// SessionStart baseline recorded under one casing was invisible to a Stop event
// under another. canonicalWorkspaceRoot now lowercases on win32 so casing can
// never split the key (POSIX paths, being case-sensitive, are left untouched).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ROUND-2 Finding 5: sessionStateKey must be INJECTIVE. The bare-space join was
// non-injective — a session_id containing a space (attacker-controlled, from the
// Stop-hook payload) could merge with a workspace root that also contains a space
// (common on Windows: "C:\Users\John Doe\...") so two distinct (sessionId, root)
// pairs produced the same key, sharing baseline/block-counter/cache across
// unrelated sessions+workspaces. The length-prefixed encoding cannot collide.
// ---------------------------------------------------------------------------
describe("sessionStateKey injectivity (finding 5)", () => {
  it("distinct (sessionId, cwd) pairs never collide even with embedded spaces", () => {
    // The classic non-injective collision: "a /home" + "/x" vs "a" + "/home /x".
    // After canonicalization the roots differ, but we also assert the encoding
    // itself is injective by feeding crafted components whose bare-space join
    // WOULD collide ("S a" | "b" vs "S" | "a b").
    assert.notEqual(
      sessionStateKey("S a", "b"),
      sessionStateKey("S", "a b"),
      "a space in the session id must not merge into the workspace component",
    );
    assert.notEqual(
      sessionStateKey("a /home/user", "/project"),
      sessionStateKey("a", "/home/user /project"),
    );
  });

  it("an embedded-space workspace root cannot be absorbed by a crafted session id", () => {
    // Use a REAL workspace root that contains a space, then split it and craft a
    // session id that, under the OLD bare-space join, would reconstruct the same
    // key for a different (sessionId, root) pair.
    const cwd = mkdtempSync(join(tmpdir(), "ar sessionkey col-")); // space in name
    try {
      const root = canonicalWorkspaceRoot(cwd);
      const sp = root.indexOf(" ");
      // The temp dir name contains a space, so the canonical root does too.
      assert.ok(sp >= 0, "test fixture must produce a space-containing root");
      const head = root.slice(0, sp);
      const tail = root.slice(sp + 1);
      // Pair 1: sessionId "S", root = full path. Pair 2: sessionId "S <head>",
      // root = tail. Under a bare-space join both = "S <head> <tail>".
      assert.notEqual(
        sessionStateKey("S", cwd),
        sessionStateKey(`S ${head}`, tail),
        "length-prefixed key must distinguish the two pairs the old join merged",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the same key stable for identical inputs (no regression)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-sk-stable-"));
    try {
      assert.equal(sessionStateKey("s1", cwd), sessionStateKey("s1", cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND-2 Finding 6: the transcript read must be TIME-BOUNDED so a FIFO / device
// file / hung FS at transcript_path cannot block the Stop hook until Claude
// Code's 300s SIGKILL (a killed hook emits no block = fail-OPEN). On timeout we
// resolve to "" (tolerant) and proceed; with edit evidence the empty transcript
// routes into the missing-baseline fail-CLOSED path.
// ---------------------------------------------------------------------------
describe("transcript read timeout (finding 6)", () => {
  // Wall-clock regression: a real never-delivering FIFO must NOT hang the read.
  // The bounded read returns "" within a small multiple of the injected timeout
  // instead of blocking forever. POSIX-only (mkfifo); skipped on win32.
  it("a blocking FIFO transcript path resolves to '' within the timeout (wall-clock)", async (t) => {
    if (process.platform === "win32") {
      t.skip("FIFO/mkfifo regression is POSIX-specific");
      return;
    }
    const { execFile } = await import("node:child_process");
    const dir = await tmpDir("ar-fifo-");
    const fifo = join(dir, "transcript.fifo");
    try {
      // Create a named pipe that no writer ever opens for writing -> a read on it
      // blocks indefinitely without the timeout.
      const made = await new Promise((resolve) => {
        execFile("mkfifo", [fifo], (err) => resolve(!err));
      });
      if (!made) {
        t.skip("mkfifo unavailable; skipping FIFO regression");
        return;
      }
      const start = Date.now();
      const text = await readTranscriptFile(fifo, 300);
      const elapsed = Date.now() - start;
      assert.equal(text, "", "a blocking FIFO read must resolve to '' on timeout");
      assert.ok(
        elapsed < 4000,
        `transcript read must not hang on a FIFO; took ${elapsed}ms`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A normal, readable transcript on disk is returned in full (fast path intact).
  it("reads a normal transcript file fully (fast path unaffected)", async () => {
    const dir = await tmpDir("ar-tx-ok-");
    try {
      const tp = join(dir, "t.jsonl");
      const body = '{"a":1}\n{"b":2}\n';
      await writeFile(tp, body);
      const text = await readTranscriptFile(tp, 2000);
      assert.equal(text, body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R3: an oversized transcript is CAPPED (peak memory bounded) instead of being
  // loaded in full — a huge transcript_path can no longer OOM-kill the hook
  // (a fail-OPEN). The read stops at maxBytes; the filesystem diff remains the
  // authoritative edit evidence so a truncated transcript only fails toward review.
  it("R3: caps an oversized transcript read at maxBytes", async () => {
    const dir = await tmpDir("ar-tx-big-");
    try {
      const tp = join(dir, "big.jsonl");
      await writeFile(tp, "x".repeat(64 * 1024)); // 64 KiB
      const text = await readTranscriptFile(tp, 2000, 4 * 1024); // 4 KiB cap
      assert.ok(text.length >= 4 * 1024, "reads up to the cap");
      assert.ok(text.length < 64 * 1024, "does NOT read the full oversized file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Definitive wall-clock: a child whose transcript_path is a never-delivering
  // FIFO must EXIT NATURALLY (no leaked fs handle) shortly after the timeout,
  // rather than hanging until SIGKILL (the host-timeout fail-OPEN). POSIX-only.
  it("a Stop hook with a FIFO transcript exits naturally after the timeout (wall-clock)", async (t) => {
    if (process.platform === "win32") {
      t.skip("FIFO/mkfifo regression is POSIX-specific");
      return;
    }
    const { execFile, spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const hookUrl = new URL("../../src/cli/hook.js", import.meta.url).href;

    const childDir = await tmpDir("ar-fifo-child-");
    const fifo = join(childDir, "transcript.fifo");
    const childScript = join(childDir, "child.mjs");
    try {
      const made = await new Promise((resolve) => {
        execFile("mkfifo", [fifo], (err) => resolve(!err));
      });
      if (!made) {
        t.skip("mkfifo unavailable; skipping FIFO child regression");
        return;
      }
      await writeFile(
        childScript,
        [
          `import { hookCommand } from ${JSON.stringify(hookUrl)};`,
          `import { mkdtempSync } from "node:fs";`,
          `import { tmpdir } from "node:os";`,
          `import { join } from "node:path";`,
          `const cwd = mkdtempSync(join(tmpdir(), "ar-fifo-c-"));`,
          `const stateDir = mkdtempSync(join(tmpdir(), "ar-fifo-c-state-"));`,
          `const home = mkdtempSync(join(tmpdir(), "ar-fifo-c-home-"));`,
          `const payload = JSON.stringify({ session_id: "fifoSess", cwd, transcript_path: ${JSON.stringify(
            fifo,
          )}, hook_event_name: "Stop" });`,
          `const io = {`,
          `  stdin: payload,`,
          `  stdout: { write: () => {} },`,
          `  stderr: { write: () => {} },`,
          `  env: { ...process.env, ADVERSARIAL_REVIEW_HOME: home, HOME: home, USERPROFILE: home, ADVERSARIAL_REVIEW_STATE_DIR: stateDir },`,
          `  cwd,`,
          `  transcriptTimeoutMs: 300,`,
          `};`,
          `await hookCommand(["--event", "stop", "--host", "claude-code"], io);`,
        ].join("\n"),
      );

      const child = spawn(process.execPath, [childScript], { stdio: ["ignore", "ignore", "ignore"] });
      const exited = await new Promise((resolve) => {
        let done = false;
        child.on("exit", (code) => {
          if (!done) {
            done = true;
            resolve({ code, killed: false });
          }
        });
        const kill = setTimeout(() => {
          if (!done) {
            done = true;
            child.kill("SIGKILL");
            resolve({ code: null, killed: true });
          }
        }, 5000);
        if (typeof kill.unref === "function") kill.unref();
      });
      assert.equal(
        exited.killed,
        false,
        "Stop hook hung on a FIFO transcript (fs handle leaked -> fail-open)",
      );
      assert.equal(exited.code, 0, "hook child must exit cleanly after the transcript timeout");
    } finally {
      await rm(childDir, { recursive: true, force: true });
    }
  });
});

describe("canonicalWorkspaceRoot case-normalization", () => {
  it("yields the SAME state key for the same workspace under different casing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ar-CaseKey-"));
    try {
      const upper = canonicalWorkspaceRoot(cwd.toUpperCase());
      const lower = canonicalWorkspaceRoot(cwd.toLowerCase());
      if (process.platform === "win32") {
        assert.equal(upper, lower, "win32 must case-fold the workspace root");
        assert.equal(
          sessionStateKey("s1", cwd.toUpperCase()),
          sessionStateKey("s1", cwd.toLowerCase()),
          "win32 state keys must match across casing",
        );
        // The folded form is lowercase.
        assert.equal(upper, upper.toLowerCase());
      } else {
        // POSIX is case-sensitive: distinct casings legitimately differ. We only
        // assert no crash + idempotent same-casing keying here.
        assert.equal(
          sessionStateKey("s1", cwd),
          sessionStateKey("s1", cwd),
        );
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// On win32, a baseline recorded at SessionStart under one path casing must be
// FOUND by a Stop event under a different casing (same physical workspace).
describe("hook command (workspace casing, win32)", () => {
  it("SessionStart under UPPER casing pairs with Stop under lower casing", async (t) => {
    if (process.platform !== "win32") {
      t.skip("case-folding regression is win32-specific");
      return;
    }
    const cwd = await tmpDir("ar-hook-case-");
    const stateDir = await tmpDir("ar-state-case-");
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      // Record the baseline under an UPPER-cased cwd.
      {
        const { io } = makeIo(cwd.toUpperCase(), stdinFrom({ session_id: "caseSess", cwd: cwd.toUpperCase() }), {
          ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
        });
        await hookCommand(["--event", "session-start", "--host", "claude-code"], io);
      }
      // Add an unreviewed code file, then evaluate under a lower-cased cwd.
      await writeFile(join(cwd, "src", "x.js"), "export function f(){ return 1; }\n");
      const tp = await writeEditTranscript(cwd, "src/x.js");
      const { io, out } = makeIo(
        cwd.toLowerCase(),
        stdinFrom({ session_id: "caseSess", cwd: cwd.toLowerCase(), transcript_path: tp }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );
      await hookCommand(["--event", "stop", "--host", "claude-code"], io);
      const json = parseHookJson(out);
      assert.ok(json, "expected a review requirement");
      assert.equal(json.decision, "block");
      // The recorded baseline WAS found (key matched across casing), so the
      // missing-baseline disclosure must NOT appear.
      assert.doesNotMatch(
        json.reason,
        /no SessionStart baseline was recorded/i,
        "the baseline recorded under a different casing must be reused, not rejected",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Git-dependent: review a change committed during the session.
// ---------------------------------------------------------------------------

describe("hook command (git)", () => {
  it("emits the skipped-gitignored diagnostic once on Stop", async (t) => {
    const cwd = await tmpDir("ar-hook-gitignore-");
    const stateDir = await tmpDir("ar-state-gitignore-");
    try {
      const init = await git(["init"], cwd);
      if (init.code !== 0) {
        t.skip("git not available; skipping git-dependent hook test");
        return;
      }
      await git(["config", "user.email", "t@example.com"], cwd);
      await git(["config", "user.name", "Test"], cwd);
      await writeFile(join(cwd, ".gitignore"), "ignored/\n");
      await writeFile(join(cwd, "README.md"), "# repo\n");
      await git(["add", "-A"], cwd);
      await git(["commit", "-m", "init"], cwd);
      await recordBaseline(cwd, stateDir, "ignoreSess");

      await mkdir(join(cwd, "ignored"), { recursive: true });
      await writeFile(join(cwd, "ignored", "cache.bin"), "noise\n");
      const { io, out, err } = makeIo(
        cwd,
        stdinFrom({ session_id: "ignoreSess", cwd }),
        { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }
      );

      await hookCommand(["--event", "stop", "--host", "claude-code"], io);

      assert.equal(parseHookJson(out), null);
      const stderr = err.join("");
      assert.match(stderr, /adversarial-review: skipped 1 gitignored untracked file\(s\)/);
      assert.equal(stderr.match(/adversarial-review: skipped/g)?.length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

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
