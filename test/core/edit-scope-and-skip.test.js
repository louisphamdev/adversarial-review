// Regression for the "it blocks on files outside the repo / temp scripts" feedback.
//
// Fix #2 (scanKeys cwd-scope): an Edit/Write to a file OUTSIDE the workspace (a temp
// scratch script in /tmp or a sibling dir) must NOT count as "edit evidence" — otherwise
// the gate sees an edit but an empty cwd-scoped diff and fail-closed BLOCKS.
//
// Fix #1 (runtime.extraSkipDirs): a trusted user/global config can exclude extra dirs
// (e.g. a tool's scratch dir) from review — but a PROJECT config CANNOT (runtime is
// pinned to the trusted baseline, so a cloned repo can't hide code: a fail-open).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanKeys } from "../../src/core/transcript.js";
import { snapshotWorkspace, captureBaseline, buildReviewDiff } from "../../src/core/diff.js";
import { loadEffectiveConfig } from "../../src/core/load-config.js";

function editEntry(filePath) {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] },
  };
}

describe("scanKeys cwd-scope (edits outside the workspace are not edit evidence)", () => {
  const cwd = path.resolve("ar-scope-root");
  const insidePath = join(cwd, "src", "app.js");
  const outsidePath = path.resolve("ar-scope-elsewhere", "scratch.py"); // sibling of cwd

  it("an edit INSIDE cwd counts as evidence", () => {
    const r = scanKeys([editEntry(insidePath)], cwd);
    assert.ok(r.lastEditKey > 0, "in-cwd edit must bump lastEditKey");
    assert.equal(r.editedPaths.size, 1);
  });

  it("an edit OUTSIDE cwd is IGNORED (no false block)", () => {
    const r = scanKeys([editEntry(outsidePath)], cwd);
    assert.equal(r.lastEditKey, 0, "out-of-cwd edit must NOT bump lastEditKey");
    assert.equal(r.editedPaths.size, 0, "out-of-cwd edit must NOT be edit evidence");
  });

  it("a mix counts only the in-cwd edit", () => {
    const r = scanKeys([editEntry(outsidePath), editEntry(insidePath)], cwd);
    assert.equal(r.editedPaths.size, 1);
    assert.ok([...r.editedPaths][0].includes("app.js"));
  });

  it("no cwd => count everything (backward compatible)", () => {
    const r = scanKeys([editEntry(outsidePath)]);
    assert.equal(r.editedPaths.size, 1);
    assert.ok(r.lastEditKey > 0);
  });

  it("counts an in-workspace edit when cwd is a SYMLINK to the real root", { skip: process.platform === "win32" }, async () => {
    const real = await mkdtemp(join(tmpdir(), "ar-symws-"));
    const link = `${real}-link`;
    await symlink(real, link, "dir");
    try {
      // cwd is the SYMLINK; the edit is recorded via the REAL absolute path.
      const realFile = join(await realpath(real), "src", "auth.js");
      const r = scanKeys([editEntry(realFile)], link);
      assert.ok(r.lastEditKey > 0, "edit via the real path under a symlink cwd must still count");
      assert.equal(r.editedPaths.size, 1);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});

describe("runtime.extraSkipDirs excludes extra dirs from review", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-extraskip-"));
    await mkdir(join(dir, "scratch"), { recursive: true });
    await writeFile(join(dir, "scratch", "tmp.txt"), "noise\n", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const x = 1;\n", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("snapshotWorkspace excludes a configured extra dir but keeps real source", async () => {
    const { files } = await snapshotWorkspace(dir, { extraSkipDirs: ["scratch"] });
    const paths = [...files.keys()];
    assert.ok(paths.includes("src/app.js"), "real source kept");
    assert.ok(!paths.some((p) => p.startsWith("scratch/")), "extra-skip dir excluded");
  });

  it("snapshotWorkspace WITHOUT the config still includes the dir (opt-in)", async () => {
    const { files } = await snapshotWorkspace(dir);
    assert.ok([...files.keys()].some((p) => p.startsWith("scratch/")), "not skipped by default");
  });

  it("a malformed/unsafe extra entry is ignored (no path-escape)", async () => {
    // "../etc", "a/b", "." must not be honored as skip segments.
    const { files } = await snapshotWorkspace(dir, { extraSkipDirs: ["../scratch", "scratch/x", ".", 42] });
    assert.ok([...files.keys()].some((p) => p.startsWith("scratch/")), "unsafe entries ignored => not skipped");
  });

  it("captureBaseline records extraSkipDirs and buildReviewDiff applies them consistently", async () => {
    const baseline = await captureBaseline(dir, ["scratch"]);
    assert.deepEqual(baseline.extraSkipDirs, ["scratch"]);
    // Add a new file in BOTH the skipped dir and real source AFTER the baseline.
    await writeFile(join(dir, "scratch", "new.txt"), "more noise\n", "utf8");
    await writeFile(join(dir, "src", "new.js"), "export const y = 2;\n", "utf8");
    const diff = await buildReviewDiff(dir, baseline);
    const paths = diff.changedFiles.map((c) => c.path);
    assert.ok(paths.includes("src/new.js"), "real new source is reviewed");
    assert.ok(!paths.some((p) => p.startsWith("scratch/")), "extra-skip dir excluded from the diff");
  });
});

describe("extraSkipDirs is TRUSTED-only (project config cannot set it)", () => {
  let home;
  let cwd;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), "ar-es-home-"));
    cwd = await mkdtemp(join(tmpdir(), "ar-es-proj-"));
    await mkdir(join(home, ".adversarial-review"), { recursive: true });
    await writeFile(
      join(home, ".adversarial-review", "config.json"),
      JSON.stringify({ runtime: { extraSkipDirs: ["scratch"] } }),
      "utf8"
    );
    await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
    // A hostile PROJECT tries to skip "src" (hide all code) — must be ignored.
    await writeFile(
      join(cwd, ".adversarial-review", "config.json"),
      JSON.stringify({ runtime: { extraSkipDirs: ["src"] } }),
      "utf8"
    );
  });
  after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("honors the USER value and drops the PROJECT value (runtime is pinned)", async () => {
    const cfg = await loadEffectiveConfig(cwd, { env: { ADVERSARIAL_REVIEW_HOME: home } });
    assert.deepEqual(cfg.runtime.extraSkipDirs, ["scratch"], "user value kept, project 'src' dropped");
  });
});
