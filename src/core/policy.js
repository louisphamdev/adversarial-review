// Policy helper functions — derive boolean/string decisions from a resolved config.
// All functions are pure (no side effects, no state).

/**
 * Returns true when the effective policy mode is "strict-ci".
 *
 * @param {object} config - resolved config (from mergeConfig)
 * @returns {boolean}
 */
export function isStrict(config) {
  return config.policy.mode === "strict-ci";
}

/**
 * Returns true when every code change must be reviewed regardless of size.
 * True for "all-code" reviewScope or when mode is "strict-ci".
 *
 * @param {object} config
 * @returns {boolean}
 */
export function requiresReviewForCode(config) {
  return config.policy.reviewScope === "all-code" || isStrict(config);
}

/**
 * Returns the action to take when a reviewer call fails.
 * In "soft" mode the configured value (or "self-review") is returned.
 * In all other modes the configured value (or "block") is returned.
 *
 * @param {object} config
 * @returns {string}
 */
export function reviewerErrorAction(config) {
  if (config.policy.mode === "soft") return config.policy.onReviewerError || "self-review";
  return config.policy.onReviewerError || "block";
}

/**
 * Returns the action to take when an internal (tool-level) error occurs.
 * When there is no evidence of a significant change the gate should never
 * block — the change either hasn't happened or is trivial.
 * In "soft" mode the configured value (or "allow") is returned.
 * In all other modes the configured value (or "block") is returned.
 *
 * @param {object} config
 * @param {boolean} evidenceOfSignificantChange
 * @returns {string}
 */
export function internalErrorAction(config, evidenceOfSignificantChange) {
  if (!evidenceOfSignificantChange) return "allow";
  if (config.policy.mode === "soft") return config.policy.onInternalError || "allow";
  return config.policy.onInternalError || "block";
}

/**
 * Returns the action to take when consecutive block count reaches the cap.
 * In "soft" mode the configured value (or "allow") is returned.
 * In all other modes the configured value (or "block") is returned.
 *
 * @param {object} config
 * @returns {string}
 */
export function blockCapAction(config) {
  if (config.policy.mode === "soft") return config.policy.onBlockCap || "allow";
  return config.policy.onBlockCap || "block";
}

/**
 * Returns true when the current config permits a review to be skipped.
 * Skip is never allowed in "strict-ci" mode, regardless of allowSkip setting.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function skipAllowed(config) {
  return config.policy.mode !== "strict-ci" && config.policy.allowSkip === true;
}
