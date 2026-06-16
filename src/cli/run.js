// `adversarial-review run` — wrap a host tool command and gate after it exits.
//
//   adversarial-review run --host <host> -- <command> [args...]
//
// Captures a baseline BEFORE running, spawns the command with inherited stdio,
// waits for it to exit, waits a quiescence interval, then recaptures the review
// scope. If files are STILL changing across two snapshots (the diff hash keeps
// moving), in enforced/strict we BLOCK (files are still being written). Otherwise
// we run evaluateGate. The original command's exit code is returned ONLY when the
// gate allows; on block we exit non-zero (2) and print the reason to stderr.
//
// HARDENING #1: user-level stateDir. HARDENING #2: fail-closed try/catch.

import { evaluateGate } from "../core/gate.js";
import { captureBaseline, buildReviewDiff } from "../core/diff.js";
import { loadEffectiveConfig, resolveStateDir } from "../core/load-config.js";
import { isStrict } from "../core/policy.js";
import { resolveExecutable, spawnResolved } from "../core/process.js";
import { buildHostRouting } from "./host-map.js";
import { failClosedDecision } from "./fail-closed.js";
import { sessionStateKey } from "./hook.js";

const DEFAULT_QUIESCENCE_MS = 750;
const BLOCK_EXIT_CODE = 2;
// Number of CONSECUTIVE stable snapshots required to declare the workspace
// quiescent. A two-snapshot compare (1 stable transition) can land both samples
// in the same quiet gap of a periodic/bursty writer (file watcher, autoformatter,
// build daemon) and wrongly conclude "settled". Requiring several consecutive
// identical snapshots widens the observation window so a periodic writer is far
// more likely to be caught mid-cycle. This is best-effort quiescence detection,
// not a hard guarantee against an adversarial writer timed to our exact cadence.
const QUIESCENCE_STABLE_SAMPLES = 3;

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function runCommand(argv, io) {
  const { host, command, error } = parseArgs(argv);
  const env = io.env || process.env;
  const cwd = io.cwd;

  // Reject argument confusion BEFORE running anything: an unknown flag in the
  // head (pre-`--`) is silently ignored otherwise, so a typo like `--hosts`
  // (plural) or an unsupported `--json` would change behavior without warning.
  if (error) {
    io.stderr.write(`adversarial-review run: ${error}\n`);
    io.stderr.write("usage: adversarial-review run --host <host> -- <command> [args...]\n");
    process.exitCode = 2;
    return;
  }

  if (command.length === 0) {
    io.stderr.write("usage: adversarial-review run --host <host> -- <command> [args...]\n");
    process.exitCode = 2;
    return;
  }

  const config = await loadEffectiveConfig(cwd, io);
  const enforced = config.policy.mode === "enforced" || isStrict(config);
  const stateDir = resolveStateDir(env, cwd);
  const quiescenceMs = config.runtime?.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;

  // Capture baseline BEFORE running so post-run diff reflects only the wrapped
  // command's changes.
  const baseline = await captureBaseline(cwd, config.runtime?.extraSkipDirs);

  // Run the wrapped command with inherited stdio.
  const exitCode = await runWrapped(command, { cwd, env, io });

  // Wait for filesystem quiescence, then confirm the workspace has settled.
  await sleep(quiescenceMs);
  const { stillChanging, persistentFailure } = await stillChangingScope(cwd, baseline, quiescenceMs);

  // ROUND 5 (Finding 3): the review scope was NEVER observable — buildReviewDiff
  // threw on every quiescence sample (e.g. a persistently corrupted/unbuildable
  // diff). We cannot confirm the workspace settled, so do not treat it as
  // quiescent. Fail closed in enforced/strict (block); warn in soft.
  if (persistentFailure && enforced) {
    io.stderr.write(
      "BLOCK: the review scope could not be built after the command exited (the diff was " +
        "persistently unbuildable), so the workspace could not be confirmed settled; cannot " +
        "review (fail-closed). Re-run once the workspace/repo is in a buildable state.\n"
    );
    process.exitCode = BLOCK_EXIT_CODE;
    return { action: "block", reason: "scope_unobservable" };
  }
  if (persistentFailure) {
    io.stderr.write(
      "WARNING: the review scope could not be built after the command exited (the diff was " +
        "persistently unbuildable); the workspace could not be confirmed settled (soft mode does " +
        "not block). Re-run once the workspace/repo is in a buildable state.\n"
    );
  }

  if (stillChanging && enforced) {
    io.stderr.write(
      "BLOCK: workspace is still being written after the command exited; cannot review a " +
        "moving target. Re-run once the tool has finished.\n"
    );
    process.exitCode = BLOCK_EXIT_CODE;
    return { action: "block", reason: "files_still_changing" };
  }
  if (stillChanging) {
    // Non-enforced (soft/advisory) mode does NOT block, but the reviewer would
    // then see a moving target — an inconsistent, possibly mid-write diff. Surface
    // that the snapshot is not settled instead of silently reviewing it, so a
    // PASS on a partial change is not mistaken for a clean review of the final state.
    io.stderr.write(
      "WARNING: workspace is still being written after the command exited; reviewing a " +
        "possibly-inconsistent snapshot (soft mode does not block). Re-run once the tool has finished.\n"
    );
  }

  const { hostDescriptor, reviewerRunner } = buildHostRouting(host, config, env);

  let decision;
  try {
    decision = await evaluateGate({
      config,
      cwd,
      baseline,
      transcript: "",
      transcriptPath: "",
      host: hostDescriptor,
      reviewerRunner,
      // Compose the synthetic session id with the canonical workspace root so the
      // gate's block-counter/cache are keyed per-workspace, consistent with the
      // hook's composite keying (distinct workspaces never share state).
      sessionId: sessionStateKey(`run-${host}`, cwd),
      stateDir,
    });
  } catch (err) {
    decision = await failClosedDecision({ config, cwd, baseline, err, io });
  }

  if (decision.action === "block") {
    io.stderr.write(`BLOCK: ${decision.reason || "review required"}\n`);
    process.exitCode = BLOCK_EXIT_CODE;
    return decision;
  }

  if (decision.systemMessage) {
    io.stderr.write(`${decision.systemMessage}\n`);
  }
  // Gate allowed: surface the wrapped command's own exit code.
  process.exitCode = exitCode;
  return decision;
}

// ---------------------------------------------------------------------------
// Wrapped command execution
// ---------------------------------------------------------------------------

// Resolve and spawn the wrapped command with inherited stdio; resolve with its
// exit code. A missing executable resolves to 127 (shell "command not found").
async function runWrapped(command, { cwd, env, io }) {
  const [exe, ...args] = command;
  const resolved = await resolveExecutable(exe, env);
  if (!resolved) {
    io.stderr.write(`adversarial-review run: command not found: ${exe}\n`);
    return 127;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnResolved(resolved, args, { cwd, env, stdio: "inherit" });
    } catch (err) {
      io.stderr.write(`adversarial-review run: failed to spawn ${exe}: ${err.message}\n`);
      resolve(126);
      return;
    }
    child.on("error", (err) => {
      io.stderr.write(`adversarial-review run: ${exe} error: ${err.message}\n`);
      resolve(127);
    });
    // A signal-terminated child reports code:null with a signal name. Treating a
    // signal kill as exit 0 (success) would let a kill MASK a gate bypass: a tool
    // that signals itself (or a Ctrl+C) would surface success on a command that
    // never completed normally. Map a signal to the shell convention 128+signum
    // (non-zero), and a null-with-no-signal to 1, so a kill can never report
    // success. (The gate's own block decision still overrides the exit code.)
    child.on("close", (code, signal) =>
      resolve(code != null ? code : signal ? 128 + signalNumber(signal) : 1)
    );
  });
}

// Map a POSIX signal name to its number for the shell 128+signum exit convention.
// Falls back to SIGTERM's 15 for an unknown/unmapped signal so the result is
// always a non-zero, signal-like exit code.
function signalNumber(signal) {
  const SIGNALS = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
    SIGABRT: 6,
    SIGSEGV: 11,
  };
  return SIGNALS[signal] ?? 15;
}

// ---------------------------------------------------------------------------
// Quiescence detection
// ---------------------------------------------------------------------------

// Sample the review-scope diff hash repeatedly, `quiescenceMs` apart, and require
// QUIESCENCE_STABLE_SAMPLES CONSECUTIVE identical hashes before declaring the
// workspace settled. A single two-snapshot compare can land both samples in the
// same quiet gap of a periodic/bursty writer and wrongly report "settled";
// requiring several consecutive stable samples widens the window so a writer that
// touches files between cycles is far more likely to be caught.
//
// Returns { stillChanging, persistentFailure }:
//   - stillChanging: true as soon as ANY two adjacent BUILDABLE snapshots differ;
//   - persistentFailure: true when buildReviewDiff threw on EVERY sample, so the
//     scope could never be observed at all.
//
// ROUND 5 (Finding 3): a single build failure used to return false ("not
// changing"), which is fine when it is TRANSIENT (a later sample succeeds and the
// stability check still runs). But if ALL samples throw, the diff is persistently
// unbuildable and the workspace was NEVER actually observed — declaring it
// "settled" silently bypasses the quiescence guard. We now report that as
// `persistentFailure` so the caller fails closed in enforced (warn in soft) rather
// than treating an unobservable workspace as quiescent. Transient tolerance is
// preserved: as long as at least one sample builds, a stray failure does not wedge.
// Exported for unit tests of the Finding-3 persistent-failure tri-state.
export async function stillChangingScope(cwd, baseline, quiescenceMs) {
  let prevHash;
  let anyBuilt = false;
  try {
    prevHash = (await buildReviewDiff(cwd, baseline)).diffHash;
    anyBuilt = true;
  } catch {
    prevHash = undefined;
  }
  // We already attempted sample #1; take (STABLE_SAMPLES - 1) more and compare each
  // buildable sample to the previous buildable one. Any mismatch => still changing.
  for (let i = 1; i < QUIESCENCE_STABLE_SAMPLES; i += 1) {
    await sleep(quiescenceMs);
    let nextHash;
    try {
      nextHash = (await buildReviewDiff(cwd, baseline)).diffHash;
    } catch {
      // Transient build failure on this sample: skip it (do not wedge), but keep
      // looking — a later sample may build and reveal movement.
      continue;
    }
    if (anyBuilt && nextHash !== prevHash) {
      return { stillChanging: true, persistentFailure: false };
    }
    prevHash = nextHash;
    anyBuilt = true;
  }
  // If no sample ever built, the scope is persistently unobservable.
  if (!anyBuilt) {
    return { stillChanging: false, persistentFailure: true };
  }
  return { stillChanging: false, persistentFailure: false };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

// Parse `--host <host> -- <command...>`. Everything after the first `--` is the
// command (passed through verbatim — flags there belong to the wrapped tool).
// `--host` defaults to "wrapper" and takes the FIRST occurrence (consistent with
// check.js). Any UNKNOWN flag in the head (a token starting with `-`) is rejected
// with an `error` rather than silently ignored, so a typo or unsupported option
// cannot quietly change behavior (argument confusion).
function parseArgs(argv) {
  let host = "wrapper";
  let hostSeen = false;
  let error = null;
  const sep = argv.indexOf("--");
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  for (let i = 0; i < head.length; i += 1) {
    const tok = head[i];
    if (tok === "--host") {
      if (!head[i + 1]) {
        error = error || "--host requires a value";
        break;
      }
      // First occurrence wins; a second --host is argument confusion.
      if (!hostSeen) {
        host = head[i + 1];
        hostSeen = true;
      } else {
        error = error || "duplicate --host flag";
        break;
      }
      i += 1;
    } else if (tok.startsWith("--host=")) {
      const value = tok.slice("--host=".length);
      // ROUND 5 (Finding 4): reject an EMPTY value (`--host=`) with a clear usage
      // error, mirroring the `--host <value>` missing-value handling. Otherwise an
      // empty host silently routes to native self-review (reviewerMappingFor("")
      // => "none") and the wrapped command runs unreviewed under a likely typo —
      // argument confusion that must not pass quietly.
      if (!value) {
        error = error || "--host requires a non-empty value";
        break;
      }
      if (!hostSeen) {
        host = value;
        hostSeen = true;
      } else {
        error = error || "duplicate --host flag";
        break;
      }
    } else if (tok.startsWith("-")) {
      // Any other flag before `--` is unknown — reject rather than ignore.
      error = error || `unknown flag "${tok}" (did you forget the "--" separator before the command?)`;
      break;
    } else {
      // A bare positional before `--` is also a usage error: the command must be
      // separated by `--` so flags meant for the wrapped tool are never consumed.
      error = error || `unexpected argument "${tok}" before "--"; put the command after "--"`;
      break;
    }
  }
  return { host, command, error };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
