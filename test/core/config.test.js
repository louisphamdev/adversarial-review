import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeConfig,
  sanitizeProjectConfig,
  applyPolicyFloor,
  DEFAULT_CONFIG,
} from "../../src/core/config.js";

// ── Basic defaults ────────────────────────────────────────────────────────────

test("default mode is enforced all-code", () => {
  const cfg = mergeConfig();
  assert.equal(cfg.policy.mode, "enforced");
  assert.equal(cfg.policy.reviewScope, "all-code");
  assert.equal(cfg.policy.onReviewerError, "block");
});

// ── Policy floor: project cannot loosen ──────────────────────────────────────

test("project cannot loosen strict user policy floor", () => {
  const cfg = mergeConfig(
    { policy: { mode: "soft", allowSkip: true, onReviewerError: "allow" } },
    { policy: { mode: "strict-ci", allowSkip: false, onReviewerError: "block" } },
  );
  assert.equal(cfg.policy.mode, "strict-ci");
  assert.equal(cfg.policy.allowSkip, false);
  assert.equal(cfg.policy.onReviewerError, "block");
});

// ── sanitizeProjectConfig: unknown top-level keys are dropped ─────────────────

test("sanitizeProjectConfig drops unknown top-level keys", () => {
  const raw = {
    policy: { mode: "soft" },
    thresholds: { bigDiffLines: 50 },
    unknownKey: "should be dropped",
    anotherBadKey: { nested: true },
  };
  const clean = sanitizeProjectConfig(raw);
  assert.ok("policy" in clean, "policy should be kept");
  assert.ok("thresholds" in clean, "thresholds should be kept");
  assert.ok(!("unknownKey" in clean), "unknownKey should be dropped");
  assert.ok(!("anotherBadKey" in clean), "anotherBadKey should be dropped");
});

// ── mergeConfig: project values override defaults ────────────────────────────

test("project config values override defaults when no floor conflict", () => {
  const cfg = mergeConfig({ policy: { mode: "soft", allowSkip: true } });
  assert.equal(cfg.policy.mode, "soft");
  assert.equal(cfg.policy.allowSkip, true);
});

test("project config threshold values override defaults", () => {
  const cfg = mergeConfig({ thresholds: { bigDiffLines: 200 } });
  assert.equal(cfg.thresholds.bigDiffLines, 200);
  // Unrelated threshold should remain at default
  assert.equal(cfg.thresholds.bigFileCount, DEFAULT_CONFIG.thresholds.bigFileCount);
});

// ── Policy floor: individual floor directions ─────────────────────────────────

test("floor mode ratchets upward: enforced floor raises soft project to enforced", () => {
  const cfg = mergeConfig(
    { policy: { mode: "soft" } },
    { policy: { mode: "enforced" } },
  );
  assert.equal(cfg.policy.mode, "enforced");
});

test("floor mode does not lower: strict-ci project stays strict-ci with enforced floor", () => {
  const cfg = mergeConfig(
    { policy: { mode: "strict-ci" } },
    { policy: { mode: "enforced" } },
  );
  assert.equal(cfg.policy.mode, "strict-ci");
});

test("floor allowAdvisoryHosts=false forces false even when project sets true", () => {
  const cfg = mergeConfig(
    { policy: { allowAdvisoryHosts: true } },
    { policy: { allowAdvisoryHosts: false } },
  );
  assert.equal(cfg.policy.allowAdvisoryHosts, false);
});

test("floor onInternalError=block forces block even when project sets allow", () => {
  const cfg = mergeConfig(
    { policy: { onInternalError: "allow" } },
    { policy: { onInternalError: "block" } },
  );
  assert.equal(cfg.policy.onInternalError, "block");
});

test("floor onBlockCap=block forces block even when project sets allow", () => {
  const cfg = mergeConfig(
    { policy: { onBlockCap: "allow" } },
    { policy: { onBlockCap: "block" } },
  );
  assert.equal(cfg.policy.onBlockCap, "block");
});

test("floor reviewScope=all-code forces all-code even when project sets something else", () => {
  const cfg = mergeConfig(
    { policy: { reviewScope: "sensitive-only" } },
    { policy: { reviewScope: "all-code" } },
  );
  assert.equal(cfg.policy.reviewScope, "all-code");
});

// ── Privacy floor ─────────────────────────────────────────────────────────────

test("privacy floor externalReview=deny forces deny", () => {
  const cfg = mergeConfig(
    { privacy: { externalReview: "allow" } },
    { privacy: { externalReview: "deny" } },
  );
  assert.equal(cfg.privacy.externalReview, "deny");
});

test("privacy floor secretScan=block-all forces block-all", () => {
  const cfg = mergeConfig(
    { privacy: { secretScan: "block-external" } },
    { privacy: { secretScan: "block-all" } },
  );
  assert.equal(cfg.privacy.secretScan, "block-all");
});

// ── mergeConfig does not mutate DEFAULT_CONFIG ────────────────────────────────

test("mergeConfig does not mutate DEFAULT_CONFIG", () => {
  mergeConfig({ policy: { mode: "soft", allowSkip: true } });
  assert.equal(DEFAULT_CONFIG.policy.mode, "enforced");
  assert.equal(DEFAULT_CONFIG.policy.allowSkip, false);
});

// ── Security: prototype pollution via __proto__ key is blocked ────────────────

test("deepAssign blocks __proto__ pollution via nested policy config", () => {
  // A malicious JSON payload that would pollute Object.prototype if unguarded
  const malicious = JSON.parse('{"policy": {"__proto__": {"polluted": true}}}');
  const cfg = mergeConfig(malicious);

  // Object.prototype must NOT have been polluted
  assert.equal(({}).polluted, undefined, "Object.prototype should not be polluted");

  // The returned config should still be valid and use the default mode
  assert.equal(cfg.policy.mode, "enforced");
});
