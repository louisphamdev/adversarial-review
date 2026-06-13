// Tests for src/reviewers/_shared.js runWithTimeout.
//
// Real reviewer tools are never invoked. A fast-exiting Node child is spawned
// via process.execPath so no shell/external binary is required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runWithTimeout, TIMEOUT_SENTINEL } from "../../src/reviewers/_shared.js";

describe("runWithTimeout", () => {
  // BUG 2 (hang/leak): runWithTimeout used to never clear its timeout timer, so a
  // pending setTimeout kept the event loop alive for up to timeoutMs (~120s) after
  // the process already completed. With a large timeout and a fast child, the call
  // must still resolve PROMPTLY (proving the timer no longer blocks).
  it("resolves promptly for a fast child even with a huge timeout (timer is cleared)", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('x')"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const start = Date.now();
    const result = await runWithTimeout(child, { timeoutMs: 120000 });
    const elapsed = Date.now() - start;

    // Must NOT be the timeout branch.
    assert.notEqual(result, TIMEOUT_SENTINEL, "fast child must not hit the timeout");
    assert.equal(result.exitCode, 0, "fast child exits 0");
    assert.equal(result.stdout, "x", "captured the small stdout");
    // Resolves well under the 120s timeout — proves the call returns as soon as the
    // process completes, not after the timer.
    assert.ok(elapsed < 5000, `expected prompt resolution, took ${elapsed}ms`);
  });

  it("returns TIMEOUT_SENTINEL when the child outlives a short timeout", async () => {
    // A child that sleeps far longer than the timeout. runWithTimeout force-kills
    // the tree and returns the sentinel.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const result = await runWithTimeout(child, { timeoutMs: 200 });
    assert.equal(result, TIMEOUT_SENTINEL, "slow child must hit the timeout sentinel");
  });
});
