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

// Case 7a: ED25519 private key header (fake body) is detected as secret_pattern.
// Regression for the missed modern-SSH header — body is entirely synthetic.
test("fake ED25519 private key block is detected", () => {
  const fakeEd25519Block = [
    "-----BEGIN ED25519 PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END ED25519 PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeEd25519Block, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern for ED25519 header");
});

// Case 7b: ENCRYPTED (PKCS#8) private key header (fake body) is detected.
test("fake ENCRYPTED private key block is detected", () => {
  const fakeEncryptedBlock = [
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END ENCRYPTED PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeEncryptedBlock, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern for ENCRYPTED header");
});

// Case 7c: OPENSSH private key header (fake body) is detected.
test("fake OPENSSH private key block is detected", () => {
  const fakeOpensshBlock = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const findings = scanSecrets(fakeOpensshBlock, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected at least one secret_pattern for OPENSSH header");
});

// Case 7d: Quoted-JSON credential form (`"password": "value"`) is detected.
// Regression for the most common committed-config secret shape. Value is fake.
test("quoted JSON password form is detected", () => {
  const text = '"password": "FAKEPASS0123456789"';
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected secret_pattern for quoted JSON password");
});

// Case 7e: Quoted-JSON token form with no space (`"token":"value"`) is detected.
test("quoted JSON token form is detected", () => {
  const text = '"token":"FAKETOKEN0123456789"';
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected secret_pattern for quoted JSON token");
});

// Case 7f: Authorization Bearer header is detected.
test("Authorization Bearer header is detected", () => {
  const text = "Authorization: Bearer FAKEBEARER0123456789";
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected secret_pattern for Authorization Bearer");
});

// Case 7g: aws_secret_access_key assignment is detected.
test("aws_secret_access_key assignment is detected", () => {
  const text = "aws_secret_access_key = FAKEAWSSECRET0123456789";
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length >= 1, true, "expected secret_pattern for aws_secret_access_key");
});

// Case 7h: Negative — the bare word "password" with no value must NOT be flagged.
// Guards against false-positive over-matching of the broadened credential regex.
test("bare word password with no value is not flagged", () => {
  const samples = [
    "Please reset your password soon.",
    "The password field is required.",
    "password:",
  ];
  for (const text of samples) {
    const findings = scanSecrets(text, []);
    const secretFindings = findings.filter((f) => f.type === "secret_pattern");
    assert.equal(secretFindings.length, 0, `expected no secret_pattern for: ${text}`);
  }
});

// Case 7i: Negative — prose that merely contains BEGIN/PRIVATE/KEY words but is
// not an actual PEM header must NOT be flagged by the broadened PEM regex.
test("PEM-like prose without a real header is not flagged", () => {
  const text = "We will BEGIN PRIVATE work on the KEY feature.";
  const findings = scanSecrets(text, []);
  const secretFindings = findings.filter((f) => f.type === "secret_pattern");
  assert.equal(secretFindings.length, 0, "expected no secret_pattern for PEM-like prose");
});

// Case 7j: ROUND2 finding 1 — a credential value containing special characters
// (outside [A-Za-z0-9_./+=-]) must still be detected. Previously the value class
// truncated at the first special char, evading detection below the 12-char floor.
test("credential value with special characters is detected (round2 #1)", () => {
  const samples = [
    "authorization: Bearer abc!defghijklmnopqrstuvwxyz1234567890",
    "password = sup3r!secret@value#here$x",
    'api_key: "k3y!w1th@special#chars1"',
    "secret=p@ssw0rd!#%^&*()_longvalue",
  ];
  for (const text of samples) {
    const findings = scanSecrets(text, []);
    const secretFindings = findings.filter((f) => f.type === "secret_pattern");
    assert.equal(
      secretFindings.length >= 1,
      true,
      `expected secret_pattern for special-char value: ${text}`
    );
  }
});

// Case 7k: ROUND2 finding 1 — benign near-misses with a separator but only short
// (<12 char) word tokens after it must stay UNflagged (no false-positive blowup).
test("benign separator prose with short value tokens is not flagged (round2 #1)", () => {
  const samples = [
    "the secret to success: hard work and dedication",
    "password: please contact your administrator",
    "token: see documentation for details",
    "secret: this is a long sentence with spaces here",
    "secret = ", // empty value
    "token: short", // value < 12 chars
  ];
  for (const text of samples) {
    const findings = scanSecrets(text, []);
    const secretFindings = findings.filter((f) => f.type === "secret_pattern");
    assert.equal(secretFindings.length, 0, `expected no secret_pattern for: ${text}`);
  }
});

// Case 7l: ROUND2 finding 2 — .envrc and .env* variants without a dot/end after
// .env (and nested paths) must produce a sensitive_path finding.
test(".envrc and .env* variants produce sensitive_path (round2 #2)", () => {
  const paths = [
    ".envrc",
    "config/.envrc",
    ".env-local",
    ".env.test",
    ".env.production",
    "app/.env.local",
  ];
  for (const p of paths) {
    const findings = scanSecrets("", [p]);
    const pathFindings = findings.filter((f) => f.type === "sensitive_path");
    assert.equal(pathFindings.length >= 1, true, `expected sensitive_path for: ${p}`);
  }
});

// Case 7m: ROUND2 finding 2 — a bare `env` (no leading dot) and common env-named
// code paths must NOT be flagged, so the broadened .env branch does not explode.
test("bare env paths without leading dot are not flagged (round2 #2)", () => {
  const paths = ["env", "env/config.js", "environment.ts", "src/env.js", "docs/guide.md"];
  for (const p of paths) {
    const findings = scanSecrets("", [p]);
    const pathFindings = findings.filter((f) => f.type === "sensitive_path");
    assert.equal(pathFindings.length, 0, `expected no sensitive_path for: ${p}`);
  }
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

// Round 3: prefixed credential env-var names must be detected. `_` is a word
// char, so the old leading `\b` made `\bpassword` miss `DB_PASSWORD` etc.
test("prefixed credential names (DB_PASSWORD / MY_TOKEN / APP_SECRET) are detected (round3)", () => {
  for (const line of [
    "DB_PASSWORD=s3cr3tValue123456",
    "MY_TOKEN: abcdefghijklmnop1234",
    "APP_SECRET = qwertyuiopasdfgh99",
    "export GH_API_KEY=ghxabcdefghijklmnopqrstuv",
  ]) {
    const findings = scanSecrets(line, []);
    assert.ok(
      findings.some((f) => f.type === "secret_pattern"),
      `expected a secret_pattern for: ${line}`
    );
  }
});

test("prefixed-name false-positive guard: keyword with no real value stays unflagged (round3)", () => {
  for (const benign of ["DB_PASSWORD is required", "reset your password please", "MY_TOKEN:"]) {
    const findings = scanSecrets(benign, []);
    assert.ok(
      !findings.some((f) => f.type === "secret_pattern"),
      `benign text must not be flagged: ${benign}`
    );
  }
});

// Round 3 (medium): fine-grained GitHub PAT + GitLab PAT + gh[osru]_ tokens.
// NB: each token's PREFIX is split from its body via concatenation so no complete
// real-looking token literal appears in this file — that keeps GitHub push
// protection / secret scanning from flagging these synthetic test fixtures, while
// the scanner under test still sees the full concatenated value at runtime.
test("github_pat / glpat / gh[osru]_ tokens are detected (round3)", () => {
  for (const tok of [
    "github" + "_pat_11ABCDE0000aBcDeFgHiJ_kLmNoPqRsTuVwXyZ1234567890abcdef",
    "gl" + "pat-abcdef1234567890ABCDEF",
    "gh" + "o_abcdefghijklmnopqrstuvwxyz0123456789",
    "gh" + "s_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ]) {
    const findings = scanSecrets(`token = ${tok}`, []);
    assert.ok(findings.some((f) => f.type === "secret_pattern"), `expected detection for ${tok}`);
  }
});
