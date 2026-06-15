// Regression: a large virtualenv NOT named exactly ".venv" (e.g. ".venv-mcp", ~1.4 GB)
// had every file synthesized into the diff, overflowing V8's max string length
// (RangeError: Invalid string length) → buildReviewDiff threw → the Stop gate read
// diff===null and failed closed EVERY turn. Two layers fix it: (1) skip virtualenv
// directory variants; (2) a total-diff byte budget that degrades to a coverage sentinel
// instead of crashing. A real source FILE named like a skip dir (venv.py) must still be
// reviewed (skipping it on a basename match would be a fail-OPEN).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { snapshotWorkspace, captureBaseline, buildReviewDiff, synthesizeNewFileDiff } from "../../src/core/diff.js";

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

describe("virtualenv-variant skip (snapshot)", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-venv-snap-"));
    await mkdir(join(dir, ".venv-mcp", "torch"), { recursive: true });
    await writeFile(join(dir, ".venv-mcp", "torch", "lib.txt"), "x".repeat(1000), "utf8");
    await mkdir(join(dir, "venv311"), { recursive: true });
    await writeFile(join(dir, "venv311", "pkg.txt"), "y".repeat(1000), "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const x = 1;\n", "utf8");
    // A real SOURCE file whose basename matches the venv pattern must NOT be skipped.
    await writeFile(join(dir, "venv.py"), "import os\n", "utf8");
    // A real SOURCE directory with a non-dotted venv-ish name must NOT be skipped
    // (skipping it would be a fail-OPEN that hides code from review).
    await mkdir(join(dir, "venv-api"), { recursive: true });
    await writeFile(join(dir, "venv-api", "handler.js"), "export const h = 1;\n", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("excludes .venv-mcp and venv311 directories but keeps real source", async () => {
    const { files } = await snapshotWorkspace(dir);
    const paths = [...files.keys()];
    assert.ok(paths.includes("src/app.js"), "real source must be snapshotted");
    assert.ok(paths.includes("venv.py"), "a FILE named venv.py must still be reviewed (no fail-open)");
    assert.ok(paths.includes("venv-api/handler.js"), "a non-venv source dir (venv-api) must be reviewed");
    assert.ok(!paths.some((p) => p.startsWith(".venv-mcp/")), ".venv-mcp must be skipped");
    assert.ok(!paths.some((p) => p.startsWith("venv311/")), "venv311 must be skipped");
  });
});

describe("virtualenv-variant skip (git untracked)", { skip: !GIT_AVAILABLE }, () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-venv-git-"));
    initRepo(dir);
    await writeFile(join(dir, "README.md"), "# repo\n", "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "base"]);
    // Untracked (gitignored-but-present is the threat) trees + files.
    await writeFile(join(dir, ".gitignore"), ".venv-mcp/\n", "utf8");
    await mkdir(join(dir, ".venv-mcp", "torch"), { recursive: true });
    await writeFile(join(dir, ".venv-mcp", "torch", "big.bin"), "z".repeat(2000), "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "new.js"), "export const y = 2;\n", "utf8");
    await writeFile(join(dir, "venv.py"), "import sys\n", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("excludes .venv-mcp untracked files but includes src/new.js and venv.py", async () => {
    const baseline = await captureBaseline(dir);
    assert.equal(baseline.type, "git");
    const diff = await buildReviewDiff(dir, baseline);
    const paths = diff.changedFiles.map((c) => c.path);
    assert.ok(paths.includes("src/new.js"), "real new source must be in the diff");
    assert.ok(paths.includes("venv.py"), "venv.py FILE must be reviewed (no fail-open)");
    assert.ok(!paths.some((p) => p.startsWith(".venv-mcp/")), ".venv-mcp untracked files must be excluded");
    assert.ok(!diff.text.includes("big.bin"), "venv content must not be synthesized into the diff");
  });
});

describe("total-diff byte budget (no RangeError; degrades to sentinel)", { skip: !GIT_AVAILABLE }, () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-venv-budget-"));
    initRepo(dir);
    await writeFile(join(dir, "README.md"), "# repo\n", "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "base"]);
    // Several untracked files; a tiny injected cap forces the budget to trip.
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `extra${i}.js`), `// file ${i}\n` + "a".repeat(200), "utf8");
    }
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits the truncation sentinel + message instead of an over-long join", async () => {
    const baseline = await captureBaseline(dir);
    const diff = await buildReviewDiff(dir, baseline, { maxTotalDiffBytes: 50 });
    const paths = diff.changedFiles.map((c) => c.path);
    assert.ok(
      paths.includes(".adversarial-review-snapshot-truncated"),
      "budget overflow must surface the reviewable coverage-limitation sentinel"
    );
    assert.match(diff.text, /exceeded the .* total cap/, "diff must carry the truncation message");
  });
});

describe("filesystem-path total-diff byte budget", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-venv-fsbudget-"));
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `f${i}.js`), `// f${i}\n` + "b".repeat(200), "utf8");
    }
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("non-git added files over budget => sentinel (no crash)", async () => {
    // Empty baseline snapshot => every current file is "added".
    const baseline = { type: "filesystem", cwd: dir, snapshot: {}, truncated: false };
    const diff = await buildReviewDiff(dir, baseline, { maxTotalDiffBytes: 50 });
    const paths = diff.changedFiles.map((c) => c.path);
    assert.ok(paths.includes(".adversarial-review-snapshot-truncated"), "fs budget overflow must surface the sentinel");
    assert.match(diff.text, /exceeded the .* total cap/);
  });
});

describe("bounded per-file read (no whole-file load; cap marker is correct)", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-cap-"));
    await writeFile(join(dir, "big.txt"), "A".repeat(1000), "utf8");
    await writeFile(join(dir, "empty.txt"), "", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("caps content at maxFileBytes and emits the keyed truncation marker", async () => {
    const block = await synthesizeNewFileDiff(dir, "big.txt", 100);
    // The gate keys on this exact substring to fail closed on a truncated reviewable file.
    assert.match(block, /coverage limitation: diff text capped at 100 bytes/);
    // Only ~100 bytes of content are inlined (not the full 1000).
    const plusBytes = block.split("\n").filter((l) => l.startsWith("+")).join("").length;
    assert.ok(plusBytes <= 120, `inlined content must be capped (~100), got ${plusBytes}`);
  });

  it("an empty file renders as a valid empty added file (no 'unreadable')", async () => {
    const block = await synthesizeNewFileDiff(dir, "empty.txt", 100);
    assert.ok(!block.includes("Binary or unreadable"), "empty file must not be misreported");
    assert.ok(!block.includes("coverage limitation"), "empty file is not truncated");
  });
});

describe("newline-in-filename is parsed intact (-z), content not hidden", { skip: !GIT_AVAILABLE || process.platform === "win32" }, () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-nl-"));
    initRepo(dir);
    await writeFile(join(dir, "README.md"), "# r\n", "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "base"]);
    // Untracked file whose NAME contains a newline (legal on POSIX). Pre-fix, splitting
    // git output on newlines broke it into fake paths and hid MALICIOUS_TOKEN.
    await writeFile(join(dir, "src_evil\nfile.js"), "const x = 'MALICIOUS_TOKEN';\n", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the real path and includes its content, not fake split paths", async () => {
    const baseline = await captureBaseline(dir);
    const diff = await buildReviewDiff(dir, baseline);
    const paths = diff.changedFiles.map((c) => c.path);
    assert.ok(paths.includes("src_evil\nfile.js"), "the real (newline) path must be a single changed file");
    assert.ok(diff.text.includes("MALICIOUS_TOKEN"), "the real file content must be shown to the reviewer");
    assert.ok(!paths.includes("src_evil"), "no fake split path");
    assert.ok(!paths.includes("file.js"), "no fake split path");
  });
});
