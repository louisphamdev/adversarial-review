// Config + state-dir loading for the CLI entrypoints.
//
// This module centralizes how the `check`, `hook`, and `run` commands resolve
// their effective config and where they keep per-session state.
//
// HARDENING #1 (Task 8 review): the gate's review-pass cache lives in session
// state. A pre-seeded cache entry would yield an UNREVIEWED pass. Therefore the
// state directory MUST live at a USER-LEVEL path (under the user's home dir),
// never a repo-relative path that an untrusted project could pre-write. The
// default is `~/.adversarial-review/state`. A test-only override is available
// via the ADVERSARIAL_REVIEW_STATE_DIR env var, but the DEFAULT is always
// user-level and never under `cwd`.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, sanitizeProjectConfig, deepAssign, applyPolicyFloor } from "./config.js";

const PROJECT_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_POLICY_REL = path.join(".adversarial-review", "policy.json");

/**
 * Tolerantly read+parse a JSON file. Missing file -> `{}` (no warning). Corrupt
 * JSON -> `{}` plus a warning written to `stderr` (when provided). Never throws.
 *
 * @param {string} file
 * @param {object} [io]  - { stderr }
 * @param {string} [label]
 * @returns {Promise<object>}
 */
async function readJsonTolerant(file, io, label) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {}; // Missing/unreadable: treat as empty config.
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (err) {
    if (io?.stderr) {
      io.stderr.write(
        `adversarial-review: ignoring corrupt ${label || "config"} at ${file}: ${err.message}\n`
      );
    }
    return {};
  }
}

/**
 * Load the effective config for a workspace.
 *
 * Merge precedence (lowest to highest):
 *   DEFAULT_CONFIG < userConfig < projectConfig
 * where:
 *   - userConfig    comes from `<home>/.adversarial-review/config.json` and acts
 *     as machine-wide host/reviewer DEFAULTS (e.g. so "claude-code+codex use
 *     opencode" applies machine-wide without a per-project config);
 *   - projectConfig comes from `<cwd>/.adversarial-review/config.json` and
 *     overrides the user defaults for any key it sets.
 * The user policy floor (`<home>/.adversarial-review/policy.json`) is then applied
 * ON TOP via applyPolicyFloor, so it can only RATCHET STRICTER — neither the user
 * config nor the project config can loosen it.
 *
 * All three files are tolerant (missing -> {}, corrupt -> {} + warning).
 *
 * @param {string} cwd
 * @param {object} [io]  - { stderr, env }
 * @returns {Promise<object>} resolved config
 */
export async function loadEffectiveConfig(cwd, io = {}) {
  const home = resolveHomeDir(io.env);
  const userConfig = await readJsonTolerant(
    path.join(home, USER_CONFIG_REL),
    io,
    "user config"
  );
  const projectConfig = await readJsonTolerant(
    path.join(cwd, PROJECT_CONFIG_REL),
    io,
    "project config"
  );
  const userPolicyFloor = await readJsonTolerant(
    path.join(home, USER_POLICY_REL),
    io,
    "user policy"
  );

  // Layer lowest-to-highest: DEFAULT_CONFIG < userConfig < projectConfig.
  // Both raw layers are sanitized (unknown top-level keys stripped) and merged
  // via deepAssign, which also blocks prototype-pollution keys.
  const merged = structuredClone(DEFAULT_CONFIG);
  deepAssign(merged, sanitizeProjectConfig(userConfig));
  deepAssign(merged, sanitizeProjectConfig(projectConfig));

  // Reviewer trust floor: a PROJECT layer can never grant a reviewer trust nor
  // supply the command/args/type of a custom reviewer. Those must come from
  // USER-level config only (the threat model treats the repo's project config as
  // untrusted). Applied AFTER the merge so it strips anything a project injected.
  applyReviewerTrustFloor(merged, userConfig);

  // Apply the user policy floor LAST so it can only tighten, never loosen.
  return applyPolicyFloor(merged, userPolicyFloor);
}

/**
 * Enforce the reviewer trust floor on a fully-merged config using the RAW user
 * config as the sole source of truth for trust and custom-reviewer definitions.
 *
 * Rules (all fail-closed; a project layer can only LOSE privileges here):
 *  - For every reviewer id: if merged.reviewers[id].trusted === true but the user
 *    config did NOT set trusted === true for that id, force trusted = false. A
 *    project config can never grant trust.
 *  - For any reviewer that is custom (merged type OR user-declared type is
 *    "custom"): take `type`, `command`, and `args` ONLY from the user config for
 *    that id, dropping any project-supplied values. If the user config did not
 *    define this custom reviewer, the result has no command and is rejected at
 *    runtime (fail closed).
 *  - opencode's `readOnlyConfig` is intentionally NOT touched here: opencode
 *    isolation is bound to the bundled read-only agent in enforced/strict, so a
 *    project-set readOnlyConfig is safe.
 *
 * Tolerant of missing/non-object reviewer maps and entries.
 *
 * @param {object} merged      - fully-merged effective config (mutated in place)
 * @param {object} userConfig  - raw user-level config (trusted source)
 * @returns {object} merged
 */
function applyReviewerTrustFloor(merged, userConfig) {
  const reviewers = merged.reviewers;
  if (!reviewers || typeof reviewers !== "object" || Array.isArray(reviewers)) {
    return merged;
  }
  const userReviewers =
    userConfig && typeof userConfig.reviewers === "object" && !Array.isArray(userConfig.reviewers)
      ? userConfig.reviewers
      : {};

  for (const id of Object.keys(reviewers)) {
    const entry = reviewers[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const userEntry =
      userReviewers[id] && typeof userReviewers[id] === "object" && !Array.isArray(userReviewers[id])
        ? userReviewers[id]
        : null;

    // Trust floor: only the user config can grant trust.
    if (entry.trusted === true && userEntry?.trusted !== true) {
      entry.trusted = false;
    }

    // Custom-reviewer floor: command/args/type come from the user config only.
    const isCustom = entry.type === "custom" || userEntry?.type === "custom";
    if (isCustom) {
      if (userEntry && userEntry.type === "custom") {
        // Take the type/command/args from the trusted user config, dropping any
        // project-supplied values.
        entry.type = "custom";
        if ("command" in userEntry) {
          entry.command = userEntry.command;
        } else {
          delete entry.command;
        }
        if ("args" in userEntry) {
          entry.args = structuredClone(userEntry.args);
        } else {
          delete entry.args;
        }
      } else {
        // The user config did not define this custom reviewer. Strip any
        // project-supplied command/args so it fails closed (no command -> rejected
        // at runtime). Keep type so the custom adapter still recognizes the entry
        // and refuses it via the missing-command / untrusted checks.
        delete entry.command;
        delete entry.args;
      }
    }
  }
  return merged;
}

/**
 * Resolve the user-level state directory.
 *
 * DEFAULT: `<home>/.adversarial-review/state` — always OUTSIDE any `cwd`, where
 * `<home>` is the resolved user home (see homeDir, honoring ADVERSARIAL_REVIEW_HOME).
 * Override: the ADVERSARIAL_REVIEW_STATE_DIR env var (tests only) takes priority
 * over the home-based default. The default path is never repo-relative, so a
 * project can never pre-seed the pass cache.
 *
 * @param {object} [env=process.env]
 * @returns {string} absolute state dir path
 */
export function resolveStateDir(env = process.env) {
  const override = env && env.ADVERSARIAL_REVIEW_STATE_DIR;
  if (override) return path.resolve(override);
  return path.join(resolveHomeDir(env), ".adversarial-review", "state");
}

/**
 * Resolve the user's home directory, honoring an injected env so tests can
 * redirect the user-level base (config.json, policy.json, state dir, install
 * registry, opencode agent) without touching the real home dir.
 *
 * This is the SINGLE shared resolver imported by install.js and doctor.js so
 * the installer/doctor write/read the SAME user-level base the gate later uses.
 * Priority:
 *   1. ADVERSARIAL_REVIEW_HOME — dedicated override for the user-level base;
 *   2. HOME / USERPROFILE — standard OS home env vars;
 *   3. os.homedir() — the real home dir.
 *
 * @param {object} [env]  - environment variables
 * @returns {string} absolute home dir path
 */
export function resolveHomeDir(env) {
  if (env) {
    const fromEnv = env.ADVERSARIAL_REVIEW_HOME || env.HOME || env.USERPROFILE;
    if (fromEnv) return fromEnv;
  }
  return os.homedir();
}
