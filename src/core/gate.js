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
import { parseVerdict, validateVerdict } from "./verdict.js";
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

// The marker capForDiff (diff.js) inlines when a file's diff text is truncated
// at the per-file size cap. The full content is still HASHED (so change
// detection/freshness is intact), but the reviewer never SAW the post-cap bytes.
const TRUNCATION_MARKER = "coverage limitation: diff text capped at";

// The marker withTruncationMarker (diff.js) appends when a WHOLE `git diff`
// stdout exceeded git.js's 64 MiB buffer cap. Unlike TRUNCATION_MARKER this is
// NOT per-file: the tail of the diff (everything past the 64 MiB cap) is missing
// entirely, so it cannot be mapped to a specific changed file. A reviewer never
// saw that tail, yet diff/payload hashes bind only to the captured (truncated)
// text — so a malicious payload placed past the cap would pass review unseen.
// This must be treated as a GLOBAL coverage limitation (block enforced/strict,
// advisory soft) before any pass is accepted. (audit ROUND5 finding 1 / GPT-5.5)
// Must match the exact text emitted by diff.js withTruncationMarker.
const GIT_OUTPUT_TRUNCATION_MARKER =
  "[git output truncated: exceeded buffer cap; diff is incomplete]";

// Reviewable changed files whose diff text was truncated at the size cap, so the
// reviewer could not have seen the full change. A "pass" cannot be trusted for
// such a file (a malicious payload could hide past the cap) even though the
// diff/payload hashes and coverage citations stay self-consistent. The diff text
// is split into per-file sections at each `diff --git ` header; a section bearing
// the cap marker whose path is reviewable is reported. (audit #22)
function truncatedReviewablePaths(diffText, reviewablePaths) {
  if (!diffText || !reviewablePaths || reviewablePaths.length === 0) return [];
  const reviewable = new Set(reviewablePaths.map((p) => String(p).replace(/\\/g, "/")));
  const out = [];
  for (const section of String(diffText).split(/(?=^diff --git )/m)) {
    if (!section.includes(TRUNCATION_MARKER)) continue;
    // Extract the path from the `diff --git a/<p> b/<p>` header. The synthesized
    // truncation blocks always repeat the SAME path on both sides, so a
    // BACKREFERENCE (a/<p> b/<p>) extracts it unambiguously even when the path
    // itself contains " b/" (e.g. a real file literally named `foo b/bar.js`),
    // which a non-greedy `a/(.+?) b/` would mis-split and miss (fail-open).
    const m = /^diff --git a\/(.+) b\/\1(?:\s|$)/m.exec(section);
    if (!m) continue;
    const path = m[1].replace(/\\/g, "/");
    if (reviewable.has(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

// True when the diff text bears the per-file TRUNCATION_MARKER in a section whose
// path CANNOT be mapped to a changed-file path — i.e. the `diff --git a/<p> b/<p>`
// header regex fails to match that marker-bearing section. This is the fail-OPEN
// case that truncatedReviewablePaths cannot report: `.` in the header regex does
// not match a newline, so a reviewable file whose PATH contains a literal newline
// (`src/evil\n.js` — legal on POSIX, reachable via the non-git filesystem snapshot)
// splits the header across lines, the regex misses, and the truncation marker is
// silently dropped instead of being attributed to a reviewable path → a >cap file
// with a payload past the size cap would pass review unseen (audit ROUND6 / Gemini).
//
// We CANNOT safely re-map such a section back to a reviewable path (the path itself
// is ambiguous once it contains the section delimiter), so an unparseable truncation
// MUST fail closed: it is a coverage limitation of unknown extent. A marker-bearing
// section whose header DOES parse is handled by truncatedReviewablePaths (mapped to a
// specific reviewable file, or correctly ignored when it maps to a non-reviewable
// file such as a truncated docs file); only the UNPARSEABLE sections are reported here.
// Exported for unit tests of the ROUND6 newline-in-path unmappable-truncation case.
export function hasUnmappableTruncation(diffText) {
  if (!diffText) return false;
  for (const section of String(diffText).split(/(?=^diff --git )/m)) {
    if (!section.includes(TRUNCATION_MARKER)) continue;
    // A marker-bearing section MUST be a synthesized `diff --git a/<p> b/<p>` block.
    // If the backreference header regex cannot match it, the path is unparseable
    // (e.g. it contains a newline), so the truncation is UNMAPPABLE — fail closed.
    if (!/^diff --git a\/(.+) b\/\1(?:\s|$)/m.test(section)) return true;
  }
  return false;
}

// True when the WHOLE git-diff stdout was truncated at git.js's 64 MiB buffer
// cap (diff.js withTruncationMarker). This is a GLOBAL coverage limitation: the
// missing tail cannot be attributed to any specific file, so it is detected with
// a plain substring scan over the full diff text rather than per-file sectioning.
// (audit ROUND5 finding 1 / GPT-5.5: a >64 MiB git diff would otherwise pass —
// the reviewer never saw the tail, and the hashes bind only to the truncated text.)
function gitOutputTruncated(diffText) {
  return Boolean(diffText) && String(diffText).includes(GIT_OUTPUT_TRUNCATION_MARKER);
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

// Above this many reviewable changed files we stop requiring per-file coverage.
// A reviewer cannot reliably enumerate 40+ paths, so demanding an exact match of
// every one turns real PASSes into spurious BLOCKs. Over the cap we relax the
// per-file requirement but still demand a minimum PROOF of work (see below) so a
// single citation cannot rubber-stamp an arbitrarily large unexamined diff.
const COVERAGE_FILE_CAP = 40;

// HARDENING (finding: large diffs can pass with 40+ unexamined reviewable files):
// over the cap we no longer accept a SINGLE real citation. A pass must cite a
// minimum number of DISTINCT real reviewable paths — at least
// `max(COVERAGE_MIN_OVER_CAP_REAL, ceil(COVERAGE_OVER_CAP_RATIO * total))`. This
// keeps the cap's usability relaxation (no exact 40+ enumeration) while closing the
// fail-open where coverage of one file "covered" the whole diff. The ratio is
// deliberately small (genuine sampling of a huge mechanical diff is legitimate) but
// scales with the diff size so the larger the diff, the more files must be cited.
const COVERAGE_OVER_CAP_RATIO = 0.05;
const COVERAGE_MIN_OVER_CAP_REAL = 2;

// Canonicalize a path so coverage comparison is robust to the many FORMS the same
// file may take. Lower-risk, form-only normalizations:
//   - POSIX slashes (backslash -> slash);
//   - trim surrounding whitespace;
//   - collapse one or more leading "./" segments;
//   - collapse any run of "/" into a single "/".
// This function does NOT strip a leading "a/"/"b/" git-diff prefix and does NOT
// strip a trailing ":<line>" suffix — those are reviewer-citation-only relaxations
// applied separately (see citationVariants). Reviewable changed-file paths come
// from the filesystem and NEVER carry git a//b/ prefixes or :line suffixes, so
// canonicalizing them here without those strips prevents 'a/x.js' and 'x.js' (or
// 'a/x.js' and 'b/x.js') from collapsing onto each other — a coverage collision
// that could let one citation "cover" a DIFFERENT unexamined file.
// Returns "" for empty/non-string input.
// Exported for unit tests of the COLLISION-2 leading-'./'/'//' normalization.
export function canonicalizePath(p) {
  let s = String(p == null ? "" : p)
    .replace(/\\/g, "/")
    .trim();
  if (!s) return "";
  // Collapse any run of slashes into a single slash FIRST (handles ".//src/x.js"
  // -> "./src/x.js" and internal "src//x.js" -> "src/x.js"). Doing this before the
  // leading-"./" strip prevents a stray leading "/" surviving for inputs like
  // ".//src/x.js".
  s = s.replace(/\/{2,}/g, "/");
  // Then collapse one or more leading "./" segments robustly (handles "./",
  // "././", etc.).
  s = s.replace(/^(?:\.\/)+/, "");
  return s;
}

// Expand a REVIEWER citation into the canonical FORMS the SAME path may take.
// These are the only citation-side relaxations, and they NEVER cross to a
// different file:
//   - the citation as-is, canonicalized;
//   - if it ends with a ":<digits>" line/column suffix, the suffix-stripped form
//     too (the un-stripped exact form is kept and listed first so a real filename
//     like 'src/weird:12' is never silently mangled into 'src/weird').
//
// HARDENING (audit COLLISION-1/3a, gate-coverage): this function NO LONGER emits a
// git-diff "a/"/"b/"-prefix-STRIPPED variant. A stripped 'a/x.js' -> 'x.js' variant
// is GLOBALLY matchable and would let a citation for one file (or for a file under a
// real top-level dir literally named 'a'/'b') "cover" a DISTINCT unexamined
// reviewable file. The legitimate git-diff header form ('a/'+p / 'b/'+p) is handled
// PATH-SPECIFICALLY in coverageFailure instead, where the prefix is only accepted
// when it resolves to the exact reviewable path p. The ':<line>' strip is likewise
// no longer combined with any prefix strip, so no malformed "x.js:12" variant (a
// prefix-stripped-but-line-retained form) is ever produced.
//
// Returns a de-duplicated array of non-empty canonical variants.
// Exported for unit tests of the COLLISION-1/COLLISION-3a citation relaxations.
export function citationVariants(raw) {
  const variants = [];
  const add = (v) => {
    const c = canonicalizePath(v);
    if (c && !variants.includes(c)) variants.push(c);
  };
  const base = String(raw == null ? "" : raw)
    .replace(/\\/g, "/")
    .trim();
  if (!base) return variants;
  // Always include the exact (un-stripped) form first so an exact match against a
  // real ':<digits>'-bearing filename is preferred over the :line-stripped form.
  add(base);
  // ':<line>'-stripped form, only when a trailing ":<digits>" suffix is present.
  const stripped = base.replace(/:\d+$/, "");
  if (stripped !== base) add(stripped);
  return variants;
}

// The basename (last POSIX path segment) of an already-canonicalized path.
function baseNameOf(canonical) {
  const idx = canonical.lastIndexOf("/");
  return idx >= 0 ? canonical.slice(idx + 1) : canonical;
}

// True when a single reviewable path `canon` is covered by the examined-citation
// variant sets. Matching is PATH-SPECIFIC so a citation can never cover a DIFFERENT
// reviewable file than the one it literally references:
//   - full-path match: a citation variant equals `canon`;
//   - git-diff header match: a citation variant equals the legitimate header form
//     "a/"+canon / "b/"+canon — accepted ONLY when that prefixed form is NOT itself a
//     distinct reviewable changed path. This closes COLLISION-1: if "a/foo.js" is a
//     real reviewable file, a citation of "a/foo.js" must cover ONLY "a/foo.js" and
//     never the top-level "foo.js" via the "a/"+canon header rule;
//   - basename match: a citation variant's basename equals `canon`'s basename AND
//     that basename is UNIQUE among the reviewable changed files (ambiguous
//     basenames require the full-path match).
// `reviewableSet` is the set of all canonicalized reviewable changed paths.
function pathCovered(canon, base, baseUnique, examinedFull, examinedBase, reviewableSet) {
  if (examinedFull.has(canon)) return true;
  // Path-specific git-diff header acceptance: a reviewer reading the raw `git diff`
  // sees every path as "a/<p>" / "b/<p>". Accept those forms against THIS path p, but
  // suppress the rule when the prefixed form is itself a real reviewable changed file
  // (then the citation belongs to THAT file, not to p).
  const aForm = `a/${canon}`;
  const bForm = `b/${canon}`;
  if (examinedFull.has(aForm) && !reviewableSet.has(aForm)) return true;
  if (examinedFull.has(bForm) && !reviewableSet.has(bForm)) return true;
  if (baseUnique && examinedBase.has(base)) return true;
  return false;
}

// In enforced/strict, a pass must demonstrate coverage of every reviewable
// changed file. Returns null when coverage is acceptable, or an error reason.
//
// Both the verdict's `coverage.files_examined` citations and the reviewable
// changed-file paths are CANONICALIZED before comparison (see canonicalizePath).
// A changed file is considered covered if its full canonical path (or its
// path-specific git "a/"/"b/" header form) appears in the examined set, OR its
// basename appears AND that basename is UNIQUE among the reviewable changed files.
// A basename shared by multiple reviewable files is AMBIGUOUS (e.g. src/a/index.js
// and test/b/index.js both basename "index.js"), so a bare-basename citation cannot
// prove which file was examined — for those we require the full-path match. This
// both tolerates differing path FORMS for an unambiguous file and prevents one
// ambiguous basename from "covering" several distinct files.
function coverageFailure(verdict, reviewablePaths) {
  const coverage = verdict.coverage || {};
  const examined = Array.isArray(coverage.files_examined) ? coverage.files_examined : [];
  // Empty coverage on a non-empty reviewable diff is still an operational failure.
  if (reviewablePaths.length > 0 && examined.length === 0) {
    return "empty_coverage";
  }
  // Count how often each basename occurs among the canonicalized reviewable
  // changed files so we can tell unique basenames from ambiguous ones. Also build the
  // set of canonical reviewable paths so the git "a/"/"b/" header rule can be
  // suppressed when a prefixed citation is itself a distinct reviewable file.
  const baseCounts = new Map();
  const reviewableSet = new Set();
  for (const path of reviewablePaths) {
    const canon = canonicalizePath(path);
    reviewableSet.add(canon);
    const base = baseNameOf(canon);
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }
  // Build canonical full-path and basename lookup sets from the citations. Each
  // citation expands only into FORMS OF THE SAME path (as-is and ':<line>'-stripped;
  // see citationVariants). The reviewable changed paths, by contrast, are
  // canonicalized WITHOUT any prefix/suffix stripping (see canonicalizePath) so a
  // real top-level 'a/' file is never collapsed onto a prefix-stripped name. The
  // git "a/"/"b/" header form is matched path-specifically in pathCovered.
  const examinedFull = new Set();
  const examinedBase = new Set();
  for (const raw of examined) {
    for (const variant of citationVariants(raw)) {
      examinedFull.add(variant);
      examinedBase.add(baseNameOf(variant));
    }
  }
  // Per-file cap: with too many changed files we no longer demand an exact per-file
  // enumeration (no reviewer can reliably produce 40+ exact paths). HARDENING
  // (finding: large diffs can pass with 40+ unexamined reviewable files): above the
  // cap we still must not accept a token citation rubber-stamping the whole diff.
  // Count how many DISTINCT reviewable changed paths are actually covered and require
  // that count to meet a minimum proof-of-work threshold that scales with the diff
  // size (max(MIN, ceil(ratio*total))). The non-empty check above handled the empty
  // case; a single real citation over a 41-file diff no longer suffices.
  if (reviewablePaths.length > COVERAGE_FILE_CAP) {
    let realCovered = 0;
    for (const path of reviewablePaths) {
      const canon = canonicalizePath(path);
      const base = baseNameOf(canon);
      if (pathCovered(canon, base, baseCounts.get(base) === 1, examinedFull, examinedBase, reviewableSet)) {
        realCovered += 1;
      }
    }
    if (realCovered === 0) {
      return "coverage_no_real_path";
    }
    const requiredReal = Math.max(
      COVERAGE_MIN_OVER_CAP_REAL,
      Math.ceil(COVERAGE_OVER_CAP_RATIO * reviewablePaths.length)
    );
    if (realCovered < requiredReal) {
      return `coverage_below_min_ratio:${realCovered}/${requiredReal}`;
    }
    return null;
  }
  for (const path of reviewablePaths) {
    const canon = canonicalizePath(path);
    const base = baseNameOf(canon);
    if (pathCovered(canon, base, baseCounts.get(base) === 1, examinedFull, examinedBase, reviewableSet)) continue;
    return `missing_coverage:${canon}`;
  }
  return null;
}

// True when the reviewable changed-file count exceeds the per-file cap, i.e. when
// coverageFailure relaxed the per-file requirement. Used to annotate the allow
// decision with a coverage limitation note (informational only).
function coverageLimited(reviewablePaths) {
  return reviewablePaths.length > COVERAGE_FILE_CAP;
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

// HARDENING (audit ROUND5 finding 2 / GPT-5.5: forgeable pass cache): a cache HIT
// is no longer trusted on its own. The cache value MUST be the VALIDATED verdict
// object that produced the original pass, and on every hit we RE-RUN the exact same
// acceptance checks against the CURRENT job before honoring it:
//   - validateVerdict re-binds job_id/diff_hash/payload_hash/reviewer/level and
//     re-applies the forced-fail rule (any Critical/Important finding => "fail");
//   - the verdict must still be "pass" after that;
//   - the deferred checks (payload_hash match + coverage of every reviewable file)
//     re-run in enforced/strict, exactly as on a fresh pass.
// A bare `true`, a missing/non-object entry, or any entry that fails revalidation
// is a cache MISS (returns false) so the gate re-reviews instead of allowing.
//
// RESIDUAL RISK: a local agent that controls the user-level state dir can still
// pre-write a FULL forged verdict object (correct job_id/diff_hash/payload_hash —
// all deterministic from the current diff) to forge a hit. That is the SAME
// inherent limitation as native self-review (the gate trusts host/state honesty
// and cannot cryptographically distinguish an honest reviewer from a colluding one
// in-process). This fix raises the bar — a trivial `{cache:{<key>:true}}` forge no
// longer works — but it is NOT airtight. See README "Residual Risks".
function cachedVerdictHonored(entry, job, reviewablePaths, enforced) {
  // Only a stored verdict OBJECT can be honored; bare `true`/missing/non-object
  // entries (incl. the legacy `true` shape and any hand-forged truthy value) MISS.
  if (!entry || typeof entry !== "object") return false;
  const revalidated = validateVerdict(entry, job);
  if (!revalidated.ok) return false;
  if (revalidated.verdict.verdict !== "pass") return false;
  if (enforced && deferredCheckFailure(revalidated.verdict, job, reviewablePaths)) {
    return false;
  }
  return true;
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
//   - passes the SAME deferred checks as the external path (payload_hash match +
//     non-empty coverage of every reviewable changed file). HARDENING (audit
//     gate-decision): these binding checks now run in EVERY mode, not just
//     enforced/strict. A soft self-review pass that cites empty coverage and a
//     mismatched payload_hash is no longer accepted, so the only fail-open that a
//     non-canonical/loosened mode could exploit is also closed here.
// For the debate level the verdict's level must also be "debate".
//
// RESIDUAL RISK (audit rt-bypass, finding "self-review verdict is forgeable"):
// acceptance is decided by parseVerdict against `selfJob`. Every binding value
// (job_id / diff_hash / payload_hash / reviewable file list) is a DETERMINISTIC
// function of the current diff AND must be disclosed to the orchestrator via
// selfReviewBlockReason so an HONEST reviewer subagent can echo it. Because the
// native self-review verdict is authored by a host subagent inside the same
// transcript, the gate cannot cryptographically distinguish an honest reviewer
// from a colluding/no-op Task that simply re-emits those public values: any secret
// strong enough to prevent forgery would also have to be withheld from the honest
// reviewer, which would break legitimate self-review. The strongest FEASIBLE
// binding is enforced here — the forged verdict must reproduce the exact payload
// bytes (payload_hash) and enumerate coverage of every reviewable changed file —
// but native self-review ultimately TRUSTS host/reviewer honesty (see README
// "Residual Risks"). The external-reviewer path (run out-of-process) does not share
// this limitation. This closes the FRESHNESS bypass, not forgery.
//
// `enforced` is retained for signature stability; the deferred checks no longer
// depend on it (they apply in all modes).
function selfReviewSatisfied(entries, lastEditKey, selfJob, reviewablePaths, enforced) {
  void enforced;
  if (lastEditKey <= 0) return false;
  const outputs = collectReviewOutputs(entries, lastEditKey);
  for (const output of outputs) {
    // parseVerdict is the sole authority for acceptance.
    const parsed = parseVerdict(output, selfJob);
    if (!parsed.ok) continue;
    const verdict = parsed.verdict;
    if (verdict.verdict !== "pass") continue;
    // job_id / diff_hash / reviewer / level are already enforced by
    // validateVerdict; for debate, level equality already requires "debate".
    // Deferred checks (payload_hash match + coverage) apply in EVERY mode.
    if (deferredCheckFailure(verdict, selfJob, reviewablePaths)) continue;
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
 * @param {string} [input.hookEventName]   - authoritative host event name
 *        (e.g. "Stop"/"SubagentStop"); only "SubagentStop" skips the gate.
 * @param {Function} [input.onScopeDiagnostic] - optional best-effort message sink.
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
    hookEventName = "",
    onScopeDiagnostic,
  } = input;

  // (1) Subagent transcripts never trigger the gate (avoid serializing pipelines).
  // The decision is gated on the AUTHORITATIVE host signal (hook_event_name ===
  // "SubagentStop", set by the host itself) — the untrusted session-id / path
  // heuristics alone can no longer turn the gate off (fail closed when ambiguous).
  if (isSubagentTranscript(transcriptPath, sessionId, hookEventName)) {
    return allow({ reason: "subagent_transcript" });
  }

  // (2) Host recursion guard: a re-entrant stop hook must allow to avoid loops.
  if (recursionActive(input)) {
    return allow({ reason: "stop_hook_active" });
  }

  const entries = parseJsonl(transcript || "");
  // scanKeys reports only edit evidence; acceptance of a prior review is
  // verdict-based (collectReviewOutputs + parseVerdict), handled below.
  const { lastEditKey, editedPaths } = scanKeys(entries, cwd);

  // (3) Build review scope from the authoritative filesystem/git diff.
  let diff;
  try {
    diff = await buildReviewDiff(cwd, baseline);
  } catch {
    diff = null;
  }
  if (diff?.ignoredUntrackedSkipped > 0 && typeof onScopeDiagnostic === "function") {
    try {
      onScopeDiagnostic(
        `adversarial-review: skipped ${diff.ignoredUntrackedSkipped} gitignored untracked ` +
          `file(s) (respectGitignore=true)`
      );
    } catch {
      // Diagnostics are best-effort and must not alter gate behavior.
    }
  }

  const changedFiles = diff?.changedFiles || [];
  const hasEditEvidence = lastEditKey > 0 || editedPaths.size > 0 || changedFiles.length > 0;

  // (3b) The diff FAILED TO BUILD (buildReviewDiff threw -> null) — e.g. a `git
  // diff` errored on a corrupted .git/index, which would otherwise return an
  // empty diff that reads as "no changes". A null diff means we CANNOT confirm a
  // clean workspace, so fail closed in enforced/strict BEFORE the no_edits allow,
  // even with no other evidence (a corrupted repo must not pass unreviewed). A
  // genuinely-clean workspace returns an empty-but-NON-null diff, so this never
  // over-blocks a clean check. (round 6 / GPT-5.5 + Gemini)
  if (diff === null) {
    const enforcedBuild = config.policy.mode === "enforced" || isStrict(config);
    if (enforcedBuild) {
      return block(
        "Adversarial review could not complete: the diff could not be built (the repository may be " +
          "corrupted), so a clean workspace cannot be confirmed (fail-closed).",
        { detectionFailed: true }
      );
    }
    return advisory(
      "The diff could not be built (the repository may be corrupted); allowed per soft policy.",
      { detectionFailed: true }
    );
  }

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

  // The FULL changed-path list (POSIX-normalized), independent of classifier
  // reviewability. HARDENING (audit diff-classify-secrets): the path-based secret
  // check must scan EVERY changed path, not only the classifier-reviewable subset —
  // a path the classifier drops (e.g. a docs-extension file whose name matches a
  // sensitive pattern, or a unicode-cloaked/quotePath-mangled path) would otherwise
  // escape the sensitive-path scan.
  const allChangedPaths = (changedFiles || []).map((f) => String(f.path).replace(/\\/g, "/"));

  // Docs-only changes are allowed (no reviewable/sensitive files) — BUT a change
  // whose paths include a sensitive file (e.g. a *.md whose NAME matches a secret
  // pattern that the docs classifier treats as non-reviewable) must NOT slip through
  // the docs-only early-allow without a secret path scan. Run the path-based scan on
  // the full changed-path list first; a sensitive path is an operational BLOCK in
  // all modes (remove the sensitive file before review can proceed). The message
  // names only the finding type/path — never any secret value.
  if (allDocsOnly(changedFiles, config)) {
    const docsSecretFindings = scanSecrets("", allChangedPaths);
    if (docsSecretFindings.length === 0) {
      return allow({ reason: "docs_only" });
    }
    return block(
      "Sensitive file detected in an otherwise docs-only change; remove or review it before completion " +
        `(${summarizeSecretFindings(docsSecretFindings)}).`,
      { secretBlocked: true, secretScan: "sensitive_path" }
    );
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

  // (6a) GLOBAL GIT-OUTPUT TRUNCATION (audit ROUND5 finding 1 / GPT-5.5): when the
  // WHOLE `git diff` stdout exceeded git.js's 64 MiB buffer cap, diff.js appended a
  // git-output truncation marker and the diff TAIL (everything past the cap) is
  // missing entirely. This is NOT per-file and cannot be attributed to any specific
  // changed file, so the per-file check below would never catch it — a malicious
  // payload placed past the 64 MiB cap would pass review unseen (the reviewer never
  // saw the tail, and diff/payload hashes bind only to the captured/truncated text).
  // Treat it as a GLOBAL coverage limitation and FAIL CLOSED: block in enforced/strict,
  // advisory in soft. Checked BEFORE the native self-review / external paths so no pass
  // can be accepted on an incomplete diff.
  if (gitOutputTruncated(diff.text)) {
    const msg =
      "git diff output exceeded the buffer cap, so the diff is incomplete and the " +
      "reviewer could not see the full change (the tail past the cap is missing)";
    if (enforced) {
      return block(
        `Adversarial review could not complete: ${msg} (fail-closed). Reduce the change size ` +
          "or review the omitted tail manually before completing.",
        { gitOutputTruncated: true }
      );
    }
    return advisory(`${msg}; the review is based on incomplete diff content.`, {
      gitOutputTruncated: true,
    });
  }

  // (6b) TRUNCATED REVIEWABLE CONTENT (audit #22): a reviewable file whose diff
  // text was capped at the per-file size limit means the reviewer NEVER SAW the
  // post-cap payload — a "pass" cannot be trusted for it, yet the diff/payload
  // hashes and coverage citations stay self-consistent. Fail closed: block in
  // enforced/strict, advisory in soft. (Full content is still hashed, so
  // freshness is intact; only the COMPLETENESS of the review is at stake.)
  const truncated = truncatedReviewablePaths(diff.text, reviewablePaths);
  if (truncated.length > 0) {
    const list = truncated.slice(0, 5).join(", ") + (truncated.length > 5 ? ", …" : "");
    if (enforced) {
      return block(
        `Adversarial review could not complete: ${truncated.length} reviewable file(s) had their diff ` +
          `truncated at the size cap, so the reviewer could not see the full change (fail-closed): ${list}.`,
        { truncated: true, truncatedPaths: truncated }
      );
    }
    return advisory(
      `Reviewable file(s) were truncated at the size cap; the reviewer saw incomplete content: ${list}.`,
      { truncated: true, truncatedPaths: truncated }
    );
  }

  // (6c) UNMAPPABLE PER-FILE TRUNCATION (audit ROUND6 / Gemini): the diff text
  // bears the per-file size-cap TRUNCATION_MARKER, but the marker-bearing section's
  // `diff --git a/<p> b/<p>` header does NOT parse, so the truncation cannot be
  // attributed to a specific changed file (above, truncatedReviewablePaths returned
  // []). The classic trigger is a path containing a literal newline (`src/evil\n.js`,
  // legal on POSIX and reachable via the non-git filesystem snapshot): the header
  // regex's `.` does not cross the newline, the section silently fails to map, and a
  // >cap reviewable file with a payload hidden past the size cap would otherwise pass
  // review unseen. An UNPARSEABLE truncation is a coverage limitation of unknown
  // extent and MUST fail closed: block in enforced/strict, advisory in soft —
  // exactly like the global git-output truncation. Checked AFTER the mappable
  // per-file check so a normal truncation still reports its concrete path list.
  if (hasUnmappableTruncation(diff.text)) {
    const msg =
      "the diff text was truncated at the per-file size cap but the truncated section's " +
      "path could not be parsed (an unparseable/ambiguous file path), so the reviewer " +
      "could not see the full change and it cannot be attributed to a specific file";
    if (enforced) {
      return block(
        `Adversarial review could not complete: ${msg} (fail-closed). Rename the offending file ` +
          "(remove unusual characters such as newlines from its path) or review the truncated content manually before completing.",
        { truncated: true, unmappableTruncation: true }
      );
    }
    return advisory(`${msg}; the review is based on incomplete diff content.`, {
      truncated: true,
      unmappableTruncation: true,
    });
  }

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
    const passExtra = { reason: "already_reviewed", level };
    // Mirror the external path: record a coverage limitation when the change has
    // more reviewable files than the per-file coverage cap.
    if (enforced && coverageLimited(reviewablePaths)) {
      passExtra.coverageLimited = true;
      passExtra.coverageNote =
        `Coverage limitation: ${reviewablePaths.length} reviewable files exceed the ` +
        `per-file coverage cap (${COVERAGE_FILE_CAP}); accepted on non-empty coverage.`;
    }
    return allow(passExtra);
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

  // Secret scan on the EXACT payload about to be sent. The diff text plus ALL
  // changed-file paths (not just the classifier-reviewable subset) are scanned so a
  // sensitive path the classifier dropped is still caught before any external
  // dispatch. Only reached when externalReview === "allow".
  const secretFindings = scanSecrets(diff.text, allChangedPaths);
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

  // Cache hit: a prior identical review already passed. HARDENING (audit ROUND5
  // finding 2 / GPT-5.5): the cache now stores the VALIDATED verdict object, not a
  // bare `true`. Re-validate it against the CURRENT job AND re-run the deferred
  // coverage checks before honoring the hit; a bare `true` / missing / invalid /
  // non-passing entry is a cache MISS that falls through to a fresh review. This
  // defeats a trivially pre-written `{cache:{<key>:true}}` forge.
  const cacheKey = cacheKeyFor(job, config);
  if (cachedVerdictHonored(cache[cacheKey], job, reviewablePaths, enforced)) {
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

  // HARDENING (audit gate-decision advisory): re-validate the runner's verdict in
  // the gate itself rather than trusting its shape. The shipped adapters call
  // parseVerdict, but the gate's documented contract is to FAIL CLOSED even if a
  // future/third-party/compromised runner returns a malformed object. validateVerdict
  // (idempotent on an already-validated verdict) re-binds job_id/diff_hash/reviewer/
  // level, requires verdict to be exactly "pass"/"fail", and FORCES "fail" on any
  // Critical/Important finding. Anything that fails validation is an operational
  // failure routed through reviewerErrorDecision (block in enforced/strict).
  const validated = validateVerdict(result.verdict, job);
  if (!validated.ok) {
    return await blockWithCap(
      stateDir,
      sessionId,
      state,
      config,
      reviewerErrorDecision(config, level, `invalid_verdict:${validated.error}`)
    );
  }
  const verdict = validated.verdict;

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

  // Pass accepted: cache the VALIDATED verdict object (not a bare `true`) so a
  // re-run of the identical review is instant AND the cache hit can be re-validated
  // against the current job (audit ROUND5 finding 2). The stored object is the same
  // shape validateVerdict re-checks on a hit, so a genuine pass round-trips cleanly.
  if (stateDir) {
    const nextCache = { ...cache, [cacheKey]: verdict };
    await writeSessionState(stateDir, sessionId, { ...state, cache: nextCache });
  }
  const passExtra = { reason: "external_pass", level, cached: false };
  // When the change has more reviewable files than the per-file coverage cap, the
  // gate accepted non-empty (not exhaustive) coverage; record that limitation.
  if (enforced && coverageLimited(reviewablePaths)) {
    passExtra.coverageLimited = true;
    passExtra.coverageNote =
      `Coverage limitation: ${reviewablePaths.length} reviewable files exceed the ` +
      `per-file coverage cap (${COVERAGE_FILE_CAP}); accepted on non-empty coverage.`;
  }
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
