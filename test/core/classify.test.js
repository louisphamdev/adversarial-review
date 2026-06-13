import test from "node:test";
import assert from "node:assert/strict";
import { classifyPath } from "../../src/core/classify.js";

// Case 1: Plain README.md is docs-only and not reviewable/sensitive.
test("README.md is docs-only", () => {
  const result = classifyPath("README.md");
  assert.equal(result.docsOnly, true);
  assert.equal(result.reviewable, false);
  assert.equal(result.sensitive, false);
});

// Case 2: A markdown file under a sensitive directory is sensitive and reviewable.
test("security/README.md is sensitive and reviewable", () => {
  const result = classifyPath("security/README.md");
  assert.equal(result.sensitive, true);
  assert.equal(result.reviewable, true);
  assert.equal(result.docsOnly, false);
});

// Case 3: package.json is in REVIEWABLE_NAMES so it is reviewable.
test("package.json is reviewable", () => {
  const result = classifyPath("package.json");
  assert.equal(result.reviewable, true);
});

// Case 4: GitHub Actions workflow file — test BOTH backslash (Windows) and
// forward-slash path variants to confirm backslash normalization works.
test(".github/workflows/ci.yml (forward slash) is reviewable and sensitive", () => {
  const result = classifyPath(".github/workflows/ci.yml");
  assert.equal(result.reviewable, true);
  assert.equal(result.sensitive, true);
});

test(".github\\workflows\\ci.yml (backslash) is reviewable and sensitive", () => {
  const result = classifyPath(".github\\workflows\\ci.yml");
  assert.equal(result.reviewable, true);
  assert.equal(result.sensitive, true);
});

// Case 5: auth_login.py matches the sensitive regex by name.
test("auth_login.py is sensitive", () => {
  const result = classifyPath("src/auth_login.py");
  assert.equal(result.sensitive, true);
  assert.equal(result.reviewable, true);
});

// Case 6: .astro files are not reviewable by default but become reviewable
// when added via config.sensitivity.extraCodeExts.
test(".astro extension is reviewable when configured via extraCodeExts", () => {
  const config = { sensitivity: { extraCodeExts: [".astro"] } };
  const resultDefault = classifyPath("index.astro");
  assert.equal(resultDefault.reviewable, false, "should not be reviewable without config");

  const resultConfigured = classifyPath("index.astro", config);
  assert.equal(resultConfigured.reviewable, true, "should be reviewable with extraCodeExts");
});

// Case 7: Windows script extensions are reviewable via CODE_EXTS.
test("scripts/build.bat is reviewable", () => {
  const result = classifyPath("scripts/build.bat");
  assert.equal(result.reviewable, true);
});

test("scripts/deploy.cmd is reviewable", () => {
  const result = classifyPath("scripts/deploy.cmd");
  assert.equal(result.reviewable, true);
});

test("scripts/setup.ps1 is reviewable", () => {
  const result = classifyPath("scripts/setup.ps1");
  assert.equal(result.reviewable, true);
});

// Case 8: Terraform .tfvars is reviewable via CODE_EXTS.
test("prod.tfvars is reviewable", () => {
  const result = classifyPath("prod.tfvars");
  assert.equal(result.reviewable, true);
});

// Case 9: Jupyter notebooks are reviewable via CODE_EXTS.
test("analysis.ipynb is reviewable", () => {
  const result = classifyPath("analysis.ipynb");
  assert.equal(result.reviewable, true);
});

// Case 10: Makefile is reviewable via REVIEWABLE_NAMES (base is lowercased).
test("Makefile at root is reviewable", () => {
  const result = classifyPath("Makefile");
  assert.equal(result.reviewable, true);
});

// Case 11: Rust and Go manifest/lockfiles are reviewable via REVIEWABLE_NAMES.
test("Cargo.lock is reviewable", () => {
  const result = classifyPath("Cargo.lock");
  assert.equal(result.reviewable, true);
});

test("go.mod is reviewable", () => {
  const result = classifyPath("go.mod");
  assert.equal(result.reviewable, true);
});

// Case 12: SSH/TLS key files are sensitive=true AND reviewable=true via SENSITIVE_RE.
test("id_rsa is sensitive and reviewable", () => {
  const result = classifyPath("id_rsa");
  assert.equal(result.sensitive, true);
  assert.equal(result.reviewable, true);
});

test("server.pem is sensitive", () => {
  const result = classifyPath("server.pem");
  assert.equal(result.sensitive, true);
});

// Case 13: Regression — README.md must still be docsOnly after all additions.
test("README.md is still docsOnly (regression)", () => {
  const result = classifyPath("README.md");
  assert.equal(result.docsOnly, true);
  assert.equal(result.reviewable, false);
  assert.equal(result.sensitive, false);
});
