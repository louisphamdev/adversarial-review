import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  captureBaseline,
  buildReviewDiff,
  synthesizeNewFileDiff,
  snapshotWorkspace,
} from "../../src/core/diff.js";
import { git } from "../../src/core/git.js";

// Detect git once. If git is missing, GIT tests skip but FILESYSTEM tests run.
const GIT_AVAILABLE = (() => {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

// Run a git command synchronously in `cwd`, asserting success.
function gitSync(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// Initialize a fresh temp git repo with an identity configured locally.
function initRepo(cwd) {
  gitSync(cwd, ["init", "-q"]);
  gitSync(cwd, ["config", "user.email", "test@example.com"]);
  gitSync(cwd, ["config", "user.name", "Test User"]);
  // Stable default branch name across git versions.
  gitSync(cwd, ["checkout", "-q", "-b", "main"]);
}

// ---------------------------------------------------------------------------
// GIT baseline + diff
// ---------------------------------------------------------------------------

describe("buildReviewDiff (git)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-diff-git-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a file committed after the baseline", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "committed");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);

    const baseline = await captureBaseline(repo);
    assert.equal(baseline.type, "git");
    assert.ok(baseline.head);

    // New commit after baseline.
    await writeFile(join(repo, "feature.js"), "export const x = 1;\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "feature"]);

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.includes("feature.js"), "diff text should mention feature.js");
    assert.ok(
      diff.changedFiles.some((f) => f.path === "feature.js" && f.status === "A"),
      "changedFiles should contain feature.js as A"
    );
  });

  it("reports a staged file", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "staged");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    await writeFile(join(repo, "staged.js"), "const s = 1;\n");
    gitSync(repo, ["add", "staged.js"]);

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.includes("staged.js"));
    assert.ok(diff.changedFiles.some((f) => f.path === "staged.js"));
  });

  it("reports an unstaged modification", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "unstaged");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "mod.txt"), "original\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    await writeFile(join(repo, "mod.txt"), "changed\n");

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.includes("mod.txt"));
    assert.ok(
      diff.changedFiles.some((f) => f.path === "mod.txt" && f.status === "M")
    );
  });

  it("synthesizes an untracked file into the diff", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "untracked");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    await writeFile(join(repo, "untracked.js"), "const u = 2;\n");

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.includes("untracked.js"), "synthesized diff should mention untracked.js");
    assert.ok(diff.text.includes("+const u = 2;"), "synthesized diff should include + content");
    assert.ok(
      diff.changedFiles.some((f) => f.path === "untracked.js" && f.status === "A")
    );
  });

  it("returns both old and new paths for a rename", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "rename");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "old-name.js"), "export const value = 42;\nconst more = 1;\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    gitSync(repo, ["mv", "old-name.js", "new-name.js"]);
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "rename"]);

    const diff = await buildReviewDiff(repo, baseline);
    const paths = diff.changedFiles.map((f) => f.path);
    assert.ok(paths.includes("old-name.js"), "changedFiles should include old path");
    assert.ok(paths.includes("new-name.js"), "changedFiles should include new path");
  });

  it("produces a non-empty binary diff block", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "binary");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    // Buffer containing NUL bytes -> git treats it as binary.
    await writeFile(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 255, 0]));
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "binary"]);

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.length > 0, "binary diff text must be non-empty");
    assert.ok(diff.text.includes("blob.bin"), "diff should reference the binary file");
    assert.ok(
      diff.changedFiles.some((f) => f.path === "blob.bin"),
      "changedFiles should include the binary file"
    );
  });
});

// ---------------------------------------------------------------------------
// FILESYSTEM baseline + diff (the bypass-closing tests) — always run
// ---------------------------------------------------------------------------

describe("buildReviewDiff (filesystem, non-git)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-diff-fs-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures a filesystem baseline with a serializable snapshot", async () => {
    const ws = join(dir, "capture");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "a.js"), "const a = 1;\n");

    const baseline = await captureBaseline(ws);
    assert.equal(baseline.type, "filesystem");
    assert.equal(typeof baseline.snapshot, "object");
    assert.ok(baseline.snapshot["a.js"], "snapshot keyed by relative posix path");
    // Must be JSON round-trippable (later tasks persist it).
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(baseline)));
  });

  it("reports ADDED, MODIFIED and DELETED files (closes the non-git bypass)", async () => {
    const ws = join(dir, "amd");
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "keep.js"), "const keep = 1;\n");
    await writeFile(join(ws, "modify.js"), "const before = 1;\n");
    await writeFile(join(ws, "remove.js"), "const gone = 1;\n");

    const baseline = await captureBaseline(ws);

    // Mutate the workspace: add, modify, delete.
    await writeFile(join(ws, "sub", "added.js"), "const added = 2;\n");
    await writeFile(join(ws, "modify.js"), "const after = 999;\n");
    await rm(join(ws, "remove.js"));

    const diff = await buildReviewDiff(ws, baseline);

    // INVARIANT: changed files -> non-empty text and changedFiles.
    assert.ok(diff.text.length > 0, "text must be non-empty when files changed");
    assert.ok(diff.changedFiles.length > 0, "changedFiles must be non-empty");

    const byPath = new Map(diff.changedFiles.map((f) => [f.path, f.status]));
    assert.equal(byPath.get("sub/added.js"), "A", "added file should be A");
    assert.equal(byPath.get("modify.js"), "M", "modified file should be M");
    assert.equal(byPath.get("remove.js"), "D", "removed file should be D");
    // Unchanged file must NOT appear.
    assert.equal(byPath.has("keep.js"), false, "unchanged file should be absent");

    // Diff text should reflect the change content / markers.
    assert.ok(diff.text.includes("sub/added.js"));
    assert.ok(diff.text.includes("modify.js"));
    assert.ok(diff.text.includes("deleted file mode"), "should contain a deletion marker");
  });

  it("reports a binary file change as a metadata block, not silently dropped", async () => {
    const ws = join(dir, "binfs");
    await mkdir(ws, { recursive: true });
    // Baseline binary file.
    await writeFile(join(ws, "data.bin"), Buffer.from([0, 1, 2, 3, 0, 4]));
    const baseline = await captureBaseline(ws);

    // Change its content (and size).
    await writeFile(join(ws, "data.bin"), Buffer.from([0, 9, 9, 9, 9, 9, 9, 0]));

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(diff.text.includes("data.bin"), "binary change must appear in text");
    assert.ok(
      diff.text.includes("Binary file"),
      "binary change should be a metadata block"
    );
    assert.ok(diff.changedFiles.some((f) => f.path === "data.bin" && f.status === "M"));
  });

  it("reports an added binary file as a metadata block", async () => {
    const ws = join(dir, "binadd");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "seed.txt"), "seed\n");
    const baseline = await captureBaseline(ws);

    await writeFile(join(ws, "new.bin"), Buffer.from([0, 5, 0, 6, 0]));

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(diff.text.includes("new.bin"));
    assert.ok(diff.text.includes("Binary file"));
    assert.ok(diff.changedFiles.some((f) => f.path === "new.bin" && f.status === "A"));
  });

  it("returns an empty changedFiles when nothing changed (correct empty, not bypass)", async () => {
    const ws = join(dir, "nochange");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "stable.js"), "const s = 1;\n");
    const baseline = await captureBaseline(ws);

    const diff = await buildReviewDiff(ws, baseline);
    assert.deepEqual(diff.changedFiles, [], "no changes -> empty changedFiles");
    assert.equal(diff.text, "", "no changes -> empty text");
  });
});

// ---------------------------------------------------------------------------
// snapshotWorkspace internals
// ---------------------------------------------------------------------------

describe("snapshotWorkspace", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-snap-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips ignored directories and uses posix relative paths", async () => {
    const ws = join(dir, "skip");
    await mkdir(join(ws, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(ws, ".git"), { recursive: true });
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(join(ws, ".git", "config"), "ignored\n");
    await writeFile(join(ws, "src", "main.js"), "kept\n");

    const { files, truncated } = await snapshotWorkspace(ws);
    assert.equal(truncated, false);
    assert.ok(files.has("src/main.js"), "should keep src/main.js with posix path");
    assert.equal(
      [...files.keys()].some((k) => k.includes("node_modules")),
      false,
      "node_modules must be skipped"
    );
    assert.equal(
      [...files.keys()].some((k) => k.includes(".git")),
      false,
      ".git must be skipped"
    );
  });

  it("flags truncation when maxFiles is exceeded", async () => {
    const ws = join(dir, "trunc");
    await mkdir(ws, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(ws, `f${i}.txt`), `n${i}\n`);
    }
    const { truncated } = await snapshotWorkspace(ws, { maxFiles: 2 });
    assert.equal(truncated, true);
  });

  it("marks binary files with binary:true and metadata hash", async () => {
    const ws = join(dir, "bin");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "x.bin"), Buffer.from([0, 1, 2, 0]));
    const { files } = await snapshotWorkspace(ws);
    assert.equal(files.get("x.bin").binary, true);
  });
});

// ---------------------------------------------------------------------------
// synthesizeNewFileDiff
// ---------------------------------------------------------------------------

describe("synthesizeNewFileDiff", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-synth-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefixes each content line with +", async () => {
    await writeFile(join(dir, "f.js"), "line1\nline2\n");
    const block = await synthesizeNewFileDiff(dir, "f.js");
    assert.ok(block.includes("new file mode 100644"));
    assert.ok(block.includes("+line1"));
    assert.ok(block.includes("+line2"));
  });
});

// ---------------------------------------------------------------------------
// FIX 1+2 — content hash detects same-size edits of large / binary files
// ---------------------------------------------------------------------------

describe("content-hash detects same-size edits (FIX 1+2)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-hash-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects a one-byte middle edit of a 2MB text file (size unchanged)", async () => {
    const ws = join(dir, "bigtext");
    await mkdir(ws, { recursive: true });
    // 2MB of 'a' (above the 1MB diff-text cap, hashed in full regardless).
    const size = 2 * 1024 * 1024;
    const buf = Buffer.alloc(size, "a".charCodeAt(0));
    await writeFile(join(ws, "big.txt"), buf);

    const baseline = await captureBaseline(ws);

    // Flip ONE middle byte, keeping the file size identical.
    buf[Math.floor(size / 2)] = "b".charCodeAt(0);
    await writeFile(join(ws, "big.txt"), buf);

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "big.txt" && f.status === "M"),
      "same-size large-file edit must be reported as M"
    );
    assert.ok(diff.text.includes("big.txt"), "diff text must mention the file");
    assert.ok(diff.text.length > 0, "diff text must be non-empty");
    // Coverage-limitation marker present because the body exceeds the cap.
    assert.ok(diff.text.includes("truncated:"), "over-cap diff text should carry a truncation marker");
  });

  it("detects a same-size content edit of a binary file", async () => {
    const ws = join(dir, "binsamesize");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
    const baseline = await captureBaseline(ws);

    // Same length, different content -> previously hashed identically by size.
    await writeFile(join(ws, "blob.bin"), Buffer.from([0, 9, 8, 7, 0, 6, 5, 4]));

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "blob.bin" && f.status === "M"),
      "same-size binary edit must be reported as M"
    );
    assert.ok(diff.text.includes("blob.bin"), "diff text must mention the binary file");
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — dist/build/.next are reviewable (not skipped)
// ---------------------------------------------------------------------------

describe("committed build artifacts are reviewable (FIX 3)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-dist-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a changed dist/bundle.js under a filesystem baseline", async () => {
    const ws = join(dir, "distws");
    await mkdir(join(ws, "dist"), { recursive: true });
    await writeFile(join(ws, "dist", "bundle.js"), "console.log('v1');\n");
    const baseline = await captureBaseline(ws);

    await writeFile(join(ws, "dist", "bundle.js"), "console.log('v2-pwned');\n");

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "dist/bundle.js" && f.status === "M"),
      "dist/bundle.js change must be reported"
    );
    assert.ok(diff.text.includes("dist/bundle.js"), "diff text must mention dist/bundle.js");
    assert.ok(diff.text.length > 0, "diff text must be non-empty");
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — git mode does not let .gitignore hide untracked runtime files
// ---------------------------------------------------------------------------

describe("git mode surfaces gitignored-but-present files (FIX 4)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-gitignore-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("includes a gitignored new file, still excludes node_modules", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "ignored");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, ".gitignore"), "secret-runtime/\n");
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    // A gitignored-but-present runtime file (the bypass we are closing).
    await mkdir(join(repo, "secret-runtime"), { recursive: true });
    await writeFile(join(repo, "secret-runtime", "loader.js"), "globalThis.pwn = 1;\n");
    // A dependency file that MUST stay excluded.
    await mkdir(join(repo, "node_modules", "evil"), { recursive: true });
    await writeFile(join(repo, "node_modules", "evil", "index.js"), "noise\n");

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "secret-runtime/loader.js" && f.status === "A"),
      "gitignored-but-present file must appear as A"
    );
    assert.ok(
      diff.text.includes("secret-runtime/loader.js"),
      "diff text must include the gitignored file"
    );
    assert.equal(
      diff.changedFiles.some((f) => f.path.includes("node_modules")),
      false,
      "node_modules must remain excluded"
    );
  });
});

// ---------------------------------------------------------------------------
// FIX 5 — symlink target changes are reviewable
// ---------------------------------------------------------------------------

describe("symlink target changes are reviewable (FIX 5)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-symlink-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a repointed symlink as a modification", async (t) => {
    const ws = join(dir, "symws");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "target-a.txt"), "A\n");
    await writeFile(join(ws, "target-b.txt"), "B\n");

    // Symlink creation needs privilege on Windows; skip gracefully if denied.
    try {
      await symlink("target-a.txt", join(ws, "link.txt"));
    } catch (err) {
      return t.skip(`symlink unsupported here: ${err.code || err.message}`);
    }

    const baseline = await captureBaseline(ws);
    assert.ok(baseline.snapshot["link.txt"], "symlink should be snapshotted");
    assert.equal(baseline.snapshot["link.txt"].symlink, true);

    // Repoint the link to a different target (no content read involved).
    await rm(join(ws, "link.txt"));
    await symlink("target-b.txt", join(ws, "link.txt"));

    const diff = await buildReviewDiff(ws, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "link.txt" && f.status === "M"),
      "repointed symlink must be reported as M"
    );
    assert.ok(diff.text.includes("Symlink"), "diff text should note the symlink");
    assert.ok(diff.text.includes("target-b.txt"), "diff text should show the new target");
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — git() bounds stdout and exposes a truncated flag
// ---------------------------------------------------------------------------

describe("git() stdout buffering (FIX 6)", () => {
  it("returns normal output with a falsy truncated flag", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const result = await git(["--version"], process.cwd());
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("git version"), "should capture normal output");
    assert.ok(!result.truncated, "truncated should default to falsy on normal output");
  });
});
