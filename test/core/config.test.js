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

// ── TRUST-2: privacy floor is MONOTONIC over ranked domains ───────────────────
// A floor at an INTERMEDIATE level must still be enforced — a project must not be
// able to loosen below it. Previously only block-all / deny were enforced.

test("TRUST-2: secretScan floor=block-external is NOT loosened to warn by project", () => {
  const cfg = mergeConfig(
    { privacy: { secretScan: "warn" } },
    { privacy: { secretScan: "block-external" } },
  );
  assert.equal(
    cfg.privacy.secretScan,
    "block-external",
    "block-external floor must ratchet a 'warn' project value back up"
  );
});

test("TRUST-2: externalReview floor=prompt is NOT loosened to allow by project", () => {
  const cfg = mergeConfig(
    { privacy: { externalReview: "allow" } },
    { privacy: { externalReview: "prompt" } },
  );
  assert.equal(
    cfg.privacy.externalReview,
    "prompt",
    "prompt floor must ratchet an 'allow' project value back up"
  );
});

test("TRUST-2: a privacy floor never LOOSENS a stricter project value", () => {
  // Project is already stricter than the floor in both domains; floor must not lower it.
  const cfg = mergeConfig(
    { privacy: { secretScan: "block-all", externalReview: "deny" } },
    { privacy: { secretScan: "block-external", externalReview: "prompt" } },
  );
  assert.equal(cfg.privacy.secretScan, "block-all", "stricter project secretScan preserved");
  assert.equal(cfg.privacy.externalReview, "deny", "stricter project externalReview preserved");
});

test("TRUST-2: secretScan floor=block-external also blocks a block-all project? (stays block-all)", () => {
  // block-all is stricter than the block-external floor; it must be preserved.
  const cfg = mergeConfig(
    { privacy: { secretScan: "block-all" } },
    { privacy: { secretScan: "block-external" } },
  );
  assert.equal(cfg.privacy.secretScan, "block-all");
});

test("TRUST-2: existing block-all/deny floors still ratchet from the loosest project value", () => {
  const cfg = mergeConfig(
    { privacy: { secretScan: "warn", externalReview: "allow" } },
    { privacy: { secretScan: "block-all", externalReview: "deny" } },
  );
  assert.equal(cfg.privacy.secretScan, "block-all");
  assert.equal(cfg.privacy.externalReview, "deny");
});

test("TRUST-2: an absent privacy floor leaves the project privacy values untouched", () => {
  const cfg = mergeConfig(
    { privacy: { secretScan: "warn", externalReview: "allow" } },
    {},
  );
  assert.equal(cfg.privacy.secretScan, "warn");
  assert.equal(cfg.privacy.externalReview, "allow");
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

// ── Security: applyPolicyFloor coerces malformed sub-objects & canonicalizes mode

test("mergeConfig does NOT throw when a sub-object is replaced by a scalar/null", () => {
  // Each of these would make applyPolicyFloor read .mode/.externalReview off a
  // non-object and throw (fail-open) if not coerced.
  for (const bad of [{ privacy: "pwned" }, { policy: null }, { policy: "soft" }, { privacy: 5 }, { policy: [] }]) {
    const cfg = mergeConfig(bad);
    assert.equal(typeof cfg.policy, "object");
    assert.equal(typeof cfg.privacy, "object");
    assert.equal(cfg.policy.mode, "enforced", `bad input ${JSON.stringify(bad)} must stay enforced`);
  }
});

test("applyPolicyFloor canonicalizes a non-canonical mode to a known value", () => {
  assert.equal(mergeConfig({ policy: { mode: "Enforced" } }).policy.mode, "enforced");
  assert.equal(mergeConfig({ policy: { mode: " strict-ci " } }).policy.mode, "strict-ci");
  assert.equal(mergeConfig({ policy: { mode: "garbage" } }).policy.mode, "enforced");
  assert.equal(mergeConfig({ policy: { mode: 123 } }).policy.mode, "enforced");
  // A genuine soft is preserved (mergeConfig's single layer is the trusted input).
  assert.equal(mergeConfig({ policy: { mode: "soft" } }).policy.mode, "soft");
});
