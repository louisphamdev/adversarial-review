// Meta-test: the Claude Code plugin manifest (.claude-plugin/plugin.json) MUST stay
// valid and in lockstep with package.json.
//
// Why this exists (audit ROUND7): the published manifest had drifted to (a) a stale
// version ("2.1.0" while package.json was several patches ahead) and (b) an INVALID
// `hooks` schema — a FLAT STRING (`"SessionStart": "node ..."`) instead of the nested
// `[{ hooks: [{ type, command }] }]` array Claude Code requires. Either defect makes
// the plugin FAIL TO LOAD on a fresh `marketplace update` re-clone, which SILENTLY
// DISABLES the gate — the worst failure mode for a security/quality gate. Nothing kept
// the manifest in sync, so the drift went unnoticed. This test runs in `npm test` (CI)
// and `prepublishOnly`, so any future drift fails the pipeline instead of shipping a
// gate that quietly turns itself off.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));

describe("plugin manifest (.claude-plugin/plugin.json)", () => {
  it("version is in lockstep with package.json", () => {
    assert.equal(
      manifest.version,
      pkg.version,
      `plugin.json version (${manifest.version}) must equal package.json version (${pkg.version}). ` +
        `Bump BOTH on release (npm version updates package.json + lockfile; update plugin.json too).`
    );
  });

  it("hooks is the nested array schema, NOT a flat string", () => {
    assert.ok(manifest.hooks && typeof manifest.hooks === "object", "hooks must be an object");
    for (const event of ["SessionStart", "Stop"]) {
      const groups = manifest.hooks[event];
      assert.ok(Array.isArray(groups), `hooks.${event} must be an ARRAY of groups (flat string is invalid)`);
      assert.ok(groups.length >= 1, `hooks.${event} must have at least one group`);
      const leaves = groups[0].hooks;
      assert.ok(Array.isArray(leaves) && leaves.length >= 1, `hooks.${event}[0].hooks must be a non-empty array`);
      const leaf = leaves[0];
      assert.equal(leaf.type, "command", `hooks.${event}[0].hooks[0].type must be "command"`);
      assert.equal(typeof leaf.command, "string", `hooks.${event}[0].hooks[0].command must be a string`);
    }
  });

  it("hook commands invoke the bundled gate via ${CLAUDE_PLUGIN_ROOT} for the right event", () => {
    const sessionCmd = manifest.hooks.SessionStart[0].hooks[0].command;
    const stopCmd = manifest.hooks.Stop[0].hooks[0].command;
    for (const cmd of [sessionCmd, stopCmd]) {
      assert.ok(cmd.includes("${CLAUDE_PLUGIN_ROOT}"), `command must reference \${CLAUDE_PLUGIN_ROOT}: ${cmd}`);
      assert.ok(cmd.includes("bin/adversarial-review.js"), `command must invoke the bundled bin: ${cmd}`);
      assert.ok(cmd.includes("--host claude-code"), `command must target the claude-code host: ${cmd}`);
    }
    assert.ok(sessionCmd.includes("--event session-start"), "SessionStart command must use --event session-start");
    assert.ok(stopCmd.includes("--event stop"), "Stop command must use --event stop");
  });

  it("the Stop gate hook keeps a non-default timeout (a real review exceeds the ~60s default)", () => {
    // Without an explicit, generous timeout, Claude Code's default would KILL the Stop
    // hook mid-review; a killed Stop hook emits no {"decision":"block"} → fail-OPEN.
    const stopTimeout = manifest.hooks.Stop[0].hooks[0].timeout;
    assert.equal(typeof stopTimeout, "number", "Stop hook must set an explicit timeout (seconds)");
    assert.ok(stopTimeout >= 120, `Stop hook timeout (${stopTimeout}s) must be >= 120s so a real review is not killed`);
  });
});
