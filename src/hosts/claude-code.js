// Claude Code native host integration module.
//
// Returns the planned writes needed to enable the Claude Code SessionStart and
// Stop hooks. Exposes a planning function rather than writing files directly so
// the `install` command can operate in dry-run mode without touching the disk.
//
// Hook target: bin/adversarial-review.js hook --host claude-code --event <event>
//
// Claude Code hooks.json location (per-project): <cwd>/.claude/settings.json
// (hooks are embedded in the settings file as a "hooks" key). The installer
// must NOT clobber an existing settings.json (which may carry permissions, env,
// statusLine, mcpServers, other hooks). We therefore DEEP-MERGE our two hook
// entries into the existing object, preserving every other top-level key.

import path from "node:path";

// Marker substring every adversarial-review hook command carries. Used to
// detect (and strip / dedupe) our own entries idempotently.
const AR_HOOK_MARKER = "adversarial-review";

// Substring identifying a prior Python-era plugin hook command. When migrating
// a project we STRIP these so the project does not run both the old guard.py
// and our new native hook.
const LEGACY_GUARD_MARKER = "guard.py";

/**
 * Build the hook configuration object for Claude Code.
 *
 * Mirrors src/integrations/claude-code/hooks.json: the Stop hook gets a 300s
 * timeout (a real review easily exceeds Claude Code's ~60s default and would be
 * killed mid-flight), the SessionStart baseline hook gets 60s, and both carry a
 * statusMessage so the user sees what is running.
 *
 * @param {string} binPath  - command used to invoke the gate
 * @returns {object}  hook config JSON object ({ hooks: { SessionStart, Stop } })
 */
function buildHookConfig(binPath) {
  const bin = binPath || "npx adversarial-review-gate";
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${bin} hook --host claude-code --event session-start`,
              statusMessage: "Adversarial review baseline",
              timeout: 60,
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
              statusMessage: "Adversarial review gate",
              timeout: 300,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Whether a single hook leaf object is one of OUR adversarial-review hooks for
 * the given event ("session-start" | "stop"). Matches on the command string
 * carrying both the package marker and the matching --event flag.
 *
 * @param {object} leaf  - { type, command, ... }
 * @param {string} event - "session-start" | "stop"
 * @returns {boolean}
 */
function isOurHookLeaf(leaf, event) {
  if (!leaf || typeof leaf.command !== "string") return false;
  const cmd = leaf.command;
  return cmd.includes(AR_HOOK_MARKER) && cmd.includes(`--event ${event}`);
}

/** Whether a hook leaf is a legacy Python guard.py command (to be stripped). */
function isLegacyGuardLeaf(leaf) {
  return Boolean(
    leaf && typeof leaf.command === "string" && leaf.command.includes(LEGACY_GUARD_MARKER)
  );
}

/**
 * Filter a Claude Code hook-group array for one event, removing any leaf that is
 * either (a) a prior adversarial-review entry for this event (so re-install is
 * idempotent — no duplicates) or (b) a legacy guard.py entry (so a migrated
 * project never runs both). Empty groups are dropped.
 *
 * @param {Array} groups - existing hook groups for a single event
 * @param {string} event - "session-start" | "stop"
 * @returns {Array}      - cleaned groups (new array; never mutates input)
 */
function stripOurAndLegacy(groups, event) {
  if (!Array.isArray(groups)) return [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const leaves = Array.isArray(group.hooks) ? group.hooks : [];
    const keptLeaves = leaves.filter(
      (leaf) => !isOurHookLeaf(leaf, event) && !isLegacyGuardLeaf(leaf)
    );
    // Drop a group that became empty after stripping; otherwise keep it with the
    // surviving leaves (preserving any matcher/other keys on the group object).
    if (keptLeaves.length > 0) {
      cleaned.push({ ...group, hooks: keptLeaves });
    } else if (!leaves.length && Object.keys(group).length) {
      // A group with no hooks array but other keys — preserve as-is.
      cleaned.push(group);
    }
  }
  return cleaned;
}

/**
 * Deep-merge our Claude Code hooks into an existing settings.json object.
 *
 * Preserves EVERY existing top-level key (permissions, env, statusLine,
 * mcpServers, unrelated hooks, ...). Within hooks.SessionStart / hooks.Stop it
 * APPENDS our hook group only after stripping any prior adversarial-review entry
 * for the same event (idempotent) and any legacy guard.py entry (migration).
 *
 * Never mutates the input object.
 *
 * @param {object} existing  - parsed existing settings.json (or {})
 * @param {string} binPath   - command used to invoke the gate
 * @returns {object}         - merged settings object to write
 */
export function mergeClaudeCodeSettings(existing, binPath) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const ourConfig = buildHookConfig(binPath);

  // Shallow-clone the top level so unrelated keys are preserved untouched.
  const merged = { ...base };

  const existingHooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};
  const mergedHooks = { ...existingHooks };

  for (const event of ["SessionStart", "Stop"]) {
    const eventKey = event === "SessionStart" ? "session-start" : "stop";
    const cleaned = stripOurAndLegacy(existingHooks[event], eventKey);
    // Append our freshly-built group for this event.
    mergedHooks[event] = [...cleaned, ...ourConfig.hooks[event]];
  }

  merged.hooks = mergedHooks;
  return merged;
}

/**
 * Remove ONLY our adversarial-review hook entries (both events) from an existing
 * settings object. Used by the `uninstall` command. Preserves every other
 * top-level key and any non-AR hooks. Idempotent (no-op when none present).
 *
 * @param {object} existing - parsed existing settings.json (or {})
 * @returns {object}        - settings object with our hooks removed
 */
export function removeClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const merged = { ...base };

  const existingHooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : null;
  if (!existingHooks) return merged;

  const mergedHooks = { ...existingHooks };
  for (const event of ["SessionStart", "Stop"]) {
    const eventKey = event === "SessionStart" ? "session-start" : "stop";
    // Strip our entries but DO NOT strip legacy guard.py here — uninstall removes
    // only what WE installed.
    const groups = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
    const cleaned = [];
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const leaves = Array.isArray(group.hooks) ? group.hooks : [];
      const keptLeaves = leaves.filter((leaf) => !isOurHookLeaf(leaf, eventKey));
      if (keptLeaves.length > 0) {
        cleaned.push({ ...group, hooks: keptLeaves });
      } else if (!leaves.length && Object.keys(group).length) {
        cleaned.push(group);
      }
    }
    if (cleaned.length > 0) {
      mergedHooks[event] = cleaned;
    } else {
      delete mergedHooks[event];
    }
  }

  if (Object.keys(mergedHooks).length > 0) {
    merged.hooks = mergedHooks;
  } else {
    delete merged.hooks;
  }
  return merged;
}

/**
 * Whether our SessionStart + Stop hooks are BOTH present in a settings object.
 * Used by `doctor` to report registration status.
 *
 * @param {object} existing - parsed settings.json (or {})
 * @returns {{ sessionStart: boolean, stop: boolean }}
 */
export function detectClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const hooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const hasEvent = (event, key) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return groups.some(
      (group) =>
        group &&
        Array.isArray(group.hooks) &&
        group.hooks.some((leaf) => isOurHookLeaf(leaf, key))
    );
  };

  return {
    sessionStart: hasEvent("SessionStart", "session-start"),
    stop: hasEvent("Stop", "stop"),
  };
}

/**
 * Resolve the Claude Code settings.json path for a given base directory.
 *
 * @param {string} baseDir - project root (project scope) or home (user scope)
 * @returns {string}
 */
export function claudeCodeSettingsPath(baseDir) {
  return path.join(baseDir, ".claude", "settings.json");
}

/**
 * Return the list of planned writes to enable the Claude Code native hooks.
 *
 * This DEEP-MERGES our two hook entries into the existing settings.json object
 * (passed in by the caller, which owns IO) so unrelated keys are preserved and
 * re-install is idempotent. The function never writes anything — it is pure so
 * callers (including dry-run) can inspect planned writes first.
 *
 * @param {object} options
 * @param {string} options.baseDir          - base dir whose .claude/ we target
 *                                             (cwd for project, home for user)
 * @param {string} [options.binPath]         - resolved gate command
 * @param {object} [options.existingSettings] - parsed existing settings.json ({})
 * @returns {Array<{path: string, content: string, note: string}>}
 */
export function plannedClaudeCodeWrites({ baseDir, binPath, existingSettings = {} }) {
  const merged = mergeClaudeCodeSettings(existingSettings, binPath);
  const settingsPath = claudeCodeSettingsPath(baseDir);

  return [
    {
      path: settingsPath,
      content: JSON.stringify(merged, null, 2),
      note: "Claude Code native hooks (SessionStart + Stop) — merged into settings.json",
    },
  ];
}
