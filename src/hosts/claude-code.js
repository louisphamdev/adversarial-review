// Claude Code native host integration module.
//
// Returns the planned writes needed to enable the Claude Code SessionStart and
// Stop hooks. Exposes a planning function rather than writing files directly so
// the `install` command can operate in dry-run mode without touching the disk.
//
// Hook target: bin/adversarial-review.js hook --host claude-code --event <event>
//
// Claude Code hooks.json location (per-project): <cwd>/.claude/settings.json
// (hooks are embedded in the settings file as a "hooks" key) or a standalone
// <cwd>/.claude/hooks.json depending on the Claude Code version. We write the
// settings.json variant as that is the current standard and supported by
// Task 12; Task 12 will refine the exact template.

import path from "node:path";

/**
 * Build the hook configuration object for Claude Code.
 *
 * @param {object} options
 * @param {string} options.binPath  - absolute path to the adversarial-review binary
 * @returns {object}  hook config JSON object
 */
function buildHookConfig(binPath) {
  const bin = binPath || "npx adversarial-review";
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${bin} hook --host claude-code --event session-start`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `${bin} hook --host claude-code --event stop`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Return the list of planned writes to enable the Claude Code native hooks.
 *
 * Each entry describes a file that the installer would write:
 *   { path: <absolute path>, content: <JSON string>, note: <human note> }
 *
 * This function never writes anything — it is intentionally pure so callers
 * (including dry-run mode) can inspect planned writes before committing.
 *
 * @param {object} options
 * @param {string} options.cwd      - project root (where .claude/ lives)
 * @param {string} [options.binPath] - resolved path to adversarial-review binary
 * @returns {Array<{path: string, content: string, note: string}>}
 */
export function plannedClaudeCodeWrites({ cwd, binPath }) {
  const hookConfig = buildHookConfig(binPath);
  const settingsPath = path.join(cwd, ".claude", "settings.json");

  return [
    {
      path: settingsPath,
      content: JSON.stringify(hookConfig, null, 2),
      note: "Claude Code native hooks (SessionStart + Stop) — native-enforced",
    },
  ];
}
