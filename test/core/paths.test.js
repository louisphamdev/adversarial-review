import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalWorkspacePath } from "../../src/core/paths.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

describe("canonicalWorkspacePath", () => {
  let workspaceDir;  // the "safe" workspace root
  let outsideDir;    // a directory that lives outside the workspace

  before(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "ar-paths-workspace-"));
    outsideDir = await mkdtemp(join(tmpdir(), "ar-paths-outside-"));
  });

  after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Case 1: path inside workspace is NOT outside
  // -------------------------------------------------------------------------
  it("path inside workspace is not flagged as outside", async () => {
    // Create a real file inside the workspace.
    const innerFile = join(workspaceDir, "src", "foo.js");
    await mkdir(join(workspaceDir, "src"), { recursive: true });
    await writeFile(innerFile, "// hello");

    const result = await canonicalWorkspacePath(workspaceDir, "src/foo.js");
    assert.equal(result.outside, false, "inner path must not be flagged outside");
    assert.ok(
      result.absolute.startsWith(result.rootReal),
      "absolute must be inside rootReal"
    );
  });

  // -------------------------------------------------------------------------
  // Case 2: path with traversal (..\outside.txt) is flagged outside
  // -------------------------------------------------------------------------
  it("path with traversal (../outside.txt) is flagged as outside", async () => {
    const result = await canonicalWorkspacePath(workspaceDir, "../outside.txt");
    assert.equal(result.outside, true, "traversal path must be flagged outside");
  });

  // -------------------------------------------------------------------------
  // Case 3: symlink inside workspace pointing outside is flagged outside
  // -------------------------------------------------------------------------
  it("symlink inside workspace pointing outside is flagged as outside", async (t) => {
    const linkPath = join(workspaceDir, "evil-link");
    // Attempt to create the symlink; on Windows without SeCreateSymbolicLink
    // privilege this will throw EPERM — skip gracefully in that case.
    try {
      await symlink(outsideDir, linkPath, "dir");
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        t.skip("symlink creation requires elevated privileges on this Windows machine — skipping symlink test");
        return;
      }
      throw err;
    }

    // Ask whether a file inside the symlinked dir is "inside" the workspace.
    // The real path of the symlink's parent resolves to outsideDir, so it
    // must be flagged as outside.
    const result = await canonicalWorkspacePath(workspaceDir, "evil-link/secret.txt");
    assert.equal(
      result.outside,
      true,
      "symlink pointing outside workspace must be flagged as outside"
    );

    // Cleanup the symlink (rm with recursive handles symlink dirs on Windows too)
    await rm(linkPath, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Case 4: temp artifact paths are not created by following symlink paths
  //         (i.e. the function returns outside:true and does NOT create files)
  // -------------------------------------------------------------------------
  it("canonicalWorkspacePath does not create files when checking a path", async () => {
    // A path that does not exist at all — function must not create it.
    const ghostPath = "nonexistent-subdir/ghost.txt";
    const result = await canonicalWorkspacePath(workspaceDir, ghostPath);

    // The function should succeed (no throw) and report the outside status
    // correctly, but must not have created any filesystem artefacts.
    assert.equal(typeof result.outside, "boolean");
    assert.equal(typeof result.absolute, "string");

    // Confirm that the ghost file was not created.
    const { access, constants } = await import("node:fs/promises");
    const { constants: fsConstants } = await import("node:fs");
    await assert.rejects(
      () => access(result.absolute, fsConstants.F_OK),
      "ghost file must not exist after canonicalWorkspacePath"
    );
  });
});
