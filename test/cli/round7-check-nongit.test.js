// ROUND7 regression (GPT-5.5-xhigh): `check` captured its baseline from the CURRENT
// filesystem state, so on a NON-GIT workspace it diffed current-vs-current and reviewed
// NOTHING — already-present (possibly malicious) code was reported clean (fail-OPEN).
// `check` on a non-git workspace must now review against an EMPTY baseline so the
// existing tree is surfaced for review (a block when no external reviewer is wired).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkCommand } from "../../src/cli/check.js";

// Only meaningful when the temp dir is NOT inside a git repo (the common case for the
// OS temp dir). If it somehow is, skip rather than assert a git-path behavior.
function isInsideGitRepo(dir) {
  try {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
    return r.status === 0 && String(r.stdout).trim() === "true";
  } catch {
    return false;
  }
}

describe("ROUND7 check: non-git workspace reviews existing content (no clean fail-open)", () => {
  let dir;
  let home;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ar7-check-"));
    home = await mkdtemp(join(tmpdir(), "ar7-check-home-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const handler = (x) => eval(x);\n", "utf8");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("does NOT allow already-present code as a clean no-edits result", async (t) => {
    if (isInsideGitRepo(dir)) return t.skip("temp dir is inside a git repo");
    const out = [];
    const err = [];
    const io = {
      cwd: dir,
      env: { ADVERSARIAL_REVIEW_HOME: home },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
    };
    const decision = await checkCommand([], io);
    // checkCommand sets process.exitCode=1 on a block; reset it so this assertion's
    // expected block does not mark the whole test FILE as failed via the exit code.
    process.exitCode = 0;
    // The bug allowed with reason "no_edits"/"level_none"; the fix surfaces the existing
    // file as an addition → review required (a block, since no external reviewer).
    assert.notEqual(decision.reason, "no_edits", "existing code must not pass as no_edits");
    assert.notEqual(decision.reason, "level_none", "existing code must not pass as level_none");
    assert.equal(decision.action, "block", `expected review-required block, got ${JSON.stringify(decision)}`);
  });
});
