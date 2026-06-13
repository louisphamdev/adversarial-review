// Tests for the opencode reviewer adapter.
//
// Real opencode is never invoked. Tests use temporary Node.js stub scripts
// spawned via process.execPath. The Windows .cmd resolution test creates a
// real opencode.cmd shim in a temp directory.
//
// opencode is multi-subcommand: verify() runs `opencode --version` AND
// `opencode agent list`, while run() runs `opencode run ...`. The stub script
// therefore dispatches on its argv so a single shim can serve every call.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAdapter } from "../../src/reviewers/opencode.js";
import { createStubs, makeJob, buildVerdictOutput } from "./stub-helper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an "opencode" shim in a temp dir that runs a specific stub script.
 * On Windows: opencode.cmd; elsewhere: a POSIX shell script named opencode.
 * The shim forwards all command-line args to the stub so the stub can dispatch
 * on subcommand (--version / agent list / run).
 */
async function createOpencodeShim(stubPath) {
  const shimDir = await mkdtemp(join(tmpdir(), "ar-oc-shim-"));

  if (process.platform === "win32") {
    const shimFile = join(shimDir, "opencode.cmd");
    // %* forwards every argument that cmd.exe received to the stub.
    await writeFile(shimFile, `@"${process.execPath}" "${stubPath}" %*\r\n`);
  } else {
    const shimFile = join(shimDir, "opencode");
    await writeFile(shimFile, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`, { mode: 0o755 });
  }

  // DETERMINISM: prepend this test's UNIQUE shim dir to PATH so
  // resolveExecutable("opencode") resolves THIS test's shim first — never the
  // real `opencode` on the machine PATH nor another test's shim, even under
  // parallel `node --test`. PATHEXT is narrowed to .CMD (the shim's extension)
  // so the lookup matches the shim's opencode.cmd and cannot fall through to a
  // real opencode.exe; the system PATH is kept AFTER the shim dir only so the
  // cmd.exe wrapper for .cmd shims still resolves.
  const env = {
    ...process.env,
    PATH: shimDir + (process.env.PATH ? (process.platform === "win32" ? ";" : ":") + process.env.PATH : ""),
    PATHEXT: process.platform === "win32" ? ".CMD" : undefined,
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }

  return {
    dir: shimDir,
    env,
    cleanup: () => rm(shimDir, { recursive: true, force: true }),
  };
}

/**
 * Build an opencode stub script that dispatches on argv.
 *
 * Behavior:
 *  - `--version`               -> prints a version line, exits 0.
 *  - `agent list`              -> prints the agent list, exits 0.
 *  - `run ...`                 -> reads the brief from stdin, optionally records
 *                                 it and the run args to sidecar files, prints a
 *                                 verdict (and optionally a stderr warning).
 *
 * @param {object} job
 * @param {object} [opts]
 * @param {string} [opts.verdict="pass"]   - verdict the run subcommand emits
 * @param {string[]} [opts.agents]         - names listed by `agent list`
 * @param {string} [opts.stderr]           - text written to stderr during run
 * @param {string} [opts.recordStdinPath]  - file to write the received stdin to
 * @param {string} [opts.recordArgsPath]   - file to write the received run args to
 * @param {string} [opts.recordDiffPath]   - file to copy the -f diff file content to
 * @returns {string} stub source
 */
function buildOpencodeStub(job, opts = {}) {
  const verdict = opts.verdict || "pass";
  const verdictBlock = buildVerdictOutput(job, verdict);
  const agents = opts.agents || ["adversarial-reviewer"];
  const cfg = {
    verdictBlock,
    agents,
    stderr: opts.stderr || "",
    recordStdinPath: opts.recordStdinPath || "",
    recordArgsPath: opts.recordArgsPath || "",
    recordDiffPath: opts.recordDiffPath || "",
  };
  return `
const fs = require("node:fs");
const CFG = ${JSON.stringify(cfg)};
const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("test-stub 1.0.0\\n");
  process.exit(0);
}

if (argv[0] === "agent" && argv[1] === "list") {
  process.stdout.write(CFG.agents.join("\\n") + "\\n");
  process.exit(0);
}

if (argv[0] === "run") {
  if (CFG.recordArgsPath) {
    try { fs.writeFileSync(CFG.recordArgsPath, JSON.stringify(argv)); } catch {}
  }
  // Read the diff file the adapter passed after "-f" and copy its content to a
  // side file so the test can prove the real diff content was delivered.
  if (CFG.recordDiffPath) {
    try {
      const fi = argv.indexOf("-f");
      const dp = fi >= 0 ? argv[fi + 1] : "";
      const content = dp ? fs.readFileSync(dp, "utf8") : "";
      fs.writeFileSync(CFG.recordDiffPath, content);
    } catch {}
  }
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    if (CFG.recordStdinPath) {
      try { fs.writeFileSync(CFG.recordStdinPath, stdin); } catch {}
    }
    if (CFG.stderr) process.stderr.write(CFG.stderr);
    process.stdout.write(CFG.verdictBlock);
    process.exit(0);
  });
  return;
}

// Unknown subcommand: behave like opencode and exit non-zero.
process.exit(2);
`;
}

/**
 * Write an opencode stub script to a fresh temp dir and return its path plus a
 * cleanup function.
 */
async function writeOpencodeStub(job, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ar-oc-stub-"));
  const stubPath = join(dir, "opencode-stub.cjs");
  await writeFile(stubPath, buildOpencodeStub(job, opts), "utf8");
  return { dir, stubPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("opencode adapter", () => {
  let stubs;
  let job;

  before(async () => {
    job = makeJob({ reviewer: "opencode" });
    stubs = await createStubs(job);
    job = { ...job, diffPath: stubs.paths.diff };
  });

  after(async () => {
    await stubs.cleanup();
  });

  // --- verify() ---

  it("verify() returns ok:false with reason missing_binary when opencode is not found", async () => {
    const adapter = createAdapter({});
    const result = await adapter.verify({ PATH: "", PATHEXT: ".EXE" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_binary");
  });

  it("verify() returns ok:true with resolvedPath when binary and agent are present", async () => {
    const stub = await writeOpencodeStub(job, { agents: ["adversarial-reviewer", "build"] });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const adapter = createAdapter({});
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      assert.ok(result.resolvedPath, "should have a resolvedPath");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- verify() — capabilities reflect readOnlyConfig ---

  it("verify() reports { readOnly:true, noEdit:true } when readOnlyConfig:true", async () => {
    const stub = await writeOpencodeStub(job);
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { readOnlyConfig: true } } };
      const adapter = createAdapter(config);
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      assert.equal(result.capabilities.readOnly, true);
      assert.equal(result.capabilities.noEdit, true);
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  it("verify() reports { readOnly:false, noEdit:false } without readOnlyConfig", async () => {
    const stub = await writeOpencodeStub(job);
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const adapter = createAdapter({});
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      assert.equal(result.capabilities.readOnly, false);
      assert.equal(result.capabilities.noEdit, false);
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- verify() — agent missing closes the silent-fallback hole ---

  it("verify() returns reviewer_agent_missing when `agent list` omits the agent", async () => {
    const stub = await writeOpencodeStub(job, { agents: ["build", "general"] });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { readOnlyConfig: true } } };
      const adapter = createAdapter(config);
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "reviewer_agent_missing");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- verify({requireAgent:false}) — install-time binary-only check ---

  // The installer is the very thing that CREATES the read-only agent, so on a
  // clean machine the agent does not exist yet. verify(env, {requireAgent:false})
  // must report ok:true (with capabilities) for binary+version alone, SKIPPING
  // the `agent list` check — otherwise the install rejects before it can create
  // the agent (chicken-and-egg).
  it("verify({requireAgent:false}) returns ok:true even when the agent is NOT listed", async () => {
    // Stub whose `agent list` does NOT include the read-only agent (clean home).
    const stub = await writeOpencodeStub(job, { agents: ["build", "general"] });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { readOnlyConfig: true } } };
      const adapter = createAdapter(config);
      const result = await adapter.verify(shim.env, { requireAgent: false });
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      // Capabilities still reflect the read-only config.
      assert.equal(result.capabilities.readOnly, true);
      assert.equal(result.capabilities.noEdit, true);
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // Same stub, DEFAULT verify() (requireAgent:true) must STILL reject — proving
  // the agent-existence check is intact for runtime/doctor.
  it("verify() (default requireAgent:true) still returns reviewer_agent_missing for the same stub", async () => {
    const stub = await writeOpencodeStub(job, { agents: ["build", "general"] });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { readOnlyConfig: true } } };
      const adapter = createAdapter(config);
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "reviewer_agent_missing");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // requireAgent:false must NOT mask a missing binary — install must still reject
  // when opencode is not installed at all.
  it("verify({requireAgent:false}) still returns missing_binary when opencode is absent", async () => {
    const adapter = createAdapter({});
    const result = await adapter.verify({ PATH: "", PATHEXT: ".EXE" }, { requireAgent: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_binary");
  });

  it("verify() honors a custom agent name from config", async () => {
    const stub = await writeOpencodeStub(job, { agents: ["my-readonly-agent"] });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { agent: "my-readonly-agent" } } };
      const adapter = createAdapter(config);
      const result = await adapter.verify(shim.env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- run() — valid pass ---

  it("run() returns ok:true with verdict.verdict==='pass' for a valid pass stub", async () => {
    const stub = await writeOpencodeStub(job, { verdict: "pass" });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
      assert.equal(result.verdict.verdict, "pass");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- run() — valid fail ---

  it("run() returns ok:true with verdict.verdict==='fail' for a valid fail stub", async () => {
    const stub = await writeOpencodeStub(job, { verdict: "fail" });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);
      assert.equal(result.verdict.verdict, "fail");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- run() — brief reaches the child via STDIN, never as an arg ---

  it("run() delivers the brief via stdin and passes no -m flag or brief-text arg", async () => {
    const recDir = await mkdtemp(join(tmpdir(), "ar-oc-rec-"));
    const recStdin = join(recDir, "stdin.txt");
    const recArgs = join(recDir, "args.json");
    const stub = await writeOpencodeStub(job, {
      verdict: "pass",
      recordStdinPath: recStdin,
      recordArgsPath: recArgs,
    });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);

      const args = JSON.parse(await readFile(recArgs, "utf8"));
      // The bad `-m` flag (which actually means --model) must be gone.
      assert.ok(!args.includes("-m"), `args should not contain -m: ${JSON.stringify(args)}`);
      // The brief contains the job_id; it must NOT appear as a positional arg.
      assert.ok(
        !args.some((a) => a.includes(job.jobId)),
        `brief text leaked into args: ${JSON.stringify(args)}`
      );
      // The expected read-only invocation shape.
      assert.deepEqual(args.slice(0, 5), ["run", "--pure", "--agent", "adversarial-reviewer", "-f"]);

      // The brief MUST have reached the stub via stdin.
      const stdin = await readFile(recStdin, "utf8");
      assert.ok(stdin.includes(job.jobId), "brief should reach stub via stdin");
      assert.ok(stdin.includes("UNTRUSTED DATA"), "brief text should arrive on stdin");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
      await rm(recDir, { recursive: true, force: true });
    }
  });

  // --- run() — the real diff content is delivered to the reviewer ---

  it("run() writes job.diffText to the -f diff file when no job.diffPath is set", async () => {
    const recDir = await mkdtemp(join(tmpdir(), "ar-oc-diff-"));
    const recDiff = join(recDir, "diff-seen.txt");
    // A job WITHOUT diffPath but WITH diffText: the adapter must write the diff
    // content to its temp file and pass it via -f.
    const diffJob = { ...job, diffPath: undefined, diffText: "DIFFMARKER-12345" };
    const stub = await writeOpencodeStub(diffJob, {
      verdict: "pass",
      recordDiffPath: recDiff,
    });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(diffJob, { env: shim.env });
      assert.equal(result.ok, true, `Expected ok:true but got error: ${result.error}`);

      // The stub read the -f file and copied its content here. It must be the
      // real diff text — proving the diff reached the reviewer, not an empty file.
      const seen = await readFile(recDiff, "utf8");
      assert.ok(seen.length > 0, "diff file delivered to reviewer must NOT be empty");
      assert.ok(
        seen.includes("DIFFMARKER-12345"),
        `diff file must contain the job's diffText, got: ${JSON.stringify(seen)}`
      );
    } finally {
      await shim.cleanup();
      await stub.cleanup();
      await rm(recDir, { recursive: true, force: true });
    }
  });

  // --- run() — silent agent fallback is an operational failure ---

  it("run() returns reviewer_agent_fallback when stderr warns of default-agent fallback", async () => {
    const stub = await writeOpencodeStub(job, {
      verdict: "pass",
      // opencode prints this to stderr then runs the writable default agent.
      stderr: 'agent "adversarial-reviewer" not found. Falling back to default agent\n',
    });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      // Even though a valid verdict was printed, the fallback agent is writable,
      // so the review must be rejected as an operational failure.
      assert.equal(result.ok, false);
      assert.equal(result.error, "reviewer_agent_fallback");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- run() — subagent-not-primary fallback is ALSO rejected (broadened marker) ---

  // The AGENT_FALLBACK_MARKER was broadened to the common suffix "Falling back to
  // default agent" so it catches EVERY fallback reason. This message ("... is a
  // subagent, not a primary agent. Falling back to default agent") does NOT
  // contain "not found", so it would slip past the old narrow check — but the
  // writable default agent still ran, so the review MUST be rejected.
  it("run() returns reviewer_agent_fallback on the subagent-not-primary fallback warning", async () => {
    const stub = await writeOpencodeStub(job, {
      verdict: "pass",
      stderr:
        'agent "adversarial-reviewer" is a subagent, not a primary agent. Falling back to default agent\n',
    });
    const shim = await createOpencodeShim(stub.stubPath);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      // A valid-looking verdict was printed to stdout, but the warning proves the
      // writable default agent produced it -> reject as an operational failure.
      assert.equal(result.ok, false);
      assert.equal(result.error, "reviewer_agent_fallback");
    } finally {
      await shim.cleanup();
      await stub.cleanup();
    }
  });

  // --- run() — timeout ---

  it("run() returns ok:false with error==='timeout' when stub sleeps past timeoutSec", async () => {
    const shim = await createOpencodeShim(stubs.paths.sleep);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 0.2 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.equal(result.error, "timeout");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — non-zero exit ---

  it("run() returns ok:false when stub exits with code 1", async () => {
    const shim = await createOpencodeShim(stubs.paths.nonzero);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.ok(result.error, "should have an error reason");
    } finally {
      await shim.cleanup();
    }
  });

  // --- run() — malformed output ---

  it("run() returns ok:false when stub prints malformed output", async () => {
    const shim = await createOpencodeShim(stubs.paths.malformed);
    try {
      const config = { reviewers: { opencode: { timeoutSec: 10 } } };
      const adapter = createAdapter(config);
      const result = await adapter.run(job, { env: shim.env });
      assert.equal(result.ok, false);
      assert.ok(result.error, "should have an error reason");
    } finally {
      await shim.cleanup();
    }
  });

  // --- Windows .cmd resolution ---

  it("verify() resolves opencode.cmd via PATHEXT on Windows", async () => {
    if (process.platform !== "win32") {
      // Skip on non-Windows: PATHEXT extension resolution is Windows-only.
      return;
    }

    const stub = await writeOpencodeStub(job);
    const shimDir = await mkdtemp(join(tmpdir(), "ar-oc-cmd-"));
    try {
      // Create opencode.cmd in the shim dir, forwarding args to the stub.
      const cmdPath = join(shimDir, "opencode.cmd");
      await writeFile(cmdPath, `@"${process.execPath}" "${stub.stubPath}" %*\r\n`);

      const env = {
        ...process.env,
        PATH: shimDir + ";" + (process.env.PATH || ""),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };

      const adapter = createAdapter({});
      const result = await adapter.verify(env);
      assert.equal(result.ok, true, `verify failed: ${result.reason}`);
      assert.ok(
        result.resolvedPath.toLowerCase().endsWith("opencode.cmd"),
        `expected resolvedPath ending in opencode.cmd, got: ${result.resolvedPath}`
      );
    } finally {
      await rm(shimDir, { recursive: true, force: true });
      await stub.cleanup();
    }
  });
});
