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

// Canonical invocation tail that EVERY adversarial-review hook command ends
// with: `... hook --host claude-code --event <event>`. Hook ownership is a
// SECURITY decision (doctor's health verdict + uninstall's "remove only our
// hooks" guarantee), so it MUST be matched on the exact canonical token
// sequence — never a loose substring. A loose `cmd.includes("--event stop")`
// is spoofable (e.g. `true # adversarial-review --event stop` neuters the gate
// while still matching) AND collides with distinct user hooks (`--event stop`
// is a substring of `--event stop-done`).
//
// We accept the leaf as OURS only when, after collapsing internal whitespace,
// the command ENDS WITH the exact canonical tail for the event AND the bin
// portion preceding it carries the package marker as a real path token (not as
// a comment). This anchors on structure we write, so a re-install dedupes its
// own prior entry while a neutered/decorated command (leading `true #`, `;`,
// `&&`, `|`, backticks before the invocation) fails the match.

/** Collapse runs of whitespace to single spaces and trim ends. */
function normalizeCommand(cmd) {
  return String(cmd).replace(/\s+/g, " ").trim();
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shell metacharacters that would let an attacker wrap/neuter our invocation
// while keeping the canonical tail intact (e.g. `true # <bin> ... --event stop`
// or `<bin> ... --event stop; rm -rf /`). Any of these in the UNQUOTED part of a
// leaf command disqualifies it from being treated as OURS. (Metachars that occur
// only INSIDE the double-quoted bin token — e.g. `C:\Program Files (x86)\...` —
// are inert to the shell and are explicitly allowed; see isOurBinPrefix.)
const SHELL_META_RE = /[#;&|`$(){}<>]|&&|\|\|/;

/**
 * Shell-quote a bin invocation for embedding in a `type: command` hook string.
 *
 * FINDING 1 (fail-open): an unquoted bin path containing a space (extremely
 * common on Windows, e.g. `C:\Users\John Doe\...`) is split by the shell at the
 * space — the first fragment is run as the executable, fails, no block JSON is
 * emitted, and Claude Code ALLOWS the change: a silent gate bypass. We therefore
 * double-quote any bin that contains a space or a shell metacharacter, escaping
 * embedded double-quotes. A clean, special-char-free bin (the common
 * `adversarial-review-gate` / `npx adversarial-review-gate` forms) is left
 * unquoted so the emitted command stays human-readable and the existing canonical
 * forms are unchanged.
 *
 * The quoting is the SAME shape isOurHookLeaf recognizes, so a command this
 * produces always round-trips through ownership detection (FINDING 2: re-install
 * dedupes its own prior entry even when the bin path carries `(`/`)`/space).
 *
 * @param {string} bin
 * @returns {string}
 */
function quoteBin(bin) {
  // Already needs no quoting: no whitespace and no shell metacharacters.
  if (!/\s/.test(bin) && !SHELL_META_RE.test(bin)) return bin;
  return `"${bin.replace(/"/g, '\\"')}"`;
}

/**
 * Build the canonical hook command string for an event:
 * `<bin> hook --host claude-code --event <event>` with `<bin>` shell-quoted via
 * quoteBin(). Single source of truth so buildHookConfig() and isOurHookLeaf()
 * cannot drift (the command we WRITE must always be one we RECOGNIZE).
 *
 * @param {string} bin   - resolved gate invocation
 * @param {string} event - "session-start" | "stop"
 * @returns {string}
 */
function buildHookCommand(bin, event) {
  return `${quoteBin(bin)} hook --host claude-code --event ${event}`;
}

// A fully double-quoted bin token: an opening quote, a run of non-quote chars or
// backslash-escaped quotes, and a closing quote — nothing else. This is exactly
// the shape quoteBin() emits, so metachars that appear ONLY inside it (a literal
// `(x86)` in a path) are inert to the shell yet still recognized as ours.
const QUOTED_BIN_RE = /^"(?:[^"\\]|\\.)*"$/;

/**
 * Whether the portion of a command preceding the canonical tail is one of OUR
 * bin invocations — and NOT an attacker wrapper. Two accepted shapes:
 *   (a) a single fully double-quoted token (`"C:\Program Files (x86)\...\ar.js"`),
 *       which neutralizes any interior metachar, OR
 *   (b) a bare, metachar-FREE invocation (`adversarial-review-gate`,
 *       `npx adversarial-review-gate`).
 * In both shapes the prefix MUST carry the package marker. A wrapper such as
 * `true # adversarial-review` or `foo; bar` fails both shapes (it is neither a
 * lone quoted token nor metachar-free), so the gate cannot be neutered while
 * still matching.
 *
 * @param {string} prefix - normalized command text before ` <tail>` (trimmed)
 * @returns {boolean}
 */
function isOurBinPrefix(prefix) {
  if (!prefix) return false; // `cmd === tail` (no bin) is not one of ours
  if (QUOTED_BIN_RE.test(prefix)) {
    // Quoted token: the marker must appear inside the quotes (interior metachars
    // are inert). Strip the surrounding quotes and unescape for the marker check.
    const inner = prefix.slice(1, -1).replace(/\\"/g, '"');
    return inner.includes(AR_HOOK_MARKER);
  }
  // Unquoted shape: must be metachar-free AND carry the marker.
  if (SHELL_META_RE.test(prefix)) return false;
  return prefix.includes(AR_HOOK_MARKER);
}

/**
 * Whether a single hook leaf object is one of OUR adversarial-review hooks for
 * the given event ("session-start" | "stop").
 *
 * STRICT canonical match (security-critical — used by doctor's registration
 * verdict, install dedupe, AND uninstall removal). A leaf is ours only when its
 * whitespace-normalized command:
 *   1. ENDS WITH the exact canonical tail `hook --host claude-code --event <event>`
 *      as a whole-token suffix, and
 *   2. the bin prefix before that tail passes isOurBinPrefix (a single quoted
 *      token OR a metachar-free invocation, carrying the package marker).
 *
 * This rejects a spoofed `true # adversarial-review --event stop`, refuses to
 * treat `--event stop` as covering `--event stop-done`, still matches every
 * command buildHookCommand() emits (so re-install stays idempotent even when the
 * bin path contains spaces or `(x86)`-style metachars — FINDINGS 1 & 2).
 *
 * @param {object} leaf  - { type, command, ... }
 * @param {string} event - "session-start" | "stop"
 * @returns {boolean}
 */
function isOurHookLeaf(leaf, event) {
  if (!leaf || typeof leaf.command !== "string") return false;
  const cmd = normalizeCommand(leaf.command);
  const tail = `hook --host claude-code --event ${event}`;
  if (cmd !== tail && !cmd.endsWith(` ${tail}`)) return false;
  // The portion before the canonical tail is the bin invocation and MUST be one
  // of our recognized shapes (quoted token or metachar-free), marker-bearing.
  const prefix = cmd.slice(0, cmd.length - tail.length).trim();
  return isOurBinPrefix(prefix);
}

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
              command: buildHookCommand(bin, "session-start"),
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
              command: buildHookCommand(bin, "stop"),
              statusMessage: "Adversarial review gate",
              timeout: 300,
            },
          ],
        },
      ],
    },
  };
}

// The legacy Python plugin invoked a script whose FILENAME is exactly `guard.py`
// (e.g. `python ${CLAUDE_PLUGIN_ROOT}/hooks/guard.py` or `python guard.py
// --event stop`). We match that basename at a path/word boundary so an unrelated
// user script with a DIFFERENT filename that merely ends in the same substring
// (`my-guard.py`, `safeguard.py`) is NOT mistaken for ours. The boundary before
// the basename is start-of-string, whitespace, or a path separator (`/` or `\`);
// the boundary after `.py` is end-of-string, whitespace, or any non-name char.
const LEGACY_GUARD_RE = new RegExp(
  `(?:^|[\\s/\\\\])${LEGACY_GUARD_MARKER.replace(/[.]/g, "\\$&")}(?![\\w.])`
);

/**
 * Whether a hook leaf is a legacy Python-era adversarial-review guard.py command
 * (to be stripped on migration).
 *
 * FINDING 3: a bare `command.includes("guard.py")` is over-broad — it strips ANY
 * user hook whose command merely contains the substring `guard.py` (an unrelated
 * `my-guard.py` lint script, `safeguard.py`, a comment), silently deleting user
 * configuration. We instead match `guard.py` as a whole PATH BASENAME (bounded by
 * a path separator / whitespace / start, and by a non-name char / end), which is
 * exactly how the legacy plugin's script was invoked while still excluding the
 * `*-guard.py` family of unrelated user scripts.
 *
 * @param {object} leaf
 * @returns {boolean}
 */
function isLegacyGuardLeaf(leaf) {
  if (!leaf || typeof leaf.command !== "string") return false;
  return LEGACY_GUARD_RE.test(leaf.command);
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
 * Whether a leaf command LOOKS LIKE an adversarial-review hook for `event`
 * (carries the package marker + an `--event <event>` reference) but FAILS the
 * strict canonical match — i.e. it is present-but-tampered/neutered (e.g.
 * `true # adversarial-review hook ... --event stop`). Used by `doctor` to warn
 * rather than silently report the gate as healthy.
 *
 * @param {object} leaf
 * @param {string} event - "session-start" | "stop"
 * @returns {boolean}
 */
function isTamperedHookLeaf(leaf, event) {
  if (!leaf || typeof leaf.command !== "string") return false;
  const cmd = normalizeCommand(leaf.command);
  // FINDING 4: `cmd.includes("--event stop")` also matches a DISTINCT user event
  // like `--event stop-done` (stop ⊂ stop-done), so doctor spuriously flagged an
  // unrelated third-party hook as our tampered Stop hook. Match the event as a
  // whole token (word boundary after the event name) so `stop` never covers
  // `stop-done`/`stop-report`.
  const eventTokenRe = new RegExp(`--event\\s+${escapeRegExp(event)}(?![\\w-])`);
  const looksLikeOurs = cmd.includes(AR_HOOK_MARKER) && eventTokenRe.test(cmd);
  return looksLikeOurs && !isOurHookLeaf(leaf, event);
}

/**
 * Detect present-but-non-canonical (tampered/neutered) adversarial-review hooks
 * in a settings object. A configured Stop/SessionStart leaf that carries our
 * marker but does NOT match the exact canonical command is a SECURITY signal:
 * the gate may have been disarmed while still appearing installed.
 *
 * @param {object} existing - parsed settings.json (or {})
 * @returns {{ sessionStart: boolean, stop: boolean }}
 */
export function detectTamperedClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const hooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const hasTampered = (event, key) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return groups.some(
      (group) =>
        group &&
        Array.isArray(group.hooks) &&
        group.hooks.some((leaf) => isTamperedHookLeaf(leaf, key))
    );
  };

  return {
    sessionStart: hasTampered("SessionStart", "session-start"),
    stop: hasTampered("Stop", "stop"),
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
