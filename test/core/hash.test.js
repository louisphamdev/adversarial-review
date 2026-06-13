import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sha256, stableJson, reviewCacheKey } from "../../src/core/hash.js";

// Base set of all 9 cache-key fields
function baseParts() {
  return {
    diffHash: "aaa",
    configHash: "bbb",
    promptHash: "ccc",
    reviewerId: "default",
    reviewerVersion: "1.0.0",
    model: "claude-sonnet-4-5",
    level: "standard",
    toolVersion: "2.0.0",
    privacyMode: false,
  };
}

describe("sha256", () => {
  it("produces a 64-character hex string", () => {
    const h = sha256("hello world");
    assert.equal(typeof h, "string");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it("produces identical output for identical input", () => {
    assert.equal(sha256("same"), sha256("same"));
  });

  it("produces different output for different input", () => {
    assert.notEqual(sha256("a"), sha256("b"));
  });
});

describe("stableJson", () => {
  it("serialises object keys in sorted order regardless of insertion order", () => {
    const a = stableJson({ z: 1, a: 2 });
    const b = stableJson({ a: 2, z: 1 });
    assert.equal(a, b);
  });

  it("handles arrays", () => {
    assert.equal(stableJson([1, 2, 3]), "[1,2,3]");
  });

  it("handles primitives", () => {
    assert.equal(stableJson("hello"), '"hello"');
    assert.equal(stableJson(42), "42");
    assert.equal(stableJson(null), "null");
    assert.equal(stableJson(false), "false");
  });
});

describe("reviewCacheKey", () => {
  it("returns a 64-character hex string", () => {
    const key = reviewCacheKey(baseParts());
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]+$/);
  });

  it("identical inputs produce identical keys", () => {
    assert.equal(reviewCacheKey(baseParts()), reviewCacheKey(baseParts()));
  });

  // Parameterised: changing any single field must change the key
  const fieldMutations = [
    ["diffHash", "DIFFERENT_diffHash"],
    ["configHash", "DIFFERENT_configHash"],
    ["promptHash", "DIFFERENT_promptHash"],
    ["reviewerId", "DIFFERENT_reviewerId"],
    ["reviewerVersion", "9.9.9"],
    ["model", "claude-opus-5"],
    ["level", "strict"],
    ["toolVersion", "9.9.9"],
    ["privacyMode", true],
  ];

  for (const [field, newValue] of fieldMutations) {
    it(`changing ${field} produces a different cache key`, () => {
      const original = reviewCacheKey(baseParts());
      const mutated = { ...baseParts(), [field]: newValue };
      const changed = reviewCacheKey(mutated);
      assert.notEqual(
        original,
        changed,
        `Expected cache key to differ when ${field} changes from ${JSON.stringify(baseParts()[field])} to ${JSON.stringify(newValue)}`
      );
    });
  }

  it("model defaults to empty string when omitted and still produces a stable key", () => {
    const withModel = reviewCacheKey({ ...baseParts(), model: "" });
    const withoutModel = reviewCacheKey({ ...baseParts(), model: undefined });
    assert.equal(withModel, withoutModel, "model:undefined should be treated the same as model:''");
  });
});
