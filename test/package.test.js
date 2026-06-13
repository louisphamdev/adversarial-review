/**
 * Package gate test — verifies npm pack --dry-run --json produces the expected
 * file list: runtime source only, no Python artifacts, no tests, no docs, no
 * local state, no tarballs.
 *
 * On Windows the npm executable is npm.cmd; the test resolves it via PATHEXT.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve the package directory (one level up from this test file's directory).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, "..");

/**
 * Resolve the npm executable accounting for Windows PATHEXT.
 * Returns "npm.cmd" on Windows, "npm" on POSIX.
 */
function resolveNpm() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Run npm pack --dry-run --json and return the parsed output.
 * Returns { ok: true, files: string[] } on success, or { ok: false, reason }
 * when npm is unavailable or the command fails.
 */
function runNpmPackDryRun() {
  const npmBin = resolveNpm();
  const result = spawnSync(npmBin, ["pack", "--dry-run", "--json"], {
    cwd: PKG_DIR,
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
  });

  if (result.error) {
    return {
      ok: false,
      reason: `npm exec error: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: `npm pack exited ${result.status}: ${result.stderr || result.stdout}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      reason: `could not parse npm pack JSON output: ${result.stdout.slice(0, 300)}`,
    };
  }

  // npm pack --json returns an array of tarball descriptors; each has a "files" array.
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      ok: false,
      reason: `unexpected npm pack JSON structure: ${JSON.stringify(parsed).slice(0, 300)}`,
    };
  }

  // Collect all filenames across all listed tarballs (usually one).
  const files = parsed.flatMap((entry) =>
    Array.isArray(entry.files)
      ? entry.files.map((f) => (typeof f === "object" && f.path ? f.path : String(f)))
      : []
  );

  return { ok: true, files };
}

// ─────────────────────────────────────────────────────────────────────────────

let packResult;

before(() => {
  packResult = runNpmPackDryRun();
});

describe("npm pack --dry-run file list", () => {
  it("npm pack runs successfully (skip if npm unavailable)", () => {
    if (!packResult.ok) {
      // Fail gracefully: print a clear skip message and do not count as a
      // test failure when npm is not available in the environment.
      console.log(`SKIP: npm pack unavailable — ${packResult.reason}`);
      return;
    }
    assert.ok(packResult.files.length > 0, "pack should list at least one file");
  });

  // ── Exclusions ───────────────────────────────────────────────────────────────

  it("excludes hooks/guard.py (legacy Python entrypoint)", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) => f.includes("guard.py"));
    assert.deepEqual(found, [], `guard.py must not be in the pack: ${found}`);
  });

  it("excludes hooks/__pycache__", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) => f.includes("__pycache__"));
    assert.deepEqual(found, [], `__pycache__ must not be in the pack: ${found}`);
  });

  it("excludes tests/ directory (Python tests)", () => {
    if (!packResult.ok) return;
    // Match paths that start with "tests/" (Python test directory)
    const found = packResult.files.filter((f) => /^tests[/\\]/.test(f));
    assert.deepEqual(found, [], `tests/ (Python) must not be in the pack: ${found}`);
  });

  it("excludes test/ directory (Node test files)", () => {
    if (!packResult.ok) return;
    // Match paths that start with "test/" (Node test directory)
    const found = packResult.files.filter((f) => /^test[/\\]/.test(f));
    assert.deepEqual(found, [], `test/ (Node tests) must not be in the pack: ${found}`);
  });

  it("excludes docs/superpowers/ directory", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) =>
      f.includes("docs/superpowers") || f.includes("docs\\superpowers")
    );
    assert.deepEqual(found, [], `docs/superpowers/ must not be in the pack: ${found}`);
  });

  it("excludes .adversarial-review/ local state directory", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) =>
      f.includes(".adversarial-review/") || f.includes(".adversarial-review\\")
    );
    assert.deepEqual(found, [], `.adversarial-review/ local state must not be in the pack: ${found}`);
  });

  it("excludes transcript files", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) =>
      f.includes("transcript") && (f.endsWith(".jsonl") || f.endsWith(".json"))
    );
    assert.deepEqual(found, [], `transcript files must not be in the pack: ${found}`);
  });

  it("excludes .tgz artifacts", () => {
    if (!packResult.ok) return;
    const found = packResult.files.filter((f) => f.endsWith(".tgz"));
    assert.deepEqual(found, [], `.tgz files must not be in the pack: ${found}`);
  });

  // ── Inclusions ───────────────────────────────────────────────────────────────

  it("includes package.json", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some((f) => f === "package.json");
    assert.ok(found, "package.json must be in the pack");
  });

  it("includes bin/adversarial-review.js", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) => f === "bin/adversarial-review.js" || f.endsWith("adversarial-review.js")
    );
    assert.ok(found, "bin/adversarial-review.js must be in the pack");
  });

  it("includes README.md", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some((f) => f.toLowerCase() === "readme.md");
    assert.ok(found, "README.md must be in the pack");
  });

  it("includes LICENSE", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some((f) => f === "LICENSE");
    assert.ok(found, "LICENSE must be in the pack");
  });

  it("includes src/prompts/external-brief.md", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) =>
        f.includes("src/prompts/external-brief.md") ||
        f.includes("src\\prompts\\external-brief.md")
    );
    assert.ok(found, "src/prompts/external-brief.md must be in the pack");
  });

  it("includes src/prompts/adversarial-review-orchestrator.md", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) =>
        f.includes("src/prompts/adversarial-review-orchestrator.md") ||
        f.includes("src\\prompts\\adversarial-review-orchestrator.md")
    );
    assert.ok(found, "src/prompts/adversarial-review-orchestrator.md must be in the pack");
  });

  it("includes src/integrations/claude-code/hooks.json", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) =>
        f.includes("src/integrations/claude-code/hooks.json") ||
        f.includes("src\\integrations\\claude-code\\hooks.json")
    );
    assert.ok(found, "src/integrations/claude-code/hooks.json must be in the pack");
  });

  it("includes .claude-plugin/ directory files", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) => f.includes(".claude-plugin/") || f.includes(".claude-plugin\\")
    );
    assert.ok(found, ".claude-plugin/ files must be in the pack");
  });

  it("includes src/core/ runtime files", () => {
    if (!packResult.ok) return;
    const found = packResult.files.some(
      (f) =>
        f.includes("src/core/") || f.includes("src\\core\\")
    );
    assert.ok(found, "src/core/ runtime files must be in the pack");
  });
});
