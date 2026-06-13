// `adversarial-review doctor` — diagnostics for config, hosts, and reviewers.
//
// Reads (never writes) all config sources, checks reviewer availability, and
// reports a human-readable (or --json) summary with explicit WARNINGS for
// wrapper/advisory hosts.
//
// Exit codes:
//   0 - all checks passed (or completed with warnings)
//   1 - a fatal error was encountered (corrupt package.json, etc.)

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { HOSTS } from "../hosts/index.js";
import { createReviewer } from "../reviewers/index.js";
import { loadEffectiveConfig } from "../core/load-config.js";

// Paths relative to home / cwd.
const PROJECT_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_POLICY_REL = path.join(".adversarial-review", "policy.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve home from env, falling back to os.homedir(). Honors
 * ADVERSARIAL_REVIEW_HOME so doctor reports the SAME user-level base that
 * loadEffectiveConfig (the gate's loader) uses. */
function homeDir(env) {
  if (env) {
    const fromEnv = env.ADVERSARIAL_REVIEW_HOME || env.HOME || env.USERPROFILE;
    if (fromEnv) return fromEnv;
  }
  return os.homedir();
}

/** Read package.json to get the package version. */
async function readPackageVersion() {
  try {
    // Walk up from this file to find package.json.
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.join(path.dirname(thisFile), "..", "..", "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/** Check whether a reviewer is available; return { ok, resolvedPath, version, capabilities, reason }. */
async function checkReviewer(reviewerId, config, env) {
  if (reviewerId === "none") {
    return { ok: true, note: "native self-review (no external process)" };
  }
  try {
    const adapter = createReviewer(reviewerId, config);
    return adapter.verify(env);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main doctor command
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function doctorCommand(argv, io) {
  const json = argv.includes("--json");
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;
  const home = homeDir(env);

  // Read package version.
  const version = await readPackageVersion();

  // Locate config files.
  const projectConfigPath = path.join(cwd, PROJECT_CONFIG_REL);
  const userConfigPath = path.join(home, USER_CONFIG_REL);
  const userPolicyPath = path.join(home, USER_POLICY_REL);

  const projectConfigExists = existsSync(projectConfigPath);
  const userConfigExists = existsSync(userConfigPath);
  const userPolicyExists = existsSync(userPolicyPath);

  // Validate project config (simple validity check).
  let projectConfigValid = false;
  if (projectConfigExists) {
    try {
      const raw = await readFile(projectConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      projectConfigValid = parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      projectConfigValid = false;
    }
  }

  // Effective config — use the SAME loader the gate uses so the report matches
  // runtime reality: DEFAULT < user config (~/.adversarial-review/config.json) <
  // project config, then the user policy floor applied on top. (The old doctor
  // loader ignored the user-level config.json and under-reported configured
  // hosts.)
  const effectiveConfig = await loadEffectiveConfig(cwd, io);

  // Enumerate configured hosts.
  const configuredHostIds = Object.keys(effectiveConfig.hosts || {});
  const hostReports = [];
  const warnings = [];

  for (const hostId of configuredHostIds) {
    const hostInfo = HOSTS[hostId];
    const hostConfig = effectiveConfig.hosts[hostId] || {};
    const reviewerId = hostConfig.reviewer || "none";

    // Check reviewer.
    const reviewerResult = await checkReviewer(reviewerId, effectiveConfig, env);

    const hostReport = {
      id: hostId,
      enforcement: hostInfo ? hostInfo.enforcement : "unknown",
      capabilities: hostInfo || null,
      reviewer: reviewerId,
      reviewerAvailable: reviewerResult.ok,
      reviewerPath: reviewerResult.resolvedPath || null,
      reviewerVersion: reviewerResult.version || null,
      reviewerCapabilities: reviewerResult.capabilities || null,
      reviewerNote: reviewerResult.note || null,
      reviewerReason: reviewerResult.reason || null,
    };
    hostReports.push(hostReport);

    // Warn about wrapper/advisory hosts.
    if (hostInfo && hostInfo.enforcement === "wrapper-enforced") {
      warnings.push(
        `WARNING: Host "${hostId}" is wrapper-enforced. Enforcement depends on the user ` +
          `always invoking ${hostId} through \`adversarial-review run --host ${hostId}\`. ` +
          `Bypassing the wrapper skips the review gate entirely. ` +
          `This is NOT equivalent to native enforcement.`
      );
    }
    if (!reviewerResult.ok && reviewerId !== "none") {
      warnings.push(
        `WARNING: Reviewer "${reviewerId}" for host "${hostId}" is unavailable: ` +
          `${reviewerResult.reason || "unknown"}`
      );
    }
  }

  // Effective enforcement level.
  const hasNativeHost = hostReports.some((h) => h.enforcement === "native-enforced");
  const hasWrapperOnlyHosts =
    hostReports.length > 0 && hostReports.every((h) => h.enforcement === "wrapper-enforced");
  const effectiveEnforcement = hasNativeHost
    ? "native-enforced"
    : hasWrapperOnlyHosts
      ? "wrapper-enforced (advisory)"
      : "none";

  // Build the report object.
  const report = {
    version,
    projectConfigPath,
    projectConfigExists,
    projectConfigValid: projectConfigExists ? projectConfigValid : null,
    userConfigPath,
    userConfigExists,
    userPolicyPath,
    userPolicyExists,
    privacyMode: effectiveConfig.privacy?.externalReview || "allow",
    policyMode: effectiveConfig.policy?.mode || "enforced",
    effectiveEnforcement,
    allowAdvisoryHosts: effectiveConfig.policy?.allowAdvisoryHosts ?? false,
    hosts: hostReports,
    warnings,
  };

  if (json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report, io);
  }

  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------

function printHumanReport(report, io) {
  const w = (s) => io.stdout.write(s);

  w(`adversarial-review v${report.version}\n`);
  w(`\nProject config: ${report.projectConfigPath}\n`);
  if (!report.projectConfigExists) {
    w(`  (not found — using defaults)\n`);
  } else if (!report.projectConfigValid) {
    w(`  ERROR: file exists but is not valid JSON\n`);
  } else {
    w(`  (valid)\n`);
  }

  w(`\nUser config (machine-wide defaults): ${report.userConfigPath}\n`);
  if (!report.userConfigExists) {
    w(`  (not found — no machine-wide host/reviewer defaults)\n`);
  } else {
    w(`  (present)\n`);
  }

  w(`\nUser policy floor: ${report.userPolicyPath}\n`);
  if (!report.userPolicyExists) {
    w(`  (not found — no user-level floor enforced)\n`);
  } else {
    w(`  (present)\n`);
  }

  w(`\nEffective policy:\n`);
  w(`  mode:                ${report.policyMode}\n`);
  w(`  enforcement:         ${report.effectiveEnforcement}\n`);
  w(`  allowAdvisoryHosts:  ${report.allowAdvisoryHosts}\n`);
  w(`  privacyMode:         ${report.privacyMode}\n`);

  if (report.hosts.length === 0) {
    w(`\nHosts: (none configured)\n`);
  } else {
    w(`\nHosts:\n`);
    for (const h of report.hosts) {
      w(`  ${h.id} (${h.enforcement})\n`);
      w(`    reviewer: ${h.reviewer}\n`);
      if (h.reviewer === "none") {
        w(`    reviewer status: native self-review\n`);
      } else if (h.reviewerAvailable) {
        w(`    reviewer status: available\n`);
        if (h.reviewerPath) w(`    reviewer path:   ${h.reviewerPath}\n`);
        if (h.reviewerVersion) w(`    reviewer version: ${h.reviewerVersion}\n`);
        if (h.reviewerCapabilities) {
          w(`    reviewer capabilities: ${JSON.stringify(h.reviewerCapabilities)}\n`);
        }
      } else {
        w(`    reviewer status: UNAVAILABLE (${h.reviewerReason || "unknown"})\n`);
      }
    }
  }

  if (report.warnings.length > 0) {
    w(`\nWarnings:\n`);
    for (const warning of report.warnings) {
      w(`  ${warning}\n`);
    }
  } else {
    w(`\nNo warnings.\n`);
  }
}
