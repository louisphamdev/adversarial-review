import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEffectiveConfig, resolveStateDir } from "../../src/core/load-config.js";

// ---------------------------------------------------------------------------
// loadEffectiveConfig: user-level config provides machine-wide defaults
//
// Precedence (lowest -> highest):
//   DEFAULT_CONFIG < userConfig (<home>/.adversarial-review/config.json)
//                  < projectConfig (<cwd>/.adversarial-review/config.json)
// then the user policy floor (<home>/.adversarial-review/policy.json) is applied
// LAST so it can only ratchet stricter.
//
// We redirect the user-level base via the ADVERSARIAL_REVIEW_HOME env override so
// no real home dir is touched.
// ---------------------------------------------------------------------------

const CONFIG_REL = join(".adversarial-review", "config.json");
const POLICY_REL = join(".adversarial-review", "policy.json");

async function writeJson(file, obj) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(obj), "utf8");
}

describe("loadEffectiveConfig with user-level config", () => {
  let home; // fake user home (ADVERSARIAL_REVIEW_HOME)
  let cwd; // fake project workspace

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "ar-loadcfg-home-"));
    cwd = await mkdtemp(join(tmpdir(), "ar-loadcfg-cwd-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Start each test from a clean slate (remove any config/policy from prior tests).
    await rm(join(home, ".adversarial-review"), { recursive: true, force: true });
    await rm(join(cwd, ".adversarial-review"), { recursive: true, force: true });
  });

  const io = () => ({ env: { ADVERSARIAL_REVIEW_HOME: home } });

  it("applies a user-level config when no project config exists", async () => {
    // Machine-wide default: claude-code reviewer is opencode.
    await writeJson(join(home, CONFIG_REL), {
      hosts: { "claude-code": { reviewer: "opencode" } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.hosts["claude-code"].reviewer, "opencode");
  });

  it("project config OVERRIDES user config for the same key", async () => {
    await writeJson(join(home, CONFIG_REL), {
      hosts: { "claude-code": { reviewer: "opencode" } },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      hosts: { "claude-code": { reviewer: "codex" } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(
      cfg.hosts["claude-code"].reviewer,
      "codex",
      "project config wins over user config for the same key"
    );
  });

  it("user config defaults survive where project config does not override", async () => {
    // User sets two hosts; project only overrides one of them.
    await writeJson(join(home, CONFIG_REL), {
      hosts: {
        "claude-code": { reviewer: "opencode" },
        codex: { reviewer: "opencode" },
      },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      hosts: { "claude-code": { reviewer: "gemini" } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.hosts["claude-code"].reviewer, "gemini", "project override applies");
    assert.equal(cfg.hosts["codex"].reviewer, "opencode", "untouched user default survives");
  });

  it("user policy floor cannot be loosened by user config", async () => {
    // Floor requires strict-ci; user config tries to relax to soft.
    await writeJson(join(home, POLICY_REL), { policy: { mode: "strict-ci" } });
    await writeJson(join(home, CONFIG_REL), { policy: { mode: "soft", allowSkip: true } });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "strict-ci", "floor ratchets mode back to strict-ci");
  });

  it("user policy floor cannot be loosened by project config", async () => {
    // Floor requires strict-ci; project config tries to relax to soft.
    await writeJson(join(home, POLICY_REL), { policy: { mode: "strict-ci" } });
    await writeJson(join(cwd, CONFIG_REL), { policy: { mode: "soft", allowSkip: true } });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "strict-ci", "floor ratchets mode back to strict-ci");
  });

  it("user policy floor cannot be loosened even when both user+project config say soft", async () => {
    await writeJson(join(home, POLICY_REL), {
      policy: { mode: "strict-ci", allowSkip: false },
    });
    await writeJson(join(home, CONFIG_REL), { policy: { mode: "soft", allowSkip: true } });
    await writeJson(join(cwd, CONFIG_REL), { policy: { mode: "soft", allowSkip: true } });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "strict-ci");
    assert.equal(cfg.policy.allowSkip, false);
  });

  it("missing user config + missing project config falls back to defaults", async () => {
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "enforced");
    assert.equal(cfg.policy.reviewScope, "all-code");
  });

  it("corrupt user config is ignored with a stderr warning", async () => {
    await mkdir(join(home, ".adversarial-review"), { recursive: true });
    await writeFile(join(home, CONFIG_REL), "{ this is not json", "utf8");

    let warned = "";
    const cfg = await loadEffectiveConfig(cwd, {
      env: { ADVERSARIAL_REVIEW_HOME: home },
      stderr: { write: (s) => (warned += s) },
    });
    // Falls back to defaults; warning mentions the user config.
    assert.equal(cfg.policy.mode, "enforced");
    assert.match(warned, /corrupt user config/);
  });

  it("user-level config is honored via HOME env override (not just ADVERSARIAL_REVIEW_HOME)", async () => {
    await writeJson(join(home, CONFIG_REL), {
      hosts: { "claude-code": { reviewer: "opencode" } },
    });
    const cfg = await loadEffectiveConfig(cwd, { env: { HOME: home } });
    assert.equal(cfg.hosts["claude-code"].reviewer, "opencode");
  });
});

describe("resolveStateDir honors ADVERSARIAL_REVIEW_HOME", () => {
  it("state dir base uses ADVERSARIAL_REVIEW_HOME when no STATE_DIR override", () => {
    const dir = resolveStateDir({ ADVERSARIAL_REVIEW_HOME: "/fake/home" });
    assert.match(dir, /[\\/]\.adversarial-review[\\/]state$/);
    assert.ok(dir.includes("fake") && dir.includes("home"));
  });

  it("ADVERSARIAL_REVIEW_STATE_DIR still takes priority over the home base", () => {
    const dir = resolveStateDir({
      ADVERSARIAL_REVIEW_HOME: "/fake/home",
      ADVERSARIAL_REVIEW_STATE_DIR: "/explicit/state",
    });
    assert.match(dir, /explicit[\\/]state$/);
  });
});
