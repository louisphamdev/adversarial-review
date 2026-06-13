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

/**
 * Apply a user-level policy floor to a fully-merged config object so that
 * a project config can never loosen what the user has set as a minimum.
 *
 * Floor rules (all one-directional — can only tighten, never loosen):
 *  - mode: ratchets to whichever rank is higher
 *  - allowSkip / allowAdvisoryHosts: floor=false forces false
 *  - onReviewerError / onInternalError / onBlockCap: floor="block" forces "block"
 *  - reviewScope: floor="all-code" forces "all-code"
 *  - privacy.externalReview: floor="deny" forces "deny"
 *  - privacy.secretScan: floor="block-all" forces "block-all"
 *
 * @param {object} config  - already deep-cloned merged config (mutated in place)
 * @param {object} floor   - user policy floor (may have .policy sub-object or be flat)
 * @returns {object} config
 */
export function applyPolicyFloor(config, floor = {}) {
  const floorPolicy = floor.policy || floor;

  if (floorPolicy.mode && MODE_RANK.has(floorPolicy.mode)) {
    const currentRank = MODE_RANK.get(config.policy.mode) ?? 1;
    const floorRank = MODE_RANK.get(floorPolicy.mode);
    if (currentRank < floorRank) config.policy.mode = floorPolicy.mode;
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

  if (floor.privacy?.externalReview === "deny") {
    config.privacy.externalReview = "deny";
  }
  if (floor.privacy?.secretScan === "block-all") {
    config.privacy.secretScan = "block-all";
  }

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
