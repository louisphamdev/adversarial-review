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
import { realpathSync } from "node:fs";
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
 * Whether the project config file's REAL path stays inside the workspace root,
 * so a committed symlink cannot redirect the read to an out-of-tree file.
 *
 * Returns true when the file does not exist / cannot be resolved (the tolerant
 * reader then yields `{}`), and when the resolved path is contained in the
 * resolved workspace root. Returns false ONLY when the resolved file escapes the
 * workspace — in which case the caller treats the project config as absent.
 *
 * @param {string} cwd
 * @param {string} fullPath  - <cwd>/.adversarial-review/config.json
 * @param {object} [io]      - { stderr }
 * @returns {boolean}
 */
function projectConfigWithinWorkspace(cwd, fullPath, io) {
  let rootReal;
  let fileReal;
  try {
    rootReal = realpathSync(cwd);
  } catch {
    return true; // can't resolve the root: let the tolerant reader handle it
  }
  try {
    fileReal = realpathSync(fullPath);
  } catch {
    return true; // file missing / unreadable: tolerant reader returns {}
  }
  const rel = path.relative(rootReal, fileReal);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside && io?.stderr) {
    io.stderr.write(
      `adversarial-review: ignoring project config whose real path escapes the workspace: ${fullPath}\n`
    );
  }
  return inside;
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
  // Pass cwd so an ADVERSARIAL_REVIEW_HOME override pointing INSIDE the workspace
  // is rejected (a repo-controlled env must not relocate the trusted user base).
  const home = resolveHomeDir(io.env, cwd);
  const userConfig = await readJsonTolerant(
    path.join(home, USER_CONFIG_REL),
    io,
    "user config"
  );
  // The PROJECT config lives in the (untrusted) repo. A hostile repo could
  // commit `.adversarial-review/config.json` as a SYMLINK pointing OUTSIDE the
  // workspace (e.g. -> ~/.aws/credentials.json) to make the gate read an
  // arbitrary file (a parse-error then leaks a fragment to stderr, or an
  // attacker-controlled out-of-tree file is used as config). Read it ONLY when
  // its real path stays inside the workspace; otherwise treat it as absent. The
  // user config + policy floor live under the trusted home dir, so they are not
  // guarded.
  const projectConfigPath = path.join(cwd, PROJECT_CONFIG_REL);
  const projectConfig = projectConfigWithinWorkspace(cwd, projectConfigPath, io)
    ? await readJsonTolerant(projectConfigPath, io, "project config")
    : {};
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

  // The config schema `version` selects how the runtime interprets the config;
  // an untrusted project must not be able to downgrade it (a v1 interpretation
  // could skip invariants the v2 schema enforces). Pin it to the baseline.
  merged.version = baseline.version;

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

  // Per-ENTRY restore: a project `reviewers.opencode = null` (or a scalar/array)
  // must not WIPE an individual user/baseline reviewer entry either.
  // applyReviewerTrustFloor SKIPS a corrupted (null/scalar/array) entry, so without
  // this a project could null out a user-pinned reviewer to drop its models /
  // requiredDimensions / timeout / readOnlyConfig back to the gate's weaker built-in
  // defaults (a downgrade the trust floor is meant to prevent). Restore the trusted
  // baseline entry for any id the project corrupted. (audit ROUND7 / GPT-5.5)
  if (
    merged.reviewers && typeof merged.reviewers === "object" && !Array.isArray(merged.reviewers) &&
    baseline.reviewers && typeof baseline.reviewers === "object"
  ) {
    for (const id of Object.keys(baseline.reviewers)) {
      const entry = merged.reviewers[id];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        merged.reviewers[id] = structuredClone(baseline.reviewers[id]);
      }
    }
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

    // Trust floor: only the user config can grant trust. A project may set a
    // TRUTHY NON-BOOLEAN (`trusted:1`, `"true"`, `[true]`) that a `=== true`
    // guard misses; coerce ANY value the user did not explicitly confirm to a
    // strict `false`, and canonicalize a user-confirmed grant to `true`.
    if (userEntry?.trusted === true) {
      entry.trusted = true;
    } else if ("trusted" in entry) {
      entry.trusted = false;
    }

    // Security-relevant reviewer fields a PROJECT layer must NEVER set, for EVERY
    // reviewer (built-in opencode/codex AND custom). Each is sourced from the
    // trusted USER config ONLY; any project-supplied value is dropped:
    //   - type:    the ADAPTER selector — a project must not turn a built-in into
    //              a custom reviewer, nor redirect it to a different adapter with
    //              different isolation properties;
    //   - command/args: a custom reviewer's executable + args — never project-set;
    //   - models:  the fallback model list (no weak/colluding rubber-stamp model);
    //   - requiredDimensions: the review dimensions (no shrinking to []);
    //   - timeoutSec: the reviewer timeout (no 0/negative DoS).
    // The plugin ships no per-reviewer defaults, so a dropped field fails closed
    // to the gate's built-in defaults / a runtime rejection.
    for (const field of ["type", "command", "args", "models", "requiredDimensions", "timeoutSec"]) {
      if (userEntry && field in userEntry && userEntry[field] !== undefined) {
        entry[field] = structuredClone(userEntry[field]);
      } else {
        delete entry[field];
      }
    }

    // readOnlyConfig (isolation assertion):
    //  - CUSTOM reviewer (user-declared type:"custom"): the SOLE isolation
    //    assertion (no bundled-agent anchor) — sourced from the trusted user
    //    config only, coerced to a strict boolean;
    //  - built-in opencode/codex: a project value is intentionally allowed, since
    //    their isolation is anchored to the forced bundled read-only agent /
    //    sandbox in enforced/strict, not to this flag;
    //  - any OTHER (unknown) reviewer id a project injected: strip it.
    if (entry.type === "custom") {
      entry.readOnlyConfig = userEntry?.readOnlyConfig === true;
    } else if (id !== "opencode" && id !== "codex") {
      delete entry.readOnlyConfig;
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
export function resolveStateDir(env = process.env, cwd) {
  // Read case-insensitively: a plain-object/native-Windows env may carry the key
  // in a non-canonical case (e.g. "Adversarial_Review_State_Dir").
  const override = getEnvCaseInsensitive(env, "ADVERSARIAL_REVIEW_STATE_DIR");
  // Only honor an ABSOLUTE override that does NOT resolve INSIDE the workspace.
  // A relative value, OR an absolute path under `cwd`, is a project-writable
  // location where a malicious repo (or a repo-controlled env, e.g. an npm
  // script / CI wrapper that sets ADVERSARIAL_REVIEW_STATE_DIR=$PWD/...) could
  // pre-seed the review-pass cache and bypass review. Such overrides are ignored
  // so the state dir is always the user-level, non-repo-relative default.
  if (override && path.isAbsolute(override) && !overrideInsideCwd(cwd, override)) {
    return path.resolve(override);
  }
  return path.join(resolveHomeDir(env, cwd), ".adversarial-review", "state");
}

/**
 * Whether an absolute override path resolves INSIDE the workspace `cwd`. Used to
 * reject ADVERSARIAL_REVIEW_HOME / ADVERSARIAL_REVIEW_STATE_DIR overrides that
 * point into the (untrusted) repo, which would relocate the trusted user-level
 * base or pass cache into a project-writable location. Pure path math (the dir
 * may not exist yet), so `..` segments are collapsed by path.resolve. When `cwd`
 * is not provided the check is a no-op (false).
 *
 * @param {string|undefined} cwd
 * @param {string} overrideAbs  - an absolute override path
 * @returns {boolean}
 */
function overrideInsideCwd(cwd, overrideAbs) {
  if (!cwd) return false;
  const root = path.resolve(cwd);
  const cand = path.resolve(overrideAbs);
  const rel = path.relative(root, cand);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
export function resolveHomeDir(env, cwd) {
  if (env) {
    const override = getEnvCaseInsensitive(env, "ADVERSARIAL_REVIEW_HOME");
    // Only honor an ABSOLUTE override that does NOT resolve INSIDE the workspace.
    // A relative value, OR an absolute path under `cwd`, would put the trusted
    // user-level base (config, policy floor, state/pass cache, install registry)
    // inside a project-writable location — a malicious repo (or a repo-controlled
    // env) could then supply a fake "user" config/policy that loosens the
    // baseline, or pre-seed the pass cache. Such overrides are ignored so the
    // trusted user-level base is never repo-relative. (Mirrors resolveStateDir.)
    if (override && path.isAbsolute(override) && !overrideInsideCwd(cwd, override)) {
      return override;
    }

    const home = getEnvCaseInsensitive(env, "HOME");
    const userProfile = getEnvCaseInsensitive(env, "USERPROFILE");

    if (process.platform === "win32") {
      // On Windows, prefer USERPROFILE (a real native path) over a possibly
      // POSIX-style HOME. Only trust HOME if it looks like a native Windows path.
      if (userProfile && envHomeUsable(cwd, userProfile)) return userProfile;
      if (home) {
        const normalized = normalizeWindowsHome(home);
        if (normalized && envHomeUsable(cwd, normalized)) return normalized;
      }
    } else {
      // POSIX behavior unchanged: HOME first, then USERPROFILE.
      if (home && envHomeUsable(cwd, home)) return home;
      if (userProfile && envHomeUsable(cwd, userProfile)) return userProfile;
    }
  }
  return safeOsHomedir(cwd);
}

/**
 * Whether an env-provided home value (HOME / USERPROFILE) is usable as the TRUSTED
 * user-level base. The dedicated ADVERSARIAL_REVIEW_HOME override is already guarded
 * against pointing INSIDE cwd; HOME / USERPROFILE are the STANDARD env vars a
 * repo-controlled wrapper (an npm script / CI step setting HOME=$PWD or
 * USERPROFILE=%CD%) would set to relocate the trusted base — fake user config/policy
 * that loosens the baseline, or a pre-seeded pass cache — into the project-writable
 * tree. Reject an ABSOLUTE value that resolves inside cwd so HOME/USERPROFILE get the
 * SAME inside-cwd guard as the dedicated override. A relative value (degenerate, rare)
 * keeps the prior behavior. When cwd is not provided the guard is a no-op.
 * (audit ROUND7 / GPT-5.5: the round-6 fix guarded only ADVERSARIAL_REVIEW_HOME.)
 *
 * @param {string|undefined} cwd
 * @param {string} value  - a HOME / USERPROFILE env value
 * @returns {boolean}
 */
function envHomeUsable(cwd, value) {
  if (path.isAbsolute(value) && overrideInsideCwd(cwd, value)) return false;
  return true;
}

/**
 * os.homedir() ITSELF consults HOME (POSIX) / USERPROFILE (win32), so a repo-poisoned
 * env that points those INSIDE cwd would make even the final fallback resolve into the
 * repo — re-opening the same hole envHomeUsable closes above. When os.homedir() lands
 * inside cwd, fall back to os.userInfo().homedir, which reads the OS account database
 * (POSIX getpwuid / win32 user token) and is NOT influenced by the env. Only if that
 * is unavailable do we return the (poisoned) os.homedir() value. (audit ROUND7)
 *
 * @param {string|undefined} cwd
 * @returns {string}
 */
function safeOsHomedir(cwd) {
  const h = os.homedir();
  if (cwd && typeof h === "string" && path.isAbsolute(h) && overrideInsideCwd(cwd, h)) {
    try {
      const info = os.userInfo();
      if (info && typeof info.homedir === "string" && info.homedir) return info.homedir;
    } catch {
      /* no OS account entry — fall through to the os.homedir() value */
    }
  }
  return h;
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
