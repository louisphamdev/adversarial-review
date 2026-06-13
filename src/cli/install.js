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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { mergeConfig, applyPolicyFloor, DEFAULT_CONFIG } from "../core/config.js";
import { HOSTS } from "../hosts/index.js";
import { plannedClaudeCodeWrites } from "../hosts/claude-code.js";
import { wrapperInstructions } from "../hosts/wrapper.js";
import { createReviewer } from "../reviewers/index.js";

// Path constants (relative to cwd / home).
const PROJECT_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_POLICY_REL = path.join(".adversarial-review", "policy.json");
const USER_INSTALL_REL = path.join(".adversarial-review", "install.json");
const LEGACY_CONFIG_REL = path.join("hooks", "config.json");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse the install command's argv array into structured options.
 *
 * @param {string[]} argv
 * @returns {{ hosts: string[], reviewerMap: Map<string,string>, dryRun: boolean, projectConfigPath: string|null }}
 */
function parseArgs(argv) {
  const hosts = [];
  const reviewerMap = new Map();
  let dryRun = false;
  let projectConfigPath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
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

  return { hosts, reviewerMap, dryRun, projectConfigPath };
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

/** Resolve home directory from env, falling back to os.homedir(). */
function homeDir(env) {
  if (env) {
    const fromEnv = env.HOME || env.USERPROFILE;
    if (fromEnv) return fromEnv;
  }
  return os.homedir();
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
 * Verify that a reviewer id is available (its binary resolves on PATH).
 * "none" is always treated as available.
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
    return adapter.verify(env);
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
 * @param {string} filePath
 * @param {string} content
 */
async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp${Date.now()}`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  // node:fs rename is atomic on POSIX; on Windows it will overwrite on Node 14+.
  const { rename } = await import("node:fs/promises");
  await rename(tmp, filePath);
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
  const home = homeDir(env);

  const { hosts, reviewerMap, dryRun, projectConfigPath } = parseArgs(argv);

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

  // --- Load existing project config (from explicit path or default location) ---
  const projectConfigPath2 = projectConfigPath || path.join(cwd, PROJECT_CONFIG_REL);
  const existingProjectConfig = await readJsonTolerant(projectConfigPath2);

  // --- Read legacy config and merge ---
  const legacyFragment = await readLegacyConfig(cwd);

  // Build initial project config by layering: DEFAULT_CONFIG <- legacy <- existing.
  // We do NOT write legacy values if the existing config already has them.
  const baseProjectConfig = Object.assign({}, legacyFragment, existingProjectConfig);

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

  const newProjectConfig = {
    ...baseProjectConfig,
    hosts: hostsConfig,
  };

  // Merge with DEFAULT_CONFIG and enforce policy floor.
  const resolvedConfig = mergeConfig(newProjectConfig, userPolicyFloor);

  // Serialize the project-level config (strip runtime defaults that came from
  // DEFAULT_CONFIG; keep only what was explicitly set or migrated).
  const configToWrite = buildProjectConfigToWrite(newProjectConfig, resolvedConfig);
  const configJson = JSON.stringify(configToWrite, null, 2);

  // --- Collect planned writes ---

  const plannedWrites = [];

  // 1. Project config.
  const projectConfigOutPath = path.join(cwd, PROJECT_CONFIG_REL);
  plannedWrites.push({
    path: projectConfigOutPath,
    content: configJson,
    note: "Project config (.adversarial-review/config.json)",
    type: "project-config",
  });

  // 2. User-level install registry.
  const installRegistryPath = path.join(home, USER_INSTALL_REL);
  const existingRegistry = await readJsonTolerant(installRegistryPath);
  const registryEntry = {
    installedAt: new Date().toISOString(),
    hosts,
    reviewers: Object.fromEntries(reviewerMap),
  };
  const updatedRegistry = {
    ...existingRegistry,
    [cwd]: registryEntry,
  };
  plannedWrites.push({
    path: installRegistryPath,
    content: JSON.stringify(updatedRegistry, null, 2),
    note: "User-level install registry (~/.adversarial-review/install.json)",
    type: "install-registry",
  });

  // 3. Per-host integration files (native) or wrapper instructions.
  const wrapperInstructionsList = [];
  for (const host of hosts) {
    const hostInfo = HOSTS[host];
    if (hostInfo.enforcement === "native-enforced") {
      // Native host: compute planned file writes.
      if (host === "claude-code") {
        const nativeWrites = plannedClaudeCodeWrites({ cwd });
        for (const w of nativeWrites) {
          plannedWrites.push({
            path: w.path,
            content: w.content,
            note: w.note,
            type: "native-hook",
          });
        }
      }
    } else {
      // Wrapper host: collect printable instructions (no file writes).
      const instructions = wrapperInstructions({
        host,
        reviewer: reviewerMap.get(host),
      });
      wrapperInstructionsList.push(instructions);
    }
  }

  // --- Dry-run: print and exit without writing ---

  if (dryRun) {
    io.stdout.write("adversarial-review install --dry-run: planned writes\n");
    io.stdout.write("(No files will be written in dry-run mode)\n\n");
    for (const w of plannedWrites) {
      io.stdout.write(`  [WRITE] ${w.path}\n`);
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
    io.stdout.write(`Writing ${w.path} ...\n`);
    await atomicWrite(w.path, w.content);
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

  io.stdout.write("\nadversarial-review install: complete.\n");
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Helper: build the project config object to serialize to disk.
// ---------------------------------------------------------------------------

/**
 * Build the project config object to write.  We include only the keys that
 * are meaningful for a project config (not DEFAULT_CONFIG boilerplate), plus
 * the computed hosts/reviewers from the install run.  We always run through
 * applyPolicyFloor to ensure we never loosen the user floor.
 *
 * @param {object} newProjectConfig  - merged project + legacy + install config
 * @param {object} resolvedConfig    - fully resolved config (post applyPolicyFloor)
 * @returns {object}
 */
function buildProjectConfigToWrite(newProjectConfig, resolvedConfig) {
  // Start from the project-level config (not DEFAULT_CONFIG) so we don't
  // flood the project file with defaults.
  const out = {
    version: resolvedConfig.version,
    hosts: resolvedConfig.hosts,
  };

  // Carry over any explicit policy/threshold/runtime/privacy overrides.
  if (newProjectConfig.policy) out.policy = resolvedConfig.policy;
  if (newProjectConfig.thresholds) out.thresholds = resolvedConfig.thresholds;
  if (newProjectConfig.runtime) out.runtime = resolvedConfig.runtime;
  if (newProjectConfig.privacy) out.privacy = resolvedConfig.privacy;
  if (newProjectConfig.reviewers) out.reviewers = resolvedConfig.reviewers;
  if (newProjectConfig.sensitivity) out.sensitivity = resolvedConfig.sensitivity;

  return out;
}
