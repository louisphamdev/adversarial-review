// `adversarial-review check` — run the gate against the current workspace.
//
// Loads the effective config, captures a fresh baseline, runs evaluateGate, and
// reports the decision. `--json` emits the decision as machine-readable JSON.
// Exit code is 1 on block, 0 on allow. The whole evaluation is wrapped in the
// fail-closed catch (HARDENING #2): an unexpected throw with edit evidence
// blocks in enforced/strict rather than silently allowing.

import { evaluateGate } from "../core/gate.js";
import { captureBaseline } from "../core/diff.js";
import { loadEffectiveConfig, resolveStateDir } from "../core/load-config.js";
import { buildHostRouting } from "./host-map.js";
import { failClosedDecision } from "./fail-closed.js";
import { sessionStateKey } from "./hook.js";

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function checkCommand(argv, io) {
  const json = argv.includes("--json");
  const host = parseHost(argv) || "cli";
  const cwd = io.cwd;
  const env = io.env || process.env;

  const config = await loadEffectiveConfig(cwd, io);
  const stateDir = resolveStateDir(env);
  const { hostDescriptor, reviewerRunner } = buildHostRouting(host, config, env);

  let decision;
  // Hoist `baseline` OUT of the try so the catch can forward it to
  // failClosedDecision. If it stayed `const baseline` inside the try, the catch
  // (a separate scope) could not see it, so failClosedDecision would receive
  // baseline:undefined and could not recompute the live diff — and with no
  // transcript either, hasEditEvidence() would return false and FAIL OPEN
  // (`fail_open_no_evidence`) even when the workspace really changed. We pass the
  // captured baseline so fail-closed can detect edit evidence and block in
  // enforced/strict.
  //
  // ROUND 5 (Finding 2): `captureBaseline` can ITSELF throw (e.g. a broken cwd or
  // git-plumbing failure). If it does, `baseline` stays undefined and edit
  // detection is impossible — fail-closed must NOT treat that as a clean "no
  // evidence" allow. We capture the baseline-capture error separately and forward
  // it so failClosedDecision routes through its detection-failed path (block in
  // enforced/strict), rather than diffing against an empty baseline.
  let baseline;
  let baselineError;
  try {
    try {
      baseline = await captureBaseline(cwd);
    } catch (capErr) {
      // Record the capture failure and re-throw INTO the fail-closed catch below so
      // the same fail-closed decision path runs (now with the detection-failed
      // signal). evaluateGate is not run against a missing baseline.
      baselineError = capErr;
      throw capErr;
    }
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
      sessionId: sessionStateKey(`check-${host}`, cwd),
      stateDir,
    });
  } catch (err) {
    // HARDENING #2: fail closed. `check` has no transcript, so edit evidence is
    // whatever the live diff shows; failClosedDecision recomputes that from the
    // captured baseline. ROUND 5 (Finding 2): if captureBaseline ITSELF threw,
    // `baseline` is undefined and `baselineError` is set — we forward that so
    // failClosedDecision treats it as a DETECTION FAILURE (block in
    // enforced/strict) instead of computing against an empty baseline and silently
    // failing open. (The previous comment claiming it "computes against an empty
    // baseline" was misleading: an undefined baseline gave no evidence at all.)
    decision = await failClosedDecision({ config, cwd, baseline, baselineError, transcript: "", err, io });
  }

  if (json) {
    io.stdout.write(`${JSON.stringify(decision)}\n`);
  } else {
    if (decision.action === "block") {
      io.stderr.write(`BLOCK: ${decision.reason || "review required"}\n`);
    } else if (decision.systemMessage) {
      io.stdout.write(`${decision.systemMessage}\n`);
    } else {
      io.stdout.write(`allow: ${decision.reason || "ok"}\n`);
    }
  }

  process.exitCode = decision.action === "block" ? 1 : 0;
  return decision;
}

// Parse `--host <name>` if present.
function parseHost(argv) {
  const i = argv.indexOf("--host");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return null;
}
