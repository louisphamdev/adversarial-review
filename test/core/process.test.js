import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolveExecutable, spawnResolved, expandArgs, ALLOWED_PLACEHOLDERS } from "../../src/core/process.js";
import * as processModule from "../../src/core/process.js";

// ---------------------------------------------------------------------------
// Dead-export removal: spawnSafe was superseded by spawnResolved and had zero
// callers. It must no longer be exported from the module.
// ---------------------------------------------------------------------------

describe("process module exports", () => {
  it("no longer exports the dead spawnSafe()", () => {
    assert.equal(
      processModule.spawnSafe,
      undefined,
      "spawnSafe must be removed (zero callers; superseded by spawnResolved)"
    );
  });

  it("still exports spawnResolved", () => {
    assert.equal(typeof processModule.spawnResolved, "function");
  });
});

// ---------------------------------------------------------------------------
// resolveExecutable
// ---------------------------------------------------------------------------

describe("resolveExecutable", () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ar-process-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves a temporary executable by absolute path", async () => {
    // Create a real file in the temp dir and reference it by absolute path.
    const filePath = join(tempDir, "my-tool");
    await writeFile(filePath, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    const result = await resolveExecutable(filePath);
    assert.ok(result, "should return a non-null path");
    assert.ok(result.includes("my-tool"), "should include the filename");
  });

  it("returns null for a missing binary", async () => {
    // Use a path/env that will never find anything.
    const result = await resolveExecutable("totally-nonexistent-binary-xyz", {
      PATH: tempDir,
      PATHEXT: ".EXE",
    });
    assert.equal(result, null);
  });

  it("returns null for a nonexistent explicit path (no throw)", async () => {
    // Regression: explicit-path branch must return null, not throw ENOENT.
    // Use a platform-appropriate separator so the explicit-path branch is taken.
    const missingPath =
      process.platform === "win32"
        ? "C:\\nope\\does-not-exist-xyz.exe"
        : "/definitely/nonexistent/path/binary-xyz";

    // Should resolve to null without throwing.
    const result = await resolveExecutable(missingPath);
    assert.equal(result, null, "expected null for a nonexistent explicit path");
  });

  // BUG 4 (Windows PATH case): resolveExecutable must read PATH/PATHEXT
  // case-insensitively. A plain-object env copy (or a native Windows cmd/powershell
  // env) may carry the key as `Path` instead of `PATH`, which previously made
  // resolveExecutable return null and broke node/opencode/codex resolution.
  it("resolves a bare command when PATH is keyed as `Path` (case-insensitive)", async () => {
    // Note the capital-P-lowercase key. With the real machine PATH behind it,
    // "node" must still resolve to a non-null path.
    const result = await resolveExecutable("node", {
      Path: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
    });
    assert.ok(result, "node must resolve even when the env key is `Path`, not `PATH`");
  });

  it("returns null for a bare command when the env has no path-like key", async () => {
    const result = await resolveExecutable("node", { PATHEXT: process.env.PATHEXT });
    assert.equal(result, null, "no PATH-like key -> bare command cannot resolve");
  });

  // REGRESSION (Finding 5): the PATH-walking branch must require EXECUTE
  // permission (X_OK) on POSIX, not mere existence (F_OK). A non-executable
  // same-named file (mode 0o644) earlier in PATH must be SKIPPED so a later, real
  // executable is resolved — returning the non-executable one would make spawn()
  // fail EACCES (a false negative). Skipped on Windows where the execute bit is
  // not modeled and executability is expressed via PATHEXT.
  it("on POSIX skips a non-executable PATH entry and resolves a later executable", async () => {
    if (process.platform === "win32") {
      return; // POSIX execute-bit semantics only.
    }
    const earlyDir = await mkdtemp(join(tmpdir(), "ar-path-early-"));
    const lateDir = await mkdtemp(join(tmpdir(), "ar-path-late-"));
    try {
      // A NON-executable stub named "mytool" earlier in PATH (mode 0o644).
      const earlyFile = join(earlyDir, "mytool");
      await writeFile(earlyFile, "#!/bin/sh\necho early\n", { mode: 0o644 });
      // The REAL executable later in PATH (mode 0o755).
      const lateFile = join(lateDir, "mytool");
      await writeFile(lateFile, "#!/bin/sh\necho late\n", { mode: 0o755 });

      const env = { PATH: `${earlyDir}:${lateDir}` };
      const result = await resolveExecutable("mytool", env);
      assert.equal(
        result,
        lateFile,
        `must skip the non-executable early entry and resolve the executable later one, got: ${result}`
      );
    } finally {
      await rm(earlyDir, { recursive: true, force: true });
      await rm(lateDir, { recursive: true, force: true });
    }
  });

  // Companion: when the ONLY candidate is non-executable on POSIX, resolution
  // returns null (so the caller fails closed) rather than a path spawn() rejects.
  it("on POSIX returns null when the only PATH match is non-executable", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "ar-path-noexec-"));
    try {
      const file = join(dir, "mytool");
      await writeFile(file, "#!/bin/sh\necho hi\n", { mode: 0o644 });
      const result = await resolveExecutable("mytool", { PATH: dir });
      assert.equal(result, null, "a non-executable-only match must resolve to null on POSIX");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows resolves .cmd through PATHEXT using a temp PATH", async () => {
    // Create foo.cmd in the temp dir.
    const cmdPath = join(tempDir, "foo.cmd");
    await writeFile(cmdPath, "@echo off\r\necho hello\r\n");

    // Build a minimal environment pointing PATH at our temp dir.
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };

    const result = await resolveExecutable("foo", env);

    if (process.platform === "win32") {
      // On Windows this MUST resolve because PATHEXT includes .CMD.
      assert.ok(result !== null, "foo should resolve on Windows via PATHEXT");
      assert.ok(
        result.toLowerCase().endsWith("foo.cmd"),
        `expected path ending in foo.cmd, got: ${result}`
      );
    } else {
      // On non-Windows platforms the extensions loop is not used; resolution
      // depends on whether a bare "foo" file exists (it doesn't), so null is fine.
      assert.equal(result, null);
    }
  });
});

// ---------------------------------------------------------------------------
// spawnResolved — batch-wrapper argument validation (fail closed)
// ---------------------------------------------------------------------------

describe("spawnResolved batch-wrapper safety", () => {
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ar-spawn-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("on Windows THROWS unsafe_batch_argument for a cmd-metachar arg and creates no side effect", async () => {
    if (process.platform !== "win32") {
      // The cmd.exe-wrapping branch only triggers on Windows for .cmd/.bat.
      return;
    }

    // A batch file that, if its args were re-parsed by cmd.exe, would create a
    // marker file. We assert the THROW happens before any process is spawned.
    const markerPath = join(tempDir, "OWNED.txt");
    const batPath = join(tempDir, "wrap.cmd");
    // The body echoes %* — if the injected `&echo ... >FILE` ran, the marker
    // would appear. The throw must prevent that entirely.
    await writeFile(batPath, "@echo off\r\necho %*\r\n");

    assert.throws(
      () => spawnResolved(batPath, [`x&echo OWNED>${markerPath}`]),
      (err) => err instanceof Error && err.message === "unsafe_batch_argument",
      "expected unsafe_batch_argument to be thrown"
    );

    // No file/side effect should have been produced (nothing was spawned).
    let created = false;
    try {
      await access(markerPath, constants.F_OK);
      created = true;
    } catch {
      created = false;
    }
    assert.equal(created, false, "no marker file should be created — the throw must precede spawning");
  });

  it("on Windows does NOT throw for safe args (flag + plain path)", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const batPath = join(tempDir, "safe.cmd");
    // A batch file that exits 0 immediately so the spawned child is harmless.
    await writeFile(batPath, "@echo off\r\nexit /b 0\r\n");

    let child;
    assert.doesNotThrow(() => {
      child = spawnResolved(batPath, ["--flag", "C:\\tmp\\safe-path"]);
    }, "safe args (no cmd metacharacters) must be allowed");

    // Reap the child so the test does not leak a process.
    await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", resolve);
    });
  });

  it("a non-batch target (process.execPath) is unaffected by the metachar check", async () => {
    // The metacharacter validation only applies to .cmd/.bat batch wrappers.
    // A real executable is spawned via CreateProcess with no shell, so args
    // containing cmd metacharacters must NOT be rejected.
    let child;
    assert.doesNotThrow(() => {
      // node -e "process.exit(0)" — the literal arg contains a metachar-like
      // string but must not be rejected because the target is not a batch file.
      child = spawnResolved(process.execPath, ["-e", "0 & 0"]);
    }, "non-batch targets must not be subject to the batch metachar check");

    await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", resolve);
    });
  });
});

// ---------------------------------------------------------------------------
// spawnResolved — POSIX process-group leadership (Round 6 group-kill fix)
// ---------------------------------------------------------------------------

describe("spawnResolved process group (POSIX)", () => {
  // REGRESSION (Round 6 / Finding HIGH): on POSIX the child must be spawned in its
  // OWN process group/session (detached:true) so forceKill can signal the WHOLE
  // group (process.kill(-pid,...)) and no forked descendant survives the watchdog.
  // A group LEADER has pgid == pid, so a process group whose id equals the child's
  // pid EXISTS — which we probe portably with `process.kill(-child.pid, 0)` (signal
  // 0 = existence check). For a detached leader this SUCCEEDS; for a NON-detached
  // child (sharing the parent's group) no group is named `child.pid`, so it would
  // throw ESRCH. (process.getpgid is NOT used: it is unavailable on some Node POSIX
  // builds.) Skipped on Windows (detached is intentionally NOT set there;
  // taskkill /F /T tree-kills instead).
  it("spawns the child as a process-group LEADER on POSIX (group id == child pid)", async () => {
    if (process.platform === "win32") {
      return; // detached is POSIX-only; Windows uses taskkill /F /T.
    }
    // A child that lives ~3s so the group exists while we probe it.
    const child = spawnResolved(
      process.execPath,
      ["-e", "process.stdout.write('UP'); setTimeout(() => {}, 3000);"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let up = "";
    child.stdout.on("data", (c) => { up += c.toString(); });
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      // Wait until the child is up so its process group definitely exists.
      const dl = Date.now() + 3000;
      while (!up.includes("UP") && Date.now() < dl) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(up.includes("UP"), "child must be up before probing its group");

      // The group whose pgid == child.pid exists IFF the child is its own leader
      // (i.e. was spawned detached). Signal 0 is an existence/permission check.
      let groupExists = false;
      try {
        process.kill(-child.pid, 0);
        groupExists = true;
      } catch (err) {
        groupExists = false;
      }
      assert.ok(
        groupExists,
        "a detached child must be its OWN process-group leader (group id == pid) so forceKill can group-kill it"
      );
    } finally {
      // Group-kill the whole group, then the lone pid, so nothing leaks.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
      await exited;
    }
  });

  // The detached process-group change must NOT alter the adapters' piped stdio:
  // stdin is writable and stdout/stderr are readable exactly as before. (The codex
  // and opencode adapters write the prompt/brief to the child's stdin and read the
  // verdict from stdout — that contract must be preserved.)
  it("preserves piped stdin/stdout (detached does not change stdio)", async () => {
    // Echo stdin back to stdout: proves stdin is piped/writable AND stdout readable.
    const child = spawnResolved(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    assert.ok(child.stdin, "stdin must be a writable pipe");
    assert.ok(child.stdout, "stdout must be a readable pipe");
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stdin.on("error", () => { /* ignore EPIPE on early exit */ });
    child.stdin.end("round6-payload");
    const code = await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(null));
    });
    assert.equal(code, 0, "child exits 0");
    assert.equal(out, "round6-payload", "stdin must reach the child and be echoed back via stdout");
  });
});

// ---------------------------------------------------------------------------
// expandArgs
// ---------------------------------------------------------------------------

describe("expandArgs", () => {
  it("substitutes known placeholders", () => {
    const args = ["{cwd}", "--diff={diffPath}", "--brief={briefPath}", "--job={jobPath}"];
    const values = {
      cwd: "/workspace",
      diffPath: "/tmp/diff.txt",
      briefPath: "/tmp/brief.txt",
      jobPath: "/tmp/job.json",
    };
    const result = expandArgs(args, values);
    assert.deepEqual(result, [
      "/workspace",
      "--diff=/tmp/diff.txt",
      "--brief=/tmp/brief.txt",
      "--job=/tmp/job.json",
    ]);
  });

  it("rejects unknown placeholders with an error", () => {
    const args = ["--foo={unknownPlaceholder}"];
    assert.throws(
      () => expandArgs(args, {}),
      /Unknown custom reviewer placeholder: unknownPlaceholder/
    );
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_PLACEHOLDERS (sanity check the exported Set)
// ---------------------------------------------------------------------------

describe("ALLOWED_PLACEHOLDERS", () => {
  it("contains exactly the four expected placeholders", () => {
    assert.ok(ALLOWED_PLACEHOLDERS.has("cwd"));
    assert.ok(ALLOWED_PLACEHOLDERS.has("diffPath"));
    assert.ok(ALLOWED_PLACEHOLDERS.has("briefPath"));
    assert.ok(ALLOWED_PLACEHOLDERS.has("jobPath"));
    assert.equal(ALLOWED_PLACEHOLDERS.size, 4);
  });
});
