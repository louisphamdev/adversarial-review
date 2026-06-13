import test from "node:test";
import assert from "node:assert/strict";
import { scanSecrets } from "../../src/core/secrets.js";

// Case 1: A .env path triggers a sensitive_path finding regardless of content.
test(".env path produces sensitive_path finding", () => {
  const findings = scanSecrets("", [".env"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, "sensitive_path");
  assert.equal(findings[0].path, ".env");
});

// Case 2: A fake private key block in the diff is detected as secret_pattern.
// The body is obviously fake and contains no real key material.
test("fake private key block is detected", () => {
  const fakeKeyBlock = [
    "-----BEGIN PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeKeyBlock, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern finding");
});

// Case 3: A fake token assignment (api_key = "...") is detected.
// Value is obviously fake — just the right shape to match the pattern.
test("fake token assignment is detected", () => {
  const text = 'api_key = "FAKEKEY0123456789"';
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern finding");
});

// Case 4: Ordinary documentation text produces no findings.
test("ordinary docs text has no finding", () => {
  const text = "This is a plain English paragraph with no secrets, keys, or tokens.";
  const findings = scanSecrets(text, ["docs/guide.md"]);
  assert.equal(findings.length, 0);
});

// Case 5: SSH key file names produce a sensitive_path finding.
test("id_rsa path produces sensitive_path finding", () => {
  const findings = scanSecrets("", ["id_rsa"]);
  const pathFindings = findings.filter((f) => f.type === "sensitive_path");
  assert.equal(pathFindings.length >= 1, true, "expected sensitive_path for id_rsa");
});

test("server.pem path produces sensitive_path finding", () => {
  const findings = scanSecrets("", ["server.pem"]);
  const pathFindings = findings.filter((f) => f.type === "sensitive_path");
  assert.equal(pathFindings.length >= 1, true, "expected sensitive_path for server.pem");
});

// Case 6: ECDSA private key header (fake body) is detected as secret_pattern.
// The block is entirely synthetic — no real key material is present.
test("fake ECDSA private key block is detected", () => {
  const fakeEcdsaBlock = [
    "-----BEGIN ECDSA PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END ECDSA PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeEcdsaBlock, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern for ECDSA header");
});

// Case 7: DSA private key header (fake body) is detected as secret_pattern.
test("fake DSA private key block is detected", () => {
  const fakeDsaBlock = [
    "-----BEGIN DSA PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END DSA PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeDsaBlock, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern for DSA header");
});

// Case 8: Robustness — null paths must not throw; result is an array.
test("scanSecrets with null paths does not throw", () => {
  let findings;
  assert.doesNotThrow(() => {
    findings = scanSecrets("some text", null);
  });
  assert.ok(Array.isArray(findings), "result should be an array");
});

// Case 9: Robustness — non-string text (number) must not throw.
test("scanSecrets with numeric text does not throw", () => {
  let findings;
  assert.doesNotThrow(() => {
    findings = scanSecrets(123);
  });
  assert.ok(Array.isArray(findings), "result should be an array");
});

// Case 10: Robustness — undefined paths must not throw.
test("scanSecrets with undefined paths does not throw", () => {
  let findings;
  assert.doesNotThrow(() => {
    findings = scanSecrets("hello", undefined);
  });
  assert.ok(Array.isArray(findings), "result should be an array");
});
