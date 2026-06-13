// Host -> reviewer mapping for the CLI entrypoints.
//
// The gate routes review work based on `host.reviewerMapping`:
//   - "none"  -> native self-review (the host's own agent runs the bundled
//                self-review orchestrator; no external reviewer process);
//   - <id>    -> an external reviewer adapter (codex/opencode/custom) is spawned.
//
// Claude Code enforces natively via its Stop hook, so it always uses native
// self-review ("none"). Wrapper hosts (codex/opencode/...) map to an external
// reviewer; the project config's `hosts[<host>].reviewer` selects which one,
// defaulting to the host id itself when it names a known reviewer.

import { makeReviewerRunner } from "../reviewers/index.js";

const NATIVE_HOSTS = new Set(["claude-code"]);
const KNOWN_REVIEWERS = new Set(["codex", "opencode"]);

/**
 * Resolve the reviewer mapping for a host given the effective config.
 *
 * @param {string} host
 * @param {object} config
 * @returns {string} reviewer id, or "none" for native self-review
 */
export function reviewerMappingFor(host, config) {
  // Explicit per-host config wins for every host, including native ones. This
  // lets a native host (e.g. claude-code) opt into an external reviewer such as
  // "opencode", or explicitly request native self-review with "none".
  const configured = config?.hosts?.[host]?.reviewer;
  if (typeof configured === "string" && configured.length) return configured;

  // No explicit config: native hosts default to native self-review.
  if (NATIVE_HOSTS.has(host)) return "none";

  // A host id that itself names a known/custom reviewer maps to that reviewer.
  if (KNOWN_REVIEWERS.has(host)) return host;
  if (config?.reviewers?.[host]?.type === "custom") return host;

  // Nothing mapped: native self-review.
  return "none";
}

/**
 * Build the `host` descriptor + (optional) reviewerRunner the gate expects.
 *
 * @param {string} host
 * @param {object} config
 * @param {object} env
 * @returns {{ hostDescriptor: object, reviewerRunner: Function|null }}
 */
export function buildHostRouting(host, config, env) {
  const reviewerMapping = reviewerMappingFor(host, config);
  const hostDescriptor = { id: host, reviewerMapping };
  let reviewerRunner = null;
  if (reviewerMapping !== "none") {
    reviewerRunner = makeReviewerRunner(reviewerMapping, config, env);
  }
  return { hostDescriptor, reviewerRunner };
}
