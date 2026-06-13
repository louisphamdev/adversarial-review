import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCommand } from "../../src/cli/run.js";
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
});
