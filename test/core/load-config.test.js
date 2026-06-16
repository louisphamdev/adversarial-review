import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEffectiveConfig, resolveStateDir, resolveHomeDir } from "../../src/core/load-config.js";

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

  it("project config OVERRIDES user config for a NON-security key (thresholds)", async () => {
    // A non-security tuning key (escalation threshold) may still be overridden by
    // the project — only SECURITY policy and the host->reviewer mapping are locked.
    await writeJson(join(home, CONFIG_REL), { thresholds: { bigDiffLines: 80 } });
    await writeJson(join(cwd, CONFIG_REL), { thresholds: { bigDiffLines: 5 } });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(
      cfg.thresholds.bigDiffLines,
      5,
      "project config wins over user config for a non-security key"
    );
  });

  // SECURITY (#9): the host -> reviewer mapping decides WHO reviews. An untrusted
  // project config must NOT be able to redirect/downgrade it — it is pinned to the
  // trusted baseline (DEFAULT < user config < user floor), never the project.
  it("project config CANNOT override the host->reviewer mapping (pinned to baseline)", async () => {
    await writeJson(join(home, CONFIG_REL), {
      hosts: {
        "claude-code": { reviewer: "opencode" },
        codex: { reviewer: "opencode" },
      },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      // Hostile project tries to redirect the reviewer to a different/weaker tool.
      hosts: { "claude-code": { reviewer: "gemini" } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.hosts["claude-code"].reviewer, "opencode", "project must NOT redirect the reviewer");
    assert.equal(cfg.hosts["codex"].reviewer, "opencode", "untouched user mapping survives");
  });

  // -------------------------------------------------------------------------
  // SECURITY: an untrusted project config can only TIGHTEN, never loosen, and a
  // malformed project sub-object must never throw (which would FAIL OPEN).
  // -------------------------------------------------------------------------

  it("#1 project {privacy: scalar} does NOT throw and stays enforced", async () => {
    await writeJson(join(cwd, CONFIG_REL), { privacy: "pwned" });
    const cfg = await loadEffectiveConfig(cwd, io()); // must not throw
    assert.equal(cfg.policy.mode, "enforced");
    assert.equal(typeof cfg.privacy, "object");
    assert.equal(cfg.privacy.secretScan, "block-external", "privacy reset to the trusted baseline");
  });

  it("#2 project {policy: null} with a user enforced floor does NOT throw and stays enforced", async () => {
    await writeJson(join(home, POLICY_REL), { policy: { mode: "enforced" } });
    await writeJson(join(cwd, CONFIG_REL), { policy: null });
    const cfg = await loadEffectiveConfig(cwd, io()); // must not throw
    assert.equal(cfg.policy.mode, "enforced");
  });

  it("#11 project {policy: scalar} cannot de-enforce the gate", async () => {
    await writeJson(join(cwd, CONFIG_REL), { policy: "soft-please" });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "enforced");
  });

  it("#4/#10 non-canonical project mode ('Enforced') is canonicalized (no silent bypass)", async () => {
    await writeJson(join(cwd, CONFIG_REL), { policy: { mode: "Enforced" } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "enforced");
  });

  it("#20 project mode:soft cannot downgrade the default enforced baseline", async () => {
    await writeJson(join(cwd, CONFIG_REL), { policy: { mode: "soft", allowSkip: true } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "enforced", "project may not loosen below the baseline");
    assert.equal(cfg.policy.allowSkip, false, "project may not enable allowSkip");
  });

  it("#8 project cannot loosen onReviewerError/onInternalError/onBlockCap to 'allow'", async () => {
    await writeJson(join(cwd, CONFIG_REL), {
      policy: { onReviewerError: "allow", onInternalError: "allow", onBlockCap: "allow" },
    });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.onReviewerError, "block");
    assert.equal(cfg.policy.onInternalError, "block");
    assert.equal(cfg.policy.onBlockCap, "block");
  });

  it("a project MAY tighten (mode:strict-ci over default enforced)", async () => {
    await writeJson(join(cwd, CONFIG_REL), { policy: { mode: "strict-ci" } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.policy.mode, "strict-ci", "tightening is allowed");
  });

  it("#25/#31/#32 project cannot set a built-in reviewer's timeoutSec/requiredDimensions/models", async () => {
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { opencode: { models: ["good-model"], requiredDimensions: ["Correctness", "Security"] } },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { opencode: { timeoutSec: 0, requiredDimensions: [], models: ["evil-rubber-stamp"] } },
    });
    const cfg = await loadEffectiveConfig(cwd, io());
    const oc = cfg.reviewers.opencode;
    assert.equal(oc.timeoutSec, undefined, "project timeoutSec dropped (user did not set it)");
    assert.deepEqual(oc.requiredDimensions, ["Correctness", "Security"], "user requiredDimensions survive project shrink");
    assert.deepEqual(oc.models, ["good-model"], "user models survive; project models dropped");
  });

  it("project cannot inject a model list on a built-in reviewer the user never configured", async () => {
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { opencode: { models: ["evil-rubber-stamp"] } },
    });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.opencode?.models, undefined, "project-only models dropped");
  });

  it("R2: project cannot redirect runtime.baselineRef (diff-baseline bypass)", async () => {
    await writeJson(join(cwd, CONFIG_REL), { runtime: { baselineRef: "HEAD~99", timeoutSec: 0 } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.runtime.baselineRef, "auto", "baselineRef pinned to baseline");
    assert.equal(cfg.runtime.timeoutSec, 180, "runtime.timeoutSec pinned to baseline");
  });

  it("R2: project cannot relax privacy.tempFileMode", async () => {
    await writeJson(join(cwd, CONFIG_REL), { privacy: { tempFileMode: "0666" } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.privacy.tempFileMode, "0600", "tempFileMode pinned to baseline");
  });

  it("R2: project reviewers:null does not wipe the user's reviewer config", async () => {
    await writeJson(join(home, CONFIG_REL), { reviewers: { opencode: { readOnlyConfig: true } } });
    await writeJson(join(cwd, CONFIG_REL), { reviewers: null });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(typeof cfg.reviewers, "object");
    assert.equal(cfg.reviewers.opencode.readOnlyConfig, true, "user reviewer config restored");
  });

  it("R2: project may LOWER an escalation threshold but not RAISE it", async () => {
    await writeJson(join(cwd, CONFIG_REL), { thresholds: { bigDiffLines: 9999, debateDiffLines: 1 } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.ok(cfg.thresholds.bigDiffLines <= 80, "raising a threshold is clamped to the baseline");
    assert.equal(cfg.thresholds.debateDiffLines, 1, "lowering (tightening) a threshold is allowed");
  });

  it("R2: resolveStateDir ignores a RELATIVE override (no cwd-relative state dir)", async () => {
    const rel = resolveStateDir({ ADVERSARIAL_REVIEW_STATE_DIR: "evil/state", ADVERSARIAL_REVIEW_HOME: home });
    assert.ok(!rel.includes("evil"), "relative override ignored");
    assert.ok(rel.startsWith(home), "falls back to the user-level default");
  });

  it("R3: resolveHomeDir ignores a RELATIVE ADVERSARIAL_REVIEW_HOME (no cwd-relative base)", async () => {
    // A relative home would place the trusted user base under cwd (project-
    // writable -> pass-cache poisoning). It must be ignored; an ABSOLUTE one wins.
    const relHome = resolveHomeDir({ ADVERSARIAL_REVIEW_HOME: "evil-home", USERPROFILE: home });
    assert.ok(!relHome.includes("evil-home"), "relative ADVERSARIAL_REVIEW_HOME ignored");
    const absHome = resolveHomeDir({ ADVERSARIAL_REVIEW_HOME: home });
    assert.equal(absHome, home, "an absolute ADVERSARIAL_REVIEW_HOME still wins");
  });

  it("R3: a NON-number project threshold cannot disable escalation", async () => {
    await writeJson(join(cwd, CONFIG_REL), { thresholds: { bigDiffLines: "99999", debateDiffLines: "x" } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(typeof cfg.thresholds.bigDiffLines, "number", "coerced to a number");
    assert.ok(cfg.thresholds.bigDiffLines <= 80, "string threshold coerced to baseline");
    assert.equal(typeof cfg.thresholds.debateDiffLines, "number");
  });

  it("R3: project cannot REMOVE user sensitive patterns (additive union)", async () => {
    await writeJson(join(home, CONFIG_REL), { sensitivity: { extraSensitive: ["infra/.*"] } });
    await writeJson(join(cwd, CONFIG_REL), { sensitivity: { extraSensitive: [] } }); // try to drop them
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.ok(cfg.sensitivity.extraSensitive.includes("infra/.*"), "user sensitive pattern survives");
  });

  it("R5: project cannot grant trust via a TRUTHY NON-BOOLEAN value", async () => {
    await writeJson(join(cwd, CONFIG_REL), { reviewers: { ev: { type: "custom", trusted: 1, command: "x" } } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.notEqual(cfg.reviewers.ev?.trusted, 1, "`trusted:1` must not survive");
    assert.notEqual(cfg.reviewers.ev?.trusted, true, "project must not self-grant trust");
  });

  it("R5: project cannot change a built-in reviewer's adapter TYPE or inject a command", async () => {
    await writeJson(join(home, CONFIG_REL), { reviewers: { opencode: { readOnlyConfig: true } } });
    await writeJson(join(cwd, CONFIG_REL), { reviewers: { opencode: { type: "custom", command: "echo pass" } } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.notEqual(cfg.reviewers.opencode.type, "custom", "project cannot make opencode a custom adapter");
    assert.equal(cfg.reviewers.opencode.command, undefined, "injected command dropped");
    assert.equal(cfg.reviewers.opencode.readOnlyConfig, true, "opencode readOnlyConfig preserved (anchored)");
  });

  it("R5: project cannot downgrade the config schema version", async () => {
    await writeJson(join(cwd, CONFIG_REL), { version: 1, policy: { mode: "soft" } });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.version, 2, "version pinned to baseline");
  });

  it("R6: an ABSOLUTE env override resolving INSIDE the workspace is rejected (HOME + STATE_DIR)", async () => {
    const insideHome = join(cwd, ".fake-home");
    const insideState = join(cwd, ".adversarial-review", "evil-state");
    // HOME override inside cwd must be ignored (not returned verbatim).
    assert.notEqual(
      resolveHomeDir({ ADVERSARIAL_REVIEW_HOME: insideHome }, cwd),
      insideHome,
      "HOME override inside the workspace must be ignored"
    );
    // STATE_DIR override inside cwd must be ignored -> home-based default.
    const s = resolveStateDir({ ADVERSARIAL_REVIEW_STATE_DIR: insideState, ADVERSARIAL_REVIEW_HOME: home }, cwd);
    assert.ok(!s.includes("evil-state"), "STATE_DIR override inside the workspace must be ignored");
    assert.ok(s.startsWith(home), "falls back to the user-level default");
    // A legit OUTSIDE-cwd absolute override is still honored.
    const out = resolveStateDir({ ADVERSARIAL_REVIEW_STATE_DIR: join(home, "x-state") }, cwd);
    assert.ok(out.includes("x-state"), "an outside-cwd absolute override is still honored");
  });

  it("R5: a symlinked project config escaping the workspace is ignored", async (t) => {
    if (process.platform === "win32") return t.skip("symlink creation needs privilege on win32");
    const outside = await mkdtemp(join(tmpdir(), "ar-outside-"));
    try {
      await writeFile(join(outside, "evil.json"), JSON.stringify({ policy: { mode: "soft" } }));
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await symlink(join(outside, "evil.json"), join(cwd, CONFIG_REL));
      const cfg = await loadEffectiveConfig(cwd, io());
      assert.equal(cfg.policy.mode, "enforced", "escaping-symlink project config ignored -> default enforced");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

  // BUG 1 (trust boundary): a PROJECT config must not be able to self-grant a
  // custom reviewer's trust nor inject its command/args. Trust and the custom
  // command/args/type must come from USER-level config only.
  it("project config cannot self-grant a custom reviewer trust + inject a command", async () => {
    // NO user config. Project tries to declare a trusted, read-only custom
    // reviewer running an arbitrary command.
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: {
        x: { type: "custom", command: "evil", args: ["--pwn"], trusted: true, readOnlyConfig: true },
      },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    // Trust stripped (a project layer can never grant trust).
    assert.equal(cfg.reviewers.x.trusted, false, "project-granted trust must be forced false");
    // Command/args stripped (user config did not define this custom reviewer).
    assert.equal(cfg.reviewers.x.command, undefined, "project-injected command must be stripped");
    assert.equal(cfg.reviewers.x.args, undefined, "project-injected args must be stripped");
  });

  it("a USER-defined trusted custom reviewer keeps its trust+command; project cannot override the command", async () => {
    // User config defines the trusted custom reviewer with a safe command.
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "safe", trusted: true } },
    });
    // Project config tries to override the command to "evil".
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "evil" } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.x.trusted, true, "user-granted trust survives");
    assert.equal(cfg.reviewers.x.command, "safe", "project must not override the user-set command");
  });

  it("opencode readOnlyConfig set by a project config is preserved (not stripped)", async () => {
    // opencode isolation is bound to the bundled read-only agent in enforced/strict,
    // so a project-set readOnlyConfig is safe and must survive the trust floor.
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { opencode: { readOnlyConfig: true } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.opencode.readOnlyConfig, true, "opencode readOnlyConfig must be preserved");
  });

  // TRUST-1 (HIGH): readOnlyConfig is the SOLE isolation assertion for a CUSTOM
  // reviewer (no bundled-agent anchor like opencode). A malicious PROJECT config
  // must NOT be able to add readOnlyConfig:true to a user-trusted-but-non-isolated
  // custom reviewer and bypass the enforced/strict isolation gate. It must come
  // from the trusted USER config only.
  it("TRUST-1: project cannot inject readOnlyConfig:true onto a user custom reviewer", async () => {
    // User trusts a custom reviewer WITHOUT readOnlyConfig (non-isolated).
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "safe", trusted: true } },
    });
    // Project tries to assert isolation by adding readOnlyConfig:true.
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { readOnlyConfig: true } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.x.trusted, true, "user trust survives");
    assert.equal(cfg.reviewers.x.command, "safe", "user command survives");
    assert.notEqual(
      cfg.reviewers.x.readOnlyConfig,
      true,
      "project-injected readOnlyConfig must NOT take effect (isolation bypass)"
    );
  });

  it("TRUST-1: a USER-set readOnlyConfig:true on a custom reviewer is preserved", async () => {
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "safe", trusted: true, readOnlyConfig: true } },
    });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.x.readOnlyConfig, true, "user-set isolation must survive");
  });

  it("TRUST-1: project cannot shrink requiredDimensions on a user custom reviewer", async () => {
    // User defines a custom reviewer WITHOUT explicit requiredDimensions (so the
    // gate's defaults apply). Project tries to shrink to [] to skip all dimensions.
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "safe", trusted: true } },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { requiredDimensions: [] } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    // Project's [] must NOT take effect; absent value lets the gate fall back to
    // its default dimension set (consumers read `?.requiredDimensions || [defaults]`).
    assert.notDeepEqual(
      cfg.reviewers.x.requiredDimensions,
      [],
      "project must not shrink requiredDimensions to []"
    );
    assert.ok(
      cfg.reviewers.x.requiredDimensions === undefined ||
        cfg.reviewers.x.requiredDimensions.length > 0,
      "effective requiredDimensions must be the user/default set, not []"
    );
  });

  it("TRUST-1: a USER-set requiredDimensions on a custom reviewer is preserved; project cannot shrink it", async () => {
    await writeJson(join(home, CONFIG_REL), {
      reviewers: {
        x: { type: "custom", command: "safe", trusted: true, requiredDimensions: ["Correctness", "Security"] },
      },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { requiredDimensions: [] } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.deepEqual(
      cfg.reviewers.x.requiredDimensions,
      ["Correctness", "Security"],
      "user-set requiredDimensions survive; project shrink ignored"
    );
  });

  it("TRUST-1: project cannot inject timeoutSec onto a user custom reviewer", async () => {
    await writeJson(join(home, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "safe", trusted: true } },
    });
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { timeoutSec: 9999 } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(
      cfg.reviewers.x.timeoutSec,
      undefined,
      "project-injected timeoutSec must be stripped (user did not set it)"
    );
  });

  it("TRUST-1: project cannot inject readOnlyConfig on a custom reviewer the user never defined", async () => {
    // No user config. Project declares a custom reviewer with isolation asserted.
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { x: { type: "custom", command: "evil", trusted: true, readOnlyConfig: true } },
    });

    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(cfg.reviewers.x.trusted, false, "project cannot self-grant trust");
    assert.equal(cfg.reviewers.x.command, undefined, "project command stripped");
    assert.notEqual(cfg.reviewers.x.readOnlyConfig, true, "project isolation assertion stripped");
  });

  it("TRUST-1: opencode project readOnlyConfig:true is still preserved (unchanged)", async () => {
    await writeJson(join(cwd, CONFIG_REL), {
      reviewers: { opencode: { readOnlyConfig: true } },
    });
    const cfg = await loadEffectiveConfig(cwd, io());
    assert.equal(
      cfg.reviewers.opencode.readOnlyConfig,
      true,
      "opencode isolation is anchored to the bundled agent; project value stays allowed"
    );
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

// ---------------------------------------------------------------------------
// PLATFORM-1: env vars must be read CASE-INSENSITIVELY. A plain-object env copy
// or a native Windows shell may carry keys as 'Userprofile'/'Adversarial_...'.
// ---------------------------------------------------------------------------

describe("PLATFORM-1: case-insensitive env reads", () => {
  it("resolveStateDir honors a STATE_DIR override under a non-canonical key case", () => {
    const dir = resolveStateDir({ Adversarial_Review_State_Dir: "/explicit/state" });
    assert.match(dir, /explicit[\\/]state$/, "case-insensitive override key must be honored");
  });

  it("resolveStateDir honors ADVERSARIAL_REVIEW_HOME under a non-canonical key case", () => {
    const dir = resolveStateDir({ Adversarial_Review_Home: "/fake/home" });
    assert.match(dir, /[\\/]\.adversarial-review[\\/]state$/);
    assert.ok(dir.includes("fake") && dir.includes("home"));
  });

  it("resolveHomeDir resolves home from a 'Userprofile' key (no USERPROFILE/HOME)", () => {
    // Native-Windows-style casing: only 'Userprofile' is present.
    const home = resolveHomeDir({ Userprofile: "C:\\Users\\Bob" });
    assert.equal(home, "C:\\Users\\Bob", "case-insensitive USERPROFILE must resolve");
  });

  it("resolveHomeDir resolves home from an 'Adversarial_Review_Home' key", () => {
    // The dedicated override is only honored when ABSOLUTE (round-6 inside-cwd guard),
    // so use a path that is absolute on the CURRENT platform: a Windows "C:\\.." path is
    // NOT absolute on POSIX (path.isAbsolute is false) and would be correctly ignored.
    const abs = process.platform === "win32" ? "C:\\override\\home" : "/override/home";
    const home = resolveHomeDir({ Adversarial_Review_Home: abs });
    assert.equal(home, abs);
  });
});

// ---------------------------------------------------------------------------
// PLATFORM-2: on win32, a POSIX-looking HOME (e.g. /c/Users/Louis) must not
// override a real USERPROFILE, and must be normalized when used as a fallback.
// POSIX behavior (HOME first) must remain unchanged on non-win32.
// ---------------------------------------------------------------------------

describe("PLATFORM-2: HOME vs USERPROFILE platform-aware preference", () => {
  it("on win32, a POSIX-looking HOME does not override a real USERPROFILE", function () {
    if (process.platform !== "win32") {
      // Guarded: only meaningful on win32 where the POSIX HOME hazard exists.
      return;
    }
    const home = resolveHomeDir({ HOME: "/c/Users/Louis", USERPROFILE: "C:\\Users\\Louis" });
    assert.equal(home, "C:\\Users\\Louis", "USERPROFILE wins over POSIX HOME on win32");
  });

  it("on win32, a POSIX MSYS HOME is normalized when it is the only home source", function () {
    if (process.platform !== "win32") return;
    const home = resolveHomeDir({ HOME: "/c/Users/Louis" });
    assert.equal(home, "C:\\Users\\Louis", "/c/Users/Louis must normalize to C:\\Users\\Louis");
  });

  it("on win32, a native-Windows HOME (no USERPROFILE) is used as-is", function () {
    if (process.platform !== "win32") return;
    const home = resolveHomeDir({ HOME: "D:\\home\\bob" });
    assert.equal(home, "D:\\home\\bob");
  });

  it("on non-win32, HOME is still preferred over USERPROFILE (POSIX unchanged)", function () {
    if (process.platform === "win32") return;
    const home = resolveHomeDir({ HOME: "/home/louis", USERPROFILE: "/should/not/win" });
    assert.equal(home, "/home/louis", "POSIX behavior: HOME first");
  });

  it("ADVERSARIAL_REVIEW_HOME always wins regardless of platform", () => {
    const home = resolveHomeDir({
      ADVERSARIAL_REVIEW_HOME: "/dedicated/base",
      HOME: "/home/x",
      USERPROFILE: "C:\\Users\\x",
    });
    assert.equal(home, "/dedicated/base");
  });
});
