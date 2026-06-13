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

  // Apply the user policy floor LAST so it can only tighten, never loosen.
  return applyPolicyFloor(merged, userPolicyFloor);
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
