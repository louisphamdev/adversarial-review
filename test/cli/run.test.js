import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCommand, stillChangingScope } from "../../src/cli/run.js";
import { resolveExecutable } from "../../src/core/process.js";
import { makeIsolatedEnv } from "../helpers/isolated-env.js";

// Build an io object around an isolated env so `loadEffectiveConfig` never reads
// the developer's real `~/.adversarial-review/` (HERMETIC: see helpers/isolated-env.js).
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

// The CLI commands set process.exitCode as part of their contract; reset it
// after each test so a block's exit code does not fail the whole test file.
function resetExit() {
  process.exitCode = 0;
}

describe("run command", () => {
  it("reviews a shell-generated code file -> gate requires review -> non-zero exit", async () => {
    const cwd = await tmpDir("ar-run-");
    const iso = await makeIsolatedEnv();
    try {
      // Use `node` to create a code file (cross-platform; node is on PATH here).
      const node = await resolveExecutable("node", iso.env);
      assert.ok(node, "node executable must resolve for this test");

      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      // The wrapped command writes a new code file into the workspace.
      const script =
        "require('fs').writeFileSync(process.argv[1], 'export function f(){ return 1; }\\n')";
      const target = join(cwd, "generated.js");
      const decision = await runCommand(
        ["--host", "claude-code", "--", "node", "-e", script, target],
        io
      );
      // The wrapped command created a reviewable code file -> gate blocks.
      assert.equal(decision.action, "block");
      assert.equal(process.exitCode, 2);
      assert.match(err.join(""), /BLOCK/);
      // And the file really was created.
      const body = await readFile(target, "utf8");
      assert.match(body, /export function f/);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("returns the wrapped command's exit code when the gate allows (no code change)", async () => {
    const cwd = await tmpDir("ar-run-noop-");
    const iso = await makeIsolatedEnv();
    try {
      const node = await resolveExecutable("node", iso.env);
      assert.ok(node);
      const { io } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      // A command that changes nothing and exits 0 -> gate allows -> exit 0.
      const decision = await runCommand(
        ["--host", "claude-code", "--", "node", "-e", "process.exit(0)"],
        io
      );
      assert.equal(decision.action, "allow");
      assert.equal(process.exitCode, 0);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("a signal-terminated wrapped command does NOT report exit 0 (finding 2)", async () => {
    // POSIX-only: signal semantics differ on Windows. A child killed by a signal
    // reports code:null; mapping that to 0 (success) would let a kill MASK a gate
    // bypass. The wrapped command makes no code change, so the gate allows and the
    // CLI surfaces the wrapped command's own exit code — which must be the non-zero
    // 128+signum (143 for SIGTERM), never 0.
    if (process.platform === "win32") return;
    const cwd = await tmpDir("ar-run-signal-");
    const iso = await makeIsolatedEnv();
    try {
      const sh = await resolveExecutable("sh", iso.env);
      assert.ok(sh, "sh executable must resolve for this test");
      const { io } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      // The command sends itself SIGTERM and changes nothing in the workspace.
      const decision = await runCommand(
        ["--host", "wrapper", "--", "sh", "-c", "kill $$"],
        io
      );
      // Gate allows (no code change), so the wrapped command's exit code surfaces.
      assert.equal(decision.action, "allow", `expected allow, got ${JSON.stringify(decision)}`);
      assert.notEqual(process.exitCode, 0, "a signal-killed command must not report exit 0");
      assert.equal(process.exitCode, 143, "SIGTERM should surface as 128+15=143");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("errors with usage when no command is given", async () => {
    const cwd = await tmpDir("ar-run-usage-");
    const iso = await makeIsolatedEnv();
    try {
      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      await runCommand(["--host", "claude-code"], io);
      assert.equal(process.exitCode, 2);
      assert.match(err.join(""), /usage/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("soft mode warns (does not silently review) when the workspace is still changing (finding 4)", async () => {
    // POSIX-only: relies on a detached background writer. In soft mode a workspace
    // that is still being written must NOT be reviewed silently — the reviewer
    // would see a moving target. We assert a WARNING is surfaced (no block in soft).
    if (process.platform === "win32") return;
    const cwd = await tmpDir("ar-run-moving-");
    const iso = await makeIsolatedEnv();
    try {
      const sh = await resolveExecutable("sh", iso.env);
      assert.ok(sh, "sh must resolve");
      // Soft mode: still-changing must warn, not block.
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({ policy: { mode: "soft" } })
      );

      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      // The wrapped command spawns a DETACHED background loop that keeps writing a
      // file ~every 120ms for ~4s, then the foreground command exits immediately.
      // The post-exit quiescence sampling (3 samples, 750ms apart) therefore sees
      // a moving diff hash across samples => stillChanging=true.
      const script =
        "(i=0; while [ $i -lt 35 ]; do echo $i > moving.txt; i=$((i+1)); sleep 0.12; done) & exit 0";
      const decision = await runCommand(
        ["--host", "wrapper", "--", "sh", "-c", script],
        io
      );
      // Soft mode never blocks for a moving target.
      assert.notEqual(decision.action, "block", "soft mode must not block on a moving target");
      // But it must have WARNED about the still-changing workspace.
      assert.match(
        err.join(""),
        /still being written/i,
        "soft mode must warn that the workspace is still changing"
      );
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("rejects an unknown flag before the -- separator (finding 5)", async () => {
    // An unknown flag in the head was previously SILENTLY ignored (argument
    // confusion). It must now be a hard usage error so it never reaches the
    // wrapped command or changes behavior unnoticed.
    const cwd = await tmpDir("ar-run-badflag-");
    const iso = await makeIsolatedEnv();
    try {
      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      const decision = await runCommand(
        ["--json", "--host", "wrapper", "--", "node", "-e", "process.exit(0)"],
        io
      );
      assert.equal(process.exitCode, 2, "unknown flag must produce a usage error (exit 2)");
      assert.equal(decision, undefined, "must not run the wrapped command on a usage error");
      assert.match(err.join(""), /unknown flag/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("ROUND5 finding 4: rejects an empty --host= value before -- (usage error)", async () => {
    // `--host=` yields host='' which previously routed SILENTLY to native
    // self-review (reviewerMappingFor("")==="none"), running the wrapped command
    // unreviewed under a likely typo. It must now be a hard usage error, mirroring
    // the `--host <value>` missing-value handling.
    const cwd = await tmpDir("ar-run-emptyhost-");
    const iso = await makeIsolatedEnv();
    try {
      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      const decision = await runCommand(
        ["--host=", "--", "node", "-e", "process.exit(0)"],
        io
      );
      assert.equal(process.exitCode, 2, "empty --host= must produce a usage error (exit 2)");
      assert.equal(decision, undefined, "must not run the wrapped command on a usage error");
      assert.match(err.join(""), /--host requires a non-empty value/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("ROUND5 finding 3: a persistently-unbuildable diff is NOT declared 'settled'", async () => {
    // stillChangingScope used to return false (== "not changing", i.e. settled)
    // whenever buildReviewDiff threw — INCLUDING when EVERY sample threw, so a
    // persistently-unbuildable diff bypassed the quiescence guard. It now reports a
    // tri-state { stillChanging, persistentFailure }: when no sample ever builds,
    // persistentFailure is true so runCommand can fail closed in enforced.
    //
    // A filesystem baseline with a poisoned `snapshot` getter makes buildReviewDiff
    // throw on EVERY sample (deterministic, no timing).
    const poisoned = { type: "filesystem", cwd: "/nonexistent" };
    Object.defineProperty(poisoned, "snapshot", {
      get() {
        throw new Error("persistently unbuildable diff");
      },
    });
    const res = await stillChangingScope("/nonexistent", poisoned, 1);
    assert.equal(res.persistentFailure, true, "all samples threw => persistentFailure");
    assert.equal(res.stillChanging, false, "no buildable movement observed");
  });

  it("ROUND5 finding 3 (transient tolerance preserved): a buildable static baseline is settled, not a failure", async () => {
    // A normal, buildable baseline that does not change must report settled WITHOUT
    // a persistentFailure (transient tolerance unchanged: a single stray throw on a
    // mostly-buildable run does not wedge, and a fully-buildable stable run is
    // simply quiescent).
    const cwd = await tmpDir("ar-run-still-static-");
    const iso = await makeIsolatedEnv();
    try {
      const { captureBaseline } = await import("../../src/core/diff.js");
      const baseline = await captureBaseline(cwd); // empty, buildable filesystem baseline
      const res = await stillChangingScope(cwd, baseline, 1);
      assert.equal(res.persistentFailure, false, "a buildable baseline is not a detection failure");
      assert.equal(res.stillChanging, false, "a static workspace is settled");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });

  it("rejects a duplicate --host flag before -- (finding 5)", async () => {
    // `--host` takes the first occurrence; a second one is argument confusion and
    // must be rejected rather than silently letting the last value win.
    const cwd = await tmpDir("ar-run-duphost-");
    const iso = await makeIsolatedEnv();
    try {
      const { io, err } = makeIo(cwd, iso.env);
      process.exitCode = 0;
      const decision = await runCommand(
        ["--host", "wrapper", "--host", "malicious", "--", "node", "-e", "process.exit(0)"],
        io
      );
      assert.equal(process.exitCode, 2, "duplicate --host must produce a usage error (exit 2)");
      assert.equal(decision, undefined, "must not run the wrapped command on a usage error");
      assert.match(err.join(""), /duplicate --host/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await iso.cleanup();
    }
  });
});
