import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from "node:fs/promises";
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

  it("R3: a git repo with NO commits falls back to a filesystem baseline (no bypass)", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "zero-commit");
    await mkdir(repo, { recursive: true });
    initRepo(repo); // initialized but NEVER committed -> no HEAD
    const baseline = await captureBaseline(repo);
    // With no HEAD there is no committed tree to diff against; the baseline must
    // fall back to a filesystem snapshot, not type:"git" with head:null (which
    // made buildReviewDiff skip BOTH branches and render every file invisible).
    assert.equal(baseline.type, "filesystem", "no-HEAD repo uses a filesystem baseline");
    await writeFile(join(repo, "evil.js"), "const evil = 1;\n");
    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(diff.text.includes("evil.js"), "a new file in a zero-commit repo must be visible to the gate");
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

  // ROUND2 finding 4 — an empty (0-byte) new TEXT file must render as a proper
  // empty added-file block, NOT be misreported as "Binary or unreadable file".
  it("renders an empty new text file as an added file, not binary/unreadable (round2 #4)", async () => {
    await writeFile(join(dir, "empty.txt"), "");
    const block = await synthesizeNewFileDiff(dir, "empty.txt");
    assert.ok(block.includes("new file mode 100644"), "should mark a new file");
    assert.ok(block.includes("--- /dev/null"), "should render the added-file header");
    assert.ok(block.includes("+++ b/empty.txt"), "should reference the new path");
    assert.equal(
      block.includes("Binary or unreadable file"),
      false,
      "empty text file must NOT be reported as binary/unreadable"
    );
  });

  // ROUND2 finding 4 — a genuinely missing/unreadable file MUST still take the
  // "Binary or unreadable" path (the read-failure branch is preserved).
  it("still reports a missing/unreadable file as binary/unreadable (round2 #4)", async () => {
    const block = await synthesizeNewFileDiff(dir, "does-not-exist.txt");
    assert.ok(
      block.includes("Binary or unreadable file"),
      "a missing file must still be reported as binary/unreadable"
    );
  });
});

// ---------------------------------------------------------------------------
// ROUND2 finding 3 — a truncated filesystem baseline fails CLOSED: the diff is
// never a vacuous empty result and carries a coverage-limitation marker plus a
// reviewable sentinel changed-file so the gate cannot treat it as "no changes".
// ---------------------------------------------------------------------------

describe("truncated filesystem baseline fails closed (round2 #3)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-trunc-baseline-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("surfaces a change to a file outside the truncated window via a sentinel + marker", async () => {
    const ws = join(dir, "trunc");
    await mkdir(ws, { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      await writeFile(join(ws, `f${String(i).padStart(3, "0")}.txt`), `content ${i}\n`);
    }

    // Build a TRUNCATED filesystem baseline (capture only a subset of files).
    const snap = await snapshotWorkspace(ws, { maxFiles: 3 });
    assert.equal(snap.truncated, true, "snapshot must be truncated for this repro");
    const baseline = {
      type: "filesystem",
      cwd: ws,
      capturedAt: Date.now(),
      snapshot: Object.fromEntries(snap.files),
      truncated: snap.truncated,
      options: { maxFiles: 3 },
    };

    // Modify a victim file that fell OUTSIDE the captured window.
    const captured = new Set(Object.keys(baseline.snapshot));
    let victim = null;
    for (let i = 0; i < 10; i += 1) {
      const name = `f${String(i).padStart(3, "0")}.txt`;
      if (!captured.has(name)) {
        victim = name;
        break;
      }
    }
    assert.ok(victim, "there must be an uncaptured victim file");
    await writeFile(join(ws, victim), "MALICIOUS PAYLOAD\n");

    const diff = await buildReviewDiff(ws, baseline);

    // The diff must NOT be vacuously empty (the silent-bypass case).
    assert.ok(diff.text.length > 0, "truncated baseline must not yield empty text");
    assert.ok(diff.changedFiles.length > 0, "truncated baseline must not yield empty changedFiles");
    // The coverage-limitation marker must be present.
    assert.ok(
      /coverage limitation: filesystem snapshot truncated/.test(diff.text),
      "diff text must carry the truncation coverage-limitation marker"
    );
    // A sentinel reviewable changed-file must be present so the gate escalates.
    assert.ok(
      diff.changedFiles.some((f) => f.path === ".adversarial-review-snapshot-truncated"),
      "diff must include the reviewable truncation sentinel changed-file"
    );
  });

  it("does NOT add the truncation marker for a complete (non-truncated) baseline", async () => {
    const ws = join(dir, "complete");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "a.txt"), "1\n");
    const baseline = await captureBaseline(ws);
    assert.equal(baseline.truncated, false, "small workspace must not truncate");

    await writeFile(join(ws, "a.txt"), "2\n");
    const diff = await buildReviewDiff(ws, baseline);

    assert.equal(
      /snapshot truncated/.test(diff.text),
      false,
      "a complete baseline must NOT carry a truncation marker (no false positive)"
    );
    assert.equal(
      diff.changedFiles.some((f) => f.path === ".adversarial-review-snapshot-truncated"),
      false,
      "a complete baseline must NOT add the truncation sentinel"
    );
    assert.ok(
      diff.changedFiles.some((f) => f.path === "a.txt" && f.status === "M"),
      "the real modification is still reported normally"
    );
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

// ---------------------------------------------------------------------------
// AUDIT — non-ASCII filenames classify reviewable in a default git repo
// (git core.quotePath=true C-quotes non-ASCII paths; git.js now forces it off)
// ---------------------------------------------------------------------------

describe("non-ASCII code filenames are reviewable under git (quotePath)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-quotepath-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Repro: with the DEFAULT core.quotePath=true, `git ls-files --others` /
  // `git diff --name-status` emit "caf\303\251.js" (octal-escaped, quoted).
  // The old code turned that into the bogus path "caf/303/251.js" with a
  // literal trailing quote, so classifyPath saw ext '.js"' -> reviewable:false
  // and synthesizeNewFileDiff could not read the (phantom) file.
  it("surfaces an untracked café.js with a clean UTF-8 path and real content", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "untracked-unicode");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    await writeFile(join(repo, "café.js"), "export const x = 1;\n");

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "café.js" && f.status === "A"),
      "café.js must appear with its real UTF-8 path, not an octal-mangled one"
    );
    assert.equal(
      diff.changedFiles.some((f) => /\\\d{3}|"/.test(f.path)),
      false,
      "no changed-file path should carry octal escapes or quote chars"
    );
    // The real file content (not a 'Binary or unreadable file' phantom) is inlined.
    assert.ok(
      diff.text.includes("+export const x = 1;"),
      "the real non-ASCII file content must be in the diff text"
    );
  });

  it("surfaces a committed CJK code file (日本.ts) with a clean path", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "committed-cjk");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    await writeFile(join(repo, "日本.ts"), "export const y = 2;\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "cjk"]);

    const diff = await buildReviewDiff(repo, baseline);
    assert.ok(
      diff.changedFiles.some((f) => f.path === "日本.ts"),
      "日本.ts must appear with its real UTF-8 path"
    );
  });

  it("preserves rename old/new paths and space-containing paths", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    const repo = join(dir, "rename-unicode");
    await mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeFile(join(repo, "café.js"), "export const v = 1;\nconst more = 2;\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "base"]);
    const baseline = await captureBaseline(repo);

    gitSync(repo, ["mv", "café.js", "naïve.js"]);
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "rename"]);
    // A separate untracked file whose name contains a space must still parse.
    await writeFile(join(repo, "my file.js"), "const z = 3;\n");

    const diff = await buildReviewDiff(repo, baseline);
    const paths = diff.changedFiles.map((f) => f.path);
    assert.ok(paths.includes("café.js"), "rename old non-ASCII path retained");
    assert.ok(paths.includes("naïve.js"), "rename new non-ASCII path retained");
    assert.ok(paths.includes("my file.js"), "path with a space still parses");
  });
});

// ---------------------------------------------------------------------------
// AUDIT — synthesized diff is byte-faithful: CRLF vs LF -> different diffHash
// ---------------------------------------------------------------------------

describe("synthesized diff preserves line endings (CRLF != LF diffHash)", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-crlf-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders CRLF and LF bodies to DIFFERENT diff text", async () => {
    const ws = join(dir, "render");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "lf.txt"), "a\nb\nc\n");
    await writeFile(join(ws, "crlf.txt"), "a\r\nb\r\nc\r\n");

    // Normalize the filename out so only the content rendering is compared.
    const lf = (await synthesizeNewFileDiff(ws, "lf.txt")).replace(/lf\.txt/g, "X");
    const crlf = (await synthesizeNewFileDiff(ws, "crlf.txt")).replace(/crlf\.txt/g, "X");
    assert.notEqual(lf, crlf, "CRLF and LF content must render to different diff text");
    assert.ok(crlf.includes("+a\r"), "CRLF rendering must retain the carriage return");
    assert.ok(!lf.includes("\r"), "LF rendering must not introduce a carriage return");
  });

  it("yields a DIFFERENT diffHash for CRLF vs LF content at the same path", async () => {
    const wsLf = join(dir, "fslf");
    await mkdir(wsLf, { recursive: true });
    const blLf = await captureBaseline(wsLf);
    await writeFile(join(wsLf, "f.txt"), "a\nb\nc\n");
    const dLf = await buildReviewDiff(wsLf, blLf);

    const wsCr = join(dir, "fscr");
    await mkdir(wsCr, { recursive: true });
    const blCr = await captureBaseline(wsCr);
    await writeFile(join(wsCr, "f.txt"), "a\r\nb\r\nc\r\n");
    const dCr = await buildReviewDiff(wsCr, blCr);

    assert.notEqual(
      dLf.diffHash,
      dCr.diffHash,
      "byte-distinct CRLF vs LF content must produce different diffHash"
    );
  });
});

// ---------------------------------------------------------------------------
// AUDIT — git() bounds stderr with the same byte cap as stdout
// ---------------------------------------------------------------------------

describe("git() bounds stderr accumulation", () => {
  it("captures error stderr as a decoded string (chunk-buffered, not unbounded concat)", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    // An invalid ref makes git write a 'fatal:' line to stderr and exit nonzero.
    const r = await git(["rev-parse", "--verify", "no-such-ref-xyz"], process.cwd());
    assert.notEqual(r.code, 0, "invalid ref should exit nonzero");
    assert.equal(typeof r.stderr, "string", "stderr must be a decoded string");
    assert.ok(r.stderr.length > 0, "stderr from a failing git command must be captured");
  });

  it("decodes multibyte stderr without splitting a UTF-8 sequence", async (t) => {
    if (!GIT_AVAILABLE) return t.skip("git not on PATH");
    // A non-ASCII bad ref forces a multibyte sequence into git's stderr message;
    // the chunked Buffer.concat decode must round-trip it intact.
    const r = await git(["rev-parse", "--verify", "réf-入"], process.cwd());
    assert.equal(typeof r.stderr, "string");
    assert.ok(!r.stderr.includes("�"), "stderr must not contain a replacement char");
  });

  it("never lets stderr exceed the documented byte cap", async () => {
    // Structural guarantee: a real 64MB+ stderr flood is impractical to drive
    // through `git` in a unit test, so assert the source enforces the same
    // MAX_*_BYTES ceiling on stderr that it does on stdout (the audited fix).
    const src = await readFile(
      new URL("../../src/core/git.js", import.meta.url),
      "utf8"
    );
    assert.ok(/MAX_STDERR_BYTES/.test(src), "git.js must define a stderr byte cap");
    assert.ok(
      /stderrBytes\s*>=\s*MAX_STDERR_BYTES|stderrBytes\s*\+/.test(src),
      "git.js must bound stderr accumulation against the cap"
    );
  });
});
