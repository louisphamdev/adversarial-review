import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { doctorCommand } from "../../src/cli/doctor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeIo(cwd, home, env = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdin: null,
      stdout: { write: (s) => out.push(String(s)) },
      stderr: { write: (s) => err.push(String(s)) },
      env: {
        // Pin the user-level base to the per-test temp home explicitly so the
        // config loader can NEVER read the developer's real `~/.adversarial-review/`
        // (ADVERSARIAL_REVIEW_HOME wins over HOME/USERPROFILE in homeDir()).
        ADVERSARIAL_REVIEW_HOME: home,
        HOME: home,
        USERPROFILE: home,
        PATH: process.env.PATH || "",
        PATHEXT: process.env.PATHEXT || "",
        ...env,
      },
      cwd,
    },
    out,
    err,
  };
}

async function tmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function resetExit() {
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("doctor command", () => {
  // -------------------------------------------------------------------------
  // Basic human-readable output exits 0
  // -------------------------------------------------------------------------
  it("exits 0 and prints version line", async () => {
    const cwd = await tmpDir("ar-doctor-basic-");
    const home = await tmpDir("ar-doctor-basic-home-");
    try {
      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand([], io);

      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);
      const output = out.join("");
      assert.match(output, /adversarial-review/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // --json produces valid JSON with required fields
  // -------------------------------------------------------------------------
  it("--json outputs valid JSON with required fields", async () => {
    const cwd = await tmpDir("ar-doctor-json-");
    const home = await tmpDir("ar-doctor-json-home-");
    try {
      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--json"], io);

      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const raw = out.join("");
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw);
      }, "output must be valid JSON");

      // Required fields.
      assert.ok(typeof parsed.version === "string", "version must be a string");
      assert.ok(typeof parsed.projectConfigPath === "string", "projectConfigPath must be a string");
      assert.ok(typeof parsed.userPolicyPath === "string", "userPolicyPath must be a string");
      assert.ok(typeof parsed.policyMode === "string", "policyMode must be a string");
      assert.ok(typeof parsed.effectiveEnforcement === "string", "effectiveEnforcement must be a string");
      assert.ok(typeof parsed.privacyMode === "string", "privacyMode must be a string");
      assert.ok(Array.isArray(parsed.hosts), "hosts must be an array");
      assert.ok(Array.isArray(parsed.warnings), "warnings must be an array");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Reports wrapper-host limitation warning
  // -------------------------------------------------------------------------
  it("reports a wrapper-host limitation warning for wrapper-enforced hosts", async () => {
    const cwd = await tmpDir("ar-doctor-wrapper-");
    const home = await tmpDir("ar-doctor-wrapper-home-");
    try {
      // Write project config with a wrapper host (codex).
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({
          policy: { allowAdvisoryHosts: true },
          hosts: {
            codex: { reviewer: "none" },
          },
        })
      );

      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--json"], io);

      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const parsed = JSON.parse(out.join(""));
      const hasWrapperWarning = parsed.warnings.some(
        (w) => /wrapper/i.test(w) || /advisory/i.test(w)
      );
      assert.ok(hasWrapperWarning, "expected a wrapper/advisory limitation warning in output");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Reports no warnings for a clean native-enforced setup
  // -------------------------------------------------------------------------
  it("reports no warnings for a clean claude-code setup", async () => {
    const cwd = await tmpDir("ar-doctor-clean-");
    const home = await tmpDir("ar-doctor-clean-home-");
    try {
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        JSON.stringify({
          hosts: {
            "claude-code": { reviewer: "none" },
          },
        })
      );
      // A genuinely clean setup also has the native hooks registered — otherwise
      // doctor (correctly) warns the gate would never fire. Register both events.
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "adversarial-review-gate hook --host claude-code --event session-start",
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "adversarial-review-gate hook --host claude-code --event stop",
                  },
                ],
              },
            ],
          },
        })
      );

      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--json"], io);

      assert.equal(process.exitCode, 0);

      const parsed = JSON.parse(out.join(""));
      assert.equal(parsed.warnings.length, 0, "expected no warnings for native-enforced host");
      assert.equal(parsed.effectiveEnforcement, "native-enforced");
      // The host report must surface that our native hooks are registered.
      const cc = parsed.hosts.find((h) => h.id === "claude-code");
      assert.ok(cc.hooks, "claude-code host report must include hooks status");
      assert.equal(cc.hooks.registered, true, "hooks must be reported as registered");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Reports project config validity
  // -------------------------------------------------------------------------
  it("reports project config as invalid when file is corrupt JSON", async () => {
    const cwd = await tmpDir("ar-doctor-corrupt-");
    const home = await tmpDir("ar-doctor-corrupt-home-");
    try {
      await mkdir(join(cwd, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(cwd, ".adversarial-review", "config.json"),
        "{ this is not valid json "
      );

      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--json"], io);

      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const parsed = JSON.parse(out.join(""));
      assert.equal(parsed.projectConfigExists, true);
      assert.equal(parsed.projectConfigValid, false, "corrupt config must be reported as invalid");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // --dry-run performs no writes (doctor is already read-only, but test confirms)
  // -------------------------------------------------------------------------
  it("--dry-run flag is accepted and makes no writes (doctor is read-only)", async () => {
    const cwd = await tmpDir("ar-doctor-dryrun-");
    const home = await tmpDir("ar-doctor-dryrun-home-");
    try {
      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--dry-run"], io);

      // Doctor always exits 0 and never writes files.
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      // No .adversarial-review dirs should have been created.
      const { existsSync: efs } = await import("node:fs");
      assert.ok(!efs(join(cwd, ".adversarial-review")), "no cwd AR dir should be created");
      assert.ok(!efs(join(home, ".adversarial-review")), "no home AR dir should be created");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // User policy floor is reported
  // -------------------------------------------------------------------------
  it("reports user policy floor when present", async () => {
    const cwd = await tmpDir("ar-doctor-floor-");
    const home = await tmpDir("ar-doctor-floor-home-");
    try {
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "policy.json"),
        JSON.stringify({ policy: { mode: "strict-ci" } })
      );

      const { io, out } = makeIo(cwd, home);
      process.exitCode = 0;

      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      assert.equal(parsed.userPolicyExists, true);
      assert.equal(parsed.policyMode, "strict-ci");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
