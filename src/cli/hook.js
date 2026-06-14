// `adversarial-review hook` — run as a native host lifecycle hook.
//
// Currently supports the Claude Code host (--host claude-code) with two events:
//   --event session-start : capture + persist the workspace baseline (no output).
//   --event stop (default) : run the gate and emit Claude Stop-hook JSON.
//
// The Stop event reads the host payload from stdin (JSON), loads the baseline
// recorded at SessionStart, builds the gate input, runs evaluateGate, and maps
// the decision to the Claude Stop hook protocol:
//   block            -> {"decision":"block","reason":"..."}
//   advisory message -> {"systemMessage":"..."}
//   silent allow     -> no stdout output
//
// HARDENING #1: state lives at a user-level path (resolveStateDir), never
// repo-relative. HARDENING #2: gate evaluation is wrapped in a fail-closed
// try/catch that blocks on edit evidence in enforced/strict.

import { realpathSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { evaluateGate, block } from "../core/gate.js";
import { captureBaseline } from "../core/diff.js";
import { loadEffectiveConfig, resolveStateDir } from "../core/load-config.js";
import { readSessionState, writeSessionState } from "../core/state.js";
import { isStrict } from "../core/policy.js";
import { parseJsonl, scanKeys, isSubagentTranscript } from "../core/transcript.js";
import { buildHostRouting } from "./host-map.js";
import { failClosedDecision } from "./fail-closed.js";

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function hookCommand(argv, io) {
  const host = parseFlag(argv, "--host") || "claude-code";
  const event = parseFlag(argv, "--event") || "stop";
  const env = io.env || process.env;

  // ASYNC-3: bound the stdin read. If the host opens but never closes the stdin
  // pipe the read would hang the hook forever; readStdinJson races the drain
  // against a timeout and yields {} on timeout so the gate proceeds / fails
  // closed per its missing-payload logic. io.stdinTimeoutMs lets tests inject a
  // short timeout without slowing the normal fast path.
  const payload = await readStdinJson(io.stdin, io.stdinTimeoutMs);
  // The host payload carries the authoritative cwd; fall back to the process cwd.
  const cwd = (payload && typeof payload.cwd === "string" && payload.cwd) || io.cwd;
  const sessionId = (payload && payload.session_id) || "default";
  const stateDir = resolveStateDir(env, cwd);
  // Key state by session id AND canonical workspace root so distinct workspaces
  // never share a baseline even when they share a session_id (cross-workspace
  // baseline-collision bypass). This composite key is used both for direct
  // readSessionState/writeSessionState here AND as the evaluateGate sessionId.
  const stateKey = sessionStateKey(sessionId, cwd);

  if (event === "session-start") {
    return sessionStart({ cwd, stateKey, stateDir, io });
  }
  return stopEvent({ argv, host, env, payload, cwd, sessionId, stateKey, stateDir, io });
}

// ---------------------------------------------------------------------------
// session-start: record the baseline. No blocking output.
// ---------------------------------------------------------------------------

async function sessionStart({ cwd, stateKey, stateDir, io }) {
  try {
    const baseline = await captureBaseline(cwd);
    const prev = await readSessionState(stateDir, stateKey);
    await writeSessionState(stateDir, stateKey, {
      ...prev,
      baseline,
      // Store the CANONICAL workspace root so the Stop event can validate that
      // the baseline belongs to the workspace it is being evaluated against.
      workspaceRoot: canonicalWorkspaceRoot(cwd),
      updatedAt: Date.now(),
    });
  } catch (err) {
    // SessionStart is best-effort; a failure here is surfaced but never blocks.
    // The Stop event will detect the missing baseline and fail closed there.
    io.stderr.write(`adversarial-review: session-start baseline capture failed: ${err.message}\n`);
  }
  // No stdout output for SessionStart.
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// stop: evaluate the gate and emit Claude Stop-hook JSON.
// ---------------------------------------------------------------------------

async function stopEvent({ host, env, payload, cwd, sessionId, stateKey, stateDir, io }) {
  const config = await loadEffectiveConfig(cwd, io);
  const enforced = config.policy.mode === "enforced" || isStrict(config);

  const transcriptPath =
    (payload && typeof payload.transcript_path === "string" && payload.transcript_path) || "";
  const stopHookActive = Boolean(payload && payload.stop_hook_active);
  // AUTHORITATIVE event name set by Claude Code itself (NOT repo content). Only a
  // genuine "SubagentStop" may skip the gate; a plain "Stop" / missing value
  // keeps the gate armed. See isSubagentTranscript for the fail-closed rationale.
  const hookEventName =
    (payload && typeof payload.hook_event_name === "string" && payload.hook_event_name) || "";

  // Subagent Stop events never trigger the gate (avoid serializing pipelines).
  // The gate also checks this, but short-circuit here to avoid any state IO.
  // Gated on the host-set event name — untrusted transcriptPath/sessionId can no
  // longer silently disable the gate (fail-OPEN); when ambiguous we review.
  if (isSubagentTranscript(transcriptPath, sessionId, hookEventName)) {
    return emit(null, io); // silent allow
  }

  // Read the transcript text (tolerant: unreadable -> ""). ASYNC: bounded by a
  // timeout so a FIFO/device file / hung network FS at transcriptPath cannot block
  // the Stop hook until Claude Code's 300s kill (a killed hook emits no block =
  // fail-OPEN). On timeout we resolve to "" and proceed; with edit evidence the
  // empty transcript routes into the missing-baseline fail-CLOSED path (block in
  // enforced/strict), so a slow read can never silently allow a change.
  let transcript = "";
  if (transcriptPath) {
    transcript = await readTranscriptFile(transcriptPath, io.transcriptTimeoutMs);
  }

  // Load the baseline recorded at SessionStart (keyed by session id AND
  // canonical workspace root).
  const state = await readSessionState(stateDir, stateKey);

  // Defense-in-depth: even with the composite state key, never trust a baseline
  // whose recorded workspaceRoot does not match the workspace we are evaluating.
  // If it differs (or is somehow stale/mismatched), treat the baseline as ABSENT
  // so we route into the missing-baseline path (block in enforced/strict; NOW
  // baseline with a disclosed limitation in soft) rather than silently reusing a
  // foreign repo's baseline.
  const canonicalCwd = canonicalWorkspaceRoot(cwd);
  const workspaceMatches =
    !state.workspaceRoot || state.workspaceRoot === canonicalCwd;
  let baseline = workspaceMatches ? state.baseline || null : null;

  // Detect edit evidence so we can fail closed on a missing baseline.
  const { lastEditKey, editedPaths } = scanKeys(parseJsonl(transcript));
  const transcriptEditEvidence = lastEditKey > 0 || editedPaths.size > 0;

  if (!baseline) {
    if (transcriptEditEvidence && enforced) {
      // HARDENING: edit evidence but NO recorded baseline in enforced/strict.
      // We cannot trust an after-the-fact baseline to cover the change, so block
      // and advise reinstalling the SessionStart hook.
      const decision = block(
        "Adversarial review could not verify this change: no SessionStart baseline was " +
          "recorded for this session, so the full change scope is unknown. Reinstall the " +
          "adversarial-review SessionStart hook (it records the baseline) and retry."
      );
      return emit(decision, io);
    }
    // Soft (or no edit evidence): fall back to a current-git/filesystem baseline.
    // This is a disclosed limitation — only changes since NOW are visible.
    baseline = await captureBaseline(cwd).catch(() => null);
  }

  const { hostDescriptor, reviewerRunner } = buildHostRouting(host, config, env);

  let decision;
  try {
    decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript,
      transcriptPath,
      // Forward the authoritative host event name so the gate's own subagent
      // short-circuit (defense in depth) uses the same fail-closed signal.
      hookEventName,
      host: hostDescriptor,
      reviewerRunner,
      // Use the composite key so the gate's block-counter/cache are also keyed
      // per-workspace, consistent with the baseline state above.
      sessionId: stateKey,
      stateDir,
      stopHookActive,
    });
  } catch (err) {
    decision = await failClosedDecision({ config, cwd, baseline, transcript, err, io });
  }

  // When we fell back to a NOW baseline — either no recorded SessionStart
  // baseline, or one rejected because it belongs to a different workspace — and
  // there is edit evidence, disclose the limitation on whatever message we emit:
  // only changes still present in the workspace were reviewable.
  if ((!state.baseline || !workspaceMatches) && transcriptEditEvidence) {
    const note =
      " (Limitation: no SessionStart baseline was recorded; only changes still present in the " +
      "workspace were reviewable. Reinstall the SessionStart hook for full coverage.)";
    if (decision.systemMessage) {
      decision = { ...decision, systemMessage: decision.systemMessage + note };
    } else if (decision.action === "block" && decision.reason) {
      decision = { ...decision, reason: decision.reason + note };
    }
  }

  return emit(decision, io);
}

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

// Emit Claude Stop-hook JSON for a decision. block -> decision/reason;
// advisory (allow + systemMessage) -> systemMessage; silent allow -> nothing.
function emit(decision, io) {
  process.exitCode = 0;
  if (!decision) return decision;
  if (decision.action === "block") {
    io.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason || "" }));
    return decision;
  }
  if (decision.systemMessage) {
    io.stdout.write(JSON.stringify({ systemMessage: decision.systemMessage }));
    return decision;
  }
  // Silent allow: no stdout output.
  return decision;
}

// ---------------------------------------------------------------------------
// Workspace-scoped state keying
// ---------------------------------------------------------------------------

// Resolve a stable, canonical absolute path for a workspace root. realpathSync
// resolves symlinks so two different paths pointing at the same directory key
// the same state; if it throws (e.g. the path does not yet exist) we fall back
// to path.resolve so we still get an absolute, normalized key.
//
// Windows case-folding: NTFS is case-INSENSITIVE but case-PRESERVING, and
// realpathSync preserves whatever casing the caller passed (`C:\Repo` vs
// `c:\repo`). Without normalization the SAME physical workspace under two
// casings produces two different state keys, so a SessionStart baseline recorded
// under one casing is invisible to a Stop event under another — the baseline
// lookup misses and the gate mis-handles the change. On win32 we therefore
// lowercase the canonical path so casing can never split the state key. POSIX
// paths are case-sensitive and are left untouched.
export function canonicalWorkspaceRoot(cwd) {
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    root = resolve(cwd);
  }
  return process.platform === "win32" ? root.toLowerCase() : root;
}

// Compose the session-state key from BOTH the host session id AND the canonical
// workspace root. Without the workspace component, two different workspaces that
// happen to share a session_id would collide on a single state file — letting
// repo A's baseline be used to evaluate repo B (a silent bypass). Including the
// canonical root makes the on-disk state file distinct per workspace, and keeps
// the gate's block-counter/cache consistent under the same composite key.
//
// SECURITY (FINDING 5 — injective encoding): the previous join used a bare space
// (`${sessionId} ${root}`). The session_id is attacker-controlled (it arrives in
// the Stop-hook stdin payload) and the workspace root commonly contains spaces on
// Windows (`C:\Users\John Doe\...`), so the join was NON-injective: distinct
// (sessionId, root) pairs could map to the same key (e.g. session `"a /home"` in
// root `"/x"` collides with session `"a"` in root `"/home /x"`). A collision lets
// one workspace's baseline / block-counter / review cache be reused for an
// unrelated session+workspace — a silent bypass. We therefore length-prefix each
// component (`<len>:<value>` joined by `|`), which is unambiguously injective: the
// decoder reads exactly `len` bytes per field, so no value (spaces or otherwise)
// can ever be misattributed across the field boundary. The result is fed to
// state.js, which hashes it for the on-disk file name.
export function sessionStateKey(sessionId, cwd) {
  const sid = String(sessionId || "");
  const root = canonicalWorkspaceRoot(cwd);
  return `${sid.length}:${sid}|${root.length}:${root}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Parse a `--flag <value>` pair from argv.
function parseFlag(argv, flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return null;
}

// Default bound (ms) for the transcript file read. A normal transcript on a local
// disk reads in microseconds; this only guards the pathological case where
// transcriptPath resolves to a FIFO/device file or a hung network FS.
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 5000;

// Hard cap (bytes) on how much of the transcript is read into memory. A huge
// (or attacker-influenced) transcript_path would otherwise be loaded in full by
// readFile and then DUPLICATED by parseJsonl's split — exhausting memory and
// getting the hook OOM-killed before it can emit a block (a fail-OPEN). Beyond
// the cap we stop reading: the filesystem/git diff (built from the SessionStart
// baseline) remains the authoritative edit evidence, so a truncated transcript
// only ever fails TOWARD review, never open.
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Read up to `maxBytes` of a file as utf8, honoring an AbortSignal. Resolves to
 * whatever was read (""+) on EOF, cap, abort (timeout), or any read error — it
 * never rejects, so a FIFO/slow-FS/oversized path can never hang or crash the
 * Stop hook. Streaming bounds peak memory to ~maxBytes regardless of file size.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
function readBoundedTranscript(path, maxBytes, signal) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    let stream;
    try {
      stream = createReadStream(path, { encoding: "utf8", signal });
    } catch {
      resolve("");
      return;
    }
    stream.on("data", (chunk) => {
      // A single read can be up to the stream's highWaterMark (default 64 KiB),
      // so SLICE the chunk at the cap rather than checking only after appending —
      // otherwise the whole file (in one big chunk) would slip past the cap.
      if (data.length + chunk.length >= maxBytes) {
        data += chunk.slice(0, Math.max(0, maxBytes - data.length));
        try { stream.destroy(); } catch { /* ignore */ }
        finish();
      } else {
        data += chunk;
      }
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish); // FIFO / abort / read error: return what we have
  });
}

// Read the transcript file with a hard timeout (FINDING 6 — Async Lifecycle).
//
// A plain `readFile(path)` on a named pipe / device file / hung mount blocks
// indefinitely; the Stop hook would then hang until Claude Code's 300s timeout
// SIGKILLs it, and a killed Stop hook emits no {decision:block} — the change is
// ALLOWED (a delayed fail-OPEN of the gate). We bound the read with an
// AbortController-backed timeout. The AbortSignal is what makes this safe under
// the real host: it actively CANCELS the pending fs read so libuv releases the
// handle and the process can exit naturally (the hook path relies on event-loop
// drain, never process.exit). Without the abort, resolving the race alone would
// leave the read pending and keep the loop alive — the same leak class the stdin
// teardown fixes. On timeout (or any read error) we resolve to "" (tolerant): an
// empty transcript with edit evidence routes into the missing-baseline
// fail-CLOSED path, so a slow read never silently allows a change.
//
// @param {string} transcriptPath
// @param {number} [timeoutMs]
// @returns {Promise<string>}
export async function readTranscriptFile(transcriptPath, timeoutMs = DEFAULT_TRANSCRIPT_TIMEOUT_MS, maxBytes = MAX_TRANSCRIPT_BYTES) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Abort the pending fs read so its libuv handle is released (prevents the
      // hook from hanging on a FIFO/slow FS). The readFile below rejects with an
      // AbortError, which its .catch swallows to "".
      try {
        controller.abort();
      } catch {
        /* ignore — best-effort cancel */
      }
      resolve("");
    }, timeoutMs);
    // unref so the pending timer alone never blocks process exit; the fast path
    // clears it in finally below.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  // Bounded streaming read: caps peak memory at MAX_TRANSCRIPT_BYTES and aborts
  // on the timeout signal (FIFO/slow FS) — never rejects.
  const readPromise = readBoundedTranscript(transcriptPath, maxBytes, controller.signal);

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// Default bound (ms) for the stdin read. The host normally closes stdin promptly
// so the fast path resolves well before this fires; the timeout only guards the
// pathological case where the host opens but never closes the pipe.
const DEFAULT_STDIN_TIMEOUT_MS = 5000;

// Read all of stdin and parse it as JSON. Tolerant: empty/unreadable/malformed
// input — AND a stdin pipe that never closes (timeout) — yields `{}` so a
// malformed/absent payload with no edit evidence fails open and an edit-evidence
// payload fails closed, per the gate's missing-payload logic.
async function readStdinJson(stdin, timeoutMs = DEFAULT_STDIN_TIMEOUT_MS) {
  const text = await readStream(stdin, timeoutMs);
  if (!text || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

// Drain a readable stream to a string. Accepts a Node Readable, an async
// iterable, or a plain string (tests may inject any of these).
//
// ASYNC-3: the drain is raced against a timeout. A host that opens but never
// closes the stdin pipe would otherwise make the `for await` loop hang forever,
// freezing the hook; on timeout we resolve to "" (the tolerant readStdinJson
// then yields {}). A plain string / null resolves immediately and bypasses the
// race entirely (fast path preserved).
//
// CRITICAL (fail-closed): resolving the race is NOT sufficient. The losing
// `for await (const chunk of stdin)` keeps the still-open OS stdin pipe in
// flowing/reading mode — a ref'd libuv handle that keeps the event loop alive
// indefinitely. The hook path relies on natural event-loop drain (no
// process.exit; see bin/adversarial-review.js), so a leaked stdin handle makes
// the hook NEVER EXIT under the real host; Claude Code's 300s Stop-hook timeout
// then KILLS it, and a killed Stop hook emits no {decision:block} — the change
// is allowed (fail-OPEN of the gate). To prevent this we actively tear down the
// stream on timeout: pause() the flowing read, then destroy() the handle so
// libuv releases it and the process can exit. The for-await drain's own error
// handler swallows the resulting abort so destroy() never surfaces as a reject.
async function readStream(stdin, timeoutMs = DEFAULT_STDIN_TIMEOUT_MS) {
  if (stdin == null) return "";
  if (typeof stdin === "string") return stdin;

  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Actively release the stdin handle so the abandoned `for await` below
      // cannot keep the event loop alive on a never-closing pipe. pause() stops
      // the flowing read; destroy() drops the underlying libuv handle. Both are
      // guarded because the injected stdin may be a bare async iterable.
      tearDownStdin(stdin);
      resolve("");
    }, timeoutMs);
    // unref() so the pending timer alone never blocks process exit; clearTimeout
    // below is the primary cleanup for the fast (prompt-close) path.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  const drainPromise = (async () => {
    const chunks = [];
    try {
      for await (const chunk of stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    } catch {
      // A destroy()/abort triggered by the timeout lands here — discard it and
      // return whatever (if anything) was read before the cutoff.
      return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    }
    return Buffer.concat(chunks).toString("utf8");
  })();

  try {
    return await Promise.race([drainPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
    // Belt-and-braces: if the race was won by the timeout, ensure the handle is
    // released even if tearDownStdin somehow no-op'd; the normal fast path leaves
    // an already-ended stream untouched (destroy on an ended stream is a no-op).
    if (timedOut) tearDownStdin(stdin);
  }
}

// Release a readable stdin handle so a never-closing OS pipe can no longer keep
// the event loop alive. Pauses the flowing read, then destroys the underlying
// handle. Fully defensive: stdin may be a plain async iterable without these
// methods, in which case this is a no-op.
function tearDownStdin(stdin) {
  if (!stdin || typeof stdin !== "object") return;
  try {
    if (typeof stdin.pause === "function") stdin.pause();
  } catch {
    /* ignore — best-effort release */
  }
  try {
    if (typeof stdin.destroy === "function") stdin.destroy();
    else if (typeof stdin.unref === "function") stdin.unref();
  } catch {
    /* ignore — best-effort release */
  }
}
