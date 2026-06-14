// `adversarial-review install` — multi-host installation and config writer.
//
// Non-interactive flags:
//   --hosts a,b              comma-separated list of hosts to install
//   --reviewer host=reviewer  reviewer mapping (repeatable)
//   --dry-run                print planned writes; write nothing
//   --project-config <path>  path to an explicit project config file
//
// Validation rules (reject with non-zero exit + clear error):
//   1. A host mapped to ITSELF as reviewer.
//   2. A selected host with NO reviewer mapping (must choose a reviewer or "none").
//   3. A reviewer mapping value that is empty/whitespace (distinct from "none").
//   4. A reviewer that is unavailable (verify() fails) and is NOT "none".
//   5. A host whose enforcement is literally "advisory" when policy disallows advisory hosts.
//      "wrapper-enforced" is DISTINCT from "advisory" and is allowed by default; a
//      wrapper-enforced host emits an informational disclosure note but is not rejected.
//
// In dry-run mode: print every planned write path and its note, then exit 0
// WITHOUT writing any files.

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { mergeConfig, applyPolicyFloor, deepAssign, DEFAULT_CONFIG } from "../core/config.js";
import { HOSTS } from "../hosts/index.js";
import {
  plannedClaudeCodeWrites,
  claudeCodeSettingsPath,
} from "../hosts/claude-code.js";
import { wrapperInstructions } from "../hosts/wrapper.js";
import { createReviewer } from "../reviewers/index.js";
import { resolveExecutable } from "../core/process.js";
import { resolveHomeDir } from "../core/load-config.js";

// Path constants (relative to cwd / home).
const PROJECT_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_POLICY_REL = path.join(".adversarial-review", "policy.json");
const USER_INSTALL_REL = path.join(".adversarial-review", "install.json");
const LEGACY_CONFIG_REL = path.join("hooks", "config.json");

// Read-only opencode agent: where it lives in the user's home, and the bundled
// source that ships inside the package. The agent MUST be a `primary` opencode
// agent (not a subagent) or opencode falls back to the writable default agent.
const OPENCODE_AGENT_REL = path.join(
  ".config",
  "opencode",
  "agent",
  "adversarial-reviewer.md"
);
const BUNDLED_OPENCODE_AGENT_PATH = fileURLToPath(
  new URL("../integrations/opencode/adversarial-reviewer.agent.md", import.meta.url)
);

// Default config block written for an opencode reviewer so enforced-mode
// isolation (readOnly && noEdit) passes and the read-only agent is selected.
const OPENCODE_REVIEWER_DEFAULTS = Object.freeze({
  readOnlyConfig: true,
  agent: "adversarial-reviewer",
  timeoutSec: 180,
});

// Mode strictness ranks (mirrors the private MODE_RANK in src/core/config.js).
// Higher rank == stricter. Used ONLY to ratchet the user-level policy.json floor
// UP — never to loosen an existing stricter floor.
const MODE_RANK = new Map([
  ["soft", 0],
  ["enforced", 1],
  ["strict-ci", 2],
]);

// The recognized policy modes (mirrors KNOWN_MODES in src/core/config.js). Used
// to validate the explicit `--mode` flag.
const KNOWN_MODES = new Set(["soft", "enforced", "strict-ci"]);

/**
 * Canonicalize a policy mode value to a known mode string (mirrors the private
 * canonicalizeMode in src/core/config.js). Any unrecognized value — non-string,
 * typo, case/whitespace variant, or garbage — maps to the secure default
 * "enforced" (fail-closed). Kept local because the core helper is not exported.
 *
 * @param {*} mode
 * @returns {"soft"|"enforced"|"strict-ci"}
 */
function canonicalizeMode(mode) {
  if (typeof mode === "string") {
    const m = mode.trim().toLowerCase();
    if (KNOWN_MODES.has(m)) return m;
  }
  return "enforced";
}

// The strictest mode the installer will EVER write as the user-level floor on a
// first install. The floor mode is derived ONLY from trusted inputs (this
// constant, an existing user floor, and an explicit operator --mode flag) — it
// is NEVER taken from the UNTRUSTED project config, so a cloned repo's
// `{"policy":{"mode":"soft"}}` can never lower the installed floor below this.
const MIN_FLOOR_MODE = "enforced";

/**
 * Compute the policy-floor MODE to write from TRUSTED inputs only.
 *
 * The floor mode is the STRICTEST of:
 *   - MIN_FLOOR_MODE ("enforced") — the fail-closed default floor;
 *   - the existing user floor's mode (a prior operator choice — may already be
 *     stricter, e.g. "strict-ci");
 *   - an explicit operator `--mode` flag (canonicalized).
 *
 * The UNTRUSTED project config is deliberately NOT an input here. Deriving the
 * floor from the project config (the old behavior) let a cloned repo's
 * `{"policy":{"mode":"soft"}}` install a `soft` floor (the weakest rank), and
 * the tighten-only ratchet could never recover — the gate would be installed
 * fail-open. (FINDING 1, ROUND 5.)
 *
 * @param {object} existingFloor    - parsed existing policy.json (or {})
 * @param {string|null} explicitMode - canonicalized --mode flag, or null
 * @returns {"soft"|"enforced"|"strict-ci"} the floor mode to write
 */
function resolveFloorMode(existingFloor, explicitMode) {
  const efPolicy =
    existingFloor && typeof existingFloor === "object" && !Array.isArray(existingFloor)
      ? existingFloor.policy && typeof existingFloor.policy === "object"
        ? existingFloor.policy
        : existingFloor
      : {};

  // Start at the fail-closed minimum, then ratchet UP toward the strictest of
  // the existing floor mode and an explicit operator choice. Each candidate is
  // canonicalized; an unknown existing-floor value is ignored (rank stays at the
  // minimum) rather than treated as the loosest.
  let bestRank = MODE_RANK.get(MIN_FLOOR_MODE);
  let best = MIN_FLOOR_MODE;
  const consider = (mode) => {
    if (mode == null) return;
    const canon = canonicalizeMode(mode);
    const rank = MODE_RANK.get(canon);
    if (rank > bestRank) {
      bestRank = rank;
      best = canon;
    }
  };
  if (MODE_RANK.has(efPolicy.mode)) consider(efPolicy.mode);
  if (explicitMode != null) consider(explicitMode);
  return best;
}

/**
 * Compute the user-level policy.json floor to write so a cloned repo's project
 * config can never silently downgrade the chosen enforcement (e.g. enforced ->
 * soft). The floor is a tighten-only RATCHET applied over any existing floor:
 *
 *  - policy.mode: take whichever of {existing floor, chosen mode} is STRICTER
 *    (an unknown existing floor mode is treated as the loosest so the chosen
 *    canonical mode wins). Never lowers a stricter existing floor.
 *  - onReviewerError / onInternalError / onBlockCap: pinned to "block" unless the
 *    existing floor already pins them to "block" (idempotent — stays "block").
 *  - allowSkip / allowAdvisoryHosts: pinned to false (a floor only tightens).
 *
 * Returns `null` when the existing floor is already at least as strict on every
 * dimension (so install performs no redundant write — idempotent).
 *
 * @param {object} existingFloor - parsed existing policy.json (or {})
 * @param {string} chosenMode    - resolved policy.mode for this install
 * @returns {object|null} floor object to write, or null when no change is needed
 */
function computePolicyFloorToWrite(existingFloor, chosenMode) {
  const ef =
    existingFloor && typeof existingFloor === "object" && !Array.isArray(existingFloor)
      ? existingFloor.policy && typeof existingFloor.policy === "object"
        ? existingFloor.policy
        : existingFloor
      : {};

  const chosenRank = MODE_RANK.has(chosenMode) ? MODE_RANK.get(chosenMode) : 1;
  const existingRank = MODE_RANK.has(ef.mode) ? MODE_RANK.get(ef.mode) : -1;
  // Never loosen: keep the stricter of (existing floor mode, chosen mode).
  const flooredMode = existingRank >= chosenRank && MODE_RANK.has(ef.mode) ? ef.mode : chosenMode;

  const desired = {
    mode: flooredMode,
    onReviewerError: "block",
    onInternalError: "block",
    onBlockCap: "block",
    allowSkip: false,
    allowAdvisoryHosts: false,
  };

  // Idempotency: if the existing floor already satisfies every dimension at
  // least as strictly, no write is needed.
  const alreadyCovered =
    ef.mode === desired.mode &&
    ef.onReviewerError === "block" &&
    ef.onInternalError === "block" &&
    ef.onBlockCap === "block" &&
    ef.allowSkip === false &&
    ef.allowAdvisoryHosts === false;
  if (alreadyCovered) return null;

  // Preserve any unrelated keys the user authored at the top level / in policy.
  const base =
    existingFloor && typeof existingFloor === "object" && !Array.isArray(existingFloor)
      ? structuredClone(existingFloor)
      : {};
  const basePolicy =
    base.policy && typeof base.policy === "object" && !Array.isArray(base.policy)
      ? base.policy
      : {};
  base.policy = { ...basePolicy, ...desired };
  return base;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse the install command's argv array into structured options.
 *
 * @param {string[]} argv
 * @returns {{ hosts: string[], reviewerMap: Map<string,string>, dryRun: boolean, projectConfigPath: string|null, userScope: boolean, modeFlag: string|null }}
 */
function parseArgs(argv) {
  const hosts = [];
  const reviewerMap = new Map();
  let dryRun = false;
  let projectConfigPath = null;
  let userScope = false;
  // Explicit operator enforcement mode for the user-level policy floor. This is
  // the ONLY way an install can RAISE the floor above the fail-closed default
  // ("enforced") from the command line; the UNTRUSTED project config can never
  // set it. A value is canonicalized at use; an unknown value is rejected.
  let modeFlag = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--user" || arg === "--global") {
      // Machine-wide install: write to <home>/.adversarial-review/config.json
      // and merge hooks into <home>/.claude/settings.json instead of cwd.
      userScope = true;
    } else if (arg === "--mode" && argv[i + 1]) {
      modeFlag = argv[i + 1].trim();
      i++;
    } else if (arg.startsWith("--mode=")) {
      modeFlag = arg.slice("--mode=".length).trim();
    } else if (arg === "--hosts" && argv[i + 1]) {
      // Accept either `--hosts a,b` or `--hosts a --hosts b`.
      argv[i + 1].split(",").forEach((h) => hosts.push(h.trim()));
      i++;
    } else if (arg.startsWith("--hosts=")) {
      arg.slice("--hosts=".length).split(",").forEach((h) => hosts.push(h.trim()));
    } else if (arg === "--reviewer" && argv[i + 1]) {
      const pair = argv[i + 1];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        reviewerMap.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      i++;
    } else if (arg === "--project-config" && argv[i + 1]) {
      projectConfigPath = argv[i + 1];
      i++;
    }
  }

  return { hosts, reviewerMap, dryRun, projectConfigPath, userScope, modeFlag };
}

// ---------------------------------------------------------------------------
// Config I/O helpers
// ---------------------------------------------------------------------------

/** Tolerantly read and parse a JSON file; returns {} on any error. */
async function readJsonTolerant(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

/**
 * Read an existing Claude Code settings.json for merging. Distinguishes
 * three cases so the caller can decide whether to back up the original:
 *   - missing/unreadable: { settings: {}, corrupt: false } — nothing to back up.
 *   - present but invalid JSON: { settings: {}, corrupt: true } — back up first.
 *   - present + valid object: { settings: <obj>, corrupt: false }.
 *
 * @param {string} filePath
 * @returns {Promise<{ settings: object, corrupt: boolean }>}
 */
async function readSettingsForMerge(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { settings: {}, corrupt: false }; // Missing: nothing to back up.
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { settings: parsed, corrupt: false };
    }
    // Valid JSON but not an object (e.g. an array or scalar) — treat as corrupt
    // so we preserve the original via backup rather than silently dropping it.
    return { settings: {}, corrupt: true };
  } catch {
    return { settings: {}, corrupt: true };
  }
}

/**
 * Back up a corrupt settings.json before it is overwritten by the merged
 * (from-scratch) result. Best-effort; never throws.
 *
 * A prior `${filePath}.bak` (e.g. a GOOD backup from an earlier valid->corrupt
 * recovery) must NOT be silently clobbered by this new corrupt-source backup —
 * doing so would permanently destroy the only good copy. When `.bak` already
 * exists we instead write a UNIQUE timestamped backup name so every recovery
 * point is preserved.
 *
 * @param {string} filePath
 * @param {object} io  - { stdout }
 */
async function backupCorruptSettings(filePath, io) {
  const defaultBak = `${filePath}.bak`;
  // If a prior backup already exists, do not overwrite it — use a unique,
  // timestamped name so the earlier (possibly GOOD) backup survives.
  const bakPath = existsSync(defaultBak)
    ? `${filePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`
    : defaultBak;
  try {
    await copyFile(filePath, bakPath);
    io.stdout.write(
      `  NOTE: ${filePath} was not valid JSON; backed it up to ${bakPath} before merging.\n`
    );
  } catch {
    // If the backup itself fails we still proceed — but note it.
    io.stdout.write(
      `  WARNING: ${filePath} was not valid JSON and could not be backed up; merging from scratch.\n`
    );
  }
}

/**
 * Normalize a directory path into a STABLE install-registry key so the same
 * project never produces duplicate registry entries. We path.resolve() to an
 * absolute, normalized form and, on win32, lowercase the ENTIRE path (the
 * Windows filesystem is case-INSENSITIVE, so `D:\Code\Foo` and `d:\code\foo`
 * denote the same project and MUST map to one key — lowercasing only the drive
 * letter wrongly produced two keys for the same dir, defeating dedupe/uninstall).
 * On POSIX the casing is left intact because the filesystem is case-sensitive.
 *
 * NOTE: this implementation is duplicated verbatim in src/cli/uninstall.js; the
 * two MUST stay byte-for-byte identical so install and uninstall agree on the
 * key. Keep them in sync.
 *
 * @param {string} dir
 * @returns {string}
 */
function normalizeRegistryKey(dir) {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Pick the command used to invoke this package from hooks/wrappers.
 *
 * Prefers the direct bin name `adversarial-review-gate` when it resolves on
 * PATH (a global install — faster, no npx resolution per Stop hook). Falls back
 * to `npx adversarial-review-gate` otherwise, which always works.
 *
 * @param {object} env  - environment variables
 * @returns {Promise<{ command: string, direct: boolean }>}
 */
async function resolveHookBinCommand(env) {
  const resolved = await resolveExecutable("adversarial-review-gate", env);
  if (resolved) {
    return { command: "adversarial-review-gate", direct: true };
  }
  return { command: "npx adversarial-review-gate", direct: false };
}

// ---------------------------------------------------------------------------
// Legacy config migration
// ---------------------------------------------------------------------------

/**
 * Read a legacy `hooks/config.json` (Python-era format) and translate it into
 * the current config schema.  Returns `{}` when no legacy file exists.
 *
 * Legacy mappings:
 *   thresholds.* (bigDiffLines, bigFileCount, ...)  -> thresholds.*
 *   engine: "opencode" | "codex"                   -> hosts["claude-code"].reviewer
 *   timeout (top-level or reviewers.*.timeout)      -> runtime.timeoutSec
 *
 * @param {string} cwd
 * @returns {Promise<object>} partial config fragment (empty if no legacy file)
 */
async function readLegacyConfig(cwd) {
  const legacyPath = path.join(cwd, LEGACY_CONFIG_REL);
  const legacy = await readJsonTolerant(legacyPath);
  if (!Object.keys(legacy).length) return {};

  const migrated = {};

  // Migrate threshold keys.
  const THRESHOLD_KEYS = new Set([
    "bigDiffLines",
    "bigFileCount",
    "debateDiffLines",
    "debateFileCount",
    "debateOnSensitive",
  ]);
  const thresholds = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (THRESHOLD_KEYS.has(key)) thresholds[key] = value;
  }
  if (Object.keys(thresholds).length) migrated.thresholds = thresholds;

  // Migrate engine -> hosts["claude-code"].reviewer.
  if (typeof legacy.engine === "string" && legacy.engine) {
    migrated.hosts = {
      "claude-code": { reviewer: legacy.engine },
    };
  }

  // Migrate timeout -> runtime.timeoutSec.
  const timeout =
    legacy.timeout ||
    legacy.reviewers?.opencode?.timeout ||
    legacy.reviewers?.codex?.timeout;
  if (typeof timeout === "number" && timeout > 0) {
    migrated.runtime = { timeoutSec: timeout };
  }

  return migrated;
}

// ---------------------------------------------------------------------------
// Reviewer availability check
// ---------------------------------------------------------------------------

/**
 * Verify that a reviewer id is available FOR INSTALL (its binary resolves on
 * PATH and answers --version). "none" is always treated as available.
 *
 * INSTALL-TIME SEMANTICS: this uses { requireAgent: false } so the opencode
 * adapter checks ONLY the binary + version and SKIPS the `opencode agent list`
 * / `reviewer_agent_missing` check. This breaks a chicken-and-egg: the installer
 * is the very thing that CREATES the read-only agent (FIX 2 below), so on a
 * clean machine the agent does not exist yet and the full verify() would reject
 * the install before the agent could ever be created. A MISSING BINARY or a
 * failing --version (missing_binary / version_check_failed) STILL rejects — only
 * agent-existence is skipped. Other adapters (codex/custom) ignore the option.
 * Runtime (makeReviewerRunner) and `doctor` keep the full verify() (with agent).
 *
 * @param {string} reviewerId
 * @param {object} config  - effective config (used by createReviewer)
 * @param {object} env     - environment variables
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function checkReviewerAvailability(reviewerId, config, env) {
  if (reviewerId === "none") return { ok: true };
  try {
    const adapter = createReviewer(reviewerId, config);
    return adapter.verify(env, { requireAgent: false });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath`, creating parent directories as needed.
 * Writes atomically by writing to a temp file and renaming (best-effort on
 * Windows where rename semantics differ; we do a two-step write+rename).
 *
 * The file mode is parameterized PER FILE: team-shared/committed files
 * (project config, .claude/settings.json) are written 0o644 so collaborators
 * can read them, while user-level secrets-adjacent files (user config, registry,
 * state) stay 0o600. Defaults to 0o600 (the safe default).
 *
 * @param {string} filePath
 * @param {string} content
 * @param {number} [mode=0o600]
 */
async function atomicWrite(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  // FINDING 3 (ROUND 5): the temp name must be UNPREDICTABLE. A predictable
  // `${filePath}.tmp${Date.now()}` let a local attacker pre-create a SYMLINK at
  // the guessed temp path so our write followed the link and clobbered an
  // arbitrary target with our content (run as the installing user). Use a
  // crypto-random suffix so the path cannot be guessed, AND open with the "wx"
  // flag (O_EXCL) so the write FAILS rather than follows a pre-existing symlink
  // or file at that path — closing the race entirely.
  const tmp = `${filePath}.tmp.${randomUUID()}`;
  await writeFile(tmp, content, { encoding: "utf8", mode, flag: "wx" });
  // node:fs rename is atomic on POSIX; on Windows it will overwrite on Node 14+.
  const { rename, rm } = await import("node:fs/promises");
  try {
    await rename(tmp, filePath);
  } catch (err) {
    // The temp file was written but the rename failed (cross-device link, target
    // locked by another process on Windows, concurrent install). Clean up the
    // orphaned temp file so repeated failed installs do not accumulate
    // `.tmp<uuid>` litter in .adversarial-review/ and .claude/, then re-throw so
    // the caller still sees the failure.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main install command
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function installCommand(argv, io) {
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;
  const home = resolveHomeDir(env);

  const { hosts, reviewerMap, dryRun, projectConfigPath, userScope, modeFlag } = parseArgs(argv);

  // Validate the explicit --mode flag up front so a typo is a clear usage error
  // rather than silently coerced. Canonicalize only KNOWN values; anything else
  // is rejected. (When absent, the floor falls back to the fail-closed default.)
  let explicitMode = null;
  if (modeFlag != null && modeFlag !== "") {
    const canon = canonicalizeMode(modeFlag);
    // canonicalizeMode maps garbage to "enforced", so re-validate the raw input
    // against KNOWN_MODES to distinguish a real "enforced" from a coerced typo.
    if (!KNOWN_MODES.has(modeFlag.toLowerCase())) {
      io.stderr.write(
        `adversarial-review install: unknown --mode "${modeFlag}". ` +
          `Known modes: ${[...KNOWN_MODES].join(", ")}.\n`
      );
      process.exitCode = 2;
      return;
    }
    explicitMode = canon;
  }

  // Scope base: the directory whose .adversarial-review/config.json and
  // .claude/settings.json we write. User scope targets <home>; default targets
  // the project <cwd>. The install registry + opencode agent always live under
  // <home> regardless of scope.
  const scopeBase = userScope ? home : cwd;

  // --- Require at least one host ---
  if (!hosts.length) {
    io.stderr.write(
      "adversarial-review install: no hosts specified.\n" +
        "Usage: adversarial-review install --hosts <host,...> --reviewer <host=reviewer> [--dry-run]\n"
    );
    process.exitCode = 2;
    return;
  }

  // --- Load user policy floor ---
  const userPolicyPath = path.join(home, USER_POLICY_REL);
  const userPolicyFloor = await readJsonTolerant(userPolicyPath);

  // --- Load existing config to layer onto (scope-aware) ---
  // For project scope this is <cwd>/.adversarial-review/config.json; for user
  // scope it is <home>/.adversarial-review/config.json. An explicit
  // --project-config path always wins.
  const projectConfigPath2 =
    projectConfigPath || path.join(scopeBase, PROJECT_CONFIG_REL);
  const existingProjectConfig = await readJsonTolerant(projectConfigPath2);

  // --- Read legacy config and merge ---
  const legacyFragment = await readLegacyConfig(cwd);

  // Build initial project config by DEEP-layering: legacy <- existing (existing
  // wins on a leaf conflict). A shallow Object.assign replaced whole nested
  // sections (e.g. an existing `thresholds:{debateDiffLines}` would clobber the
  // migrated legacy `thresholds:{bigDiffLines,bigFileCount}`), silently dropping
  // the migrated keys. deepAssign recurses so per-leaf keys from BOTH layers
  // survive (and it carries the same __proto__/constructor guards). Start from a
  // fresh object so neither input is mutated.
  const baseProjectConfig = deepAssign(
    deepAssign({}, legacyFragment),
    existingProjectConfig
  );

  // Build the effective config to evaluate advisory/policy constraints.
  const effectiveConfig = mergeConfig(baseProjectConfig, userPolicyFloor);

  // --- Validate hosts and reviewer mappings ---

  // 1. All selected hosts must be known.
  for (const host of hosts) {
    if (!HOSTS[host]) {
      io.stderr.write(
        `adversarial-review install: unknown host "${host}". ` +
          `Known hosts: ${Object.keys(HOSTS).join(", ")}\n`
      );
      process.exitCode = 2;
      return;
    }
  }

  // 2. Each host must have a reviewer mapping.
  for (const host of hosts) {
    if (!reviewerMap.has(host)) {
      io.stderr.write(
        `adversarial-review install: host "${host}" has no reviewer mapping.\n` +
          `Specify --reviewer ${host}=<reviewer|none>.\n`
      );
      process.exitCode = 2;
      return;
    }
  }

  // 3. No host may map to itself as reviewer.
  for (const [host, reviewer] of reviewerMap) {
    if (hosts.includes(host) && reviewer === host) {
      io.stderr.write(
        `adversarial-review install: host "${host}" cannot be mapped to itself as reviewer.\n`
      );
      process.exitCode = 2;
      return;
    }
  }

  // 3b. BONUS: Warn about reviewer mappings for hosts not in the selected --hosts list.
  // These mappings are silently ignored otherwise; surface a clear warning.
  for (const [mappedHost] of reviewerMap) {
    if (!hosts.includes(mappedHost)) {
      io.stderr.write(
        `adversarial-review install: WARNING: --reviewer mapping for "${mappedHost}" is ignored ` +
          `because "${mappedHost}" is not in the selected --hosts list.\n`
      );
    }
  }

  // 4. Reviewer availability (skip "none"; skip unknown hosts not in selected list).
  for (const host of hosts) {
    const reviewer = reviewerMap.get(host);
    // Empty/whitespace reviewer value is invalid — distinguish from the legitimate "none".
    if (typeof reviewer === "string" && reviewer.trim() === "") {
      io.stderr.write(
        `adversarial-review install: reviewer mapping for "${host}" is empty; ` +
          `specify a reviewer tool or 'none'.\n`
      );
      process.exitCode = 2;
      return;
    }
    if (reviewer === "none") continue;
    const result = await checkReviewerAvailability(reviewer, effectiveConfig, env);
    if (!result.ok) {
      io.stderr.write(
        `adversarial-review install: reviewer "${reviewer}" for host "${host}" is not available.\n` +
          `  Reason: ${result.reason || "missing_binary"}\n` +
          `  Install the reviewer or use --reviewer ${host}=none.\n`
      );
      process.exitCode = 2;
      return;
    }
  }

  // 5. Advisory host check: only reject hosts whose enforcement is literally "advisory".
  // "wrapper-enforced" is a DISTINCT level from "advisory" — wrapper hosts have reliable
  // blocking via the wrapper command and must install by default. allowAdvisoryHosts only
  // gates hosts with enforcement === "advisory". (Currently no HOSTS entries are advisory.)
  // For wrapper-enforced hosts, emit an informational disclosure note (in both dry-run
  // and real mode) disclosing residual risk — never present wrapper as equal to native.
  const allowAdvisory = effectiveConfig.policy?.allowAdvisoryHosts !== false;
  if (!allowAdvisory) {
    for (const host of hosts) {
      const hostInfo = HOSTS[host];
      if (hostInfo.enforcement === "advisory") {
        // Hard rejection in both dry-run and real mode — policy disallows advisory hosts.
        io.stderr.write(
          `adversarial-review install: host "${host}" has advisory enforcement ` +
            `but the effective policy has allowAdvisoryHosts:false.\n` +
            `Set allowAdvisoryHosts:true in your policy or choose a native-enforced host.\n`
        );
        process.exitCode = 2;
        return;
      }
    }
  }

  // --- Build the new project config ---

  // Populate hosts and reviewers sections from the mapping.
  const hostsConfig = { ...(baseProjectConfig.hosts || {}) };
  for (const host of hosts) {
    hostsConfig[host] = {
      ...(hostsConfig[host] || {}),
      reviewer: reviewerMap.get(host),
    };
  }

  // FIX 1: write a working reviewers config for any opencode reviewer.
  // Without reviewers.opencode.readOnlyConfig:true the adapter reports
  // capabilities {readOnly:false,noEdit:false}, so enforced-mode isolation
  // (readOnly && noEdit) fails and makeReviewerRunner rejects every review with
  // `reviewer_not_isolated`. For each DISTINCT selected-host mapping to
  // opencode, merge the read-only defaults — without clobbering any reviewers
  // section the user/project already set. (codex-as-reviewer already reports
  // isolated, so it needs no config block.)
  const reviewersConfig = { ...(baseProjectConfig.reviewers || {}) };
  const usesOpencodeReviewer = hosts.some(
    (host) => reviewerMap.get(host) === "opencode"
  );
  if (usesOpencodeReviewer) {
    reviewersConfig.opencode = {
      ...OPENCODE_REVIEWER_DEFAULTS,
      // Preserve any explicit overrides the user already set for opencode.
      ...(reviewersConfig.opencode || {}),
      // Always assert isolation: a user who wrote a writable opencode block must
      // not silently defeat enforced-mode isolation through this installer.
      readOnlyConfig: true,
    };
  }

  const newProjectConfig = {
    ...baseProjectConfig,
    hosts: hostsConfig,
  };
  // Only attach reviewers when there is something to write so buildProjectConfig
  // ToWrite's `if (newProjectConfig.reviewers)` guard stays accurate.
  if (Object.keys(reviewersConfig).length) {
    newProjectConfig.reviewers = reviewersConfig;
  }

  // Merge with DEFAULT_CONFIG and enforce policy floor.
  const resolvedConfig = mergeConfig(newProjectConfig, userPolicyFloor);

  // Serialize the config. For USER scope we write the full machine-wide config
  // (always include policy.mode and the reviewers block) so the user-level
  // defaults are explicit; for project scope we keep only what was explicitly
  // set or migrated (no DEFAULT_CONFIG boilerplate).
  const configToWrite = buildProjectConfigToWrite(
    newProjectConfig,
    resolvedConfig,
    userScope
  );
  const configJson = JSON.stringify(configToWrite, null, 2);

  // --- Collect planned writes ---

  const plannedWrites = [];

  // 1. Config (scope-aware). Project scope -> <cwd>/.adversarial-review/...;
  //    user scope -> <home>/.adversarial-review/... — a team-shared/committed
  //    file in either case, so mode 0o644.
  const projectConfigOutPath = path.join(scopeBase, PROJECT_CONFIG_REL);
  plannedWrites.push({
    path: projectConfigOutPath,
    content: configJson,
    note: userScope
      ? "User config (machine-wide defaults: ~/.adversarial-review/config.json)"
      : "Project config (.adversarial-review/config.json)",
    type: "project-config",
    mode: 0o644,
  });

  // 2. User-level install registry. Keyed by a NORMALIZED path so the same
  //    project never produces duplicate entries. User-level + secrets-adjacent:
  //    mode 0o600.
  const installRegistryPath = path.join(home, USER_INSTALL_REL);
  const existingRegistry = await readJsonTolerant(installRegistryPath);
  const registryEntry = {
    installedAt: new Date().toISOString(),
    scope: userScope ? "user" : "project",
    hosts,
    // Record reviewer mappings ONLY for hosts that were actually selected and
    // installed. Persisting the full reviewerMap would also store mappings for
    // hosts NOT in --hosts (those were already warned-about and ignored), giving
    // downstream tooling (doctor/audit) a false picture of reviewer coverage.
    reviewers: Object.fromEntries(
      hosts.filter((h) => reviewerMap.has(h)).map((h) => [h, reviewerMap.get(h)])
    ),
  };
  const registryKey = normalizeRegistryKey(userScope ? home : cwd);
  const updatedRegistry = {
    ...existingRegistry,
    [registryKey]: registryEntry,
  };
  plannedWrites.push({
    path: installRegistryPath,
    content: JSON.stringify(updatedRegistry, null, 2),
    note: "User-level install registry (~/.adversarial-review/install.json)",
    type: "install-registry",
    mode: 0o600,
  });

  // 2b. User-level policy.json FLOOR (~/.adversarial-review/policy.json).
  //
  // Without a floor, applyPolicyFloor's mode ratchet is a no-op, so a cloned
  // repo's .adversarial-review/config.json can silently downgrade the chosen
  // enforcement (e.g. enforced -> soft) — a full fail-open. We WRITE a tighten-
  // only floor capturing the resolved mode plus the fail-closed error actions,
  // ratcheting over (never clobbering) any existing stricter floor. Idempotent:
  // when the existing floor already covers every dimension, no write is queued.
  // User-level + security-sensitive -> mode 0o600.
  //
  // FINDING 1 (ROUND 5): the floor mode is derived from TRUSTED inputs ONLY —
  // the fail-closed minimum ("enforced"), any existing user floor, and an
  // explicit operator --mode flag. It is NEVER taken from resolvedConfig.policy
  // .mode, which (on a first install with no user floor) is the UNTRUSTED project
  // config: a cloned repo's `{"policy":{"mode":"soft"}}` would otherwise install
  // a `soft` floor (the weakest rank) and the tighten-only ratchet could never
  // recover — the gate would be installed fail-open.
  const chosenMode = resolveFloorMode(userPolicyFloor, explicitMode);
  const floorToWrite = computePolicyFloorToWrite(userPolicyFloor, chosenMode);
  if (floorToWrite) {
    plannedWrites.push({
      path: userPolicyPath,
      content: JSON.stringify(floorToWrite, null, 2),
      note:
        `User-level policy floor (~/.adversarial-review/policy.json: mode=${floorToWrite.policy.mode}, ` +
        `fail-closed) — prevents a cloned project's config from downgrading enforcement`,
      type: "policy-floor",
      mode: 0o600,
    });
  } else {
    io.stdout.write(
      `  NOTE: user policy floor at ${userPolicyPath} already enforces ` +
        `mode>=${chosenMode} (fail-closed); leaving it unchanged.\n`
    );
  }

  // FIX 3: pick the hook/wrapper command once. Prefer the direct bin name when
  // it resolves on PATH (global install — no per-Stop npx resolution); else use
  // `npx adversarial-review-gate`, which always works.
  const hookBin = await resolveHookBinCommand(env);

  // 3. Per-host integration files (native) or wrapper instructions.
  const wrapperInstructionsList = [];
  for (const host of hosts) {
    const hostInfo = HOSTS[host];
    if (hostInfo.enforcement === "native-enforced") {
      // Native host: compute planned file writes.
      if (host === "claude-code") {
        // CRITICAL: read the existing settings.json so we DEEP-MERGE rather than
        // clobber. If the file is corrupt, back it up to settings.json.bak before
        // we overwrite it with the merged result (which starts from {}). The
        // settings.json is a team-shared/committed file -> mode 0o644.
        const settingsPath = claudeCodeSettingsPath(scopeBase);
        const { settings: existingSettings, corrupt } =
          await readSettingsForMerge(settingsPath);
        if (corrupt && !dryRun) {
          await backupCorruptSettings(settingsPath, io);
        } else if (corrupt && dryRun) {
          io.stdout.write(
            `  NOTE: ${settingsPath} is not valid JSON; a real install would back ` +
              `it up to settings.json.bak and start fresh.\n`
          );
        }
        const nativeWrites = plannedClaudeCodeWrites({
          baseDir: scopeBase,
          binPath: hookBin.command,
          existingSettings,
        });
        for (const w of nativeWrites) {
          plannedWrites.push({
            path: w.path,
            content: w.content,
            note: w.note,
            type: "native-hook",
            mode: 0o644,
          });
        }
      }
    } else {
      // Wrapper host: collect printable instructions (no file writes).
      const instructions = wrapperInstructions({
        host,
        reviewer: reviewerMap.get(host),
        binPath: hookBin.command,
      });
      wrapperInstructionsList.push(instructions);
    }
  }

  // 4. FIX 2: ensure the opencode read-only agent exists when opencode is a
  // chosen reviewer. opencode SILENTLY falls back to the writable default agent
  // when this primary agent is missing, so the adapter's verify() rejects the
  // setup with `reviewer_agent_missing` until it exists. We ship the agent in
  // the package and copy it on install. IDEMPOTENT: never overwrite an existing
  // file (the user may have customized it) — only create when missing.
  if (usesOpencodeReviewer) {
    const opencodeAgentPath = path.join(home, OPENCODE_AGENT_REL);
    const agentAlreadyPresent = existsSync(opencodeAgentPath);
    let agentContent = "";
    if (!agentAlreadyPresent) {
      // Read the bundled agent markdown once so a single missing-bundle error
      // surfaces clearly instead of mid-write.
      agentContent = await readFile(BUNDLED_OPENCODE_AGENT_PATH, "utf8");
    }
    plannedWrites.push({
      path: opencodeAgentPath,
      content: agentContent,
      note: agentAlreadyPresent
        ? "opencode read-only agent (adversarial-reviewer.md) — already present, will be kept"
        : "opencode read-only agent (adversarial-reviewer.md) — mode:primary, read-only",
      type: "opencode-agent",
      // User-level shared agent: a normal-readable file -> 0o644.
      mode: 0o644,
      // Idempotency marker: when true the real-mode writer skips this entry.
      skipExisting: agentAlreadyPresent,
    });
  }

  // --- Dry-run: print and exit without writing ---

  if (dryRun) {
    io.stdout.write("adversarial-review install --dry-run: planned writes\n");
    io.stdout.write("(No files will be written in dry-run mode)\n\n");
    for (const w of plannedWrites) {
      // Idempotent entries that already exist on disk are listed as SKIP so the
      // dry-run accurately previews that the real run will keep the file.
      const tag = w.skipExisting ? "SKIP " : "WRITE";
      io.stdout.write(`  [${tag}] ${w.path}\n`);
      io.stdout.write(`          ${w.note}\n`);
    }
    if (wrapperInstructionsList.length) {
      io.stdout.write("\nWrapper-host instructions (no files written):\n");
      for (const inst of wrapperInstructionsList) {
        io.stdout.write(`\n  [WRAPPER] ${inst.host}\n`);
        io.stdout.write(`    Command: ${inst.wrapperCommand}\n`);
        io.stdout.write(`    Enforcement: ${inst.enforcement}\n`);
        io.stdout.write(`    Residual risk: ${inst.residualRisk}\n`);
      }
    }
    process.exitCode = 0;
    return;
  }

  // --- Real mode: write files ---

  for (const w of plannedWrites) {
    // FIX 2 idempotency: never overwrite an existing opencode agent (or any
    // entry flagged skipExisting) — the user may have customized it.
    if (w.skipExisting) {
      io.stdout.write(`Keeping ${w.path} (already present) ...\n`);
      io.stdout.write(`  SKIP: ${w.note}\n`);
      continue;
    }
    io.stdout.write(`Writing ${w.path} ...\n`);
    await atomicWrite(w.path, w.content, w.mode);
    io.stdout.write(`  OK: ${w.note}\n`);
  }

  if (wrapperInstructionsList.length) {
    io.stdout.write("\nWrapper-host instructions (no files written):\n");
    for (const inst of wrapperInstructionsList) {
      io.stdout.write(`\n  [WRAPPER] ${inst.host}\n`);
      io.stdout.write(`    Command: ${inst.wrapperCommand}\n`);
      io.stdout.write(`    Enforcement: ${inst.enforcement}\n`);
      io.stdout.write(`    Residual risk: ${inst.residualRisk}\n`);
    }
  }

  // FIX 3: when we fell back to npx, recommend a global install for lower
  // per-hook latency (npx resolves the package on every Stop event).
  if (!hookBin.direct) {
    io.stdout.write(
      "\nTip: install globally for lower per-hook latency: npm i -g adversarial-review-gate\n" +
        "     (the hook then runs `adversarial-review-gate` directly instead of resolving via npx).\n"
    );
  }

  io.stdout.write("\nadversarial-review install: complete.\n");
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Helper: build the project config object to serialize to disk.
// ---------------------------------------------------------------------------

// FINDING 2 (ROUND 5) — per-section key WHITELISTS for the config the installer
// WRITES. The installer used to shallow-copy EVERY key from the UNTRUSTED project
// config (overriding only reviewer/readOnlyConfig/agent), laundering hostile keys
// into the written (and, for --global, user-TRUSTED) config: e.g.
// `reviewers.<id>.command:"/bin/sh -c echo APPROVED"` (an always-pass custom
// command), `hosts.<h>.skipPatterns:["**/*"]`, `thresholds.bigDiffLines:999999`,
// or a `trusted:true` grant. We now keep ONLY known-safe keys per section and
// STRIP everything else (command, args, type, trusted, skipPatterns, unknown
// keys) before writing. The runtime trust floor (load-config.js) strips
// PROJECT-layer dangerous values at READ time; this strips them at WRITE time so
// they are never persisted (and never honored if the file is later read as a
// trusted user/global config).
const HOST_SAFE_KEYS = new Set(["reviewer"]);
const REVIEWER_SAFE_KEYS = new Set([
  "readOnlyConfig",
  "agent",
  "models",
  "requiredDimensions",
  "timeoutSec",
]);
const POLICY_SAFE_KEYS = new Set([
  "mode",
  "reviewScope",
  "onReviewerError",
  "onInternalError",
  "onBlockCap",
  "allowSkip",
  "allowAdvisoryHosts",
]);
const THRESHOLD_SAFE_KEYS = new Set([
  "bigDiffLines",
  "bigFileCount",
  "debateDiffLines",
  "debateFileCount",
  "debateOnSensitive",
]);
const RUNTIME_SAFE_KEYS = new Set([
  "blockCap",
  "stateTtlDays",
  "timeoutSec",
  "baselineRef",
]);
const PRIVACY_SAFE_KEYS = new Set([
  "externalReview",
  "secretScan",
  "tempFileMode",
]);
const SENSITIVITY_SAFE_KEYS = new Set(["extraSensitive", "extraCodeExts"]);

/**
 * Return a shallow copy of `obj` keeping ONLY keys present in `allowed`. Any
 * unknown / dangerous key is dropped. Non-object input yields {}.
 *
 * @param {*} obj
 * @param {Set<string>} allowed
 * @returns {object}
 */
function pickSafe(obj, allowed) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Whitelist-sanitize a `hosts` map: each host entry keeps only HOST_SAFE_KEYS
 * (currently just `reviewer`). Strips skipPatterns / trusted / command / unknown
 * keys an untrusted project may have injected.
 *
 * @param {*} hosts
 * @returns {object}
 */
function sanitizeHostsToWrite(hosts) {
  const out = {};
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return out;
  for (const [hostId, hostCfg] of Object.entries(hosts)) {
    out[hostId] = pickSafe(hostCfg, HOST_SAFE_KEYS);
  }
  return out;
}

/**
 * Whitelist-sanitize a `reviewers` map: each reviewer entry keeps only
 * REVIEWER_SAFE_KEYS. Strips command / args / type / trusted / unknown keys.
 *
 * @param {*} reviewers
 * @returns {object}
 */
function sanitizeReviewersToWrite(reviewers) {
  const out = {};
  if (!reviewers || typeof reviewers !== "object" || Array.isArray(reviewers)) return out;
  for (const [id, entry] of Object.entries(reviewers)) {
    out[id] = pickSafe(entry, REVIEWER_SAFE_KEYS);
  }
  return out;
}

/**
 * Build the config object to write.  For PROJECT scope we include only the keys
 * that are meaningful for a project config (not DEFAULT_CONFIG boilerplate),
 * plus the computed hosts/reviewers from the install run.  For USER scope
 * (fullMachineConfig=true) we always emit policy.mode and the reviewers block so
 * the machine-wide config is explicit and self-describing. We always run through
 * applyPolicyFloor to ensure we never loosen the user floor.
 *
 * Every section is WHITELIST-sanitized (FINDING 2): only known-safe keys survive,
 * so untrusted project-injected keys (command/args/type/trusted/skipPatterns and
 * any unknown key) are STRIPPED from what we persist.
 *
 * @param {object} newProjectConfig  - merged project + legacy + install config
 * @param {object} resolvedConfig    - fully resolved config (post applyPolicyFloor)
 * @param {boolean} [fullMachineConfig=false] - emit the full machine-wide config
 * @returns {object}
 */
function buildProjectConfigToWrite(newProjectConfig, resolvedConfig, fullMachineConfig = false) {
  // Start from the project-level config (not DEFAULT_CONFIG) so we don't
  // flood the project file with defaults. hosts is always whitelist-sanitized so
  // an injected per-host skipPatterns/trusted/command never lands on disk.
  const out = {
    version: resolvedConfig.version,
    hosts: sanitizeHostsToWrite(resolvedConfig.hosts),
  };

  // Carry over any explicit policy/threshold/runtime/privacy overrides — each
  // run through its per-section whitelist so only known-safe keys are written.
  if (newProjectConfig.policy) out.policy = pickSafe(resolvedConfig.policy, POLICY_SAFE_KEYS);
  if (newProjectConfig.thresholds) out.thresholds = pickSafe(resolvedConfig.thresholds, THRESHOLD_SAFE_KEYS);
  if (newProjectConfig.runtime) out.runtime = pickSafe(resolvedConfig.runtime, RUNTIME_SAFE_KEYS);
  if (newProjectConfig.privacy) out.privacy = pickSafe(resolvedConfig.privacy, PRIVACY_SAFE_KEYS);
  if (newProjectConfig.reviewers) out.reviewers = sanitizeReviewersToWrite(resolvedConfig.reviewers);
  if (newProjectConfig.sensitivity) out.sensitivity = pickSafe(resolvedConfig.sensitivity, SENSITIVITY_SAFE_KEYS);

  // USER scope: the machine-wide config must be self-describing. Always emit
  // policy.mode and the reviewers block even when no explicit override was given.
  if (fullMachineConfig) {
    if (!out.policy) out.policy = {};
    if (out.policy.mode === undefined) out.policy.mode = resolvedConfig.policy.mode;
    if (!out.reviewers) out.reviewers = sanitizeReviewersToWrite(resolvedConfig.reviewers);
  }

  return out;
}
