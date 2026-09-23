import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const repoRoot = path.resolve(import.meta.dirname, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build.mjs');
const agentsDir = path.join(repoRoot, 'agents');

test('build script', async (t) => {
  await t.test('build script compiles agents and --check verifies them', () => {
    // Run build to generate agents
    const buildRes = spawnSync(process.execPath, [buildScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(buildRes.status, 0, `Build failed: ${buildRes.stderr}`);

    // Verify 13 agent files exist
    const expectedAgents = [
      'rt-attacker.md', 'rt-breaker.md', 'rt-edge.md', 'rt-historian.md',
      'rt-judge.md', 'rt-keeper.md', 'rt-medic.md', 'rt-native.md',
      'rt-plumber.md', 'rt-racer.md', 'rt-simplifier.md', 'rt-skeptic.md',
      'rt-tester.md',
    ];

    assert.ok(fs.existsSync(agentsDir), 'agents directory should exist');
    for (const file of expectedAgents) {
      const filePath = path.join(agentsDir, file);
      assert.ok(fs.existsSync(filePath), `Agent file ${file} should exist`);
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.startsWith(`---\nname: ${file.replace('.md', '')}\n`));
      assert.ok(content.includes('## Before you work'));
    }

    // Now test --check succeeds when files are up-to-date
    const checkRes = spawnSync(process.execPath, [buildScript, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(checkRes.status, 0, `--check should exit 0 when matching: ${checkRes.stderr}`);
  });

  await t.test('--check detects differences and exits 1', () => {
    const targetFile = path.join(agentsDir, 'rt-breaker.md');
    const originalContent = fs.readFileSync(targetFile, 'utf8');
    try {
      // Modify file
      fs.writeFileSync(targetFile, originalContent + '\n# Extra tampered line\n', 'utf8');

      const checkFail = spawnSync(process.execPath, [buildScript, '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(checkFail.status, 1, '--check should exit 1 when files differ');
      assert.match(checkFail.stdout + checkFail.stderr, /rt-breaker\.md/);
    } finally {
      // Restore file
      fs.writeFileSync(targetFile, originalContent, 'utf8');
    }

    // Verify --check passes again after restoration
    const checkRestore = spawnSync(process.execPath, [buildScript, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(checkRestore.status, 0);
  });

  await t.test('--check detects missing files and exits 1', () => {
    const targetFile = path.join(agentsDir, 'rt-edge.md');
    const originalContent = fs.readFileSync(targetFile, 'utf8');
    try {
      // Delete file
      fs.unlinkSync(targetFile);

      const checkFail = spawnSync(process.execPath, [buildScript, '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(checkFail.status, 1, '--check should exit 1 when a file is missing');
      assert.match(checkFail.stdout + checkFail.stderr, /rt-edge\.md/);
    } finally {
      // Restore file
      fs.writeFileSync(targetFile, originalContent, 'utf8');
    }

    // Verify --check passes again
    const checkRestore = spawnSync(process.execPath, [buildScript, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(checkRestore.status, 0);
  });

  await t.test('build supports custom directories programmatically or in isolated tmpdir', async () => {
    // If build.mjs exports build(options), test it in an isolated directory
    const { build } = await import('../scripts/build.mjs');
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'build-test-'));
    try {
      const seatsDir = path.join(tmp, 'seats');
      const customAgentsDir = path.join(tmp, 'agents');
      fs.mkdirSync(seatsDir);

      fs.writeFileSync(
        path.join(seatsDir, 'custom.md'),
        `---\nkey: custom\ntitle: Custom\nlens: custom lens\ndescription: Custom seat\ntier: standard\nbudgetFactor: 1\n---\n# Custom Body\n`,
        'utf8',
      );

      // Build into customAgentsDir
      const res = build({ seatsDir, agentsDir: customAgentsDir });
      assert.equal(res.changed.length, 1);
      assert.ok(fs.existsSync(path.join(customAgentsDir, 'rt-custom.md')));

      // Check should report no changes
      const checkRes = build({ check: true, seatsDir, agentsDir: customAgentsDir });
      assert.equal(checkRes.changed.length, 0);

      // Mutate agent
      fs.writeFileSync(path.join(customAgentsDir, 'rt-custom.md'), 'tampered', 'utf8');
      const checkDiff = build({ check: true, seatsDir, agentsDir: customAgentsDir });
      assert.equal(checkDiff.changed.length, 1);
      assert.equal(checkDiff.changed[0], 'rt-custom.md');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
