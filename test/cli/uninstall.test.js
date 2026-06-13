import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { installCommand } from "../../src/cli/install.js";
import { uninstallCommand } from "../../src/cli/uninstall.js";

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

describe("uninstall command", () => {
  it("removes ONLY our hooks from settings.json, preserving unrelated keys/hooks", async () => {
    const cwd = await tmpDir("ar-uninstall-merge-");
    const home = await tmpDir("ar-uninstall-merge-home-");
    try {
      // Seed a settings.json with an unrelated Stop hook + permissions, then
      // install our hooks on top.
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(ls)"] },
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "node other.js" }] }],
          },
        })
      );

      const { io: ioInstall } = makeIo(cwd, home);
      process.exitCode = 0;
      await installCommand(
        ["--hosts", "claude-code", "--reviewer", "claude-code=none"],
        ioInstall
      );
      assert.equal(process.exitCode, 0);

      // Now uninstall.
      const { io: ioUninstall, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], ioUninstall);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const { readFile: rf } = await import("node:fs/promises");
      const after = JSON.parse(
        await rf(join(cwd, ".claude", "settings.json"), "utf8")
      );

      // Unrelated permissions key preserved.
      assert.deepEqual(after.permissions, { allow: ["Bash(ls)"] });

      // Unrelated Stop hook preserved.
      const stopCmds = (after.hooks?.Stop || []).flatMap((g) =>
        (g.hooks || []).map((h) => h.command)
      );
      assert.ok(stopCmds.some((c) => c.includes("other.js")), "unrelated hook preserved");

      // Our hooks removed (no adversarial-review entries anywhere).
      const allCmds = [
        ...((after.hooks?.SessionStart || []).flatMap((g) =>
          (g.hooks || []).map((h) => h.command)
        )),
        ...stopCmds,
      ];
      assert.ok(
        !allCmds.some((c) => c.includes("adversarial-review")),
        "all adversarial-review hooks must be removed"
      );
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("removes the registry entry for this cwd", async () => {
    const cwd = await tmpDir("ar-uninstall-reg-");
    const home = await tmpDir("ar-uninstall-reg-home-");
    try {
      const { io: ioInstall } = makeIo(cwd, home);
      process.exitCode = 0;
      await installCommand(
        ["--hosts", "claude-code", "--reviewer", "claude-code=none"],
        ioInstall
      );
      assert.equal(process.exitCode, 0);

      const { readFile: rf } = await import("node:fs/promises");
      const regBefore = JSON.parse(
        await rf(join(home, ".adversarial-review", "install.json"), "utf8")
      );
      assert.equal(Object.keys(regBefore).length, 1, "one registry entry after install");

      const { io: ioUninstall, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], ioUninstall);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const regAfter = JSON.parse(
        await rf(join(home, ".adversarial-review", "install.json"), "utf8")
      );
      assert.equal(Object.keys(regAfter).length, 0, "registry entry removed after uninstall");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps config by default and reports it; --remove-config deletes it", async () => {
    const cwd = await tmpDir("ar-uninstall-cfg-");
    const home = await tmpDir("ar-uninstall-cfg-home-");
    try {
      const { io: ioInstall } = makeIo(cwd, home);
      process.exitCode = 0;
      await installCommand(
        ["--hosts", "claude-code", "--reviewer", "claude-code=none"],
        ioInstall
      );
      assert.equal(process.exitCode, 0);

      const configPath = join(cwd, ".adversarial-review", "config.json");
      assert.ok(existsSync(configPath), "config exists after install");

      // Default uninstall keeps the config and says so.
      const { io: ioKeep, out } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], ioKeep);
      assert.equal(process.exitCode, 0);
      assert.ok(existsSync(configPath), "config kept by default");
      assert.match(out.join(""), /KEPT.*config\.json/i, "must report KEPT config");

      // --remove-config deletes it.
      const { io: ioRemove } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand(["--remove-config"], ioRemove);
      assert.equal(process.exitCode, 0);
      assert.ok(!existsSync(configPath), "config removed with --remove-config");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does NOT delete the shared opencode agent and reports keeping it", async () => {
    const cwd = await tmpDir("ar-uninstall-agent-");
    const home = await tmpDir("ar-uninstall-agent-home-");
    try {
      // Pre-create the shared opencode agent.
      const agentDir = join(home, ".config", "opencode", "agent");
      await mkdir(agentDir, { recursive: true });
      const agentPath = join(agentDir, "adversarial-reviewer.md");
      await writeFile(agentPath, "---\nmode: primary\n---\n");

      const { io, out, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], io);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      assert.ok(existsSync(agentPath), "shared opencode agent must NOT be deleted");
      assert.match(out.join(""), /KEPT.*opencode/i, "must report keeping the shared agent");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is idempotent and tolerant: a second uninstall (or empty state) still exits 0", async () => {
    const cwd = await tmpDir("ar-uninstall-idem-");
    const home = await tmpDir("ar-uninstall-idem-home-");
    try {
      // No install at all — uninstall must tolerate missing files.
      const { io, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], io);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      // A second uninstall is still a no-op exit 0.
      const { io: io2, err: err2 } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand([], io2);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err2.join("")}`);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--user removes hooks from <home>/.claude/settings.json", async () => {
    const cwd = await tmpDir("ar-uninstall-user-");
    const home = await tmpDir("ar-uninstall-user-home-");
    try {
      const { io: ioInstall } = makeIo(cwd, home);
      process.exitCode = 0;
      await installCommand(
        ["--user", "--hosts", "claude-code", "--reviewer", "claude-code=none"],
        ioInstall
      );
      assert.equal(process.exitCode, 0);

      const userSettings = join(home, ".claude", "settings.json");
      assert.ok(existsSync(userSettings), "user settings exist after --user install");

      const { io: ioUninstall, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand(["--user"], ioUninstall);
      assert.equal(process.exitCode, 0, `expected exit 0, stderr: ${err.join("")}`);

      const { readFile: rf } = await import("node:fs/promises");
      const after = JSON.parse(await rf(userSettings, "utf8"));
      const cmds = JSON.stringify(after);
      assert.ok(!cmds.includes("adversarial-review"), "user-scope hooks must be removed");
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported --host value", async () => {
    const cwd = await tmpDir("ar-uninstall-badhost-");
    const home = await tmpDir("ar-uninstall-badhost-home-");
    try {
      const { io, err } = makeIo(cwd, home);
      process.exitCode = 0;
      await uninstallCommand(["--host", "codex"], io);
      assert.notEqual(process.exitCode, 0, "unsupported --host must be a usage error");
      assert.match(err.join(""), /unsupported --host/i);
    } finally {
      resetExit();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
