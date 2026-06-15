// Detect whether the adversarial-review gate is armed via a Claude Code PLUGIN
// (marketplace / local-directory install) rather than a native settings.json install.
//
// WHY THIS EXISTS (audit ROUND7 follow-up): Claude Code does NOT write a plugin's
// hooks into .claude/settings.json — it loads them at runtime from the installed
// plugin's manifest. So `doctor`'s settings.json-only hook check reports "hooks NOT
// registered" for a gate armed purely by the plugin: a FALSE NEGATIVE that makes
// doctor exit non-zero (and a CI step gate on it) even though the gate is actually
// enforcing. This module reads Claude Code's on-disk plugin state so doctor can also
// recognize the plugin-armed case.
//
// Sources read (all tolerant — any missing/corrupt file degrades to "not detected",
// never throws):
//   <home>/.claude/plugins/installed_plugins.json  — which plugins are installed +
//        their absolute installPath(s). Schema (v2): { plugins: { "<name>@<market>":
//        [ { scope, installPath, version }, ... ] } }.
//   enabledPlugins in settings (local project > project > user scope) — the
//        enabled/disabled record: { "<name>@<market>": true|false }.
//   <installPath>/.claude-plugin/plugin.json — the installed manifest, whose `hooks`
//        block is validated with the SAME strict canonical matcher used for
//        settings.json (detectClaudeCodeHooks).
//
// SECURITY DIRECTION: for a gate, a FALSE POSITIVE ("enforced" when it is not) is the
// dangerous error — it gives false confidence. So the gate is counted as armed via the
// plugin ONLY when the plugin is installed AND ENABLED AND its manifest provides VALID
// canonical SessionStart + Stop hooks. An installed-but-disabled plugin, or one whose
// manifest hooks are stale/broken (e.g. the old flat-string schema), is reported as
// NOT enforcing — accurately.

import { readFileSync } from "node:fs";
import path from "node:path";
import { detectClaudeCodeHooks, detectTamperedClaudeCodeHooks } from "./claude-code.js";

/** Read + tolerantly parse a JSON object file. Returns null on any error / non-object. */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Split an installed-plugin key "<name>@<marketplace>" into its parts. Plugin names
 * do not contain "@", but split on the LAST "@" defensively so a marketplace name is
 * never mistaken for part of the plugin name.
 *
 * @param {string} key
 * @returns {{ name: string, marketplace: string }}
 */
function splitPluginKey(key) {
  const s = String(key);
  const at = s.lastIndexOf("@");
  if (at <= 0) return { name: s, marketplace: "" };
  return { name: s.slice(0, at), marketplace: s.slice(at + 1) };
}

/**
 * Resolve the EXPLICIT enabled state for a plugin key across settings scopes, most
 * specific first (local project > project > user). The first scope that DEFINES the
 * key wins. Returns:
 *   true      — explicitly enabled (value === true);
 *   false     — explicitly present but not true (treated as disabled);
 *   undefined — not set in any scope (caller applies the default-enabled rule).
 *
 * @param {string} key
 * @param {Array<object|undefined>} enabledMaps  - enabledPlugins maps, specific-first
 * @returns {boolean|undefined}
 */
function resolveExplicitEnabled(key, enabledMaps) {
  for (const map of enabledMaps) {
    if (map && Object.prototype.hasOwnProperty.call(map, key)) {
      return map[key] === true;
    }
  }
  return undefined;
}

/** Rank a candidate so the STRONGEST install record (registered > provides > installed) wins. */
function rankCandidate(c) {
  return (c.registered ? 4 : 0) + (c.providesHooks ? 2 : 0) + (c.enabled ? 1 : 0);
}

/**
 * Detect whether OUR plugin arms the gate via Claude Code's plugin system.
 *
 * @param {object} options
 * @param {string} options.home          - resolved user home (its .claude/ holds plugin state)
 * @param {string} options.cwd           - workspace root (for project/local settings scope)
 * @param {string} [options.pluginName]  - our plugin name (matches the manifest `name`)
 * @returns {{
 *   installed: boolean, enabled: boolean, providesHooks: boolean, registered: boolean,
 *   tampered: boolean, key: string|null, installPath: string|null, version: string|null,
 *   reason: string|null
 * }}
 */
export function detectClaudeCodePluginGate({ home, cwd, pluginName = "adversarial-review" }) {
  const none = {
    installed: false, enabled: false, providesHooks: false, registered: false,
    tampered: false, key: null, installPath: null, version: null, reason: null,
  };

  const installed = readJsonObject(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  if (!installed || !installed.plugins || typeof installed.plugins !== "object" || Array.isArray(installed.plugins)) {
    return { ...none, reason: "no_installed_plugins_record" };
  }

  // Our plugin may be installed under ANY marketplace name (a local-directory
  // marketplace, the public one, etc.), so match on the plugin-NAME part of the key.
  const matchingKeys = Object.keys(installed.plugins).filter(
    (k) => splitPluginKey(k).name === pluginName
  );
  if (matchingKeys.length === 0) {
    return { ...none, reason: "plugin_not_installed" };
  }

  // enabledPlugins maps in scope-precedence order (most specific first). cwd-scoped
  // settings only apply when a workspace is given.
  const enabledMaps = [
    cwd ? readJsonObject(path.join(cwd, ".claude", "settings.local.json"))?.enabledPlugins : undefined,
    cwd ? readJsonObject(path.join(cwd, ".claude", "settings.json"))?.enabledPlugins : undefined,
    readJsonObject(path.join(home, ".claude", "settings.json"))?.enabledPlugins,
  ];

  let best = null;
  for (const key of matchingKeys) {
    const entries = Array.isArray(installed.plugins[key]) ? installed.plugins[key] : [];
    const explicit = resolveExplicitEnabled(key, enabledMaps);
    for (const entry of entries) {
      const installPath =
        entry && typeof entry.installPath === "string" && entry.installPath ? entry.installPath : null;
      const manifest = installPath
        ? readJsonObject(path.join(installPath, ".claude-plugin", "plugin.json"))
        : null;
      // Only trust the manifest's hooks when its `name` actually matches OUR plugin.
      // The installed-plugins KEY is staleness-/impersonation-influenced, but Claude
      // Code derives that key from the manifest `name` at install time, so a key whose
      // name-part matches ours yet whose manifest `name` differs is a stale/foreign
      // record — its (possibly canonical-looking) hooks must NOT count toward our gate.
      // (audit ROUND7 / GPT-5.5-xhigh, doctor-plugin)
      const manifestIsOurs = Boolean(manifest && manifest.name === pluginName);
      const hooksObj = manifestIsOurs && manifest.hooks ? { hooks: manifest.hooks } : { hooks: {} };
      const hooks = detectClaudeCodeHooks(hooksObj);
      const tamperedDet = detectTamperedClaudeCodeHooks(hooksObj);
      const providesHooks = Boolean(hooks.sessionStart && hooks.stop);
      // Default-enabled semantics (Claude Code): an installed plugin is ENABLED unless
      // explicitly disabled, or its manifest opts out via defaultEnabled:false.
      let enabled;
      if (explicit === false) enabled = false;
      else if (explicit === true) enabled = true;
      else enabled = manifest && manifest.defaultEnabled === false ? false : true;
      const candidate = {
        installed: true,
        enabled,
        providesHooks,
        registered: enabled && providesHooks,
        tampered: Boolean(tamperedDet.sessionStart || tamperedDet.stop),
        key,
        installPath,
        version: (entry && entry.version) || (manifestIsOurs && manifest.version) || null,
        reason: null,
      };
      if (!best || rankCandidate(candidate) > rankCandidate(best)) best = candidate;
    }
  }

  if (!best) return { ...none, installed: true, reason: "no_readable_install_record" };
  if (!best.registered && !best.reason) {
    best.reason = !best.enabled
      ? "plugin_disabled"
      : !best.providesHooks
        ? "manifest_hooks_invalid_or_stale"
        : null;
  }
  return best;
}
