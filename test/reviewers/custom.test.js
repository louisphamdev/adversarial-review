// Tests for the custom reviewer adapter.
//
// Real external tools are never invoked. Tests use Node.js stub scripts.
// Key coverage:
//  - trust flag required (untrusted config refuses before spawn)
//  - unknown placeholder throws BEFORE spawn (no process started)
//  - valid pass/fail/timeout/nonzero/malformed paths

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAdapter } from "../../src/reviewers/custom.js";
import { createStubs, makeJob, buildVerdictOutput } from "./stub-helper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a config for a custom reviewer pointing at a stub script.
 *
 * @param {string} stubPath  - absolute path to the Node stub .mjs
 * @param {object} [extras]  - overrides for the reviewer config
 */
function makeCustomConfig(stubPath, extras = {}) {
  return {
    reviewers: {
      "my-reviewer": {
        type: "custom",
        trusted: true,
        // The command is process.execPath (node); args start with the stub path.
        command: process.execPath,
        args: [stubPath, "{cwd}", "{diffPath}"],
        timeoutSec: 10,
        ...extras,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("custom adapter", () => {
  let stubs;
  let job;

  before(async () => {
    job = makeJob({ reviewer: "my-reviewer" });
    stubs = await createStubs(job);
    job = { ...job, diffPath: stubs.paths.diff };
  });

  after(async () => {
    await stubs.cleanup();
  });

  // --- Trust check ---

  it("verify() returns ok:false when trusted flag is absent", async () => {
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          command: process.execPath,
          args: [],
          // trusted is intentionally omitted
        },
      },
    };
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "untrusted_custom_reviewer");
  });

  it("run() returns ok:false with untrusted_custom_reviewer when trusted flag is absent", async () => {
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          command: process.execPath,
          args: [],
          // trusted intentionally omitted
        },
      },
    };
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "untrusted_custom_reviewer");
  });

  it("run() returns ok:false when trusted is false", async () => {
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: false,
          command: process.execPath,
          args: [],
        },
      },
    };
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "untrusted_custom_reviewer");
  });

  // --- Unknown placeholder (injection guard) ---

  it("run() returns ok:false with invalid_placeholder error for unknown placeholder BEFORE spawn", async () => {
    // The args contain an unknown placeholder {secretEnv} that should be rejected
    // before any process is spawned.
    let spawnCount = 0;
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: true,
          command: process.execPath,
          args: ["{secretEnv}", "{diffPath}"],  // {secretEnv} is not allowed
          timeoutSec: 10,
        },
      },
    };
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    // The error should reference the unknown placeholder, not a spawn error.
    assert.ok(
      result.error.includes("invalid_placeholder") || result.error.includes("secretEnv"),
      `Expected invalid_placeholder error, got: ${result.error}`
    );
  });

  // --- createAdapter() type check ---

  it("createAdapter() throws immediately when type is not 'custom'", () => {
    const config = {
      reviewers: {
        "bad-reviewer": {
          type: "builtin",  // not "custom"
          command: "something",
        },
      },
    };
    assert.throws(
      () => createAdapter(config, "bad-reviewer"),
      /type:"custom"/
    );
  });

  // --- valid pass ---

  it("run() returns ok:true with verdict.verdict==='pass' for a valid pass stub", async () => {
    const config = makeCustomConfig(stubs.paths.pass);
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
    assert.equal(result.verdict.verdict, "pass");
  });

  // --- the real diff content is delivered to the reviewer ---

  it("run() writes job.diffText to the {diffPath} file when no job.diffPath is set", async () => {
    const recDir = await mkdtemp(join(tmpdir(), "ar-custom-diff-"));
    const recDiff = join(recDir, "diff-seen.txt");
    const stubDir = await mkdtemp(join(tmpdir(), "ar-custom-stub-"));
    const stubPath = join(stubDir, "custom-diff-stub.cjs");
    // The stub receives the diff path as argv[2] ({diffPath}), reads it, copies
    // its content to a side file, then prints a pass verdict.
    const verdictBlock = buildVerdictOutput(makeJob({ reviewer: "my-reviewer" }), "pass");
    await writeFile(
      stubPath,
      `
const fs = require("node:fs");
const diffPath = process.argv[3];
let content = "";
try { content = fs.readFileSync(diffPath, "utf8"); } catch {}
try { fs.writeFileSync(${JSON.stringify(recDiff)}, content); } catch {}
process.stdout.write(${JSON.stringify(verdictBlock)});
process.exit(0);
`,
      "utf8"
    );
    // A job WITHOUT diffPath but WITH diffText: the adapter must write the diff
    // content to its temp file and expand {diffPath} to that path.
    const diffJob = { ...job, diffPath: undefined, diffText: "DIFFMARKER-12345" };
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: true,
          command: process.execPath,
          args: [stubPath, "{cwd}", "{diffPath}"],
          timeoutSec: 10,
        },
      },
    };
    try {
      const adapter = createAdapter(config, "my-reviewer");
      const result = await adapter.run(diffJob, {});
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);

      const seen = await readFile(recDiff, "utf8");
      assert.ok(seen.length > 0, "diff file delivered to reviewer must NOT be empty");
      assert.ok(
        seen.includes("DIFFMARKER-12345"),
        `diff file must contain the job's diffText, got: ${JSON.stringify(seen)}`
      );
    } finally {
      await rm(stubDir, { recursive: true, force: true });
      await rm(recDir, { recursive: true, force: true });
    }
  });

  // --- valid fail ---

  it("run() returns ok:true with verdict.verdict==='fail' for a valid fail stub", async () => {
    const config = makeCustomConfig(stubs.paths.fail);
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
    assert.equal(result.verdict.verdict, "fail");
  });

  // --- timeout ---

  it("run() returns ok:false with error==='timeout' when stub sleeps past timeoutSec", async () => {
    const config = makeCustomConfig(stubs.paths.sleep, { timeoutSec: 0.2 });
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "timeout");
  });

  // --- non-zero exit ---

  it("run() returns ok:false when stub exits with code 1", async () => {
    const config = makeCustomConfig(stubs.paths.nonzero);
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    assert.ok(result.error, "should have an error reason");
  });

  // --- malformed output ---

  it("run() returns ok:false when stub prints malformed output", async () => {
    const config = makeCustomConfig(stubs.paths.malformed);
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.run(job, {});
    assert.equal(result.ok, false);
    assert.ok(result.error, "should have an error reason");
  });

  // --- verify() with trusted binary ---

  it("verify() returns ok:true when trusted flag is set and binary resolves", async () => {
    // Use process.execPath as the command — it always resolves.
    const config = {
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: true,
          command: process.execPath,
          args: [],
        },
      },
    };
    const adapter = createAdapter(config, "my-reviewer");
    const result = await adapter.verify();
    assert.equal(result.ok, true, `verify failed: ${result.reason}`);
    assert.ok(result.resolvedPath, "should have a resolvedPath");
  });
});
