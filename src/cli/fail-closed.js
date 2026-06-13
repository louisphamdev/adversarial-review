// Shared fail-closed decision helper (HARDENING #2).
//
// `evaluateGate` may throw (e.g. a writeSessionState IO error, or an injected
// failure). When that happens the CLI entrypoints MUST NOT silently allow: if
// there is evidence of a real edit, they FAIL CLOSED — block in enforced/strict,
// and follow `onInternalError` in soft. The original error is surfaced on stderr.

import { block, advisory, allow } from "../core/gate.js";
import { buildReviewDiff } from "../core/diff.js";
import { internalErrorAction } from "../core/policy.js";
import { parseJsonl, scanKeys } from "../core/transcript.js";

/**
 * Decide what to do after evaluateGate threw.
 *
 * @param {object} args
 * @param {object} args.config
 * @param {string} args.cwd
 * @param {object} [args.baseline]    - recorded baseline, if available.
 * @param {string} [args.transcript]  - transcript text, if available.
 * @param {Error}  args.err
 * @param {object} args.io            - { stderr }
 * @returns {Promise<object>} decision
 */
export async function failClosedDecision({ config, cwd, baseline, transcript, err, io }) {
  if (io?.stderr) {
    io.stderr.write(
      `adversarial-review: gate evaluation failed (failing closed): ${err?.stack || err}\n`
    );
  }

  const hasEvidence = await hasEditEvidence({ cwd, baseline, transcript });

  // No evidence of a change: nothing to protect, allow.
  if (!hasEvidence) {
    return allow({ reason: "fail_open_no_evidence", internalError: String(err?.message || err) });
  }

  // Evidence present: follow onInternalError (allow only in soft when so set).
  const action = internalErrorAction(config, true);
  if (action === "allow") {
    return advisory(
      "Gate evaluation failed; allowed per soft onInternalError policy.",
      { internalError: String(err?.message || err) }
    );
  }
  return block(
    "Adversarial review could not complete due to an internal error (fail-closed).",
    { internalError: String(err?.message || err) }
  );
}

// Best-effort edit-evidence detection: a non-empty review diff, OR edit/edited
// paths in the transcript. Tolerant of further failures (treats them as "no
// extra evidence" from that source).
async function hasEditEvidence({ cwd, baseline, transcript }) {
  if (transcript) {
    try {
      const { lastEditKey, editedPaths } = scanKeys(parseJsonl(transcript));
      if (lastEditKey > 0 || editedPaths.size > 0) return true;
    } catch {
      // Ignore transcript-scan failures.
    }
  }
  if (baseline) {
    try {
      const diff = await buildReviewDiff(cwd, baseline);
      if (diff && (diff.changedFiles?.length > 0 || diff.text)) return true;
    } catch {
      // Diff unbuildable from this baseline: fall through.
    }
  }
  return false;
}
