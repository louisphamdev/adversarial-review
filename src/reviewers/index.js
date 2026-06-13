// Reviewer adapter registry.
//
// Provides createReviewer() to get a named adapter and makeReviewerRunner() to
// produce an async function matching the gate's reviewerRunner(job) contract:
//
//   ok:false, error  -> operational failure (binary missing, timeout, bad output)
//   ok:true, verdict -> a parsed verdict (verdict.verdict may be "pass" or "fail")
//
// The gate is responsible for applying policy to the verdict. A "fail" verdict
// returned as ok:true is NOT an operational failure; the gate blocks with findings.

import { createAdapter as createCodexAdapter } from "./codex.js";
import { createAdapter as createOpencodeAdapter } from "./opencode.js";
import { createAdapter as createCustomAdapter } from "./custom.js";

// ---------------------------------------------------------------------------
// Adapter contract documentation (for callers)
// ---------------------------------------------------------------------------

/**
 * The adapter contract returned by each createAdapter() function:
 *
 * @typedef {object} ReviewerAdapter
 * @property {string}   id               - reviewer identifier
 * @property {Function} verify(env)      - check binary availability & version
 * @property {Function} run(job, io)     - run a review job; return gate result
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Return a reviewer adapter for `reviewerId`.
 *
 * Built-in reviewers: "codex", "opencode".
 * Custom reviewers: any id whose config has type:"custom".
 *
 * @param {string} reviewerId
 * @param {object} config  - full effective config
 * @returns {ReviewerAdapter}
 * @throws {Error} when the reviewerId is unknown and not custom
 */
export function createReviewer(reviewerId, config) {
  switch (reviewerId) {
    case "codex":
      return createCodexAdapter(config);
    case "opencode":
      return createOpencodeAdapter(config);
    default: {
      // Fall through to custom reviewer if the config declares it as custom.
      const reviewerConfig = config?.reviewers?.[reviewerId];
      if (reviewerConfig?.type === "custom") {
        return createCustomAdapter(config, reviewerId);
      }
      throw new Error(`Unknown reviewer: "${reviewerId}". Configure it as type:"custom" or use "codex"/"opencode".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Gate-compatible runner factory
// ---------------------------------------------------------------------------

/**
 * Return an async function matching the gate's reviewerRunner(job) contract.
 *
 * The runner:
 *  1. Creates the adapter for `reviewerId`.
 *  2. Verifies the binary lazily (on first call).
 *  3. Runs the review job.
 *  4. Returns { ok:false, error } on operational failure or { ok:true, verdict }
 *     on a successfully parsed verdict (pass OR fail — gate decides policy).
 *
 * @param {string} reviewerId
 * @param {object} config  - full effective config
 * @param {object} [env]   - environment variables for executable resolution
 * @returns {(job: object) => Promise<{ok:boolean, verdict?:object, error?:string}>}
 */
export function makeReviewerRunner(reviewerId, config, env) {
  const adapter = createReviewer(reviewerId, config);

  // Lazily resolved binary verification. We verify once and cache the result
  // so the first call pays the `--version` round-trip cost.
  let verifyPromise = null;

  return async function reviewerRunner(job) {
    // Resolve environment: prefer the passed env, then the job's io.env, then
    // process.env.
    const effectiveEnv = env || process.env;

    // Verify the binary on first call.
    if (!verifyPromise) {
      verifyPromise = adapter.verify(effectiveEnv);
    }
    const verifyResult = await verifyPromise;
    if (!verifyResult.ok) {
      return { ok: false, error: `verify_failed:${verifyResult.reason}` };
    }

    // Reviewer Isolation Requirements: in enforced or strict-ci modes a reviewer
    // MUST prove it runs read-only and edits nothing. A reviewer that cannot
    // assert capabilities.readOnly === true && capabilities.noEdit === true must
    // not be used in those modes — fail closed before spawning the tool. In soft
    // mode the reviewer is allowed to run (capability not enforced).
    const mode = config?.policy?.mode;
    if (mode === "enforced" || mode === "strict-ci") {
      const caps = verifyResult.capabilities || {};
      if (!(caps.readOnly === true && caps.noEdit === true)) {
        return { ok: false, error: "reviewer_not_isolated" };
      }
    }

    // Run the review job. Any thrown exception is an operational failure.
    try {
      return await adapter.run(job, { env: effectiveEnv });
    } catch (err) {
      return { ok: false, error: `runner_threw:${err?.message || "error"}` };
    }
  };
}
