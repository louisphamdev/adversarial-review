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

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function runCommand(argv, io) {
  const { host, command } = parseArgs(argv);
  const env = io.env || process.env;
  const cwd = io.cwd;

  if (command.length === 0) {
    io.stderr.write("usage: adversarial-review run --host <host> -- <command> [args...]\n");
    process.exitCode = 2;
    return;
  }

  const config = await loadEffectiveConfig(cwd, io);
  const enforced = config.policy.mode === "enforced" || isStrict(config);
  const stateDir = resolveStateDir(env);
  const quiescenceMs = config.runtime?.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;

  // Capture baseline BEFORE running so post-run diff reflects only the wrapped
  // command's changes.
  const baseline = await captureBaseline(cwd);

  // Run the wrapped command with inherited stdio.
  const exitCode = await runWrapped(command, { cwd, env, io });

  // Wait for filesystem quiescence, then confirm the workspace has settled.
  await sleep(quiescenceMs);
  const stillChanging = await stillChangingScope(cwd, baseline, quiescenceMs);
  if (stillChanging && enforced) {
    io.stderr.write(
      "BLOCK: workspace is still being written after the command exited; cannot review a " +
        "moving target. Re-run once the tool has finished.\n"
    );
    process.exitCode = BLOCK_EXIT_CODE;
    return { action: "block", reason: "files_still_changing" };
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
    child.on("close", (code) => resolve(code == null ? 0 : code));
  });
}

// ---------------------------------------------------------------------------
// Quiescence detection
// ---------------------------------------------------------------------------

// Take two review-scope snapshots `quiescenceMs` apart. If the diff hash changes
// between them, files are still being written (not quiescent). Tolerant: a
// build failure returns false (do not wedge on a diff error — the gate's own
// internal-error handling covers an unbuildable diff).
async function stillChangingScope(cwd, baseline, quiescenceMs) {
  let first;
  try {
    first = await buildReviewDiff(cwd, baseline);
  } catch {
    return false;
  }
  await sleep(quiescenceMs);
  let second;
  try {
    second = await buildReviewDiff(cwd, baseline);
  } catch {
    return false;
  }
  return first.diffHash !== second.diffHash;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

// Parse `--host <host> -- <command...>`. Everything after the first `--` is the
// command. `--host` defaults to "wrapper".
function parseArgs(argv) {
  let host = "wrapper";
  const sep = argv.indexOf("--");
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const command = sep >= 0 ? argv.slice(sep + 1) : [];
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === "--host" && head[i + 1]) {
      host = head[i + 1];
      i += 1;
    }
  }
  return { host, command };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
