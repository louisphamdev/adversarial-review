import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

import { checkCommand } from "../../src/cli/check.js";
import { resolveStateDir } from "../../src/core/load-config.js";
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

  it("HARDENING #1: resolveStateDir is outside cwd", () => {
    const cwd = process.cwd();
    // Default (no override) must be user-level, never under cwd.
    const def = resolveStateDir({ HOME: "/home/someuser" });
    const rel = relative(cwd, def);
    assert.ok(rel.startsWith("..") || isAbsolute(rel));
    assert.match(def, /\.adversarial-review[\\/]state$/);
  });
});
