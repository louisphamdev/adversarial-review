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
// Used by the FIXED-deadline runWithTimeout (verify() probes). For the actual
// review run(), see the inactivity/hard-cap watchdog constants below.
export const DEFAULT_TIMEOUT_SEC = 120;

// Default inactivity window (seconds) for the review run() watchdog: the
// reviewer is force-killed only after this many seconds with NO output on
// stdout/stderr (a liveness check), NOT at a fixed wall-clock deadline — a
// reviewer that is still streaming output is never killed mid-review. A truly
// hung reviewer (no output) is still caught quickly, so the gate never hangs.
export const DEFAULT_INACTIVITY_SEC = 120;

// Absolute hard-cap backstop (seconds) for the review run() watchdog: even a
// reviewer that keeps dribbling output is force-killed after this long, so the
// gate can never hang forever (preserves the async-lifecycle invariant). Set
// far above any real review so it only ever catches a runaway.
export const DEFAULT_HARDCAP_SEC = 1800;

// Maximum stdout/stderr bytes captured from the reviewer process.
export const MAX_OUTPUT_BYTES = 1024 * 1024;

// Grace period (ms) on POSIX between the initial SIGTERM and the SIGKILL
// escalation in forceKill. A well-behaved child exits on SIGTERM within this
// window; a child that TRAPS or ignores SIGTERM (e.g. `trap '' TERM; sleep`) is
// then unconditionally SIGKILLed so a hung/malicious reviewer can never survive
// the watchdog as a zombie holding the gate's permissions.
export const FORCE_KILL_GRACE_MS = 2000;

// Sentinel value returned by the timeout race arm.
export const TIMEOUT_SENTINEL = Symbol("timeout");

// Upper bound (seconds) for any configured timeout. Callers do `seconds * 1000`
// and pass the result to setTimeout, whose delay is a 32-bit signed int: a value
// whose ms product exceeds 2_147_483_647 is SILENTLY clamped by Node to 1ms (with
// a TimeoutOverflowWarning), which would fire the inactivity / hard-cap watchdog
// at ~1ms and force-kill EVERY review instantly (TIMEOUT_SENTINEL) — a self-DoS.
// 2_147_483 s (~24.8 days) is far above any real reviewer run, and ×1000 stays
// under the int32 max, so clamping here keeps the timers honest.
export const MAX_SANE_SEC = 2_147_483;

/**
 * Clamp a configured seconds value to a sane positive number, else the fallback.
 *
 * Defense-in-depth for the reviewer timers: a 0 / negative / NaN / non-numeric
 * timeout would instantly fire the watchdog and wedge the gate (a DoS primitive
 * if it ever came from an untrusted layer). The config trust floor already keeps
 * a project from setting these, but a malformed user value or test override is
 * neutralized here too.
 *
 * An absurdly LARGE value is just as dangerous: callers multiply by 1000 for ms,
 * and setTimeout's int32 delay silently clamps anything over ~2.1e9 ms down to
 * 1ms, firing the watchdog instantly and self-DoSing the gate. So the value is
 * also clamped to MAX_SANE_SEC, keeping seconds×1000 under the int32 max.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function sanePositiveSec(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_SANE_SEC)
    : fallback;
}

/**
 * Scan the FULL (untruncated) stream for any of `markers`, even when the captured
 * string is byte-capped. A reviewer can flood stdout/stderr past MAX_OUTPUT_BYTES
 * BEFORE printing a security-critical marker (e.g. opencode's silent
 * agent-fallback warning); if the marker check ran only on the truncated captured
 * string it would be defeated by the flood and a writable-agent review wrongly
 * accepted. This scanner observes EVERY chunk before truncation and carries a tail
 * of `maxMarkerLen-1` bytes across chunk boundaries so a marker split across two
 * chunks is still detected.
 *
 * @param {string[]} markers  - substrings whose presence flips the hit flag
 * @returns {{ onChunk(chunk: Buffer): void, hit(): boolean }}
 */
export function createMarkerScanner(markers) {
  const list = (markers || []).map(String).filter(Boolean);
  let found = false;
  let carry = "";
  // Longest marker - 1: the max overlap that could straddle a chunk boundary.
  const overlap = list.reduce((m, s) => Math.max(m, s.length), 0);
  return {
    onChunk(chunk) {
      if (found || list.length === 0) return;
      const text = carry + chunk.toString("utf8");
      for (const marker of list) {
        if (text.includes(marker)) {
          found = true;
          carry = "";
          return;
        }
      }
      // Keep only the tail that could still begin a marker spanning into the next
      // chunk; bound carry growth so a flood cannot balloon memory.
      carry = overlap > 1 ? text.slice(-(overlap - 1)) : "";
    },
    hit() {
      return found;
    },
  };
}

/**
 * Collect one of a child's output streams up to `maxBytes`, then resolve.
 *
 * Optionally also runs a marker scanner over the FULL untruncated stream (see
 * createMarkerScanner) so a security-critical marker that appears AFTER the byte
 * cap is still detected even though it is dropped from the returned string.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {"stdout"|"stderr"} which   - which stream to read
 * @param {number} [maxBytes]         - byte cap (defaults to MAX_OUTPUT_BYTES)
 * @param {{onChunk:Function}} [scanner] - optional marker scanner fed every chunk
 * @returns {Promise<string>}
 */
export function collectStream(child, which, maxBytes = MAX_OUTPUT_BYTES, scanner = null) {
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
      // Feed the marker scanner on EVERY chunk BEFORE the truncation short-circuit
      // — a flood must never hide a post-cap marker from the scanner.
      if (scanner) scanner.onChunk(chunk);
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
 * @param {{onChunk:Function}} [scanner] - optional marker scanner (see collectStream)
 * @returns {Promise<string>}
 */
export function collectStderr(child, scanner = null) {
  return collectStream(child, "stderr", MAX_OUTPUT_BYTES, scanner);
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
 * Send a POSIX signal to the child's whole PROCESS GROUP, falling back to the lone
 * child pid if the group send is not possible.
 *
 * The reviewer children are spawned with `detached: true` (see
 * core/process.js spawnResolved), which on POSIX makes the child a process-group
 * LEADER (pgid == pid). `process.kill(-pid, sig)` then delivers `sig` to EVERY
 * process in that group — the child AND any descendant it forked (or any process
 * its shell wrapper backgrounded). Signalling only the direct child (`child.kill`)
 * would leave such descendants ALIVE after the watchdog fires: orphaned processes
 * that keep consuming resources and hold the gate's ambient permissions,
 * accumulating across opencode's model-fallback retries.
 *
 * The group send can fail in two ways that BOTH require the direct-child fallback,
 * so any failure falls through to `child.kill(signal)`:
 *   - ESRCH on `-pid` is AMBIGUOUS: it means either the detached group is already
 *     gone (child exited — the fallback then no-ops with its own swallowed ESRCH),
 *     OR the child was NOT spawned detached so no group is named `pid` even though
 *     the child is still ALIVE (the fallback then signals it). Treating `-pid`
 *     ESRCH as unconditional success would silently leak a live non-detached child.
 *   - any other error (e.g. EPERM/unsupported) — fall back so a hung child is still
 *     terminated rather than the send silently no-op'ing.
 * The direct-child fallback swallows its OWN ESRCH (the child exited in the
 * meantime), so a genuinely-gone process is a clean no-op on every path.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid => the whole process group led by `pid`.
    process.kill(-pid, signal);
  } catch {
    // Group send failed (gone, no group, or unsupported). Fall back to the direct
    // child so a live non-detached child is still terminated; swallow ESRCH there
    // (the child already exited).
    try {
      child.kill(signal);
    } catch (err2) {
      if (err2 && err2.code === "ESRCH") return;
      /* already gone / cannot signal — ignore */
    }
  }
}

/**
 * Kill a child process tree as forcefully as possible.
 * On Windows, cmd.exe /c wrappers spawn node as a child; killing only the
 * cmd.exe parent leaves the node child running. Use taskkill /F /T to
 * terminate the entire process tree (already unconditional/forceful).
 *
 * On POSIX, signal the child's whole PROCESS GROUP (the children are spawned
 * `detached`, so the child is a group leader): send SIGTERM first (graceful) but
 * ESCALATE to SIGKILL after a short grace period. A child that traps or ignores
 * SIGTERM (e.g. a malicious custom reviewer running `trap '' TERM; sleep 3600`),
 * OR a descendant the reviewer forked, would otherwise survive the watchdog kill
 * as a zombie still holding the gate's full permissions — and with opencode's
 * model-fallback chain, each timed-out model iteration could leak another. The
 * group-wide follow-up SIGKILL is unconditional, so a hung/malicious reviewer and
 * all of its descendants are reliably terminated. The escalation timer is
 * unref()'d so it never holds the Node event loop open if the gate is otherwise
 * done.
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
      // Graceful first (whole group), then an unconditional group-wide SIGKILL
      // after the grace period so neither a SIGTERM-trapping child NOR a forked
      // descendant can survive as a zombie.
      signalGroup(child, "SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          // Re-send SIGKILL to the whole GROUP UNCONDITIONALLY after the grace
          // period. We deliberately do NOT gate on `child.exitCode === null`: a
          // descendant the reviewer forked can OUTLIVE the direct child (which may
          // have exited on SIGTERM and already been reaped), so guarding on the
          // leader's exit would skip the SIGKILL and leak the descendant. A
          // group-wide SIGKILL to an already-empty group is a harmless ESRCH
          // (swallowed by signalGroup), so the unconditional send is safe.
          signalGroup(child, "SIGKILL");
        } catch { /* already gone */ }
      }, FORCE_KILL_GRACE_MS);
      if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
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
  // Capture the timer id so it can be cleared once the race settles. Without the
  // clearTimeout below, a pending setTimeout keeps the Node event loop alive for
  // up to timeoutMs after the process already completed, hanging the CLI/hook.
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    // unref() is a secondary measure so the timer alone never blocks exit; the
    // clearTimeout below is the primary fix.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  let raceResult;
  try {
    raceResult = await Promise.race([processPromise, timeoutPromise]);
  } finally {
    // Always clear the pending timeout timer — on BOTH the timeout branch and the
    // normal completion branch — so the event loop is not held open.
    clearTimeout(timer);
  }

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

/**
 * Run a spawned child under an INACTIVITY watchdog instead of a fixed deadline.
 *
 * Unlike runWithTimeout (a single wall-clock timer), this kills the child only
 * when BOTH liveness checks say it is stuck:
 *  - inactivity: no stdout/stderr output for `inactivityMs` (the timer RESETS on
 *    every output chunk, so a reviewer still streaming is never killed); and
 *  - hard cap: an absolute `hardCapMs` backstop that is NEVER reset, so even a
 *    reviewer that dribbles output forever is eventually killed (the gate can
 *    never hang). Whichever fires first force-kills the child tree.
 *
 * The activity listeners are attached to BOTH stdout and stderr, which also
 * DRAINS stderr even when captureStderr is false — a stderr flood can therefore
 * never deadlock on a full OS pipe buffer.
 *
 * On a kill, returns TIMEOUT_SENTINEL (same contract as runWithTimeout) so every
 * caller's existing fail-closed handling applies unchanged.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {object} opts
 * @param {number} opts.inactivityMs      - max ms of no-output before killing
 * @param {number} opts.hardCapMs         - absolute ms backstop before killing
 * @param {boolean} [opts.captureStderr]  - also return stderr (default false;
 *        stderr is drained either way)
 * @param {string[]} [opts.stderrMarkers] - substrings to scan for over the FULL
 *        untruncated stderr stream; the result's `stderrMarkerHit` is true if any
 *        appeared. Detection cannot be defeated by flooding stderr past the byte
 *        cap before the marker (the scanner sees every chunk pre-truncation).
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, stderrMarkerHit:boolean} | typeof TIMEOUT_SENTINEL>}
 */
export async function runWithWatchdog(child, { inactivityMs, hardCapMs, captureStderr = false, stderrMarkers = null }) {
  // Scan the FULL stderr stream for security-critical markers so a flood that
  // pushes the marker past MAX_OUTPUT_BYTES cannot hide it from the check.
  const scanner = stderrMarkers && stderrMarkers.length ? createMarkerScanner(stderrMarkers) : null;
  const collectors = captureStderr
    ? [collectOutput(child), collectStderr(child, scanner), waitForExit(child)]
    : [collectOutput(child), waitForExit(child)];
  // When stderr is NOT captured but markers were requested, attach the scanner
  // directly to the (drained) stderr stream so detection still works.
  if (!captureStderr && scanner && child.stderr) {
    child.stderr.on("data", (chunk) => scanner.onChunk(chunk));
  }
  const processPromise = Promise.all(collectors);

  let inactivityTimer;
  let hardCapTimer;
  let settled = false;
  const timeoutPromise = new Promise((resolve) => {
    const fire = () => { if (!settled) resolve(TIMEOUT_SENTINEL); };
    const resetInactivity = () => {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(fire, inactivityMs);
      if (inactivityTimer && typeof inactivityTimer.unref === "function") inactivityTimer.unref();
    };
    // Any output (stdout OR stderr) is liveness: reset the inactivity window.
    // Attaching to stderr here also keeps it FLOWING (drained) so a stderr flood
    // cannot deadlock even when captureStderr is false.
    if (child.stdout) child.stdout.on("data", resetInactivity);
    if (child.stderr) child.stderr.on("data", resetInactivity);
    resetInactivity(); // arm the initial inactivity window
    hardCapTimer = setTimeout(fire, hardCapMs);
    if (hardCapTimer && typeof hardCapTimer.unref === "function") hardCapTimer.unref();
  });

  let raceResult;
  try {
    raceResult = await Promise.race([processPromise, timeoutPromise]);
  } finally {
    // Clear BOTH timers on every exit path (timeout AND normal completion) so a
    // pending setTimeout never holds the event loop open after run() returns.
    settled = true;
    clearTimeout(inactivityTimer);
    clearTimeout(hardCapTimer);
  }

  if (raceResult === TIMEOUT_SENTINEL) {
    forceKill(child);
    return TIMEOUT_SENTINEL;
  }

  const stderrMarkerHit = scanner ? scanner.hit() : false;
  if (captureStderr) {
    const [stdout, stderr, exitCode] = raceResult;
    return { stdout, stderr, exitCode, stderrMarkerHit };
  }
  const [stdout, exitCode] = raceResult;
  return { stdout, stderr: "", exitCode, stderrMarkerHit };
}
