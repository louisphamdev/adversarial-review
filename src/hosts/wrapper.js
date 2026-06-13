// Wrapper host integration module.
//
// Wrapper-enforced hosts cannot install native hooks; enforcement depends on
// the user invoking the tool via an `adversarial-review run` wrapper command.
// This module returns printable instructions (no file writes) that the
// installer presents to the user.

/**
 * Return the wrapper invocation string and residual-risk note for a host.
 *
 * No file writes occur — wrapper hosts require the user to change their own
 * launch command.  The returned object is printable by the installer.
 *
 * @param {object} options
 * @param {string} options.host        - host id (e.g. "codex", "opencode")
 * @param {string} [options.reviewer]  - reviewer id (may be "none")
 * @param {string} [options.binPath]   - resolved path to adversarial-review binary
 * @returns {{ host: string, wrapperCommand: string, enforcement: string, residualRisk: string }}
 */
export function wrapperInstructions({ host, reviewer, binPath }) {
  const bin = binPath || "npx adversarial-review";
  const reviewerNote = reviewer && reviewer !== "none" ? ` (reviewer: ${reviewer})` : "";

  // Build a representative wrapper command.  The user substitutes their actual
  // subcommand in place of the placeholder.
  const wrapperCommand = `${bin} run --host ${host} -- ${host} <your-command>`;

  return {
    host,
    wrapperCommand,
    enforcement: "wrapper-enforced",
    residualRisk:
      `Wrapper enforcement depends on the user always invoking ${host} through ` +
      `adversarial-review run. Bypassing the wrapper skips the review gate entirely. ` +
      `Native enforcement is not available for this host${reviewerNote}.`,
  };
}
