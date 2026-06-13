// Tests for the codex reviewer adapter.
//
// Real codex is never invoked. All tests use temporary Node.js stub scripts
// spawned via process.execPath so no shell/external binary is required.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAdapter } from "../../src/reviewers/codex.js";
import { createStubs, makeJob } from "./stub-helper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake config that points the codex binary at the given stub script.
 * The stub is invoked as: process.execPath <stubPath> <...args>
 * We achieve this by making the "codex" command be process.execPath and
 * prepending the stub path into the args by monkey-patching the adapter's run()
 * through a minimal wrapper.
 *
 * Actually, the cleanest approach is to wrap the adapter so that the resolved
 * binary is process.execPath and the stub is injected as the first arg.
 * We do this by overriding resolveExecutable via env manipulation: since the
 * adapter calls resolveExecutable("codex", env), we put process.execPath in a
 * temp directory named "codex" (or "codex.cmd" on Windows).
 */

// We use a different strategy: subclass the adapter's run() to intercept the
// spawnSafe call. But since the modules are ESM and not easily mockable without
// a mock library, we use the simplest approach:
//
// Create a thin wrapper that calls adapter.run() but overrides io.env to a
// fake PATH where "codex" resolves to process.execPath, and uses a custom
// adapter config so the adapter will pass the stub script as the first arg.
//
// Actually the cleanest approach given constraints: we override the adapter
// by creating a wrapper that directly calls the internal logic with a stub
// command. Since codex.js exports createAdapter and calls resolveExecutable
// internally, we point a fake "codex" binary at process.execPath by writing
// a wrapper script named "codex" (or codex.cmd on Windows) in the temp dir
// that delegates to the stub.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildVerdictOutput, createToolShim } from "./stub-helper.js";

/**
 * Build a codex stub that reads the prompt from stdin, extracts the diff path
 * from the "Read the diff at: <path>" line, reads that file, and copies its
 * content to a side file so the test can prove the real diff was delivered.
 *
 * @param {object} job              - job whose verdict the stub echoes
 * @param {string} recordDiffPath   - file the stub copies the diff content to
 * @returns {string} stub source
 */
function buildCodexDiffStub(job, recordDiffPath) {
  const verdictBlock = buildVerdictOutput(job, "pass");
  const cfg = { verdictBlock, recordDiffPath };
  return `
const fs = require("node:fs");
const CFG = ${JSON.stringify(cfg)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  // The prompt contains a line "Read the diff at: <path>".
  const m = stdin.match(/Read the diff at: (.+)/);
  const dp = m ? m[1].trim() : "";
  let content = "";
  try { content = dp ? fs.readFileSync(dp, "utf8") : ""; } catch {}
  try { fs.writeFileSync(CFG.recordDiffPath, content); } catch {}
  process.stdout.write(CFG.verdictBlock);
  process.exit(0);
});
`;
}

/**
 * Create a "codex" shim that runs a specific stub script. The codex adapter
 * builds its own args, so the shim IGNORES the forwarded args (forwardArgs:false)
 * and runs the stub directly. Delegates to the shared createToolShim helper.
 */
function createCodexShim(stubPath) {
  return createToolShim("codex", stubPath, { forwardArgs: false });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("codex adapter", () => {
  let stubs;
  let job;

  before(async () => {
    job = makeJob({ reviewer: "codex" });
    stubs = await createStubs(job);
    // Update job's diffPath to point at the temp diff file.
    job = { ...job, diffPath: stubs.paths.diff };
  });

  after(async () => {
    await stubs.cleanup();
  });

  // --- verify() ---

  it("verify() returns ok:false with reason missing_binary when codex is not found", async () => {
    const adapter = createAdapter({});
    const result = await adapter.verify({ PATH: "", PATHEXT: ".EXE" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_binary");
  });

  it("verify() returns ok:true with resolvedPath and capabilities when binary found", async () => {
    const shim = await createCodexShim(stubs.paths.version);
    try {
      const adapter = createAdapter({});
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      assert.ok(result.resolvedPath, "should have a resolvedPath");
      assert.ok(result.capabilities.readOnly, "should be readOnly");
      assert.ok(result.capabilities.noEdit, "should be noEdit");
      assert.ok(result.capabilities.ephemeral, "should be ephemeral");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — valid pass ---

  it("run() returns ok:true with verdict.verdict==='pass' for a valid pass stub", async () => {
    const shim = await createCodexShim(stubs.paths.pass);
    try {
      const config = { reviewers: { codex: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
      assert.equal(result.verdict.verdict, "pass");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — valid fail ---

  it("run() returns ok:true with verdict.verdict==='fail' for a valid fail stub (not an operational failure)", async () => {
    const shim = await createCodexShim(stubs.paths.fail);
    try {
      const config = { reviewers: { codex: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
      assert.equal(result.verdict.verdict, "fail", "A fail verdict should be ok:true");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — the real diff content is delivered to the reviewer ---

  it("run() writes job.diffText to the diff file referenced in the prompt when no job.diffPath is set", async () => {
    const recDir = await mkdtemp(join(tmpdir(), "ar-codex-diff-"));
    const recDiff = join(recDir, "diff-seen.txt");
    const stubDir = await mkdtemp(join(tmpdir(), "ar-codex-stub-"));
    const stubPath = join(stubDir, "codex-diff-stub.cjs");
    // A job WITHOUT diffPath but WITH diffText: the adapter must write the diff
    // content to its temp file and reference that path in the prompt.
    const diffJob = { ...job, diffPath: undefined, diffText: "DIFFMARKER-12345" };
    await writeFile(stubPath, buildCodexDiffStub(diffJob, recDiff), "utf8");
    const shim = await createCodexShim(stubPath);
    try {
      const config = { reviewers: { codex: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(diffJob, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);

      // The stub read the diff path from the prompt and copied its content here.
      const seen = await readFile(recDiff, "utf8");
      assert.ok(seen.length > 0, "diff file delivered to reviewer must NOT be empty");
      assert.ok(
        seen.includes("DIFFMARKER-12345"),
        `diff file must contain the job's diffText, got: ${JSON.stringify(seen)}`
      );
    } finally {
      await shim.cleanup();
      await rm(stubDir, { recursive: true, force: true });
      await rm(recDir, { recursive: true, force: true });
    }
  });

  // --- run() — timeout ---

  it("run() returns ok:false with error==='timeout' when the stub sleeps past timeoutSec", async () => {
    const shim = await createCodexShim(stubs.paths.sleep);
    try {
      // Use a very short timeout (0.2 seconds) to avoid slowing the test suite.
      const config = { reviewers: { codex: { timeoutSec: 0.2 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.equal(result.error, "timeout");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — non-zero exit ---

  it("run() returns ok:false when the stub exits with code 1", async () => {
    const shim = await createCodexShim(stubs.paths.nonzero);
    try {
      const config = { reviewers: { codex: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.ok(result.error, "should have an error reason");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — malformed output ---

  it("run() returns ok:false when the stub prints malformed output", async () => {
    const shim = await createCodexShim(stubs.paths.malformed);
    try {
      const config = { reviewers: { codex: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.ok(result.error, "should have an error reason");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — missing binary ---

  it("run() returns ok:false with error==='missing_binary' when codex not in PATH", async () => {
    const config = {};
    const adapter = createAdapter(config);
    const result = await adapter.run(job, { env: { PATH: "", PATHEXT: ".EXE" } });
    assert.equal(result.ok, false);
    assert.equal(result.error, "missing_binary");
  });
});
