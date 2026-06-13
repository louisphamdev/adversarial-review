// Central gate decision engine.
//
// `evaluateGate` ties together config/policy/classify/diff/transcript/verdict/
// hash to produce a single decision: allow, block, or advisory-allow. It is the
// most security-critical module in the package and MUST FAIL CLOSED in
// `enforced` and `strict-ci` modes: when anything is ambiguous or broken and
// there is evidence of a real change, the gate blocks rather than passing.
//
// IO is injected so the engine stays testable and pure-ish:
//   - filesystem/git diff comes from `cwd` + `baseline` via buildReviewDiff;
//   - session state comes from `stateDir` via state.js;
//   - external review comes from an injected `reviewerRunner(job)` stub.
// The engine never spawns real reviewer tools itself.

import { buildReviewDiff } from "./diff.js";
import { classifyPath } from "./classify.js";
import { scanSecrets } from "./secrets.js";
import {
  isStrict,
  requiresReviewForCode,
  reviewerErrorAction,
  internalErrorAction,
  blockCapAction,
  skipAllowed,
} from "./policy.js";
import {
  parseJsonl,
  scanKeys,
  collectReviewOutputs,
  isSubagentTranscript,
  lastUserText,
  wantsSkip,
} from "./transcript.js";
import { parseVerdict } from "./verdict.js";
import { sha256, stableJson, reviewCacheKey } from "./hash.js";
import { readSessionState, writeSessionState } from "./state.js";

// ---------------------------------------------------------------------------
// Decision constructors (step 1)
// ---------------------------------------------------------------------------

/**
 * An allow decision. Extra fields (e.g. `reason`, `cached`) are merged in.
 * @param {object} [extra]
 * @returns {{action:"allow"}}
 */
export function allow(extra = {}) {
  return { action: "allow", ...extra };
}

/**
 * A block decision carrying a human-readable reason.
 * @param {string} reason
 * @param {object} [extra]
 * @returns {{action:"block",reason:string}}
 */
export function block(reason, extra = {}) {
  return { action: "block", reason, ...extra };
}

/**
 * An advisory allow: the change is allowed but a systemMessage is surfaced.
 * @param {string} message
 * @param {object} [extra]
 * @returns {{action:"allow",systemMessage:string}}
 */
export function advisory(message, extra = {}) {
  return { action: "allow", systemMessage: message, ...extra };
}

// ---------------------------------------------------------------------------
// Level classification (step 2)
// ---------------------------------------------------------------------------

const LEVEL_RANK = { none: 0, single: 1, debate: 2 };

// Escalate `current` to `next` only when `next` is a higher tier.
function escalate(current, next) {
  return LEVEL_RANK[next] > LEVEL_RANK[current] ? next : current;
}

/**
 * Determine the required review level for a set of changed files.
 *
 * Rules:
 *  - no reviewable files -> "none";
 *  - all-code / strict and any reviewable changed file -> at least "single";
 *  - sensitive change with `debateOnSensitive` -> "debate";
 *  - line/file thresholds escalate (bigDiffLines/bigFileCount -> single,
 *    debateDiffLines/debateFileCount -> debate).
 *
 * @param {object} args
 * @param {object} args.config
 * @param {Array<{path:string,status?:string}>} args.changedFiles
 * @param {{lines:number,fileCount:number}} args.diffStats
 * @param {boolean} [args.sensitive] - precomputed sensitive flag (optional).
 * @returns {"none"|"single"|"debate"}
 */
export function classifyLevel({ config, changedFiles, diffStats, sensitive }) {
  const thresholds = config.thresholds || {};
  let level = "none";

  // Inspect each changed file. Renames/deletes still count as reviewable.
  let anyReviewable = false;
  let anySensitive = Boolean(sensitive);
  for (const entry of changedFiles || []) {
    const cls = classifyPath(entry.path, config);
    if (cls.reviewable) anyReviewable = true;
    if (cls.sensitive) anySensitive = true;
  }

  if (!anyReviewable) return "none";

  // In all-code / strict, any reviewable file is at least a single review.
  if (requiresReviewForCode(config)) {
    level = escalate(level, "single");
  }

  // Size thresholds.
  const lines = diffStats?.lines || 0;
  const fileCount = diffStats?.fileCount || 0;
  if (lines >= (thresholds.bigDiffLines ?? 80) || fileCount >= (thresholds.bigFileCount ?? 5)) {
    level = escalate(level, "single");
  }
  if (
    lines >= (thresholds.debateDiffLines ?? 250) ||
    fileCount >= (thresholds.debateFileCount ?? 12)
  ) {
    level = escalate(level, "debate");
  }

  // Sensitive change escalates to debate when configured.
  if (anySensitive && thresholds.debateOnSensitive !== false) {
    level = escalate(level, "debate");
  } else if (anySensitive) {
    // debateOnSensitive disabled: still require at least a single review.
    level = escalate(level, "single");
  }

  return level;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Count diff size: number of changed files plus a line estimate from the diff
// text (count of +/- prefixed lines, ignoring the diff header lines).
function diffStatsFor(changedFiles, diffText) {
  const fileCount = (changedFiles || []).length;
  let lines = 0;
  for (const raw of String(diffText || "").split(/\r?\n/)) {
    if ((raw.startsWith("+") || raw.startsWith("-")) && !raw.startsWith("+++") && !raw.startsWith("---")) {
      lines += 1;
    }
  }
  return { lines, fileCount };
}

// True when at least one changed file is reviewable (code / sensitive / manifest).
function hasReviewableFile(changedFiles, config) {
  return (changedFiles || []).some((f) => classifyPath(f.path, config).reviewable);
}

// True when every changed file is docs-only (no reviewable, no sensitive).
function allDocsOnly(changedFiles, config) {
  const files = changedFiles || [];
  if (files.length === 0) return false;
  return files.every((f) => classifyPath(f.path, config).docsOnly);
}

// Collect reviewable changed-file paths for coverage checks (POSIX-normalized).
function reviewableChangedPaths(changedFiles, config) {
  return (changedFiles || [])
    .filter((f) => classifyPath(f.path, config).reviewable)
    .map((f) => String(f.path).replace(/\\/g, "/"));
}

// True when any reviewable changed file is also sensitive.
function anySensitiveChange(changedFiles, config) {
  return (changedFiles || []).some((f) => classifyPath(f.path, config).sensitive);
}

// Honor the host recursion guard under either spelling.
function recursionActive(input) {
  return Boolean(input.stopHookActive || input.stop_hook_active);
}

// Summarize secret-scan findings for a decision message WITHOUT echoing any raw
// secret material. Only the finding `type`, a count, and (for sensitive paths)
// the file path are surfaced — never the matched secret value/sample. The
// `scanSecrets` `sample` field is deliberately ignored here.
function summarizeSecretFindings(findings) {
  const counts = new Map();
  const paths = [];
  for (const finding of findings) {
    counts.set(finding.type, (counts.get(finding.type) || 0) + 1);
    // Sensitive-path findings carry a non-secret file path that is safe to name.
    if (finding.type === "sensitive_path" && finding.path) {
      paths.push(String(finding.path));
    }
  }
  const typeParts = [...counts.entries()].map(([type, n]) => `${type} x${n}`);
  let summary = `${findings.length} finding(s): ${typeParts.join(", ")}`;
  if (paths.length > 0) {
    summary += `; sensitive path(s): ${paths.join(", ")}`;
  }
  return summary;
}

// Build the message that instructs the host to run the bundled self-review
// orchestrator for a given level. This BLOCK is the "self-review required"
// signal; it is NOT itself a pass.
//
// When a self-review `job` is provided, the message embeds the exact contract
// the orchestrator's FINAL OUTPUT must satisfy: it must emit a verdict block
// whose `job_id`, `diff_hash`, `payload_hash`, `reviewer`, `level`, and
// dimension coverage match this job. A timestamp or a forgeable sentinel is no
// longer sufficient — only a valid, current-diff verdict is accepted.
function selfReviewBlockReason(level, job) {
  const base =
    level === "debate"
      ? "Stop hook feedback: this change has NOT passed an adversarial review. " +
        "Run the bundled self-review orchestrator at DEBATE tier (panel + " +
        "cross-examination + adjudicator) before completing. Critical and " +
        "Important findings must block completion."
      : "Stop hook feedback: this change has NOT passed an adversarial review. " +
        "Run the bundled self-review orchestrator (single adversarial reviewer) " +
        "before completing. Critical and Important findings must block completion.";

  if (!job) return base;

  // Embed the verdict contract so the host orchestrator can emit a matching
  // final-output verdict block. Acceptance is verdict-based, not timestamp- or
  // sentinel-based.
  const dims = (job.requiredDimensions || []).join(", ");
  const files = (job.changedFiles || []).join(", ");
  return (
    base +
    " The orchestrator's FINAL OUTPUT must be a verdict block with " +
    `job_id="${job.jobId}", diff_hash="${job.diffHash}", ` +
    `payload_hash="${job.payloadHash}", reviewer="self", level="${level}", ` +
    `required dimensions [${dims}], and coverage.files_examined covering every ` +
    `reviewable changed file [${files}]. A stale or non-matching verdict is rejected.`
  );
}

// Compute the review cache key for an external pass. Uses available config
// metadata; unknown fields fall back to stable defaults so the key is
// deterministic within a session.
function cacheKeyFor(job, config) {
  return reviewCacheKey({
    diffHash: job.diffHash,
    configHash: sha256(stableJson(config)),
    promptHash: job.payloadHash,
    reviewerId: job.reviewer,
    reviewerVersion: job.reviewerVersion || "",
    model: job.model || "",
    level: job.level,
    toolVersion: job.toolVersion || "",
    privacyMode: config.privacy?.externalReview || "",
  });
}

// ---------------------------------------------------------------------------
// Coverage enforcement (deferred check 2)
// ---------------------------------------------------------------------------

// In enforced/strict, a pass must demonstrate coverage of every reviewable
// changed file. Returns null when coverage is acceptable, or an error reason.
function coverageFailure(verdict, reviewablePaths) {
  const coverage = verdict.coverage || {};
  const examined = Array.isArray(coverage.files_examined) ? coverage.files_examined : [];
  if (reviewablePaths.length > 0 && examined.length === 0) {
    return "empty_coverage";
  }
  const examinedSet = new Set(examined.map((p) => String(p).replace(/\\/g, "/")));
  for (const path of reviewablePaths) {
    if (!examinedSet.has(path)) return `missing_coverage:${path}`;
  }
  return null;
}

// The enforced/strict DEFERRED CHECKS applied to any accepted pass, shared by
// the external-reviewer path and the native self-review path:
//   (a) payload_hash must match the exact payload the gate built;
//   (b) coverage must be non-empty and cover every reviewable changed file.
// Returns null when the verdict passes both, or an operational-failure reason.
function deferredCheckFailure(verdict, job, reviewablePaths) {
  if (verdict.payload_hash !== job.payloadHash) {
    return "payload_hash_mismatch";
  }
  return coverageFailure(verdict, reviewablePaths);
}

// ---------------------------------------------------------------------------
// Native self-review verification (verdict-based; replaces the old timestamp /
// sentinel "already_reviewed" branch)
// ---------------------------------------------------------------------------

// Determine whether a native self-review has genuinely PASSED for the current
// change. We scan every review Task/Agent tool-use that COMPLETED after the last
// edit, parse each subagent's FINAL OUTPUT with parseVerdict against `selfJob`,
// and accept ONLY a parsed verdict that:
//   - ok:true and verdict.verdict === "pass" (validateVerdict already forces
//     "fail" on any Critical/Important finding);
//   - has job_id / diff_hash / reviewer / level all matching selfJob (so a STALE
//     verdict whose diff_hash differs from the CURRENT diffHash is rejected —
//     this is the freshness guarantee); and
//   - in enforced/strict, passes the SAME deferred checks as the external path
//     (payload_hash match + non-empty coverage of every reviewable changed file).
// For the debate level the verdict's level must also be "debate".
//
// A no-op Task carrying only the sentinel token cannot satisfy any of these, so
// substring forgery is closed. The bare GATE_SENTINEL substring is never trusted
// for acceptance; only the verdict block's own sentinel + a valid parse counts.
function selfReviewSatisfied(entries, lastEditKey, selfJob, reviewablePaths, enforced) {
  if (lastEditKey <= 0) return false;
  const outputs = collectReviewOutputs(entries, lastEditKey);
  for (const output of outputs) {
    // parseVerdict is the sole authority for acceptance. The verdict block's own
    // sentinel (<<<ADVERSARIAL-REVIEW-VERDICT>>>) gates parsing, so the bare
    // GATE_SENTINEL substring is never trusted on its own.
    const parsed = parseVerdict(output, selfJob);
    if (!parsed.ok) continue;
    const verdict = parsed.verdict;
    if (verdict.verdict !== "pass") continue;
    // job_id / diff_hash / reviewer / level are already enforced by
    // validateVerdict; for debate, level equality already requires "debate".
    if (enforced) {
      if (deferredCheckFailure(verdict, selfJob, reviewablePaths)) continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reviewer error -> decision mapping
// ---------------------------------------------------------------------------

// Map an operational reviewer failure to a decision per `onReviewerError`.
// `self-review` falls back to the self-review block for the level.
function reviewerErrorDecision(config, level, detail) {
  const action = reviewerErrorAction(config);
  if (action === "allow") {
    return advisory(`Reviewer operational failure (${detail}); allowed per soft policy.`);
  }
  if (action === "self-review") {
    return block(selfReviewBlockReason(level), { selfReview: true, reviewerError: detail });
  }
  return block(`Adversarial review could not complete: reviewer operational failure (${detail}).`, {
    reviewerError: detail,
  });
}

// ---------------------------------------------------------------------------
// Main entry point (step 3 + deferred checks)
// ---------------------------------------------------------------------------

/**
 * Evaluate the gate and return an allow/block/advisory decision.
 *
 * @param {object} input
 * @param {object} input.config            - locked effective config (mergeConfig output).
 * @param {string} input.cwd               - workspace root for diffing.
 * @param {object} input.baseline          - baseline from captureBaseline (or persisted).
 * @param {string} input.transcript        - raw JSONL transcript text.
 * @param {object} [input.host]            - host descriptor; `{ reviewerMapping: "none"|<tool> }`.
 * @param {Function} [input.reviewerRunner] - async (job) => ({ ok, verdict?|error?, raw? }).
 * @param {number} [input.now]             - injected clock (ms).
 * @param {string} [input.sessionId]       - session id for state keying.
 * @param {string} [input.stateDir]        - directory for per-session state.
 * @param {boolean} [input.stopHookActive] - host recursion guard.
 * @returns {Promise<object>} decision
 */
export async function evaluateGate(input) {
  const {
    config,
    cwd,
    baseline,
    transcript,
    host = {},
    reviewerRunner,
    sessionId = "default",
    stateDir,
    transcriptPath = "",
  } = input;

  // (1) Subagent transcripts never trigger the gate (avoid serializing pipelines).
  if (isSubagentTranscript(transcriptPath, sessionId)) {
    return allow({ reason: "subagent_transcript" });
  }

  // (2) Host recursion guard: a re-entrant stop hook must allow to avoid loops.
  if (recursionActive(input)) {
    return allow({ reason: "stop_hook_active" });
  }

  const entries = parseJsonl(transcript || "");
  // Note: lastReviewKey/lastDebateKey (timestamp-based review detection) are no
  // longer used for acceptance — native self-review is now verdict-based below.
  const { lastEditKey, editedPaths } = scanKeys(entries);

  // (3) Build review scope from the authoritative filesystem/git diff.
  let diff;
  try {
    diff = await buildReviewDiff(cwd, baseline);
  } catch {
    diff = null;
  }

  const changedFiles = diff?.changedFiles || [];
  const hasEditEvidence = lastEditKey > 0 || editedPaths.size > 0 || changedFiles.length > 0;

  // No reviewable changed files AND no edit evidence -> nothing happened.
  if (!hasReviewableFile(changedFiles, config) && !hasEditEvidence) {
    return allow({ reason: "no_edits" });
  }

  // (4) Edit evidence exists but the diff is empty/unbuildable: never produce a
  // vacuous external pass. Follow onInternalError (allow soft, block enforced).
  const diffUnbuildable = !diff || (changedFiles.length === 0 && !diff.text);
  if (hasEditEvidence && diffUnbuildable) {
    const action = internalErrorAction(config, true);
    if (action === "allow") {
      return advisory("Edit evidence present but no reviewable diff could be built; allowed per soft policy.");
    }
    return block(
      "Adversarial review could not complete: edit evidence exists but no reviewable diff could be built (fail-closed)."
    );
  }

  // Docs-only changes are allowed (no reviewable/sensitive files).
  if (allDocsOnly(changedFiles, config)) {
    return allow({ reason: "docs_only" });
  }

  // (5) Determine required review level.
  const diffStats = diffStatsFor(changedFiles, diff.text);
  const sensitive = anySensitiveChange(changedFiles, config);
  const level = classifyLevel({ config, changedFiles, diffStats, sensitive });
  if (level === "none") {
    return allow({ reason: "level_none" });
  }

  // (6) Skip handling: only when the latest GENUINE user message asks to skip
  // AND skipAllowed (never in strict-ci). Otherwise IGNORE the skip entirely.
  if (skipAllowed(config) && wantsSkip(lastUserText(entries))) {
    return advisory("Review skipped at user request (allowSkip is enabled).", { skipped: true });
  }

  // Build the review scope/payload shared by both the native self-review check
  // and the external-reviewer path. Computed BEFORE completed-review detection
  // so the self-review verdict is verified against the CURRENT diff.
  const reviewablePaths = reviewableChangedPaths(changedFiles, config);
  const payloadHash = sha256(stableJson({ diff: diff.text, level, changedFiles }));

  // Load session state for block-cap accounting, the pass cache, and the
  // persisted self-review jobId.
  const state = stateDir ? await readSessionState(stateDir, sessionId) : {};
  const cache = state.cache || {};
  const enforced = config.policy.mode === "enforced" || isStrict(config);

  // (7) Native self-review detection (verdict-based). A timestamp or a forgeable
  // sentinel is NOT sufficient: a completed review Task whose FINAL OUTPUT does
  // not parse to a VALID verdict matching the CURRENT job is rejected. This
  // closes both the freshness bypass (BUG A: a post-review non-Edit file change
  // alters diffHash so a prior verdict no longer matches) and the forgery bypass
  // (BUG B: a no-op Task with the sentinel token cannot produce a valid verdict).
  const selfDimensions = config.reviewers?.self?.requiredDimensions || [
    "Correctness",
    "Security",
    "Tests",
  ];
  // Reuse the persisted jobId if the gate previously issued one for THIS diff;
  // otherwise derive a deterministic id from the current diffHash so the
  // orchestrator can reference it before any state is persisted.
  const persistedSelfJobId =
    state.selfReview && state.selfReview.diffHash === diff.diffHash
      ? state.selfReview.jobId
      : null;
  const selfJob = {
    jobId: persistedSelfJobId || `ar-self-${diff.diffHash.slice(0, 16)}`,
    diffHash: diff.diffHash,
    payloadHash,
    reviewer: "self",
    level,
    requiredDimensions: selfDimensions,
    changedFiles: reviewablePaths,
    sensitive,
  };

  if (selfReviewSatisfied(entries, lastEditKey, selfJob, reviewablePaths, enforced)) {
    return allow({ reason: "already_reviewed", level });
  }

  // Emit the "self-review required" BLOCK for the current level. This is the
  // shared local-review path used both when no external reviewer is configured
  // AND when the privacy gate refuses to send code externally (deny / prompt /
  // secret found with block-external). It persists { jobId, diffHash } so a later
  // turn reuses the same jobId, and counts as a BLOCK, not a pass. `extra` lets
  // callers annotate WHY self-review was forced (e.g. the privacy reason) without
  // ever including raw secret material.
  const emitSelfReviewBlock = async (extra = {}) => {
    if (stateDir) {
      await writeSessionState(stateDir, sessionId, {
        ...state,
        selfReview: { jobId: selfJob.jobId, diffHash: selfJob.diffHash },
      });
    }
    return await blockWithCap(
      stateDir,
      sessionId,
      state,
      config,
      block(selfReviewBlockReason(level, selfJob), {
        selfReview: true,
        level,
        jobId: selfJob.jobId,
        diffHash: selfJob.diffHash,
        payloadHash: selfJob.payloadHash,
        requiredDimensions: selfJob.requiredDimensions,
        ...extra,
      })
    );
  };

  // (8) Reviewer routing.
  const reviewerMapping = host.reviewerMapping || host.reviewer || "none";
  const externalReview = reviewerMapping !== "none" && typeof reviewerRunner === "function";

  if (!externalReview) {
    // Self-review required: emit the orchestrator instruction with the verdict
    // contract. Counts as a BLOCK, not a pass.
    return await emitSelfReviewBlock();
  }

  // -------------------------------------------------------------------------
  // (8a) PRIVACY GATE — enforced BEFORE any external-reviewer dispatch.
  //
  // The native self-review path above never sends code off-box, so it is
  // unaffected. Reaching here means we are about to hand the diff to an external
  // reviewer tool/provider. FAIL CLOSED: anything other than an explicit allow +
  // a clean secret scan routes back to local self-review rather than leaking the
  // change. Raw secret material is NEVER placed in any decision message.
  // -------------------------------------------------------------------------
  const privacy = config.privacy || {};
  const externalReviewPolicy = privacy.externalReview || "allow";
  const secretScanPolicy = privacy.secretScan || "block-external";
  // Set only in soft mode when secretScan="warn" lets a flagged change proceed to
  // external review; surfaced as a systemMessage on the eventual allow.
  let secretWarning = null;

  // externalReview policy. `deny` never sends code out; `prompt` cannot obtain
  // consent in this non-interactive gate, so it ALSO fails closed to self-review
  // (interactive consent is the installer's job). Only `allow` proceeds to the
  // secret scan below.
  if (externalReviewPolicy === "deny") {
    return await emitSelfReviewBlock({
      privacyBlocked: true,
      privacyReason: "external_review_denied",
    });
  }
  if (externalReviewPolicy === "prompt") {
    return await emitSelfReviewBlock({
      privacyBlocked: true,
      privacyReason: "external_review_prompt_non_interactive",
    });
  }

  // Secret scan on the EXACT payload about to be sent (diff text + reviewable
  // changed-file paths). Only reached when externalReview === "allow".
  const secretFindings = scanSecrets(diff.text, reviewablePaths);
  if (secretFindings.length > 0) {
    const findingSummary = summarizeSecretFindings(secretFindings);
    if (secretScanPolicy === "block-all") {
      // Operational block in ALL modes: the secret(s) must be removed before any
      // review. The message names the finding type/path only — never the value.
      return await blockWithCap(
        stateDir,
        sessionId,
        state,
        config,
        block(
          "Secret material detected in the change; remove the secret(s) before review can proceed " +
            `(${findingSummary}).`,
          { secretBlocked: true, secretScan: "block-all", level }
        )
      );
    }
    if (secretScanPolicy === "warn") {
      // `warn` is only valid in soft mode. In enforced/strict we MUST NOT send
      // secrets externally, so treat any non-soft `warn` as block-external (fail
      // closed). In soft, proceed to external review but attach a warning.
      if (config.policy.mode === "soft") {
        // Fall through to external review, carrying a warning to surface later.
        secretWarning =
          "Warning: possible secret material detected and sent to external review " +
          `(${findingSummary}). Consider secretScan="block-external".`;
      } else {
        return await emitSelfReviewBlock({
          privacyBlocked: true,
          privacyReason: "secret_detected_block_external",
          secretScan: "block-external",
        });
      }
    } else {
      // Default `block-external` (and any unrecognized value): do NOT send the
      // change externally. Route to local self-review. The reason names that
      // secrets were detected (type/path/count) but never the secret value.
      return await emitSelfReviewBlock({
        privacyBlocked: true,
        privacyReason: "secret_detected_block_external",
        secretScan: secretScanPolicy,
      });
    }
  }

  // Build the external review job. For diff-only payloads the payloadHash equals
  // the diffHash; we compute it explicitly so external reviewers can confirm the
  // exact bytes they reviewed.
  const requiredDimensions = config.reviewers?.[reviewerMapping]?.requiredDimensions || [
    "Correctness",
    "Security",
    "Tests",
  ];
  const job = {
    jobId: `ar-${diff.diffHash.slice(0, 16)}-${level}`,
    diffHash: diff.diffHash,
    payloadHash,
    reviewer: reviewerMapping,
    level,
    requiredDimensions,
    changedFiles: reviewablePaths,
    sensitive,
    // Carry the actual diff text so external reviewer adapters can deliver it to
    // the reviewer process. Without this the adapters write an EMPTY diff file and
    // reviewers produce a meaningless pass. Native self-review (selfJob) does NOT
    // need this: it runs inside the host against the live repo.
    diffText: diff.text,
  };

  // Cache hit: a prior identical review already passed.
  const cacheKey = cacheKeyFor(job, config);
  if (cache[cacheKey]) {
    const extra = { reason: "cached_pass", cached: true, level };
    if (secretWarning) extra.systemMessage = secretWarning;
    return allow(extra);
  }

  // Run the (injected) external reviewer.
  let result;
  try {
    result = await reviewerRunner(job);
  } catch (err) {
    return await blockWithCap(
      stateDir,
      sessionId,
      state,
      config,
      reviewerErrorDecision(config, level, `runner_threw:${err?.message || "error"}`)
    );
  }

  // Operational failure (ok:false, timeout, bad output) -> onReviewerError.
  if (!result || result.ok !== true || !result.verdict) {
    const detail = result?.error || "no_verdict";
    return await blockWithCap(
      stateDir,
      sessionId,
      state,
      config,
      reviewerErrorDecision(config, level, detail)
    );
  }

  const verdict = result.verdict;

  // A valid fail is NOT an operational failure: block with findings, do not
  // fall back to self-review.
  if (verdict.verdict === "fail") {
    return await blockWithCap(
      stateDir,
      sessionId,
      state,
      config,
      block("Adversarial review FAILED. Critical/Important findings must be resolved.", {
        findings: verdict.findings || [],
        level,
      })
    );
  }

  // Valid pass: enforce the DEFERRED CHECKS before allowing, in enforced/strict.
  // (a) payload_hash must match the exact payload the gate built; (b) coverage
  // must be non-empty and cover every reviewable changed file.
  if (enforced) {
    const deferredFail = deferredCheckFailure(verdict, job, reviewablePaths);
    if (deferredFail) {
      return await blockWithCap(
        stateDir,
        sessionId,
        state,
        config,
        reviewerErrorDecision(config, level, deferredFail)
      );
    }
  }

  // Pass accepted: cache it (so a re-run of the identical review is instant).
  if (stateDir) {
    const nextCache = { ...cache, [cacheKey]: true };
    await writeSessionState(stateDir, sessionId, { ...state, cache: nextCache });
  }
  const passExtra = { reason: "external_pass", level, cached: false };
  if (secretWarning) passExtra.systemMessage = secretWarning;
  return allow(passExtra);
}

// ---------------------------------------------------------------------------
// Block-cap accounting (step 9)
// ---------------------------------------------------------------------------

/**
 * Persist an incremented block counter and, once it exceeds the configured cap,
 * apply blockCapAction. In enforced/strict the default keeps blocking; in soft
 * the cap can release the gate to avoid wedging a developer.
 *
 * @returns {Promise<object>} the original block decision, or a cap override.
 */
async function blockWithCap(stateDir, sessionId, state, config, decision) {
  const cap = config.runtime?.blockCap ?? 4;
  const nextCount = (state.blockCount || 0) + 1;

  if (stateDir) {
    await writeSessionState(stateDir, sessionId, { ...state, blockCount: nextCount });
  }

  if (nextCount > cap) {
    const action = blockCapAction(config);
    if (action === "allow") {
      return advisory(
        `Block cap (${cap}) exceeded; allowing per soft policy to avoid wedging the session.`,
        { blockCapReleased: true, blockCount: nextCount }
      );
    }
    // enforced/strict: keep blocking, but annotate the cap state.
    return { ...decision, blockCount: nextCount, blockCapReached: true };
  }

  return { ...decision, blockCount: nextCount };
}
