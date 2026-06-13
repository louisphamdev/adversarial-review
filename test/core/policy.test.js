import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfig } from "../../src/core/config.js";
import {
  isStrict,
  requiresReviewForCode,
  reviewerErrorAction,
  internalErrorAction,
  blockCapAction,
  skipAllowed,
} from "../../src/core/policy.js";

// Helper: build a resolved config for a given mode with optional policy overrides.
function cfg(mode, policyOverrides = {}) {
  return mergeConfig({ policy: { mode, ...policyOverrides } });
}

// ── isStrict ──────────────────────────────────────────────────────────────────

test("isStrict returns true only for strict-ci", () => {
  assert.equal(isStrict(cfg("strict-ci")), true);
  assert.equal(isStrict(cfg("enforced")), false);
  assert.equal(isStrict(cfg("soft")), false);
});

// ── requiresReviewForCode ─────────────────────────────────────────────────────

test("requiresReviewForCode: enforced + all-code scope returns true", () => {
  assert.equal(requiresReviewForCode(cfg("enforced", { reviewScope: "all-code" })), true);
});

test("requiresReviewForCode: enforced + sensitive-only scope returns false", () => {
  // Must bypass the default floor — use a floor that allows sensitive-only.
  // Because DEFAULT_CONFIG already sets reviewScope to all-code, project cannot
  // lower it without a permissive floor; we test by constructing config directly.
  const config = {
    policy: { mode: "enforced", reviewScope: "sensitive-only" },
  };
  assert.equal(requiresReviewForCode(config), false);
});

test("requiresReviewForCode: strict-ci always returns true regardless of scope", () => {
  const config = {
    policy: { mode: "strict-ci", reviewScope: "sensitive-only" },
  };
  assert.equal(requiresReviewForCode(config), true);
});

test("requiresReviewForCode: soft + all-code returns true", () => {
  assert.equal(requiresReviewForCode(cfg("soft", { reviewScope: "all-code" })), true);
});

test("requiresReviewForCode: soft + sensitive-only returns false", () => {
  const config = {
    policy: { mode: "soft", reviewScope: "sensitive-only" },
  };
  assert.equal(requiresReviewForCode(config), false);
});

// ── reviewerErrorAction ───────────────────────────────────────────────────────

test("reviewerErrorAction: soft with no override returns self-review", () => {
  const config = { policy: { mode: "soft" } };
  assert.equal(reviewerErrorAction(config), "self-review");
});

test("reviewerErrorAction: soft respects configured value", () => {
  const config = { policy: { mode: "soft", onReviewerError: "allow" } };
  assert.equal(reviewerErrorAction(config), "allow");
});

test("reviewerErrorAction: enforced with no override returns block", () => {
  const config = { policy: { mode: "enforced" } };
  assert.equal(reviewerErrorAction(config), "block");
});

test("reviewerErrorAction: enforced respects configured value", () => {
  const config = { policy: { mode: "enforced", onReviewerError: "block" } };
  assert.equal(reviewerErrorAction(config), "block");
});

test("reviewerErrorAction: strict-ci returns block", () => {
  const config = { policy: { mode: "strict-ci", onReviewerError: "block" } };
  assert.equal(reviewerErrorAction(config), "block");
});

// ── internalErrorAction ───────────────────────────────────────────────────────

test("internalErrorAction: returns allow when no evidence of significant change (all modes)", () => {
  for (const mode of ["soft", "enforced", "strict-ci"]) {
    const config = { policy: { mode, onInternalError: "block" } };
    assert.equal(
      internalErrorAction(config, false),
      "allow",
      `mode=${mode} should return allow when no significant change`,
    );
  }
});

test("internalErrorAction: soft with significant change and no override returns allow", () => {
  const config = { policy: { mode: "soft" } };
  assert.equal(internalErrorAction(config, true), "allow");
});

test("internalErrorAction: soft with significant change respects configured value", () => {
  const config = { policy: { mode: "soft", onInternalError: "block" } };
  assert.equal(internalErrorAction(config, true), "block");
});

test("internalErrorAction: enforced with significant change and no override returns block", () => {
  const config = { policy: { mode: "enforced" } };
  assert.equal(internalErrorAction(config, true), "block");
});

test("internalErrorAction: strict-ci with significant change returns block", () => {
  const config = { policy: { mode: "strict-ci", onInternalError: "block" } };
  assert.equal(internalErrorAction(config, true), "block");
});

// ── blockCapAction ────────────────────────────────────────────────────────────

test("blockCapAction: soft with no override returns allow", () => {
  const config = { policy: { mode: "soft" } };
  assert.equal(blockCapAction(config), "allow");
});

test("blockCapAction: soft respects configured value", () => {
  const config = { policy: { mode: "soft", onBlockCap: "block" } };
  assert.equal(blockCapAction(config), "block");
});

test("blockCapAction: enforced with no override returns block", () => {
  const config = { policy: { mode: "enforced" } };
  assert.equal(blockCapAction(config), "block");
});

test("blockCapAction: enforced respects configured value", () => {
  const config = { policy: { mode: "enforced", onBlockCap: "allow" } };
  assert.equal(blockCapAction(config), "allow");
});

test("blockCapAction: strict-ci returns block", () => {
  const config = { policy: { mode: "strict-ci", onBlockCap: "block" } };
  assert.equal(blockCapAction(config), "block");
});

// ── skipAllowed ───────────────────────────────────────────────────────────────

test("skipAllowed: strict-ci always returns false even with allowSkip=true", () => {
  assert.equal(skipAllowed(cfg("strict-ci", { allowSkip: true })), false);
});

test("skipAllowed: enforced + allowSkip=true returns true", () => {
  // Build directly to bypass floor (floor would keep allowSkip=false by default)
  const config = { policy: { mode: "enforced", allowSkip: true } };
  assert.equal(skipAllowed(config), true);
});

test("skipAllowed: enforced + allowSkip=false returns false", () => {
  const config = { policy: { mode: "enforced", allowSkip: false } };
  assert.equal(skipAllowed(config), false);
});

test("skipAllowed: soft + allowSkip=true returns true", () => {
  const config = { policy: { mode: "soft", allowSkip: true } };
  assert.equal(skipAllowed(config), true);
});

test("skipAllowed: soft + allowSkip=false returns false", () => {
  const config = { policy: { mode: "soft", allowSkip: false } };
  assert.equal(skipAllowed(config), false);
});

// ── Cross-mode policy floor + policy helper integration ───────────────────────

test("policy floor strict-ci + skipAllowed: project allowSkip=true is overridden to false", () => {
  // After floor, allowSkip is false and mode is strict-ci — both conditions block skip.
  const resolved = mergeConfig(
    { policy: { mode: "enforced", allowSkip: true } },
    { policy: { mode: "strict-ci", allowSkip: false } },
  );
  assert.equal(skipAllowed(resolved), false);
});

test("policy floor block forces reviewerErrorAction to return block in enforced mode", () => {
  const resolved = mergeConfig(
    { policy: { mode: "enforced", onReviewerError: "self-review" } },
    { policy: { onReviewerError: "block" } },
  );
  assert.equal(reviewerErrorAction(resolved), "block");
});
