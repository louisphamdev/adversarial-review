// Shared fail-closed decision helper (HARDENING #2).
//
// `evaluateGate` may throw (e.g. a writeSessionState IO error, or an injected
// failure). When that happens the CLI entrypoints MUST NOT silently allow: if
// there is evidence of a real edit, they FAIL CLOSED — block in enforced/strict,
// and follow `onInternalError` in soft. The original error is surfaced on stderr.
//
// ROUND 5 HARDENING (Findings 1 & 2): edit-evidence DETECTION can itself fail —
// buildReviewDiff may throw or return a vacuously-empty diff because the git repo
// is corrupted, or the baseline capture failed entirely (baseline undefined/null).
// Conflating "detection FAILED/unknown" with "genuinely no edits" fails OPEN: an
// attacker who makes BOTH evaluateGate AND evidence detection break would be
// allowed in enforced. So hasEditEvidence now returns a TRI-STATE:
//   { evidence: bool, detectionFailed: bool }
// and failClosedDecision routes a detection failure through internalErrorAction
// (block in enforced/strict by default) instead of allowing. Only a SUCCESSFUL
// detection that finds genuinely no edits yields `fail_open_no_evidence`.

import { block, advisory, allow } from "../core/gate.js";
import { buildReviewDiff } from "../core/diff.js";
import { internalErrorAction } from "../core/policy.js";
import { parseJsonl, scanKeys } from "../core/transcript.js";
import { git } from "../core/git.js";

/**
 * Decide what to do after evaluateGate threw.
 *
 * @param {object} args
 * @param {object} args.config
 * @param {string} args.cwd
 * @param {object} [args.baseline]      - recorded baseline, if available.
 * @param {Error}  [args.baselineError] - error thrown while CAPTURING the baseline,
 *                                         if any. A capture failure means edit
 *                                         detection is impossible (Finding 2): treat
 *                                         it as a detection failure, never a clean
 *                                         "no evidence" allow.
 * @param {string} [args.transcript]    - transcript text, if available.
 * @param {Error}  args.err
 * @param {object} args.io              - { stderr }
 * @returns {Promise<object>} decision
 */
export async function failClosedDecision({ config, cwd, baseline, baselineError, transcript, err, io }) {
  if (io?.stderr) {
    io.stderr.write(
      `adversarial-review: gate evaluation failed (failing closed): ${err?.stack || err}\n`
    );
  }

  const { evidence, detectionFailed } = await hasEditEvidence({
    cwd,
    baseline,
    baselineError,
    transcript,
  });

  // Edit-evidence DETECTION itself failed (buildReviewDiff threw, returned a
  // vacuously-empty diff from a corrupted git baseline, or the baseline capture
  // threw). We CANNOT prove the workspace is clean, so we must not fail open: a
  // `false` here would conflate "broken detection" with "genuinely no edits".
  // Treat it as an internal error WITH potential significant change so
  // internalErrorAction blocks in enforced/strict (and follows soft policy in soft).
  if (detectionFailed) {
    if (io?.stderr) {
      io.stderr.write(
        "adversarial-review: edit-evidence detection FAILED (corrupted/unbuildable diff or " +
          "baseline capture error); cannot confirm a clean workspace, failing closed.\n"
      );
    }
    const action = internalErrorAction(config, true);
    if (action === "allow") {
      return advisory(
        "Gate evaluation failed and edit detection could not run; allowed per soft onInternalError policy.",
        { internalError: String(err?.message || err), detectionFailed: true }
      );
    }
    return block(
      "Adversarial review could not complete: an internal error occurred AND edit-evidence " +
        "detection failed (corrupted/unbuildable diff or baseline capture error), so a clean " +
        "workspace cannot be confirmed (fail-closed).",
      { internalError: String(err?.message || err), detectionFailed: true }
    );
  }

  // Detection SUCCEEDED and found no evidence of a change: nothing to protect, allow.
  if (!evidence) {
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

/**
 * TRI-STATE best-effort edit-evidence detection.
 *
 * Positive evidence: a non-empty review diff OR edit/edited paths in the
 * transcript. Returns:
 *   { evidence: true,  detectionFailed: false } — a real edit was detected;
 *   { evidence: false, detectionFailed: false } — detection RAN and found nothing;
 *   { evidence: false, detectionFailed: true  } — detection could NOT run/trust its
 *      result (baseline capture threw, buildReviewDiff threw, or a git baseline
 *      yielded a vacuously-empty diff because the repo is corrupted). The caller
 *      MUST NOT fail open on this — it is indistinguishable from a hidden change.
 *
 * @returns {Promise<{evidence: boolean, detectionFailed: boolean}>}
 */
async function hasEditEvidence({ cwd, baseline, baselineError, transcript }) {
  // (1) Transcript edit keys are POSITIVE evidence regardless of the diff state.
  if (transcript) {
    try {
      const { lastEditKey, editedPaths } = scanKeys(parseJsonl(transcript));
      if (lastEditKey > 0 || editedPaths.size > 0) {
        return { evidence: true, detectionFailed: false };
      }
    } catch {
      // A transcript-scan failure is not itself decisive: fall through to the diff
      // probe, which is the authoritative source.
    }
  }

  // (2) The baseline CAPTURE failed (Finding 2): we have no "before" state to diff
  // against, so edit detection is impossible. This is a detection failure, NOT a
  // clean result.
  if (baselineError) {
    return { evidence: false, detectionFailed: true };
  }

  // (3) No baseline AND no capture error: there is simply no diff-based source to
  // consult (e.g. hook fell back to a NOW baseline that was null). Preserve the
  // prior semantics — detection RAN (transcript) and found nothing here; this is a
  // clean result, not a failure. (hook.js depends on this not over-blocking.)
  if (!baseline) {
    return { evidence: false, detectionFailed: false };
  }

  // (4) Baseline present: build the diff. A THROW is a detection failure.
  let diff;
  try {
    diff = await buildReviewDiff(cwd, baseline);
  } catch {
    return { evidence: false, detectionFailed: true };
  }

  // A non-empty diff is positive evidence of a change.
  if (diff && (diff.changedFiles?.length > 0 || diff.text)) {
    return { evidence: true, detectionFailed: false };
  }

  // (5) An EMPTY diff is ambiguous. For a FILESYSTEM baseline the comparison is a
  // self-contained snapshot diff, so an empty result is a trustworthy "no change".
  // For a GIT baseline an empty diff can mean EITHER genuinely no change OR that
  // the git plumbing failed silently (corrupted .git => git resolves non-zero with
  // empty stdout, so buildReviewDiff returns a vacuous empty diff WITHOUT throwing
  // — Finding 1). Verify the git baseline is still usable; if not, this empty diff
  // is a detection failure, not a clean result.
  if (baseline.type === "git") {
    if (!(await gitBaselineUsable(cwd, baseline))) {
      return { evidence: false, detectionFailed: true };
    }
  }
  return { evidence: false, detectionFailed: false };
}

// Re-verify that a git baseline is still comparable: the repo must be a usable git
// work tree AND the recorded baseline commit must still resolve. A corrupted .git
// (Finding 1) makes both fail, so an empty diff built from it cannot be trusted as
// "no change". Tolerant: any non-zero git result marks the baseline unusable.
async function gitBaselineUsable(cwd, baseline) {
  try {
    // HEAD must resolve to a real commit (current tip readable).
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd);
    if (head.code !== 0) return false;
    // The recorded baseline commit must still be a resolvable commit object, so the
    // committed-range diff (baseline.head..HEAD) could actually be computed.
    if (baseline.head) {
      const base = await git(["rev-parse", "--verify", "--quiet", `${baseline.head}^{commit}`], cwd);
      if (base.code !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
