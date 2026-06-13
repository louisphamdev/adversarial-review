// Tests for makeReviewerRunner — Reviewer Isolation enforcement (BUG 2).
//
// In "enforced" and "strict-ci" modes a reviewer that cannot prove
// readOnly && noEdit MUST be refused before the tool is spawned. In "soft" mode
// the same reviewer is allowed to run. These tests stub the adapters via the
// custom-reviewer registry path and via a hand-built runner so no real binary
// is invoked and we can assert the tool is never spawned.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeReviewerRunner } from "../../src/reviewers/index.js";
import { createStubs, makeJob, createToolShim } from "./stub-helper.js";

// ---------------------------------------------------------------------------
// opencode WITHOUT readOnly config — refused in enforced, allowed in soft.
// The opencode adapter reports capabilities.readOnly = false unless the bundled
// read-only config is enabled, and noEdit is always false. So in enforced/strict
// it must be refused with reviewer_not_isolated.
// ---------------------------------------------------------------------------

/**
 * Create an "opencode" shim in a temp dir.
 *
 * opencode is multi-subcommand: the adapter's verify() runs `opencode --version`
 * AND `opencode agent list`, while run() runs `opencode run ...`. The shim
 * forwards every argument to a Node dispatcher that answers --version and
 * `agent list` itself (reporting the "adversarial-reviewer" agent as present so
 * verify() succeeds and the isolation check is what gates) and delegates the
 * `run` subcommand to the provided run-stub script.
 */
async function createOpencodeShim(runStubPath, opts = {}) {
  // `agents` controls what `opencode agent list` reports. Default INCLUDES the
  // bundled read-only agent so verify() succeeds and the ISOLATION check is what
  // gates; pass a list omitting it to exercise the reviewer_agent_missing path.
  const agents = opts.agents || ["adversarial-reviewer", "build"];

  // Dispatcher: handle version / agent-list locally, exec the run-stub for run.
  // It lives in its own temp dir; the shared createToolShim writes the <tool>.cmd
  // (PATH-prepended, deterministic) that forwards the adapter's argv to it.
  const dispatchDir = await mkdtemp(join(tmpdir(), "ar-idx-oc-"));
  const dispatcherPath = join(dispatchDir, "dispatch.cjs");
  await writeFile(
    dispatcherPath,
    `
const { spawnSync } = require("node:child_process");
const AGENTS = ${JSON.stringify(agents)};
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("test-stub 1.0.0\\n");
  process.exit(0);
}
if (argv[0] === "agent" && argv[1] === "list") {
  process.stdout.write(AGENTS.join("\\n") + "\\n");
  process.exit(0);
}
// Delegate everything else (the "run" subcommand) to the run-stub, forwarding
// stdin/stdout/stderr so the brief-on-stdin path works.
const r = spawnSync(process.execPath, [${JSON.stringify(runStubPath)}, ...argv], { stdio: "inherit" });
process.exit(r.status == null ? 1 : r.status);
`,
    "utf8"
  );

  // forwardArgs:true so opencode's argv (--version / agent list / run ...) reaches
  // the dispatcher. Cleanup removes BOTH the shim dir and the dispatcher dir.
  const shim = await createToolShim("opencode", dispatcherPath, { forwardArgs: true });
  return {
    dir: shim.dir,
    env: shim.env,
    cleanup: async () => {
      await shim.cleanup();
      await rm(dispatchDir, { recursive: true, force: true });
    },
  };
}

describe("makeReviewerRunner — reviewer isolation enforcement", () => {
  let stubs;
  let job;
  let spawnMarkerDir;
  let spawnMarkerPath;

  before(async () => {
    job = makeJob({ reviewer: "opencode" });
    stubs = await createStubs(job);
    job = { ...job, diffPath: stubs.paths.diff };

    // A stub that writes a marker file as soon as it runs, so we can prove the
    // tool was NOT spawned when the reviewer is refused.
    spawnMarkerDir = await mkdtemp(join(tmpdir(), "ar-idx-marker-"));
    spawnMarkerPath = join(spawnMarkerDir, "spawned.txt");
  });

  after(async () => {
    await stubs.cleanup();
    await rm(spawnMarkerDir, { recursive: true, force: true });
  });

  // --- enforced mode: opencode without readOnly config is refused ---

  it("enforced mode + reviewer reporting readOnly:false → reviewer_not_isolated, tool NOT spawned", async () => {
    const shim = await createOpencodeShim(stubs.paths.pass);
    try {
      // No readOnlyConfig → capabilities.readOnly === false.
      const config = { policy: { mode: "enforced" }, reviewers: { opencode: { timeoutSec: 10 } } };
      const runner = makeReviewerRunner("opencode", config, shim.env);
      const result = await runner(job);
      assert.equal(result.ok, false);
      assert.equal(result.error, "reviewer_not_isolated");
    } finally {
      await shim.cleanup();
    }
  });

  // --- soft mode: same reviewer runs normally ---

  it("soft mode + same reviewer → runs normally (capability not enforced)", async () => {
    const shim = await createOpencodeShim(stubs.paths.pass);
    try {
      const config = { policy: { mode: "soft" }, reviewers: { opencode: { timeoutSec: 10 } } };
      const runner = makeReviewerRunner("opencode", config, shim.env);
      const result = await runner(job);
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
      assert.equal(result.verdict.verdict, "pass");
    } finally {
      await shim.cleanup();
    }
  });

  // --- strict-ci mode: also refused ---

  it("strict-ci mode + reviewer reporting readOnly:false → reviewer_not_isolated", async () => {
    const shim = await createOpencodeShim(stubs.paths.pass);
    try {
      const config = { policy: { mode: "strict-ci" }, reviewers: { opencode: { timeoutSec: 10 } } };
      const runner = makeReviewerRunner("opencode", config, shim.env);
      const result = await runner(job);
      assert.equal(result.ok, false);
      assert.equal(result.error, "reviewer_not_isolated");
    } finally {
      await shim.cleanup();
    }
  });

  // --- custom reviewer in enforced is refused before spawn ---

  it("custom reviewer in enforced mode → refused (reviewer_not_isolated) before spawn", async () => {
    // A custom reviewer always reports capabilities readOnly:false/noEdit:false,
    // so it must be refused in enforced mode WITHOUT running. The stub would
    // write a marker on start; we assert no marker appears.
    const markerStub = join(spawnMarkerDir, "marker-stub.mjs");
    await writeFile(
      markerStub,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(spawnMarkerPath)}, "spawned");\nprocess.stdout.write("x");\nprocess.exit(0);\n`,
      "utf8"
    );

    const config = {
      policy: { mode: "enforced" },
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: true,
          command: process.execPath,
          args: [markerStub, "{cwd}", "{diffPath}"],
          timeoutSec: 10,
        },
      },
    };
    // Refused before spawn, so the verdict reviewer field is irrelevant here.
    const runner = makeReviewerRunner("my-reviewer", config, process.env);
    const result = await runner(job);
    assert.equal(result.ok, false);
    assert.equal(result.error, "reviewer_not_isolated");

    // Prove the tool was never spawned (no marker file written).
    let spawned = false;
    try {
      const { access } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      await access(spawnMarkerPath, constants.F_OK);
      spawned = true;
    } catch {
      spawned = false;
    }
    assert.equal(spawned, false, "custom reviewer must be refused before spawning the tool");
  });

  // --- soft mode custom reviewer runs (sanity that enforcement is mode-gated) ---

  it("soft mode + custom reviewer → runs normally (capability not enforced)", async () => {
    const config = {
      policy: { mode: "soft" },
      reviewers: {
        "my-reviewer": {
          type: "custom",
          trusted: true,
          command: process.execPath,
          args: [stubs.paths.pass, "{cwd}", "{diffPath}"],
          timeoutSec: 10,
        },
      },
    };
    // The shared `job` has reviewer === "opencode", which matches the stub's
    // echoed verdict (stubs were built from that job). Soft mode allows the run.
    const runner = makeReviewerRunner("my-reviewer", config, process.env);
    const result = await runner(job);
    assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
    assert.equal(result.verdict.verdict, "pass");
  });

  // --- runtime verify uses default requireAgent:true (Task D) ---

  // makeReviewerRunner calls adapter.verify(env) with NO options, so the default
  // requireAgent:true applies at runtime: a missing read-only agent must surface
  // as verify_failed:reviewer_agent_missing and the tool must NOT be run. This is
  // gated even in SOFT mode because the agent-existence check is part of verify(),
  // independent of the isolation (readOnly/noEdit) capability check. Without it a
  // runtime caller could silently fall back to the writable default agent.
  it("runtime makeReviewerRunner (default requireAgent:true) returns verify_failed:reviewer_agent_missing when the agent is absent (soft mode)", async () => {
    // `agent list` OMITS the bundled read-only agent (clean machine / deleted agent).
    const shim = await createOpencodeShim(stubs.paths.pass, { agents: ["build", "general"] });
    try {
      const config = { policy: { mode: "soft" }, reviewers: { opencode: { timeoutSec: 10 } } };
      const runner = makeReviewerRunner("opencode", config, shim.env);
      const result = await runner(job);
      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_failed:reviewer_agent_missing");
    } finally {
      await shim.cleanup();
    }
  });
});
