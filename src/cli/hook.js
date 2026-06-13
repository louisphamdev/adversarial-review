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

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
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

  const payload = await readStdinJson(io.stdin);
  // The host payload carries the authoritative cwd; fall back to the process cwd.
  const cwd = (payload && typeof payload.cwd === "string" && payload.cwd) || io.cwd;
  const sessionId = (payload && payload.session_id) || "default";
  const stateDir = resolveStateDir(env);
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

  // Subagent transcripts never trigger the gate (avoid serializing pipelines).
  // The gate also checks this, but short-circuit here to avoid any state IO.
  if (isSubagentTranscript(transcriptPath, sessionId)) {
    return emit(null, io); // silent allow
  }

  // Read the transcript text (tolerant: unreadable -> "").
  let transcript = "";
  if (transcriptPath) {
    transcript = await readFile(transcriptPath, "utf8").catch(() => "");
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
export function canonicalWorkspaceRoot(cwd) {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

// Compose the session-state key from BOTH the host session id AND the canonical
// workspace root. Without the workspace component, two different workspaces that
// happen to share a session_id would collide on a single state file — letting
// repo A's baseline be used to evaluate repo B (a silent bypass). Including the
// canonical root makes the on-disk state file distinct per workspace, and keeps
// the gate's block-counter/cache consistent under the same composite key.
export function sessionStateKey(sessionId, cwd) {
  return `${sessionId || ""} ${canonicalWorkspaceRoot(cwd)}`;
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

// Read all of stdin and parse it as JSON. Tolerant: empty/unreadable/malformed
// input yields `{}` so a malformed payload with no edit evidence fails open.
async function readStdinJson(stdin) {
  const text = await readStream(stdin);
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
async function readStream(stdin) {
  if (stdin == null) return "";
  if (typeof stdin === "string") return stdin;
  const chunks = [];
  try {
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  } catch {
    return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
  }
  return Buffer.concat(chunks).toString("utf8");
}
