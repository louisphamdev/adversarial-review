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
import { getEnvCaseInsensitive } from "./process.js";

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

  // TRUSTED BASELINE — the security posture the USER intends. DEFAULT_CONFIG
  // (fail-closed) layered with the USER-level config, then the user policy floor
  // applied. The user layer is trusted (machine-wide, set by the operator) and
  // MAY loosen the defaults. applyPolicyFloor also coerces any malformed
  // sub-object and canonicalizes the mode here, so the baseline is always a
  // valid, fail-closed shape. Both raw layers are sanitized (unknown top-level
  // keys stripped) and merged via deepAssign, which blocks prototype-pollution.
  const baseline = structuredClone(DEFAULT_CONFIG);
  deepAssign(baseline, sanitizeProjectConfig(userConfig));
  applyPolicyFloor(baseline, userPolicyFloor);

  // EFFECTIVE — the UNTRUSTED project config (a cloned repo's committed
  // <cwd>/.adversarial-review/config.json) layered ON TOP of the trusted
  // baseline. The threat model treats this layer as attacker-controlled.
  const merged = structuredClone(baseline);
  deepAssign(merged, sanitizeProjectConfig(projectConfig));

  // Reviewer trust floor: a PROJECT layer can never grant a reviewer trust, the
  // command/args/type of a custom reviewer, nor the model list / required
  // dimensions / timeout of ANY reviewer. Those come from USER-level config
  // only. Applied AFTER the merge so it strips anything a project injected.
  applyReviewerTrustFloor(merged, userConfig);

  // SECURITY CLAMP: a project may only TIGHTEN security policy, never loosen it.
  // Re-applying the TRUSTED BASELINE as a policy floor ratchets mode /
  // onReviewerError / onInternalError / onBlockCap / allowSkip /
  // allowAdvisoryHosts / reviewScope / privacy back up to (at least) what the
  // user/default intend — so a project config can never downgrade enforcement
  // (e.g. enforced -> soft, block -> allow, all-code -> docs-only). It also
  // re-coerces any malformed project sub-object and re-canonicalizes the mode,
  // neutralizing scalar/null injection attacks. Non-security project overrides
  // (reviewer choice, thresholds, sensitivity) are left intact by the floor.
  applyPolicyFloor(merged, baseline);

  // The host -> reviewer mapping decides WHO reviews; an untrusted project must
  // not be able to redirect or downgrade it (there is no per-field floor for
  // it). Pin the entire hosts map to the trusted baseline.
  merged.hosts = structuredClone(baseline.hosts);

  // Pin the runtime block to the trusted baseline. `runtime.baselineRef` decides
  // WHAT the diff is compared against — a project that set it to a no-op ref
  // could produce an empty diff and BYPASS the gate; `runtime.timeoutSec` /
  // `blockCap` are security timers a project could DoS. None are project-tunable.
  merged.runtime = structuredClone(baseline.runtime);

  // The temp-file permission mode is a security setting (a loose mode leaks the
  // diff/brief to other local users); pin it so a project cannot relax it.
  merged.privacy.tempFileMode = baseline.privacy.tempFileMode;

  // Escalation thresholds may only be TIGHTENED by a project (a LOWER value means
  // MORE escalation / deeper review); a project must not RAISE them to suppress
  // big-diff / debate-tier review.
  clampThresholds(merged.thresholds, baseline.thresholds);

  // Sensitivity lists are ADDITIVE (they only ever widen what counts as
  // sensitive / reviewable): a project may add repo-specific entries but must not
  // DROP the user's (deepAssign replaces arrays wholesale, which a project could
  // use to delete the user's sensitive patterns). Union baseline ∪ project.
  if (merged.sensitivity && typeof merged.sensitivity === "object" && baseline.sensitivity) {
    merged.sensitivity.extraSensitive = unionList(merged.sensitivity.extraSensitive, baseline.sensitivity.extraSensitive);
    merged.sensitivity.extraCodeExts = unionList(merged.sensitivity.extraCodeExts, baseline.sensitivity.extraCodeExts);
  }

  // The reviewers map must remain an object: a project `reviewers: null` (or a
  // scalar/array) must not WIPE the user's reviewer configuration — which would
  // silently drop the readOnlyConfig isolation assertion and, in enforced mode,
  // turn a configured isolated reviewer into a fail-closed block. Restore the
  // trusted baseline shape when a project corrupted it.
  if (!merged.reviewers || typeof merged.reviewers !== "object" || Array.isArray(merged.reviewers)) {
    merged.reviewers = structuredClone(baseline.reviewers);
  }

  return merged;
}

/**
 * Clamp the numeric escalation thresholds so an untrusted project can only ever
 * TIGHTEN them (a lower value triggers escalation/debate sooner). A project may
 * not RAISE a threshold to suppress enhanced review, and if the baseline forces
 * debate on sensitive changes that cannot be turned off.
 *
 * @param {object} merged    - effective thresholds (mutated in place)
 * @param {object} baseline  - trusted baseline thresholds
 */
function clampThresholds(merged, baseline) {
  if (!merged || typeof merged !== "object" || !baseline || typeof baseline !== "object") return;
  for (const key of ["bigDiffLines", "bigFileCount", "debateDiffLines", "debateFileCount"]) {
    if (typeof baseline[key] !== "number") continue;
    // A NON-number project value (e.g. "99999") would slip past a `> baseline`
    // numeric clamp and then make `lines >= "99999"` coerce to false — disabling
    // escalation. Coerce any non-number, or a value ABOVE the baseline, back to
    // the baseline (a project may only LOWER a threshold).
    if (typeof merged[key] !== "number" || merged[key] > baseline[key]) {
      merged[key] = baseline[key];
    }
  }
  // debateOnSensitive:true is the stricter setting — a project can enable it but
  // cannot disable it when the baseline requires it.
  if (baseline.debateOnSensitive === true) merged.debateOnSensitive = true;
}

/**
 * Union an additive list field: a project may ADD entries (stricter) but must not
 * REMOVE the user/baseline ones (array replacement by deepAssign would otherwise
 * let a project drop them).
 *
 * @param {*} projectList
 * @param {*} baselineList
 * @returns {Array}
 */
function unionList(projectList, baselineList) {
  const out = Array.isArray(projectList) ? [...projectList] : [];
  if (Array.isArray(baselineList)) {
    for (const item of baselineList) if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Enforce the reviewer trust floor on a fully-merged config using the RAW user
 * config as the sole source of truth for trust and custom-reviewer definitions.
 *
 * Rules (all fail-closed; a project layer can only LOSE privileges here):
 *  - For every reviewer id: if merged.reviewers[id].trusted === true but the user
 *    config did NOT set trusted === true for that id, force trusted = false. A
 *    project config can never grant trust.
 *  - For every reviewer id: the model fallback `models` list comes from the user
 *    config ONLY (project-supplied lists are dropped) so a hostile repo cannot
 *    redirect the gate to a weak/colluding rubber-stamp model.
 *  - For any reviewer that is custom (merged type OR user-declared type is
 *    "custom"): take `type`, `command`, `args`, `readOnlyConfig`,
 *    `requiredDimensions`, and `timeoutSec` ONLY from the user config for that
 *    id, dropping any project-supplied values. If the user config did not define
 *    this custom reviewer, the result has no command and is rejected at runtime
 *    (fail closed).
 *
 *    `readOnlyConfig` is the SOLE isolation assertion for a custom reviewer (it
 *    has no bundled-agent anchor like opencode). A malicious PROJECT config that
 *    set `readOnlyConfig:true` on a user-trusted-but-non-isolated custom reviewer
 *    would otherwise bypass the enforced/strict isolation gate, so it must come
 *    from the trusted USER config only.
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

    // Security-relevant reviewer fields a PROJECT layer must NEVER set, for
    // EVERY reviewer (built-in opencode/codex AND custom):
    //   - models: the fallback model list — a hostile repo could pin a
    //     weak/colluding model to obtain a rubber-stamp review;
    //   - requiredDimensions: the review dimensions — a project could shrink it
    //     to [] to weaken the review;
    //   - timeoutSec: the reviewer timeout — a project could set 0/negative to
    //     instantly time the reviewer out (DoS / wedge the gate).
    // All three are sourced from the trusted USER config ONLY (the plugin ships
    // no per-reviewer defaults); any project-supplied value is dropped so it
    // fails closed to the gate's built-in defaults.
    for (const field of ["models", "requiredDimensions", "timeoutSec"]) {
      if (userEntry && field in userEntry && userEntry[field] !== undefined) {
        entry[field] = structuredClone(userEntry[field]);
      } else {
        delete entry[field];
      }
    }

    // Custom-reviewer floor: type/command/args AND the readOnlyConfig isolation
    // assertion come from the user config only (requiredDimensions/timeoutSec
    // are already handled by the generic field floor above).
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
        // readOnlyConfig is the SOLE isolation assertion for a custom reviewer
        // (no bundled-agent anchor). Source it ONLY from the trusted user config;
        // a project-set value must NEVER grant isolation. Coerce to a strict
        // boolean so a non-true user value cannot accidentally assert isolation.
        entry.readOnlyConfig = userEntry.readOnlyConfig === true;
      } else {
        // The user config did not define this custom reviewer. Strip any
        // project-supplied command/args so it fails closed (no command -> rejected
        // at runtime). Keep type so the custom adapter still recognizes the entry
        // and refuses it via the missing-command / untrusted checks. Also strip
        // the readOnlyConfig isolation flag a project may have injected
        // (models/requiredDimensions/timeoutSec were already cleared above).
        delete entry.command;
        delete entry.args;
        delete entry.readOnlyConfig;
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
  // Read case-insensitively: a plain-object/native-Windows env may carry the key
  // in a non-canonical case (e.g. "Adversarial_Review_State_Dir").
  const override = getEnvCaseInsensitive(env, "ADVERSARIAL_REVIEW_STATE_DIR");
  // Only honor an ABSOLUTE override. A RELATIVE value would resolve under the
  // current cwd — a project-writable location where a malicious repo could
  // pre-seed the review-pass cache. A relative override is ignored so the state
  // dir is always the user-level, non-repo-relative default.
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(resolveHomeDir(env), ".adversarial-review", "state");
}

/**
 * Resolve the user's home directory, honoring an injected env so tests can
 * redirect the user-level base (config.json, policy.json, state dir, install
 * registry, opencode agent) without touching the real home dir.
 *
 * This is the SINGLE shared resolver imported by install.js and doctor.js so
 * the installer/doctor write/read the SAME user-level base the gate later uses.
 *
 * Priority (non-win32 / POSIX — unchanged):
 *   1. ADVERSARIAL_REVIEW_HOME — dedicated override for the user-level base;
 *   2. HOME / USERPROFILE — standard OS home env vars;
 *   3. os.homedir() — the real home dir.
 *
 * Priority (win32): HOME is often a POSIX MSYS value like "/c/Users/Louis",
 * which is a broken base for path.join with backslash directories. So on win32
 * we prefer ADVERSARIAL_REVIEW_HOME, then USERPROFILE, then os.homedir(), and
 * only fall back to HOME when it looks like a NATIVE Windows path (contains ':'
 * or a backslash). A leading "/<drive>/" POSIX HOME is normalized to "<drive>:\".
 *
 * All env reads are case-insensitive: a plain-object/native-Windows env may
 * carry keys as "Userprofile"/"Home"/etc.
 *
 * @param {object} [env]  - environment variables
 * @returns {string} absolute home dir path
 */
export function resolveHomeDir(env) {
  if (env) {
    const override = getEnvCaseInsensitive(env, "ADVERSARIAL_REVIEW_HOME");
    // Only honor an ABSOLUTE override. A RELATIVE value would resolve under the
    // current cwd, putting the user-level base (config, policy floor, state/pass
    // cache, install registry) inside a project-writable location — a malicious
    // repo could then pre-seed a review-pass cache entry. A relative override is
    // ignored so the trusted user-level base is never repo-relative. (Mirrors the
    // ADVERSARIAL_REVIEW_STATE_DIR guard in resolveStateDir.)
    if (override && path.isAbsolute(override)) return override;

    const home = getEnvCaseInsensitive(env, "HOME");
    const userProfile = getEnvCaseInsensitive(env, "USERPROFILE");

    if (process.platform === "win32") {
      // On Windows, prefer USERPROFILE (a real native path) over a possibly
      // POSIX-style HOME. Only trust HOME if it looks like a native Windows path.
      if (userProfile) return userProfile;
      if (home) {
        const normalized = normalizeWindowsHome(home);
        if (normalized) return normalized;
      }
    } else {
      // POSIX behavior unchanged: HOME first, then USERPROFILE.
      if (home) return home;
      if (userProfile) return userProfile;
    }
  }
  return os.homedir();
}

/**
 * On win32, decide whether a HOME value is a usable native Windows base, and if
 * not, try to normalize a POSIX "/<drive>/rest" MSYS path to "<drive>:\rest".
 * Returns the usable native path, or null when HOME is an unusable POSIX path
 * that cannot be normalized (so the caller can fall back to os.homedir()).
 *
 * @param {string} home
 * @returns {string|null}
 */
function normalizeWindowsHome(home) {
  // Already looks like a native Windows path (drive-letter colon or backslash).
  if (home.includes(":") || home.includes("\\")) return home;
  // POSIX MSYS form: "/c/Users/Louis" -> "C:\Users\Louis". Uppercase the drive
  // letter to produce the canonical native Windows form.
  const m = /^\/([A-Za-z])\/(.*)$/.exec(home);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = m[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  // Unusable POSIX-looking HOME; signal fallback.
  return null;
}
