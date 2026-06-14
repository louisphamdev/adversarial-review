// ROUND7 regression (GPT-5.5-xhigh): the round-6 fix guarded only the dedicated
// ADVERSARIAL_REVIEW_HOME override against pointing INSIDE cwd, but left the STANDARD
// HOME / USERPROFILE env vars unguarded. A repo-controlled wrapper (an npm script / CI
// step) setting HOME=$PWD / USERPROFILE=%CD% could relocate the trusted user-level base
// (config, policy floor, pass cache) into the project-writable tree. Also: a project
// nulling out a user-pinned reviewer entry must not drop its config back to defaults.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHomeDir, loadEffectiveConfig } from "../../src/core/load-config.js";

const isWin = process.platform === "win32";
// The OS home env var that resolveHomeDir consults FIRST on this platform.
const OS_HOME_KEY = isWin ? "USERPROFILE" : "HOME";

function insideCwd(cwd, p) {
  const rel = path.relative(path.resolve(cwd), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

describe("ROUND7 resolveHomeDir: repo-poisoned HOME/USERPROFILE inside cwd is rejected", () => {
  it("does not return a home equal to cwd (HOME=$PWD attack)", () => {
    const cwd = isWin ? "C:\\repo\\project" : "/repo/project";
    const home = resolveHomeDir({ [OS_HOME_KEY]: cwd }, cwd);
    assert.equal(insideCwd(cwd, home), false, `resolved home ${home} must be OUTSIDE cwd ${cwd}`);
  });

  it("does not return a home that is a SUBDIR of cwd", () => {
    const cwd = isWin ? "C:\\repo" : "/repo";
    const poison = isWin ? "C:\\repo\\.adversarial-review" : "/repo/.adversarial-review";
    const home = resolveHomeDir({ [OS_HOME_KEY]: poison }, cwd);
    assert.equal(insideCwd(cwd, home), false, `resolved home ${home} must be OUTSIDE cwd ${cwd}`);
  });

  it("still honors a legitimate OS home OUTSIDE cwd (no false rejection)", () => {
    const cwd = isWin ? "C:\\repo" : "/repo";
    const outside = isWin ? "C:\\Users\\Real" : "/home/real";
    const home = resolveHomeDir({ [OS_HOME_KEY]: outside }, cwd);
    assert.equal(path.resolve(home), path.resolve(outside));
  });
});

describe("ROUND7 loadEffectiveConfig: a project cannot null out a user-pinned reviewer", () => {
  let home;
  let cwd;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), "ar7-home-"));
    cwd = await mkdtemp(join(tmpdir(), "ar7-proj-"));
    // User config pins opencode with an EXTRA required dimension.
    await mkdir(join(home, ".adversarial-review"), { recursive: true });
    await writeFile(
      join(home, ".adversarial-review", "config.json"),
      JSON.stringify({
        reviewers: { opencode: { requiredDimensions: ["Correctness", "Security", "Tests", "ExtraPinned"] } },
      }),
      "utf8"
    );
    // Project config tries to NULL the opencode reviewer (corrupt the entry).
    await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
    await writeFile(
      join(cwd, ".adversarial-review", "config.json"),
      JSON.stringify({ reviewers: { opencode: null } }),
      "utf8"
    );
  });
  after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("restores the trusted baseline reviewer entry (project null is ignored)", async () => {
    const cfg = await loadEffectiveConfig(cwd, { env: { ADVERSARIAL_REVIEW_HOME: home } });
    const oc = cfg.reviewers && cfg.reviewers.opencode;
    assert.ok(oc && typeof oc === "object" && !Array.isArray(oc), "opencode entry must be a restored object, not null");
    assert.ok(
      Array.isArray(oc.requiredDimensions) && oc.requiredDimensions.includes("ExtraPinned"),
      "the user-pinned requiredDimensions must survive the project's null"
    );
  });
});
