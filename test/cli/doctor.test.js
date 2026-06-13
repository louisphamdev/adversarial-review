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
      // The host->reviewer map is sourced from the TRUSTED user-level config
      // (a project config can no longer inject hosts.*), so write it under home.
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
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

      // FINDING 7: a wrapper-ONLY configuration is advisory (bypassing the wrapper
      // skips the gate), so doctor must NOT certify it as enforced — it exits
      // non-zero so CI cannot mistake an advisory gate for an enforced one.
      assert.equal(process.exitCode, 1, `expected exit 1 for wrapper-only gate, stderr: ${err.join("")}`);

      const parsed = JSON.parse(out.join(""));
      const hasWrapperWarning = parsed.warnings.some(
        (w) => /wrapper/i.test(w) || /advisory/i.test(w)
      );
      assert.ok(hasWrapperWarning, "expected a wrapper/advisory limitation warning in output");
      assert.equal(parsed.wrapperOnlyNotEnforced, true, "wrapperOnlyNotEnforced must be flagged");
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
      // Host map comes from the trusted user-level config (project layer can no
      // longer inject hosts.*).
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
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
  // Finding 1: a neutered Stop hook must NOT be certified healthy/registered.
  // -------------------------------------------------------------------------
  it("does NOT report a neutered Stop hook as registered/native-enforced; warns + exits 1 (findings 1,2,3)", async () => {
    const cwd = await tmpDir("ar-doctor-neuter-");
    const home = await tmpDir("ar-doctor-neuter-home-");
    try {
      // Host map comes from the trusted user-level config (project layer can no
      // longer inject hosts.*).
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
        JSON.stringify({ hosts: { "claude-code": { reviewer: "none" } } })
      );
      // SessionStart canonical, but Stop is a spoofed/neutered command that keeps
      // the substrings yet does nothing.
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
                      "true # adversarial-review hook --host claude-code --event stop",
                  },
                ],
              },
            ],
          },
        })
      );

      const { io, out } = makeIo(cwd, home);
      process.exitCode = 0;
      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      const cc = parsed.hosts.find((h) => h.id === "claude-code");
      assert.equal(cc.hooks.registered, false, "neutered stop must NOT be registered");
      assert.equal(cc.hooks.tampered, true, "tampered hook must be flagged");
      assert.notEqual(
        parsed.effectiveEnforcement,
        "native-enforced",
        "must NOT certify native-enforced when the stop hook is neutered"
      );
      assert.equal(parsed.nativeNotEnforced, true);
      assert.ok(
        parsed.warnings.some((wn) => /tamper|neuter|not registered|not actually/i.test(wn)),
        "must warn about the non-functional/tampered gate"
      );
      // Finding 3: CI gating contract — exit non-zero.
      assert.equal(process.exitCode, 1, "doctor must exit 1 for a configured-but-unenforced gate");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Finding 2 + 3: native host configured but NO hooks at all -> not enforced,
  // exit non-zero.
  // -------------------------------------------------------------------------
  it("exits non-zero when a native host is configured but hooks are absent (findings 2,3)", async () => {
    const cwd = await tmpDir("ar-doctor-nohooks-");
    const home = await tmpDir("ar-doctor-nohooks-home-");
    try {
      // Host map comes from the trusted user-level config (project layer can no
      // longer inject hosts.*).
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
        JSON.stringify({ hosts: { "claude-code": { reviewer: "none" } } })
      );
      // No .claude/settings.json at all.

      const { io, out } = makeIo(cwd, home);
      process.exitCode = 0;
      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      assert.notEqual(parsed.effectiveEnforcement, "native-enforced");
      assert.equal(parsed.nativeNotEnforced, true);
      assert.equal(process.exitCode, 1, "doctor must exit 1 when the gate would never fire");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // A healthy registered native gate exits 0 (regression: contract is not
  // over-eager).
  // -------------------------------------------------------------------------
  it("exits 0 for a healthy registered native-enforced gate (finding 3 negative)", async () => {
    const cwd = await tmpDir("ar-doctor-ok-");
    const home = await tmpDir("ar-doctor-ok-home-");
    try {
      // Host map comes from the trusted user-level config (project layer can no
      // longer inject hosts.*).
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
        JSON.stringify({ hosts: { "claude-code": { reviewer: "none" } } })
      );
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

      const { io, out } = makeIo(cwd, home);
      process.exitCode = 0;
      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      assert.equal(parsed.effectiveEnforcement, "native-enforced");
      assert.equal(parsed.nativeNotEnforced, false);
      assert.equal(process.exitCode, 0, "healthy enforced gate must exit 0");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Finding 8: a native host with registered hooks but an UNAVAILABLE reviewer
  // is effectively broken — doctor must warn AND exit non-zero (not certify it).
  // -------------------------------------------------------------------------
  it("exits non-zero when a native host's reviewer is unavailable (finding 8)", async () => {
    const cwd = await tmpDir("ar-doctor-revunavail-");
    const home = await tmpDir("ar-doctor-revunavail-home-");
    try {
      // claude-code mapped to opencode, but PATH is empty so opencode is missing.
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
        JSON.stringify({ hosts: { "claude-code": { reviewer: "opencode" } } })
      );
      // Hooks ARE registered (canonical), so only the reviewer is the problem.
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

      // Empty PATH so the opencode binary cannot be resolved -> reviewer unavailable.
      const { io, out } = makeIo(cwd, home, { PATH: "" });
      process.exitCode = 0;
      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      const cc = parsed.hosts.find((h) => h.id === "claude-code");
      assert.equal(cc.hooks.registered, true, "hooks ARE registered in this scenario");
      assert.equal(cc.reviewerAvailable, false, "the opencode reviewer must be unavailable");
      // Must NOT certify as native-enforced when no review can actually run.
      assert.notEqual(
        parsed.effectiveEnforcement,
        "native-enforced",
        "must not certify native-enforced when the reviewer is unavailable"
      );
      assert.equal(parsed.nativeNotEnforced, true, "nativeNotEnforced must be flagged");
      assert.equal(
        process.exitCode,
        1,
        "doctor must exit 1 when the native host's reviewer is unavailable"
      );
      assert.ok(
        parsed.warnings.some((w) => /unavailable/i.test(w)),
        "must warn about the unavailable reviewer"
      );
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Finding 7: a wrapper-only gate must not be certified as enforced; exit 1.
  // -------------------------------------------------------------------------
  it("exits non-zero for a wrapper-only (advisory) gate (finding 7)", async () => {
    const cwd = await tmpDir("ar-doctor-wrapperonly-");
    const home = await tmpDir("ar-doctor-wrapperonly-home-");
    try {
      await mkdir(join(home, ".adversarial-review"), { recursive: true });
      await writeFile(
        join(home, ".adversarial-review", "config.json"),
        JSON.stringify({
          policy: { allowAdvisoryHosts: true },
          hosts: { codex: { reviewer: "none" } },
        })
      );

      const { io, out } = makeIo(cwd, home);
      process.exitCode = 0;
      await doctorCommand(["--json"], io);

      const parsed = JSON.parse(out.join(""));
      assert.equal(parsed.effectiveEnforcement, "wrapper-enforced (advisory)");
      assert.equal(parsed.wrapperOnlyNotEnforced, true);
      assert.equal(parsed.notEffectivelyEnforced, true);
      assert.equal(process.exitCode, 1, "wrapper-only gate must exit non-zero");
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
