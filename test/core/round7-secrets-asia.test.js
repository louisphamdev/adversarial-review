// ROUND7 regression (GPT-5.5-xhigh): the AWS access-key-id pattern matched only the
// long-lived AKIA prefix, so an ASIA-prefixed STS TEMPORARY access key id slipped past
// the secret scanner. Both prefixes must be detected. Fixtures split the prefix from
// the body so the literal is not itself flagged as a real key by push protection.

import test from "node:test";
import assert from "node:assert/strict";
import { scanSecrets } from "../../src/core/secrets.js";

test("ASIA temporary AWS access key id is detected", () => {
  const fixture = "AWS_ACCESS_KEY_ID=" + "ASIA" + "ABCDEFGH12345678" + "\n";
  const findings = scanSecrets(fixture, ["src/fixture.js"]);
  assert.ok(findings.some((f) => f.type === "secret_pattern"), "ASIA key must be flagged");
});

test("AKIA long-lived AWS access key id is still detected", () => {
  const fixture = "key = " + "AKIA" + "ABCDEFGH12345678" + "\n";
  const findings = scanSecrets(fixture, ["src/fixture.js"]);
  assert.ok(findings.some((f) => f.type === "secret_pattern"), "AKIA key must be flagged");
});

test("a non-key ASIA-like word is NOT flagged (no false positive)", () => {
  // Too short to be a 16-char-body key id.
  const findings = scanSecrets("the ASIANS arrived\n", ["src/x.js"]);
  assert.equal(findings.some((f) => f.type === "secret_pattern"), false);
});
