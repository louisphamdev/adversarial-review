// `adversarial-review uninstall` — remove our hook entries and registry entry.
//
// Flags:
//   --user / --global        operate on user scope (<home>/.claude/settings.json
//                            and <home>/.adversarial-review/config.json) instead
//                            of the project (cwd) scope.
//   --host <claude-code>     restrict to a single native host (default: all
//                            native hosts; currently only claude-code).
//   --remove-config          also delete <scope>/.adversarial-review/config.json.
//   --dry-run                print what WOULD change; touch nothing.
//
// Behavior (tolerant + idempotent):
//   - Remove ONLY our adversarial-review hook entries (dedupe key) from the
//     relevant .claude/settings.json; preserve every other key/hook.
//   - Optionally remove the scope's .adversarial-review/config.json.
//   - Remove this scope's entry from the install registry
//     (<home>/.adversarial-review/install.json).
//   - PRINT what it KEPT (it never deletes the shared opencode agent by default).

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  removeClaudeCodeHooks,
  detectClaudeCodeHooks,
  claudeCodeSettingsPath,
} from "../hosts/claude-code.js";
import { resolveHomeDir } from "../core/load-config.js";

const PROJECT_CONFIG_REL = path.join(".adversarial-review", "config.json");
const USER_INSTALL_REL = path.join(".adversarial-review", "install.json");
const OPENCODE_AGENT_REL = path.join(
  ".config",
  "opencode",
  "agent",
  "adversarial-reviewer.md"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tolerantly read+parse a JSON object file; returns {} on any error. */
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

/** Normalize a registry key (matches install.js): absolute + lowercased win32 drive. */
function normalizeRegistryKey(dir) {
  let resolved = path.resolve(dir);
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

/** Atomically write content (mode 0o644 — settings/config are team-shared). */
async function atomicWrite(filePath, content, mode = 0o644) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp${Date.now()}`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  const { rename } = await import("node:fs/promises");
  await rename(tmp, filePath);
}

/**
 * Parse uninstall argv.
 *
 * @param {string[]} argv
 * @returns {{ userScope: boolean, host: string|null, removeConfig: boolean, dryRun: boolean }}
 */
function parseArgs(argv) {
  let userScope = false;
  let host = null;
  let removeConfig = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user" || arg === "--global") {
      userScope = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--remove-config") {
      removeConfig = true;
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[i + 1].trim();
      i++;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length).trim();
    }
  }

  return { userScope, host, removeConfig, dryRun };
}

// ---------------------------------------------------------------------------
// Main uninstall command
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {object} io  - { stdin, stdout, stderr, env, cwd }
 */
export async function uninstallCommand(argv, io) {
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;
  const home = resolveHomeDir(env);

  const { userScope, host, removeConfig, dryRun } = parseArgs(argv);

  // Unknown --host value is a usage error (only claude-code is a native host).
  if (host && host !== "claude-code") {
    io.stderr.write(
      `adversarial-review uninstall: unsupported --host "${host}". ` +
        `Only "claude-code" has native hooks to remove.\n`
    );
    process.exitCode = 2;
    return;
  }

  const scopeBase = userScope ? home : cwd;
  const w = (s) => io.stdout.write(s);

  w(`adversarial-review uninstall${dryRun ? " --dry-run" : ""}: ${userScope ? "user" : "project"} scope\n`);

  // --- 1. Remove our hooks from .claude/settings.json (claude-code) ---
  const settingsPath = claudeCodeSettingsPath(scopeBase);
  if (existsSync(settingsPath)) {
    const existing = await readJsonTolerant(settingsPath);
    const before = detectClaudeCodeHooks(existing);
    if (before.sessionStart || before.stop) {
      const cleaned = removeClaudeCodeHooks(existing);
      if (dryRun) {
        w(`  WOULD remove adversarial-review hooks from ${settingsPath}\n`);
      } else {
        await atomicWrite(settingsPath, JSON.stringify(cleaned, null, 2), 0o644);
        w(`  Removed adversarial-review hooks from ${settingsPath}\n`);
      }
    } else {
      w(`  No adversarial-review hooks present in ${settingsPath} (nothing to remove).\n`);
    }
  } else {
    w(`  No .claude/settings.json at ${settingsPath} (nothing to remove).\n`);
  }

  // --- 2. Optionally remove the scope's config.json ---
  const configPath = path.join(scopeBase, PROJECT_CONFIG_REL);
  if (removeConfig) {
    if (existsSync(configPath)) {
      if (dryRun) {
        w(`  WOULD remove ${configPath}\n`);
      } else {
        await rm(configPath, { force: true });
        w(`  Removed ${configPath}\n`);
      }
    } else {
      w(`  No config at ${configPath} (nothing to remove).\n`);
    }
  } else if (existsSync(configPath)) {
    w(`  KEPT ${configPath} (pass --remove-config to delete it).\n`);
  }

  // --- 3. Remove this scope's entry from the install registry ---
  const installRegistryPath = path.join(home, USER_INSTALL_REL);
  const registryKey = normalizeRegistryKey(userScope ? home : cwd);
  if (existsSync(installRegistryPath)) {
    const registry = await readJsonTolerant(installRegistryPath);
    if (Object.prototype.hasOwnProperty.call(registry, registryKey)) {
      if (dryRun) {
        w(`  WOULD remove registry entry "${registryKey}" from ${installRegistryPath}\n`);
      } else {
        const { [registryKey]: _removed, ...rest } = registry;
        await atomicWrite(installRegistryPath, JSON.stringify(rest, null, 2), 0o600);
        w(`  Removed registry entry "${registryKey}" from ${installRegistryPath}\n`);
      }
    } else {
      w(`  No registry entry for "${registryKey}" (nothing to remove).\n`);
    }
  } else {
    w(`  No install registry at ${installRegistryPath} (nothing to remove).\n`);
  }

  // --- 4. Report what we KEPT (the shared opencode agent is never deleted) ---
  const opencodeAgentPath = path.join(home, OPENCODE_AGENT_REL);
  if (existsSync(opencodeAgentPath)) {
    w(
      `  KEPT shared opencode read-only agent at ${opencodeAgentPath} ` +
        `(shared machine-wide; delete it manually if no longer needed).\n`
    );
  }

  w(`\nadversarial-review uninstall: complete.\n`);
  process.exitCode = 0;
}
