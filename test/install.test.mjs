import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeIsolatedEnv, makeTempRepo } from './helpers/isolated-env.mjs';
import { install, uninstall } from '../skills/adversarial-review/scripts/lib/install.mjs';
import { runInstallCommand } from '../skills/adversarial-review/scripts/lib/cli/install.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';
import { acquireLock } from '../skills/adversarial-review/scripts/lib/lockfile.mjs';
import { stateDir } from '../skills/adversarial-review/scripts/lib/paths.mjs';

function fakeStream() {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk;
    },
    get output() {
      return buf;
    },
  };
}

test('golden target lists per host (relative to fake home)', async () => {
  // Test claude-code
  {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const res = await install({ host: 'claude-code', env });
      assert.ok(res.written.length > 0);
      assert.equal(res.kept.length, 0);

      // Verify skill files in ~/.claude/skills/adversarial-review/
      const skillFile = path.join(home, '.claude', 'skills', 'adversarial-review', 'scripts', 'lib', 'version.mjs');
      await fs.access(skillFile);

      // Verify agents in ~/.claude/agents/rt-*.md
      const breakerAgent = path.join(home, '.claude', 'agents', 'rt-breaker.md');
      const agentContent = await fs.readFile(breakerAgent, 'utf8');
      assert.ok(agentContent.includes('name: rt-breaker'));
      assert.ok(agentContent.includes('tools: Read, Grep, Glob'));

      // Ensure no .agents or .config/opencode files
      await assert.rejects(fs.access(path.join(home, '.agents')));
      await assert.rejects(fs.access(path.join(home, '.config', 'opencode')));
    } finally {
      await cleanup();
    }
  }

  // Test codex
  {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const res = await install({ host: 'codex', env });
      assert.ok(res.written.length > 0);
      const skillFile = path.join(home, '.agents', 'skills', 'adversarial-review', 'scripts', 'lib', 'version.mjs');
      await fs.access(skillFile);
      await assert.rejects(fs.access(path.join(home, '.claude')));
      await assert.rejects(fs.access(path.join(home, '.config', 'opencode')));
    } finally {
      await cleanup();
    }
  }

  // Test gemini
  {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const res = await install({ host: 'gemini', env });
      assert.ok(res.written.length > 0);
      const skillFile = path.join(home, '.agents', 'skills', 'adversarial-review', 'scripts', 'lib', 'version.mjs');
      await fs.access(skillFile);
      await assert.rejects(fs.access(path.join(home, '.claude')));
      await assert.rejects(fs.access(path.join(home, '.config', 'opencode')));
    } finally {
      await cleanup();
    }
  }

  // Test opencode
  {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const res = await install({ host: 'opencode', env });
      assert.ok(res.written.length > 0);
      const skillFile = path.join(home, '.agents', 'skills', 'adversarial-review', 'scripts', 'lib', 'version.mjs');
      await fs.access(skillFile);
      const agentFile = path.join(home, '.config', 'opencode', 'agents', 'adversarial-review-seat.md');
      const agentContent = await fs.readFile(agentFile, 'utf8');
      assert.ok(agentContent.includes('permissions:'));
      assert.ok(agentContent.includes('action: shell'));
      assert.ok(agentContent.includes('action: edit'));
      assert.ok(agentContent.includes('action: webfetch'));
      assert.ok(agentContent.includes('action: websearch'));
      assert.ok(agentContent.includes('action: subagent'));
      assert.ok(agentContent.includes('action: question'));
      await assert.rejects(fs.access(path.join(home, '.claude')));
    } finally {
      await cleanup();
    }
  }
});

test('second install writes nothing', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const res1 = await install({ host: 'claude-code', env });
    assert.ok(res1.written.length > 0);

    const res2 = await install({ host: 'claude-code', env });
    assert.equal(res2.written.length, 0);
    assert.equal(res2.adopted.length, 0);
    assert.equal(res2.kept.length, 0);
  } finally {
    await cleanup();
  }
});

test('user-changed file kept without --force, replaced with --force plus backup', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    await install({ host: 'codex', env });
    const targetFile = path.join(home, '.agents', 'skills', 'adversarial-review', 'bench', 'defects.js');
    await fs.writeFile(targetFile, '// user edit content\n', 'utf8');

    // Run install without force -> kept
    const resKept = await install({ host: 'codex', env });
    assert.equal(resKept.written.length, 0);
    assert.ok(resKept.kept.some((k) => k.file === targetFile && k.reason === 'user-changed'));
    const contentKept = await fs.readFile(targetFile, 'utf8');
    assert.equal(contentKept, '// user edit content\n');

    // Run install with force -> overwritten with backup
    const resForced = await install({ host: 'codex', force: true, env });
    assert.ok(resForced.written.includes(targetFile));
    assert.equal(resForced.backups.length, 1);
    const backupContent = await fs.readFile(resForced.backups[0], 'utf8');
    assert.equal(backupContent, '// user edit content\n');
    const restoredContent = await fs.readFile(targetFile, 'utf8');
    assert.notEqual(restoredContent, '// user edit content\n');
  } finally {
    await cleanup();
  }
});

test('foreign file kept with --force, replaced with --adopt plus a .bak-*', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const foreignFile = path.join(home, '.claude', 'agents', 'rt-breaker.md');
    await fs.mkdir(path.dirname(foreignFile), { recursive: true });
    await fs.writeFile(foreignFile, 'FOREIGN BREAKER\n', 'utf8');

    // install with force=true -> still kept because it is foreign
    const resForced = await install({ host: 'claude-code', force: true, env });
    assert.ok(resForced.kept.some((k) => k.file === foreignFile && k.reason === 'foreign'));
    const contentKept = await fs.readFile(foreignFile, 'utf8');
    assert.equal(contentKept, 'FOREIGN BREAKER\n');

    // install with adopt=true -> replaced with backup
    const resAdopt = await install({ host: 'claude-code', adopt: true, env });
    assert.ok(resAdopt.adopted.includes(foreignFile));
    assert.ok(resAdopt.backups.length >= 1);
    const backup = resAdopt.backups.find((b) => b.startsWith(foreignFile));
    assert.ok(backup);
    const backupContent = await fs.readFile(backup, 'utf8');
    assert.equal(backupContent, 'FOREIGN BREAKER\n');

    const adoptedContent = await fs.readFile(foreignFile, 'utf8');
    assert.ok(adoptedContent.includes('name: rt-breaker'));
  } finally {
    await cleanup();
  }
});

test('uninstall --host codex after codex+gemini keeps the skill; gemini then deletes it', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    await install({ host: 'codex', env });
    await install({ host: 'gemini', env });

    const skillDir = path.join(home, '.agents', 'skills', 'adversarial-review');
    await fs.access(skillDir);

    const resCodex = await uninstall({ host: 'codex', env });
    assert.equal(resCodex.deleted.length, 0);
    assert.ok(resCodex.kept.length > 0);
    await fs.access(skillDir);

    const resGemini = await uninstall({ host: 'gemini', env });
    assert.ok(resGemini.deleted.length > 0);
    await assert.rejects(fs.access(skillDir));
  } finally {
    await cleanup();
  }
});

test('project install through a symlinked .agents -> throws ConfigError (skip win32)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlinks require privileges on Windows');
    return;
  }
  const { env, cleanup: envCleanup } = await makeIsolatedEnv();
  const repo = await makeTempRepo({ git: true });
  try {
    const outsideTarget = path.join(repo.root, '..', 'fake-outside-agents');
    await fs.mkdir(outsideTarget, { recursive: true });
    await fs.symlink(outsideTarget, path.join(repo.root, '.agents'), 'dir');

    await assert.rejects(
      () => install({ host: 'codex', project: true, cwd: repo.root, env }),
      (err) => err instanceof ConfigError
    );
  } finally {
    await envCleanup();
    await repo.cleanup();
  }
});

test('concurrent installs: one rejects with LockBusyError -> exit 2 in CLI', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    await fs.mkdir(stateDir(env), { recursive: true });
    const lockPath = path.join(stateDir(env), 'install.lock');
    const lock = await acquireLock(lockPath, { onBusy: 'fail' });

    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await runInstallCommand(['install', '--host', 'codex'], {
      env,
      cwd: process.cwd(),
      stdout,
      stderr,
    });
    assert.equal(code, 2);
    assert.ok(stderr.output.includes('busy') || stderr.output.includes('Lock'));

    await lock.release();
  } finally {
    await cleanup();
  }
});

test('v2 install.json bytes unchanged', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    await fs.mkdir(stateDir(env), { recursive: true });
    const v2Path = path.join(stateDir(env), 'install.json');
    const v2Content = '{"version":2,"installed":["old-file"]}\n';
    await fs.writeFile(v2Path, v2Content, 'utf8');

    await install({ host: 'claude-code', env });
    await uninstall({ host: 'claude-code', env });

    const after = await fs.readFile(v2Path, 'utf8');
    assert.equal(after, v2Content);
  } finally {
    await cleanup();
  }
});

test('--quota-hook merges into an existing settings file without losing keys and uninstall removes only that entry', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const initial = {
      theme: 'dark',
      hooks: {
        PostToolUse: [{ matcher: '*', command: 'echo post' }],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(initial, null, 2) + '\n', 'utf8');

    await install({ host: 'claude-code', quotaHook: true, env });
    const installedSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(installedSettings.theme, 'dark');
    assert.equal(installedSettings.hooks.PostToolUse.length, 1);
    assert.ok(installedSettings.hooks.PreToolUse.length >= 1);
    assert.ok(
      installedSettings.hooks.PreToolUse.some(
        (h) => h.matcher === 'Agent|Workflow' && h.command.includes('hook quota')
      )
    );

    // uninstall claude-code removes only the quota hook
    await uninstall({ host: 'claude-code', env });
    const uninstalledSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(uninstalledSettings.theme, 'dark');
    assert.equal(uninstalledSettings.hooks.PostToolUse.length, 1);
    const preHooks = uninstalledSettings.hooks.PreToolUse || [];
    assert.ok(!preHooks.some((h) => h.command.includes('hook quota')));
  } finally {
    await cleanup();
  }
});

test('--v2-hooks on a seeded v2 settings file removes only the v2 entries', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  const repo = await makeTempRepo({ git: true });
  try {
    const settingsPath = path.join(repo.root, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const v2Settings = {
      theme: 'light',
      hooks: {
        Stop: [
          { command: 'node bin/adversarial-review.js hook --host claude-code --event stop' },
        ],
        SessionStart: [
          { command: 'node bin/adversarial-review.js hook --host claude-code --event session-start' },
          { command: 'echo keep-me' },
        ],
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(v2Settings, null, 2) + '\n', 'utf8');

    await uninstall({ v2Hooks: true, cwd: repo.root, env });
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(after.theme, 'light');
    assert.equal(after.hooks.Stop.length, 0);
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].command, 'echo keep-me');
  } finally {
    await cleanup();
    await repo.cleanup();
  }
});

test('--dry-run writes nothing', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const res = await install({ host: 'claude-code', dryRun: true, env });
    assert.ok(res.written.length > 0);

    // Verify neither .claude nor .adversarial-review directory exists
    await assert.rejects(fs.access(path.join(home, '.claude')));
    await assert.rejects(fs.access(stateDir(env)));
  } finally {
    await cleanup();
  }
});

test('legacy memory copied when installing claude-code', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const legacyMemoryDir = path.join(home, '.claude', 'roundtable', 'memory');
    await fs.mkdir(legacyMemoryDir, { recursive: true });
    await fs.writeFile(path.join(legacyMemoryDir, 'rt-breaker.md'), 'old breaker memory\n', 'utf8');

    await install({ host: 'claude-code', env });
    const copied = path.join(stateDir(env), 'memory', 'rt-breaker.md');
    const content = await fs.readFile(copied, 'utf8');
    assert.equal(content, 'old breaker memory\n');
  } finally {
    await cleanup();
  }
});

test('CLI validation: missing or invalid host returns 2', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const stderr1 = fakeStream();
    const code1 = await runInstallCommand(['install'], { env, stderr: stderr1 });
    assert.equal(code1, 2);

    const stderr2 = fakeStream();
    const code2 = await runInstallCommand(['install', '--host', 'badhost'], { env, stderr: stderr2 });
    assert.equal(code2, 2);

    const stderr3 = fakeStream();
    const code3 = await runInstallCommand(['uninstall'], { env, stderr: stderr3 });
    assert.equal(code3, 2);

    const stderr4 = fakeStream();
    const code4 = await runInstallCommand(['uninstall', '--host', 'badhost'], { env, stderr: stderr4 });
    assert.equal(code4, 2);
  } finally {
    await cleanup();
  }
});

test('CLI execution: install and uninstall normal flows', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const stdout1 = fakeStream();
    const code1 = await runInstallCommand(['install', '--host', 'codex'], { env, stdout: stdout1 });
    assert.equal(code1, 0);
    assert.ok(stdout1.output.includes('Installed: written'));

    const stdoutDry = fakeStream();
    const codeDry = await runInstallCommand(['install', '--host', 'codex', '--dry-run'], { env, stdout: stdoutDry });
    assert.equal(codeDry, 0);

    const stdout2 = fakeStream();
    const code2 = await runInstallCommand(['uninstall', '--host', 'codex'], { env, stdout: stdout2 });
    assert.equal(code2, 0);
    assert.ok(stdout2.output.includes('Uninstalled: deleted'));
  } finally {
    await cleanup();
  }
});

test('corrupt manifest stops install with exit 2', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    await fs.mkdir(stateDir(env), { recursive: true });
    const manifestPath = path.join(stateDir(env), 'install-v3.json');
    await fs.writeFile(manifestPath, '{ not json }', 'utf8');

    const stderr = fakeStream();
    const code = await runInstallCommand(['install', '--host', 'codex'], { env, stderr });
    assert.equal(code, 2);
  } finally {
    await cleanup();
  }
});

test('refuse symlinked or invalid settings.json in --v2-hooks and --quota-hook', async (t) => {
  const { env, home, cleanup: envCleanup } = await makeIsolatedEnv();
  const repo = await makeTempRepo({ git: true });
  try {
    // 1. Invalid JSON in settings.json with v2-hooks
    const settingsPath = path.join(repo.root, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, 'not-valid-json', 'utf8');

    await assert.rejects(
      () => uninstall({ v2Hooks: true, cwd: repo.root, env }),
      (err) => err instanceof ConfigError
    );

    // 2. Symlink settings.json (skip on win32)
    if (process.platform !== 'win32') {
      await fs.unlink(settingsPath);
      const outsideSettings = path.join(repo.root, '..', 'fake-outside-settings.json');
      await fs.writeFile(outsideSettings, '{}', 'utf8');
      await fs.symlink(outsideSettings, settingsPath);

      await assert.rejects(
        () => uninstall({ v2Hooks: true, cwd: repo.root, env }),
        (err) => err instanceof ConfigError
      );

      // Quota hook symlink check on home settings.json
      const homeSettings = path.join(home, '.claude', 'settings.json');
      await fs.mkdir(path.dirname(homeSettings), { recursive: true });
      await fs.symlink(outsideSettings, homeSettings);

      await assert.rejects(
        () => install({ host: 'claude-code', quotaHook: true, env }),
        (err) => err instanceof ConfigError
      );
    }
  } finally {
    await envCleanup();
    await repo.cleanup();
  }
});

test('project install writes to repo .agents or .claude', async () => {
  const { env, home, cleanup: envCleanup } = await makeIsolatedEnv();
  const repo = await makeTempRepo({ git: true });
  try {
    // Project install for opencode
    const res = await install({ host: 'opencode', project: true, cwd: repo.root, env });
    assert.ok(res.written.length > 0);

    // Skill is in <repoRoot>/.agents/skills/adversarial-review/
    const skillPath = path.join(repo.root, '.agents', 'skills', 'adversarial-review', 'scripts', 'lib', 'version.mjs');
    await fs.access(skillPath);

    // opencode agent is in <home>/.config/opencode/agents/adversarial-review-seat.md
    const agentPath = path.join(home, '.config', 'opencode', 'agents', 'adversarial-review-seat.md');
    await fs.access(agentPath);
  } finally {
    await envCleanup();
    await repo.cleanup();
  }
});

test('install rejects --quota-hook when --project is passed with ConfigError (C7)', async () => {
  const { env, home, cleanup: c1 } = await makeIsolatedEnv();
  const { root, cleanup: c2 } = await makeTempRepo({ git: true });
  try {
    await assert.rejects(
      () => install({ host: 'claude-code', project: true, quotaHook: true, env, cwd: root }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /quota-hook/i);
        return true;
      }
    );
    const settingsPath = path.join(home, '.claude', 'settings.json');
    assert.equal(existsSync(settingsPath), false);
  } finally {
    await c1();
    await c2();
  }
});

