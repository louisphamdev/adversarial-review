// Shared process plumbing for reviewer adapters.
//
// codex.js, opencode.js, and custom.js previously each carried a byte-identical
// copy of the stream-collection / exit-wait / force-kill helpers. Those copies
// drift independently (a fix applied to one but not the others), so they are
// consolidated here. Each adapter keeps ONLY its unique buildPrompt/buildBrief +
// arg construction (and opencode's fallback-marker check); all generic child
// I/O lives in this module.

import { spawnSync } from "node:child_process";

// Default timeout in seconds when neither config nor job specifies one.
export const DEFAULT_TIMEOUT_SEC = 120;

// Maximum stdout/stderr bytes captured from the reviewer process.
export const MAX_OUTPUT_BYTES = 1024 * 1024;

// Sentinel value returned by the timeout race arm.
export const TIMEOUT_SENTINEL = Symbol("timeout");

/**
 * Collect one of a child's output streams up to `maxBytes`, then resolve.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {"stdout"|"stderr"} which   - which stream to read
 * @param {number} [maxBytes]         - byte cap (defaults to MAX_OUTPUT_BYTES)
 * @returns {Promise<string>}
 */
export function collectStream(child, which, maxBytes = MAX_OUTPUT_BYTES) {
  return new Promise((resolve) => {
    const stream = child[which];
    if (!stream) {
      resolve("");
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    stream.on("data", (chunk) => {
      if (truncated) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        truncated = true;
        chunks.push(chunk.slice(0, chunk.length - (totalBytes - maxBytes)));
      } else {
        chunks.push(chunk);
      }
    });

    // Resolve on close OR error so a failed spawn never hangs this promise.
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Collect stdout from a child process up to MAX_OUTPUT_BYTES.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<string>}
 */
export function collectOutput(child) {
  return collectStream(child, "stdout");
}

/**
 * Collect stderr from a child process up to MAX_OUTPUT_BYTES.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<string>}
 */
export function collectStderr(child) {
  return collectStream(child, "stderr");
}

/**
 * Wait for a child process to exit and return its exit code.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<number|null>}
 */
export function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
}

/**
 * Kill a child process tree as forcefully as possible.
 * On Windows, cmd.exe /c wrappers spawn node as a child; killing only the
 * cmd.exe parent leaves the node child running. Use taskkill /F /T to
 * terminate the entire process tree.
 *
 * @param {import("node:child_process").ChildProcess} child
 */
export function forceKill(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch { /* ignore */ }
}

/**
 * Race a spawned child's completion against a timeout.
 *
 * Collects stdout (always) and stderr (when captureStderr) up to MAX_OUTPUT_BYTES,
 * waits for exit, and force-kills the process tree if the timeout fires first.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {object} opts
 * @param {number} opts.timeoutMs         - timeout in milliseconds
 * @param {boolean} [opts.captureStderr]  - also collect stderr (default false)
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null} | typeof TIMEOUT_SENTINEL>}
 *          TIMEOUT_SENTINEL when the timeout fired (the child tree was killed).
 */
export async function runWithTimeout(child, { timeoutMs, captureStderr = false }) {
  const collectors = captureStderr
    ? [collectOutput(child), collectStderr(child), waitForExit(child)]
    : [collectOutput(child), waitForExit(child)];

  const processPromise = Promise.all(collectors);
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs)
  );

  const raceResult = await Promise.race([processPromise, timeoutPromise]);
  if (raceResult === TIMEOUT_SENTINEL) {
    forceKill(child);
    return TIMEOUT_SENTINEL;
  }

  if (captureStderr) {
    const [stdout, stderr, exitCode] = raceResult;
    return { stdout, stderr, exitCode };
  }
  const [stdout, exitCode] = raceResult;
  return { stdout, stderr: "", exitCode };
}
