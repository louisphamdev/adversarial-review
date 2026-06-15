// Tests for plugin-armed-gate detection (src/hosts/claude-code-plugin.js).
//
// doctor's settings.json-only hook check is a FALSE NEGATIVE for a gate armed via the
// Claude Code PLUGIN system (plugin hooks are loaded from the installed manifest, never
// written into settings.json). This detector reads Claude Code's on-disk plugin state.
// For a security gate it must count the gate as armed ONLY when the plugin is installed
// AND enabled AND its manifest provides valid canonical hooks — never a false "enforced".

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectClaudeCodePluginGate } from "../../src/hosts/claude-code-plugin.js";
import { detectClaudeCodeHooks } from "../../src/hosts/claude-code.js";

// A VALID nested-schema hooks block whose commands pass the strict canonical matcher.
// Single-quoted so ${CLAUDE_PLUGIN_ROOT} stays a LITERAL (not JS interpolation).
function validHooks() {
  const cmd = (ev) =>
    'node "${CLAUDE_PLUGIN_ROOT}/bin/adversarial-review.js" hook --host claude-code --event ' + ev;
  return {
    SessionStart: [{ hooks: [{ type: "command", command: cmd("session-start"), timeout: 60 }] }],
    Stop: [{ hooks: [{ type: "command", command: cmd("stop"), timeout: 300 }] }],
  };
}

// Canonical command strings but under a NON-command hook type (Claude Code only runs
// `type:"command"` hooks, so these would NOT actually arm the gate).
function nonCommandHooks() {
  const cmd = (ev) =>
    'node "${CLAUDE_PLUGIN_ROOT}/bin/adversarial-review.js" hook --host claude-code --event ' + ev;
  return {
    SessionStart: [{ hooks: [{ type: "prompt", command: cmd("session-start") }] }],
    Stop: [{ hooks: [{ type: "prompt", command: cmd("stop") }] }],
  };
}

// The OLD invalid flat-string schema (what shipped broken pre-2.2.4).
function flatHooks() {
  return {
    SessionStart: 'node "${CLAUDE_PLUGIN_ROOT}/bin/adversarial-review.js" hook --host claude-code --event session-start',
    Stop: 'node "${CLAUDE_PLUGIN_ROOT}/bin/adversarial-review.js" hook --host claude-code --event stop',
  };
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

describe("detectClaudeCodePluginGate", () => {
  let home;
  let cwd;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "ar-pg-home-"));
    cwd = await mkdtemp(path.join(tmpdir(), "ar-pg-cwd-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  // Install our plugin under `marketplace` with the given manifest + enabled state.
  async function installPlugin({
    marketplace = "adversarial-review",
    version = "2.2.4",
    hooks = validHooks(),
    enabled, // true | false | undefined (omit the enabledPlugins entry)
    defaultEnabled, // optional manifest field
    name = "adversarial-review", // the plugin-NAME part of the install key
    manifestName, // the manifest `name`; defaults to `name` (override to test mismatch)
  } = {}) {
    const key = `${name}@${marketplace}`;
    const installPath = path.join(home, ".claude", "plugins", "cache", marketplace, name, version);
    await writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { [key]: [{ scope: "user", installPath, version }] },
    });
    const manifest = { name: manifestName || name, version, hooks };
    if (defaultEnabled !== undefined) manifest.defaultEnabled = defaultEnabled;
    await writeJson(path.join(installPath, ".claude-plugin", "plugin.json"), manifest);
    if (enabled !== undefined) {
      await writeJson(path.join(home, ".claude", "settings.json"), { enabledPlugins: { [key]: enabled } });
    }
    return { key, installPath };
  }

  it("installed + enabled + valid hooks => registered", async () => {
    await installPlugin({ enabled: true });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, true);
    assert.equal(g.enabled, true);
    assert.equal(g.providesHooks, true);
    assert.equal(g.registered, true);
  });

  it("installed but DISABLED => NOT registered (no false 'enforced')", async () => {
    await installPlugin({ enabled: false });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, true);
    assert.equal(g.enabled, false);
    assert.equal(g.registered, false);
    assert.equal(g.reason, "plugin_disabled");
  });

  it("enabled but manifest hooks are the broken flat-string schema => NOT registered", async () => {
    await installPlugin({ enabled: true, hooks: flatHooks() });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.enabled, true);
    assert.equal(g.providesHooks, false);
    assert.equal(g.registered, false);
    assert.equal(g.reason, "manifest_hooks_invalid_or_stale");
  });

  it("installed with NO enabledPlugins entry => default-enabled => registered", async () => {
    await installPlugin({ enabled: undefined }); // omit the entry entirely
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.enabled, true, "an installed plugin is enabled by default");
    assert.equal(g.registered, true);
  });

  it("manifest defaultEnabled:false with no explicit entry => disabled", async () => {
    await installPlugin({ enabled: undefined, defaultEnabled: false });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.enabled, false);
    assert.equal(g.registered, false);
  });

  it("matches our plugin under ANY marketplace name (matched by plugin name)", async () => {
    await installPlugin({ marketplace: "some-private-market", enabled: true });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.registered, true);
    assert.ok(g.key.startsWith("adversarial-review@"));
  });

  it("no installed_plugins.json => not installed (tolerant)", () => {
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, false);
    assert.equal(g.registered, false);
    assert.equal(g.reason, "no_installed_plugins_record");
  });

  it("installed_plugins.json present but our plugin absent => plugin_not_installed", async () => {
    await writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "something-else@market": [{ scope: "user", installPath: "/x", version: "1.0.0" }] },
    });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, false);
    assert.equal(g.reason, "plugin_not_installed");
  });

  it("a project-scope disable overrides a user-scope enable (most-specific wins)", async () => {
    const { key } = await installPlugin({ enabled: true }); // user scope = enabled
    // project scope explicitly disables
    await writeJson(path.join(cwd, ".claude", "settings.json"), { enabledPlugins: { [key]: false } });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.enabled, false, "project-scope disable must win over user-scope enable");
    assert.equal(g.registered, false);
  });

  it("enabled but manifest hooks use a NON-command type => NOT registered (false-positive guard)", async () => {
    await installPlugin({ enabled: true, hooks: nonCommandHooks() });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.enabled, true);
    assert.equal(g.providesHooks, false, "a type:'prompt' leaf does not execute → does not arm the gate");
    assert.equal(g.registered, false);
  });

  it("manifest `name` mismatch with the install key => NOT registered (impersonation/stale guard)", async () => {
    // Key is adversarial-review@market (so it is FOUND), but the manifest identifies a
    // DIFFERENT plugin while carrying canonical-looking hooks.
    await installPlugin({ enabled: true, manifestName: "not-adversarial-review" });
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, true);
    assert.equal(g.providesHooks, false, "a foreign manifest's hooks must not count as ours");
    assert.equal(g.registered, false);
  });

  it("matcher itself rejects a non-command leaf (detectClaudeCodeHooks)", () => {
    const det = detectClaudeCodeHooks({ hooks: nonCommandHooks() });
    assert.equal(det.sessionStart, false);
    assert.equal(det.stop, false);
  });

  it("corrupt installed_plugins.json is tolerated (not installed)", async () => {
    const f = path.join(home, ".claude", "plugins", "installed_plugins.json");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "{ this is not json", "utf8");
    const g = detectClaudeCodePluginGate({ home, cwd });
    assert.equal(g.installed, false);
    assert.equal(g.reason, "no_installed_plugins_record");
  });
});
