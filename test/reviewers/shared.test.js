// Tests for src/reviewers/_shared.js runWithTimeout.
//
// Real reviewer tools are never invoked. A fast-exiting Node child is spawned
// via process.execPath so no shell/external binary is required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  runWithTimeout,
  runWithWatchdog,
  forceKill,
  createMarkerScanner,
  collectStream,
  sanePositiveSec,
  MAX_SANE_SEC,
  MAX_OUTPUT_BYTES,
  TIMEOUT_SENTINEL,
} from "../../src/reviewers/_shared.js";

/** Spawn a short Node child running inline source. */
function spawnNode(src) {
  return spawn(process.execPath, ["-e", src], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

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

describe("runWithWatchdog", () => {
  // Fast child: both timers are huge; the call must resolve as soon as the child
  // exits (proves both inactivity and hard-cap timers are cleared, no leak).
  it("resolves promptly for a fast child even with huge inactivity + hard-cap", async () => {
    const child = spawnNode("process.stdout.write('x')");
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs: 120000, hardCapMs: 120000 });
    const elapsed = Date.now() - start;
    assert.notEqual(result, TIMEOUT_SENTINEL);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "x");
    assert.ok(elapsed < 5000, `expected prompt resolution, took ${elapsed}ms`);
  });

  // Silent (no-output) child is killed by the INACTIVITY timer quickly, long
  // before the (large) hard cap — this is the true-hang case.
  it("kills a SILENT child at the inactivity window (well before the hard cap)", async () => {
    const child = spawnNode("setTimeout(() => {}, 10000)");
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs: 200, hardCapMs: 120000 });
    const elapsed = Date.now() - start;
    assert.equal(result, TIMEOUT_SENTINEL, "silent child must hit the inactivity kill");
    assert.ok(elapsed < 3000, `inactivity should fire promptly, took ${elapsed}ms`);
  });

  // KEY FEATURE: a slow-but-STREAMING child that runs FAR longer than the
  // inactivity window is NOT killed — each output chunk resets the inactivity
  // timer — so a legitimately slow reviewer completes instead of being false-killed.
  it("does NOT kill a streaming child that outlives the inactivity window", async () => {
    // Emits a chunk every 100ms, 6 times (~600ms total), then exits 0. With a
    // 250ms inactivity window a FIXED 250ms deadline would have killed it; the
    // watchdog must let it finish because the gaps (100ms) never reach 250ms.
    const child = spawnNode(
      "let n=0;const t=setInterval(()=>{process.stdout.write('.');if(++n>=6){clearInterval(t);process.exit(0);}},100);"
    );
    const result = await runWithWatchdog(child, { inactivityMs: 250, hardCapMs: 120000 });
    assert.notEqual(result, TIMEOUT_SENTINEL, "streaming child must NOT be killed by inactivity");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 6, "all 6 streamed chunks captured (ran past inactivity)");
  });

  // The hard cap is the absolute backstop: a child that streams FOREVER (never
  // idle) is still killed once the hard cap elapses, so the gate can't hang.
  it("kills a never-idle streaming child at the hard cap", async () => {
    const child = spawnNode("setInterval(() => process.stdout.write('.'), 40);");
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs: 120000, hardCapMs: 400 });
    const elapsed = Date.now() - start;
    assert.equal(result, TIMEOUT_SENTINEL, "hard cap must kill a never-idle child");
    assert.ok(elapsed < 4000, `hard cap should fire near 400ms, took ${elapsed}ms`);
  });

  // stderr is DRAINED even when captureStderr is false: a >70KB stderr flood
  // would deadlock a full OS pipe otherwise. The child must still complete.
  it("drains stderr (no deadlock) even when captureStderr is false", async () => {
    const child = spawnNode("process.stderr.write('E'.repeat(70*1024));process.stdout.write('ok');process.exit(0);");
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs: 120000, hardCapMs: 120000 });
    const elapsed = Date.now() - start;
    assert.notEqual(result, TIMEOUT_SENTINEL);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "", "stderr not captured when captureStderr is false");
    assert.ok(elapsed < 5000, `stderr flood must not deadlock, took ${elapsed}ms`);
  });

  // REGRESSION (Finding 3): a reviewer can flood stderr past MAX_OUTPUT_BYTES
  // BEFORE printing opencode's silent agent-fallback marker. Without incremental
  // scanning the marker is truncated out of the captured string and a writable-
  // default-agent verdict is wrongly accepted. With stderrMarkers, the watchdog
  // scans the FULL untruncated stream, so stderrMarkerHit is true even though the
  // marker is absent from the (capped) returned stderr.
  it("detects a stderr marker that appears AFTER a >MAX_OUTPUT_BYTES flood (flood-proof)", async () => {
    const MARKER = "Falling back to default agent";
    // Write >1MB of noise in backpressure-aware chunks, then the marker, then exit
    // 0. drain-aware writes guarantee the noise crosses the pipe before the marker.
    const src = [
      "const total = 1024*1024 + 65536;",
      "let written = 0;",
      "const chunk = Buffer.alloc(16*1024, 0x45);",
      "function pump(){",
      "  while (written < total){",
      "    const ok = process.stderr.write(chunk);",
      "    written += chunk.length;",
      "    if (!ok){ process.stderr.once('drain', pump); return; }",
      "  }",
      `  process.stderr.write(${JSON.stringify(MARKER)} + '\\n', () => process.stdout.write('ok', () => process.exit(0)));`,
      "}",
      "pump();",
    ].join("\n");
    const child = spawnNode(src);
    const result = await runWithWatchdog(child, {
      inactivityMs: 120000,
      hardCapMs: 120000,
      captureStderr: true,
      stderrMarkers: [MARKER],
    });
    assert.notEqual(result, TIMEOUT_SENTINEL, "child must exit, not time out");
    assert.equal(result.exitCode, 0);
    // The captured stderr is byte-capped, so the marker is (or may be) truncated
    // away from the returned string — but the incremental scanner still caught it.
    assert.equal(result.stderrMarkerHit, true, "marker must be detected over the FULL stream despite truncation");
    assert.ok(
      result.stderr.length <= 1024 * 1024,
      "returned stderr is still byte-capped (proves the flood exceeded the cap)"
    );
  });

  // No markers configured / absent marker => stderrMarkerHit is false (no false
  // positive on a clean run).
  it("stderrMarkerHit is false when the marker never appears", async () => {
    const child = spawnNode("process.stderr.write('all normal here');process.stdout.write('ok');process.exit(0);");
    const result = await runWithWatchdog(child, {
      inactivityMs: 120000,
      hardCapMs: 120000,
      captureStderr: true,
      stderrMarkers: ["Falling back to default agent"],
    });
    assert.notEqual(result, TIMEOUT_SENTINEL);
    assert.equal(result.stderrMarkerHit, false, "no marker present -> no hit");
  });
});

describe("sanePositiveSec", () => {
  // Existing contract (rounds 2-3): a sane positive value passes through, and
  // 0 / negative / NaN / Infinity / non-number all fall back. These must be
  // preserved by the int32-overflow clamp added in round 5.
  it("passes through a normal positive value unchanged", () => {
    assert.equal(sanePositiveSec(120, 999), 120);
    assert.equal(sanePositiveSec(1, 999), 1);
    assert.equal(sanePositiveSec(MAX_SANE_SEC, 999), MAX_SANE_SEC, "the cap itself passes through");
  });

  it("falls back for 0 / negative / NaN / non-finite / non-number", () => {
    assert.equal(sanePositiveSec(0, 77), 77, "zero -> fallback");
    assert.equal(sanePositiveSec(-5, 77), 77, "negative -> fallback");
    assert.equal(sanePositiveSec(Number.NaN, 77), 77, "NaN -> fallback");
    assert.equal(sanePositiveSec(Infinity, 77), 77, "Infinity is not finite -> fallback");
    assert.equal(sanePositiveSec(-Infinity, 77), 77, "-Infinity -> fallback");
    assert.equal(sanePositiveSec("300", 77), 77, "string -> fallback");
    assert.equal(sanePositiveSec(null, 77), 77, "null -> fallback");
    assert.equal(sanePositiveSec(undefined, 77), 77, "undefined -> fallback");
  });

  // ROUND 5 (Finding: int32-overflow self-DoS): callers do `seconds * 1000` and
  // pass to setTimeout, whose int32 delay SILENTLY clamps anything over
  // 2_147_483_647 ms down to 1ms. So a huge configured timeoutSec like 3_000_000
  // would fire the watchdog at ~1ms and force-kill EVERY review (TIMEOUT_SENTINEL)
  // — a self-DoS. The clamp keeps seconds×1000 under the int32 max.
  it("clamps an absurdly large value to MAX_SANE_SEC (int32-overflow guard)", () => {
    assert.equal(sanePositiveSec(3_000_000, 120), MAX_SANE_SEC, "3e6 s is clamped to the cap");
    assert.equal(sanePositiveSec(1e12, 120), MAX_SANE_SEC, "even 1e12 s is clamped");
    const clamped = sanePositiveSec(3_000_000, 120);
    assert.ok(clamped <= 2_147_483, "returned seconds must be <= 2_147_483 for a huge input");
    assert.ok(clamped * 1000 <= 2_147_483_647, "seconds*1000 must stay within int32 (no setTimeout clamp)");
  });

  // End-to-end proof: a STREAMING child run under runWithWatchdog with a HUGE
  // configured inactivity/hard-cap (passed through sanePositiveSec, as the real
  // callers do) must NOT be killed at ~1ms. Pre-fix the 3e9 ms delay clamps to
  // 1ms and TIMEOUT_SENTINEL fires instantly; post-fix the clamped timers let the
  // child finish normally.
  it("a streaming child with a huge configured timeout is NOT killed at 1ms", async () => {
    // Same shape as the callers: configured seconds -> sanePositiveSec -> *1000.
    const inactivityMs = sanePositiveSec(3_000_000, 120) * 1000;
    const hardCapMs = sanePositiveSec(3_000_000, 1800) * 1000;
    // Emits a chunk every 60ms, 5 times (~300ms), then exits 0. If the timers had
    // overflowed to 1ms this would be force-killed almost immediately.
    const child = spawnNode(
      "let n=0;const t=setInterval(()=>{process.stdout.write('.');if(++n>=5){clearInterval(t);process.exit(0);}},60);"
    );
    const start = Date.now();
    const result = await runWithWatchdog(child, { inactivityMs, hardCapMs });
    const elapsed = Date.now() - start;
    assert.notEqual(result, TIMEOUT_SENTINEL, "huge configured timeout must NOT force-kill (no int32 overflow to 1ms)");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 5, "all 5 streamed chunks captured");
    assert.ok(elapsed >= 250, `child must have run its full ~300ms, not been killed at ~1ms (took ${elapsed}ms)`);
  });
});

describe("createMarkerScanner", () => {
  it("detects a marker split across two chunks (sliding-window carry)", () => {
    const s = createMarkerScanner(["Falling back to default agent"]);
    s.onChunk(Buffer.from("noise...Falling back to de"));
    assert.equal(s.hit(), false, "not yet complete after first chunk");
    s.onChunk(Buffer.from("fault agent\n"));
    assert.equal(s.hit(), true, "marker completed across the boundary must be detected");
  });

  it("detects a marker emitted after >MAX_OUTPUT_BYTES of noise (no scanner truncation)", () => {
    const s = createMarkerScanner(["Falling back to default agent"]);
    s.onChunk(Buffer.alloc(2 * 1024 * 1024, 0x45)); // 2MB noise, well past the cap
    s.onChunk(Buffer.from("Falling back to default agent"));
    assert.equal(s.hit(), true, "scanner is not byte-capped; post-flood marker detected");
  });

  it("returns false when no marker is present, and for an empty marker list", () => {
    const s = createMarkerScanner(["MARKER"]);
    s.onChunk(Buffer.from("totally unrelated output"));
    assert.equal(s.hit(), false);
    const empty = createMarkerScanner([]);
    empty.onChunk(Buffer.from("MARKER appears but no markers configured"));
    assert.equal(empty.hit(), false, "empty marker list never hits");
  });

  it("matches any of multiple markers", () => {
    const s = createMarkerScanner(["not found", "Falling back to default agent"]);
    s.onChunk(Buffer.from('agent "x" not found'));
    assert.equal(s.hit(), true, "first marker matched");
  });
});

describe("collectStream + marker scanner (deterministic truncation proof)", () => {
  // DETERMINISTIC proof of the Finding 3 fix, independent of OS pipe-flush timing:
  // a synthetic stream emits >MAX_OUTPUT_BYTES of noise, THEN a chunk carrying the
  // marker, then close. The CAPTURED string is truncated (marker absent), but the
  // scanner — fed every chunk before truncation — still reports the hit.
  it("captured string truncates the post-cap marker, but the scanner still detects it", async () => {
    const MARKER = "Falling back to default agent";
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    const scanner = createMarkerScanner([MARKER]);

    const captured = collectStream(child, "stderr", MAX_OUTPUT_BYTES, scanner);
    // Past-cap noise, then the marker chunk, then close.
    child.stderr.emit("data", Buffer.alloc(MAX_OUTPUT_BYTES + 1024, 0x45));
    child.stderr.emit("data", Buffer.from(MARKER + "\n", "utf8"));
    child.emit("close", 0);

    const stderr = await captured;
    assert.equal(Buffer.byteLength(stderr), MAX_OUTPUT_BYTES, "captured stderr is hard-capped");
    assert.equal(stderr.includes(MARKER), false, "marker is truncated OUT of the captured string");
    assert.equal(scanner.hit(), true, "but the incremental scanner still caught it (flood-proof)");
  });
});

describe("forceKill", () => {
  // REGRESSION (Finding 1): on POSIX, a child that TRAPS SIGTERM must still be
  // killed — forceKill escalates to SIGKILL after the grace period. Without the
  // escalation the trapping child would survive as a zombie holding the gate's
  // permissions. SIGKILL cannot be trapped, so the child exits with signal
  // SIGKILL. Skipped on Windows (forceKill uses taskkill /F there, already
  // unconditional, and POSIX signals do not apply).
  it("escalates to SIGKILL for a SIGTERM-trapping child on POSIX", async () => {
    if (process.platform === "win32") {
      return; // POSIX-signal behavior only.
    }
    // Trap (ignore) SIGTERM and stay alive; only an unconditional SIGKILL ends it.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    forceKill(child);
    // Race the exit against a generous deadline: SIGKILL fires after the ~2s grace
    // period, so the child must be gone well within ~6s.
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("survived"), 6000)),
    ]);
    assert.notEqual(result, "survived", "a SIGTERM-trapping child must be SIGKILLed, not survive");
    assert.equal(result.signal, "SIGKILL", `expected SIGKILL, got ${JSON.stringify(result)}`);
  });
});
