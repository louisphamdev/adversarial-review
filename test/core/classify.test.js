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

// Case 6: .astro files have an UNKNOWN non-empty extension. Failing CLOSED, an
// unrecognized (non-docs) extension now defaults to reviewable=true with OR
// without config — an attacker must not be able to dodge review with an obscure
// extension. extraCodeExts still includes it as code; either way it is reviewed.
test(".astro extension is reviewable (unknown ext fails closed, with or without config)", () => {
  const config = { sensitivity: { extraCodeExts: [".astro"] } };
  const resultDefault = classifyPath("index.astro");
  assert.equal(resultDefault.reviewable, true, "unknown non-docs ext must fail closed to reviewable");
  assert.equal(resultDefault.docsOnly, false);

  const resultConfigured = classifyPath("index.astro", config);
  assert.equal(resultConfigured.reviewable, true, "should remain reviewable with extraCodeExts");
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

// COLLISION-3(b): a trailing space must not corrupt the computed extension and
// silently drop reviewable status. 'weird.js ' must classify exactly like
// 'weird.js' (ext ".js", reviewable=true).
test("COLLISION-3b: trailing space keeps a code file reviewable", () => {
  const result = classifyPath("weird.js ");
  assert.equal(result.reviewable, true, "trailing space must not drop reviewable status");
  assert.equal(result.ext, ".js", "ext must be computed from the trimmed segment");
});

// COLLISION-3(b): a sensitive-looking path with a trailing dot stays reviewable
// AND sensitive; the trailing dot must not be misread as the extension.
test("COLLISION-3b: trailing-dot sensitive path stays reviewable and sensitive", () => {
  const result = classifyPath("src/auth/login.js.");
  assert.equal(result.reviewable, true);
  assert.equal(result.sensitive, true);
  // The trailing dot must not corrupt ext into a bare "." — it resolves to ".js".
  assert.equal(result.ext, ".js");
});

// COLLISION-3(b): a non-sensitive code file with a trailing dot is still detected
// as code (ext computed from the trimmed segment), so it stays reviewable.
test("COLLISION-3b: trailing-dot code file stays reviewable via its real ext", () => {
  const result = classifyPath("src/util.py.");
  assert.equal(result.reviewable, true);
  assert.equal(result.ext, ".py");
});

// COLLISION-3(b): when the extension is ambiguous/empty (extensionless file that
// is not a known docs file), default to reviewable for safety (fail closed) — do
// NOT silently treat an ambiguous path as non-reviewable/docs-only.
test("COLLISION-3b: an extensionless ambiguous file defaults to reviewable", () => {
  const result = classifyPath("scripts/run-thing");
  assert.equal(result.reviewable, true, "ambiguous extensionless path must default reviewable");
  assert.equal(result.docsOnly, false);
});

// COLLISION-3(b) regression: known docs extensions are unaffected by trimming and
// must remain docs-only (not swept into the reviewable default).
test("COLLISION-3b: a docs file with a trailing space stays docs-only", () => {
  const result = classifyPath("notes.md ");
  assert.equal(result.docsOnly, true);
  assert.equal(result.reviewable, false);
  assert.equal(result.ext, ".md");
});

// ---------------------------------------------------------------------------
// Adversarial / fail-closed regressions for classifyPath hardening.
// Root cause class: a changed-file path that is unreviewable/ambiguous must be
// treated as REVIEWABLE (so it is reviewed), NEVER silently dropped (which would
// make the gate return level_none and ALLOW unreviewed code in enforced mode).
// ---------------------------------------------------------------------------

// FAIL-CLOSED #1: zero-width / Unicode format chars in a real code filename must
// NOT survive into the extension and drop the file from review. A file literally
// named "payload.js<ZWSP>" must recover ext=".js" and classify reviewable=true.
// JS `.trim()` and `\s` do NOT match these chars, so this is the bypass.
test("FAIL-CLOSED: zero-width/format chars in a .js filename stay reviewable", () => {
  const ZWSP = "​"; // ZERO WIDTH SPACE
  const ZWNJ = "‌"; // ZERO WIDTH NON-JOINER
  const ZWJ = "‍"; // ZERO WIDTH JOINER
  const BOM = "﻿"; // ZERO WIDTH NO-BREAK SPACE / BOM
  const MONGV = "᠎"; // MONGOLIAN VOWEL SEPARATOR
  for (const c of [ZWSP, ZWNJ, ZWJ, BOM, MONGV]) {
    const result = classifyPath("payload.js" + c);
    assert.equal(result.reviewable, true, `zero-width char U+${c.codePointAt(0).toString(16)} must not drop reviewable`);
    assert.equal(result.ext, ".js", "real extension must be recovered after stripping the format char");
    assert.equal(result.docsOnly, false);
  }
  // A .ts file is equally affected and must also fail closed.
  const ts = classifyPath("evil.ts" + ZWSP);
  assert.equal(ts.reviewable, true);
  assert.equal(ts.ext, ".ts");
});

// FAIL-CLOSED #2: a zero-width char must not turn a code file into a
// non-reviewable AND non-docs limbo (the level_none bypass). It also must not
// corrupt a genuine docs file: README.md<ZWSP> stays docs-only (ext recovered).
test("FAIL-CLOSED: zero-width char neither bypasses code review nor corrupts docs", () => {
  const ZWSP = "​";
  const code = classifyPath("evil.js" + ZWSP);
  assert.equal(code.reviewable, true, "cloaked code file must be reviewable, not level_none");
  assert.equal(code.docsOnly, false);

  const doc = classifyPath("README.md" + ZWSP);
  assert.equal(doc.ext, ".md", "real docs extension must be recovered after stripping the format char");
  assert.equal(doc.docsOnly, true, "a genuine docs file stays docs-only even with a trailing format char");
  assert.equal(doc.reviewable, false);
});

// FAIL-CLOSED #3: an UNKNOWN non-empty extension must fail closed to reviewable.
// Previously the ambiguous fail-open net only fired for an empty ext, so
// .config/.bak/.lock/.markdown/.so/.wasm passed unreviewed (level_none).
test("FAIL-CLOSED: unknown non-empty extensions default to reviewable", () => {
  for (const p of [
    "backdoor.config", "old.bak", "thing.lock", "doc.markdown",
    "native.so", "module.wasm", "blob.bin",
  ]) {
    const result = classifyPath(p);
    assert.equal(result.reviewable, true, `${p}: unknown non-docs ext must fail closed to reviewable`);
    assert.equal(result.docsOnly, false, `${p}: must not be treated as docs-only`);
  }
});

// FAIL-CLOSED #4: dot-prefixed config/runtime files must be reviewable. The
// leading dot must NOT be read as a non-empty unknown extension (".npmrc") that
// slips past the ambiguity net. These files execute or carry credentials
// (.bashrc/.zshrc/.profile run on shell startup; .npmrc carries _authToken).
test("FAIL-CLOSED: dot-prefixed runtime/config files are reviewable", () => {
  for (const p of [
    ".npmrc", ".bashrc", ".zshrc", ".profile", ".gitconfig",
    ".bash_profile", ".terraformrc",
  ]) {
    const result = classifyPath(p);
    assert.equal(result.reviewable, true, `${p}: dot-prefixed runtime file must be reviewable`);
    assert.equal(result.docsOnly, false, `${p}: must not be treated as docs-only`);
    assert.equal(result.ext, "", `${p}: a leading-dot-only dotfile must yield ext="" (no bogus unknown ext)`);
  }
});

// FAIL-CLOSED #4 regression: a dotfile WITH a known interior extension still
// resolves its real extension (not the leading-dot name), and stays reviewable.
test("FAIL-CLOSED: .eslintrc.json resolves its real .json extension", () => {
  const result = classifyPath(".eslintrc.json");
  assert.equal(result.ext, ".json", "interior extension must win over the leading dot");
  assert.equal(result.reviewable, true);
});
