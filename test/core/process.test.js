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
