// Default configuration for adversarial-review.
// All sub-objects are frozen shallowly; consumers receive a deep clone via mergeConfig.

export const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  policy: {
    mode: "enforced",
    reviewScope: "all-code",
    onReviewerError: "block",
    onInternalError: "block",
    onBlockCap: "block",
    allowSkip: false,
    allowAdvisoryHosts: false,
  },
  thresholds: {
    bigDiffLines: 80,
    bigFileCount: 5,
    debateDiffLines: 250,
    debateFileCount: 12,
    debateOnSensitive: true,
  },
  sensitivity: {
    extraSensitive: [],
    extraCodeExts: [],
  },
  runtime: {
    blockCap: 4,
    stateTtlDays: 14,
    timeoutSec: 180,
    baselineRef: "auto",
    // Extra workspace directory NAMES to exclude from review (in addition to the
    // built-in node_modules/.venv/.spec-workflow/... set) — e.g. a tool's scratch dir
    // or an IDE dir a non-git workspace cannot otherwise ignore. Part of `runtime`,
    // which load-config pins entirely to the TRUSTED baseline, so a cloned/untrusted
    // PROJECT config can never add a skip dir to HIDE code from review (a fail-open):
    // only the user/global config can set it.
    extraSkipDirs: [],
  },
  privacy: {
    externalReview: "allow",
    secretScan: "block-external",
    tempFileMode: "0600",
  },
  hosts: {},
  reviewers: {},
});

// Known top-level config keys; unknown keys are stripped by sanitizeProjectConfig.
const TOP_LEVEL_KEYS = new Set([
  "version",
  "policy",
  "thresholds",
  "sensitivity",
  "runtime",
  "privacy",
  "hosts",
  "reviewers",
]);

/**
 * Strip unknown top-level keys from a raw project config object.
 * Does not validate nested keys — that is intentionally left loose so
 * future sub-keys added to DEFAULT_CONFIG work without updating this list.
 *
 * @param {object} raw
 * @returns {object}
 */
export function sanitizeProjectConfig(raw) {
  const clean = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (TOP_LEVEL_KEYS.has(key)) clean[key] = value;
  }
  return clean;
}

/**
 * Recursively assign source properties onto target.
 * Arrays are treated as scalars (replaced, not merged).
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} target
 */
export function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepAssign(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// Ordering for mode strictness — higher index means stricter.
const MODE_RANK = new Map([
  ["soft", 0],
  ["enforced", 1],
  ["strict-ci", 2],
]);

// The only recognized policy modes.
const KNOWN_MODES = new Set(["soft", "enforced", "strict-ci"]);

/**
 * Canonicalize a policy mode value to a known mode string.
 *
 * Trims + lowercases a string and maps it to the matching known mode. ANY
 * unrecognized value — a non-string, a typo, a case variant ("Enforced"), a
 * padded value (" enforced "), or outright garbage — maps to the secure default
 * "enforced". This is a FAIL-CLOSED guarantee: a non-canonical mode can never
 * silently slip past the gate's `mode === "enforced"` / `=== "strict-ci"` checks
 * and thereby disable enforced-only protections (reviewer isolation, deferred
 * coverage checks, fail-closed error handling).
 *
 * @param {*} mode
 * @returns {"soft"|"enforced"|"strict-ci"}
 */
function canonicalizeMode(mode) {
  if (typeof mode === "string") {
    const m = mode.trim().toLowerCase();
    if (KNOWN_MODES.has(m)) return m;
  }
  return "enforced";
}

// Ranked privacy domains — higher rank means stricter (more protective).
// The floor ratchets each to max(floor, current) so a user floor can only
// tighten and a project can never loosen below it.
const SECRET_SCAN_RANK = new Map([
  ["warn", 0],
  ["block-external", 1],
  ["block-all", 2],
]);
const EXTERNAL_REVIEW_RANK = new Map([
  ["allow", 0],
  ["prompt", 1],
  ["deny", 2],
]);

/**
 * Ratchet a ranked config value up to the floor when the floor is stricter.
 * No-op when the floor value is unknown/absent or the current value already
 * ranks at least as strict. A stricter project value is never loosened.
 *
 * @param {Map<string, number>} rank   - value -> strictness rank
 * @param {string|undefined} floorVal  - floor value (may be undefined)
 * @param {string|undefined} currentVal - current effective value
 * @returns {string|undefined} the value to use (floor when stricter, else current)
 */
function ratchetRanked(rank, floorVal, currentVal) {
  if (floorVal == null || !rank.has(floorVal)) return currentVal;
  const floorRank = rank.get(floorVal);
  const currentRank = rank.has(currentVal) ? rank.get(currentVal) : -1;
  return currentRank < floorRank ? floorVal : currentVal;
}

/**
 * Apply a user-level policy floor to a fully-merged config object so that
 * a project config can never loosen what the user has set as a minimum.
 *
 * Floor rules (all one-directional — can only tighten, never loosen):
 *  - mode: ratchets to whichever rank is higher
 *  - allowSkip / allowAdvisoryHosts: floor=false forces false
 *  - onReviewerError / onInternalError / onBlockCap: floor="block" forces "block"
 *  - reviewScope: floor="all-code" forces "all-code"
 *  - privacy.externalReview: ratchets over deny(2) > prompt(1) > allow(0), so a
 *    "prompt" floor cannot be loosened to "allow"
 *  - privacy.secretScan: ratchets over block-all(2) > block-external(1) > warn(0),
 *    so a "block-external" floor cannot be loosened to "warn"
 *
 * @param {object} config  - already deep-cloned merged config (mutated in place)
 * @param {object} floor   - user policy floor (may have .policy sub-object or be flat)
 * @returns {object} config
 */
export function applyPolicyFloor(config, floor = {}) {
  // DEFENSIVE (fail-closed): an untrusted layer can replace a structured
  // sub-object with a scalar / null / array — e.g. a committed project config
  // `{"privacy":"pwned"}` or `{"policy":null}`. Reading `.mode` / `.externalReview`
  // off such a value throws a TypeError, and because config loading sits on the
  // gate's critical path (and is NOT wrapped by the fail-closed catch), an
  // uncaught throw would FAIL OPEN — the agent stops with un-reviewed changes.
  // Coerce every known structured sub-object back to a DEFAULT clone when it is
  // not a plain object, so the floor logic below always sees a valid shape. The
  // caller's trusted-baseline floor then re-applies the user's intended values
  // on top, so a project's scalar/null injection is neutralized, not honored.
  for (const key of ["policy", "privacy", "runtime", "thresholds", "sensitivity"]) {
    const v = config[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      config[key] = structuredClone(DEFAULT_CONFIG[key]);
    }
  }
  // Canonicalize the effective mode so a non-canonical project value (case
  // variant, padded, typo, non-string) can never silently bypass the gate's
  // `mode === "enforced"` / `=== "strict-ci"` checks (fail closed to enforced).
  config.policy.mode = canonicalizeMode(config.policy.mode);

  const floorPolicy = floor.policy || floor;

  // A PRESENT floor mode is canonicalized too (a trusted user floor of
  // "Enforced" still ratchets); an ABSENT floor mode is left untouched so it
  // never spuriously forces enforced when the user set no floor.
  if (floorPolicy.mode != null) {
    const floorMode = canonicalizeMode(floorPolicy.mode);
    const currentRank = MODE_RANK.get(config.policy.mode);
    const floorRank = MODE_RANK.get(floorMode);
    if (currentRank < floorRank) config.policy.mode = floorMode;
  }

  for (const key of ["allowSkip", "allowAdvisoryHosts"]) {
    if (floorPolicy[key] === false) config.policy[key] = false;
  }

  for (const key of ["onReviewerError", "onInternalError", "onBlockCap"]) {
    if (floorPolicy[key] === "block") config.policy[key] = "block";
  }

  if (floorPolicy.reviewScope === "all-code") {
    config.policy.reviewScope = "all-code";
  }

  // Privacy floors ratchet MONOTONICALLY over their ranked domains so a floor
  // at an intermediate level (e.g. block-external / prompt) is still enforced and
  // a project can never loosen below it.
  config.privacy.externalReview = ratchetRanked(
    EXTERNAL_REVIEW_RANK,
    floor.privacy?.externalReview,
    config.privacy.externalReview
  );
  config.privacy.secretScan = ratchetRanked(
    SECRET_SCAN_RANK,
    floor.privacy?.secretScan,
    config.privacy.secretScan
  );

  return config;
}

/**
 * Produce the final resolved config by merging project config on top of
 * DEFAULT_CONFIG and then enforcing the user's policy floor.
 *
 * @param {object} [projectConfig={}]    - raw config loaded from project
 * @param {object} [userPolicyFloor={}]  - user-level floor settings
 * @returns {object} resolved config
 */
export function mergeConfig(projectConfig = {}, userPolicyFloor = {}) {
  const merged = structuredClone(DEFAULT_CONFIG);
  deepAssign(merged, sanitizeProjectConfig(projectConfig));
  return applyPolicyFloor(merged, userPolicyFloor);
}
