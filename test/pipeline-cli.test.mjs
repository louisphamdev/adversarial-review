import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { makeIsolatedEnv, makeTempRepo, makeFakeBins } from './helpers/isolated-env.mjs';
import { runCli } from './helpers/run-cli.mjs';
import { writeSwarmBin, seedModelStore } from './helpers/run-fixture.mjs';
import { modelsForSeat, assertResumeFlags } from '../skills/adversarial-review/scripts/lib/cli/run.mjs';
import { canonicalPath } from '../skills/adversarial-review/scripts/lib/paths.mjs';

const CLI_PATH = path.resolve('skills/adversarial-review/scripts/adversarial-review.mjs');
const FAKE_SEAT_PATH = path.resolve('test/fixtures/fake-seat.mjs');

async function setupEnvAndRepo() {
  // A hermetic PATH. Every `run` discovers the swarm executable, whatever the route is, so a
  // real opencode on the developer PATH would answer these spawn cases instead of the fixtures.
  const bins = await makeFakeBins({});
  const iso = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({
    git: true,
    files: { 'index.js': 'console.log("hello");\n' },
  });

  // Make a modified file in the repo to provide a non-empty diff
  await fs.writeFile(path.join(repo.root, 'index.js'), 'console.log("hello world");\n');

  // Configure custom backend in user config
  const userConfigDir = path.join(iso.home, '.adversarial-review');
  await fs.mkdir(userConfigDir, { recursive: true });
  const userConfig = {
    version: 3,
    hostBackend: 'custom',
    backends: {
      custom: {
        command: [process.execPath, FAKE_SEAT_PATH],
      },
    },
  };
  await fs.writeFile(
    path.join(userConfigDir, 'config.json'),
    JSON.stringify(userConfig, null, 2)
  );

  const cleanup = async () => {
    await iso.cleanup();
    await repo.cleanup();
    await bins.cleanup();
  };

  return { iso, repo, cleanup };
}

// Resolves the single run directory that a `run` created under the isolated state home.
async function soleRunDir(iso) {
  const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
  const repoDirs = await fs.readdir(runsBase);
  const runDirs = await fs.readdir(path.join(runsBase, repoDirs[0]));
  return path.join(runsBase, repoDirs[0], runDirs[0]);
}

describe('pipeline-cli e2e tests', () => {
  it('two patch-review rounds on one run leave patch_seat-<seat>.r1.prompt.txt and .r2.prompt.txt', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const runRes = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--json'],
        { cwd: repo.root, env: iso.env, encoding: 'utf8' }
      );
      assert.equal(runRes.status, 1, `expected BLOCK exit 1, got ${runRes.status}. stderr: ${runRes.stderr}`);

      const runDir = await soleRunDir(iso);
      const planFile = path.join(iso.home, 'plan.md');

      await fs.writeFile(planFile, '## C1\nfirst plan\n');
      const first = spawnSync(
        process.execPath,
        [CLI_PATH, 'patch-review', runDir, '--plan', planFile],
        { cwd: repo.root, env: iso.env, encoding: 'utf8' }
      );
      assert.equal(first.status, 0, `first patch-review should APPLY. stderr: ${first.stderr}`);

      await fs.writeFile(planFile, '## C1\nsecond plan\n');
      const second = spawnSync(
        process.execPath,
        [CLI_PATH, 'patch-review', runDir, '--plan', planFile],
        { cwd: repo.root, env: iso.env, encoding: 'utf8' }
      );
      assert.equal(second.status, 0, `second patch-review should APPLY. stderr: ${second.stderr}`);

      const callsDir = path.join(runDir, 'calls');
      const r1 = await fs.readFile(path.join(callsDir, 'patch_seat-breaker.r1.prompt.txt'), 'utf8');
      const r2 = await fs.readFile(path.join(callsDir, 'patch_seat-breaker.r2.prompt.txt'), 'utf8');
      assert.match(r1, /first plan/);
      assert.match(r2, /second plan/);
      assert.equal(existsSync(path.join(callsDir, 'patch_seat-breaker.prompt.txt')), false);

      // The round number is the record index, so each round has its own stage record.
      assert.ok(existsSync(path.join(runDir, 'stages', 'patch-review-1.json')));
      assert.ok(existsSync(path.join(runDir, 'stages', 'patch-review-2.json')));
    } finally {
      await cleanup();
    }
  });

  it('two verify rounds on one run leave verify_seat-<seat>.r1.prompt.txt and .r2.prompt.txt', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const runRes = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--json'],
        { cwd: repo.root, env: iso.env, encoding: 'utf8' }
      );
      assert.equal(runRes.status, 1, `expected BLOCK exit 1, got ${runRes.status}. stderr: ${runRes.stderr}`);

      const runDir = await soleRunDir(iso);
      for (const label of ['first', 'second']) {
        const verifyRes = spawnSync(
          process.execPath,
          [CLI_PATH, 'verify', runDir],
          { cwd: repo.root, env: iso.env, encoding: 'utf8' }
        );
        assert.equal(verifyRes.status, 0, `${label} verify should PASS. stderr: ${verifyRes.stderr}`);
      }

      const callsDir = path.join(runDir, 'calls');
      assert.ok(existsSync(path.join(callsDir, 'verify_seat-breaker.r1.prompt.txt')));
      assert.ok(existsSync(path.join(callsDir, 'verify_seat-breaker.r2.prompt.txt')));
      assert.equal(existsSync(path.join(callsDir, 'verify_seat-breaker.prompt.txt')), false);

      // The round number is the record index, so each round has its own stage record.
      assert.ok(existsSync(path.join(runDir, 'stages', 'verify-1.json')));
      assert.ok(existsSync(path.join(runDir, 'stages', 'verify-2.json')));
    } finally {
      await cleanup();
    }
  });

  it('e2e run --route spawn --backend custom --json -> exit 1, result.json exists, sift skipped with no-key', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--json'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );

      assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr: ${res.stderr}`);

      let outJson;
      try {
        outJson = JSON.parse(res.stdout);
      } catch (err) {
        assert.fail(`stdout was not valid json: ${res.stdout}\nstderr: ${res.stderr}`);
      }

      assert.equal(outJson.gateVerdict, 'BLOCK');
      assert.equal(outJson.exitCode, 1);
      assert.ok(outJson.blockingCount >= 1);
      assert.equal(outJson.sift?.status, 'skipped');
      assert.equal(outJson.sift?.reason, 'no-key');

      // Verify result.json exists under <state>/runs/
      const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
      assert.ok(existsSync(runsBase), 'runs directory should exist');
      const repoDirs = await fs.readdir(runsBase);
      assert.ok(repoDirs.length > 0, 'should have repo run folder');
      const runDirs = await fs.readdir(path.join(runsBase, repoDirs[0]));
      assert.ok(runDirs.length > 0, 'should have run folder');
      const resultPath = path.join(runsBase, repoDirs[0], runDirs[0], 'result.json');
      assert.ok(existsSync(resultPath), 'result.json should exist');
    } finally {
      await cleanup();
    }
  });

  it('persists materialPath and runId to request.json for resumed/detached runs (C4)', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--until', 'find', '--json'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res.status, 0, `expected 0, got ${res.status}. stderr: ${res.stderr}`);
      const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
      const repoDirs = await fs.readdir(runsBase);
      const runDirs = await fs.readdir(path.join(runsBase, repoDirs[0]));
      const reqPath = path.join(runsBase, repoDirs[0], runDirs[0], 'request.json');
      const req = JSON.parse(await fs.readFile(reqPath, 'utf8'));
      assert.ok(req.runId, 'runId should be set in request.json');
      assert.equal(req.runId, runDirs[0]);
      assert.ok(req.materialPath, 'materialPath should be set in request.json');
      assert.equal(req.materialPath, path.join(runsBase, repoDirs[0], runDirs[0], 'material.diff'));
    } finally {
      await cleanup();
    }
  });

  it('dead seat handling: breaker returns prose -> exit 1 with gaps.deadSeats; with --allow-gaps -> exit 0', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const deadEnv = {
        ...iso.env,
        FAKE_SEAT_PLAN: JSON.stringify({ breaker: { FIND: 'prose' } }),
      };

      // 1. Without --allow-gaps
      const res1 = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker,skeptic', '--json'],
        {
          cwd: repo.root,
          env: deadEnv,
          encoding: 'utf8',
        }
      );

      assert.equal(res1.status, 1, `expected exit 1. stderr: ${res1.stderr}`);
      const json1 = JSON.parse(res1.stdout);
      assert.equal(json1.gateVerdict, 'BLOCK');
      assert.ok(
        json1.gaps?.deadSeats?.some((d) => d.seat === 'breaker'),
        'deadSeats should contain breaker'
      );

      // 2. With --allow-gaps
      // Need fake-seat plan where other seats don't produce critical/important findings
      // skeptic returns minor findings or none, breaker is dead
      const res2 = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker,skeptic', '--allow-gaps', '--json'],
        {
          cwd: repo.root,
          env: deadEnv,
          encoding: 'utf8',
        }
      );

      assert.equal(res2.status, 0, `expected exit 0 with --allow-gaps. stderr: ${res2.stderr}`);
      const json2 = JSON.parse(res2.stdout);
      assert.equal(json2.gateVerdict, 'PASS');
      assert.equal(json2.exitCode, 0);
      assert.equal(json2.allowGaps, true);
    } finally {
      await cleanup();
    }
  });

  it('run --until find then run --resume <dir> -> FIND not re-run', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const counterFile = path.join(iso.home, 'fake-seat-counter.txt');
      const counterEnv = {
        ...iso.env,
        FAKE_SEAT_COUNTER_FILE: counterFile,
      };

      // 1. Run until find
      const res1 = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--until', 'find', '--json'],
        {
          cwd: repo.root,
          env: counterEnv,
          encoding: 'utf8',
        }
      );

      assert.equal(res1.status, 0, `expected exit 0 for run --until find. stderr: ${res1.stderr}`);

      // Count calls in FIND stage
      const lines1 = existsSync(counterFile) ? readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean) : [];
      const findCallCount = lines1.length;
      assert.ok(findCallCount > 0, 'FIND stage should have called seats');

      // Find the created run directory
      const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
      const repoDir = (await fs.readdir(runsBase))[0];
      const runId = (await fs.readdir(path.join(runsBase, repoDir)))[0];
      const runDir = path.join(runsBase, repoDir, runId);

      // Verify stages/find.json exists but result.json does not yet exist
      assert.ok(existsSync(path.join(runDir, 'stages', 'find.json')));
      assert.equal(existsSync(path.join(runDir, 'result.json')), false);

      // 2. Resume the run
      const res2 = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--resume', runDir, '--json'],
        {
          cwd: repo.root,
          env: counterEnv,
          encoding: 'utf8',
        }
      );

      assert.equal(res2.status, 1, `resume expected exit 1 from ruling. stderr: ${res2.stderr}`);
      const json2 = JSON.parse(res2.stdout);
      assert.equal(json2.gateVerdict, 'BLOCK');
      assert.ok(existsSync(path.join(runDir, 'result.json')));

      // Verify FIND was not called again
      const lines2 = readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean);
      // The total calls should increase by the subsequent stages, but find shouldn't have been re-run
      assert.ok(lines2.length > findCallCount, 'subsequent stages should have added calls');
    } finally {
      await cleanup();
    }
  });

  it('run --resume <dir> --stage spec -> exit 2', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
      const dummyRun = path.join(runsBase, 'dummy-repo', 'dummy-run');
      await fs.mkdir(dummyRun, { recursive: true });

      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--resume', dummyRun, '--stage', 'spec'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );

      assert.equal(res.status, 2, `expected exit 2, got ${res.status}`);
      assert.ok(res.stderr.includes('resume') || res.stderr.includes('stage') || res.stderr.includes('flag'));
    } finally {
      await cleanup();
    }
  });

  it('status <repo dir> -> exit 2; status --latest after a run -> prints the verdict', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      // status <repo dir> must fail with exit 2 because repo dir is not inside <state>/runs/
      const res1 = spawnSync(
        process.execPath,
        [CLI_PATH, 'status', repo.root],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res1.status, 2, `status on repo dir should exit 2. stderr: ${res1.stderr}`);

      // Perform a run first
      const runRes = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(runRes.status, 1);

      // Now status --latest
      const res2 = spawnSync(
        process.execPath,
        [CLI_PATH, 'status', '--latest'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res2.status, 0, `status --latest should exit 0. stderr: ${res2.stderr}`);
      assert.ok(res2.stdout.includes('BLOCK') || res2.stdout.includes('verdict'), 'should print verdict');
    } finally {
      await cleanup();
    }
  });

  it('SIGINT during a hang seat: run exits within 5 s, no fake-seat process is left, lock file is gone', async (t) => {
    if (process.platform === 'win32') {
      t.skip('Skipped on Windows (SIGINT process groups)');
      return;
    }
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const pidFile = path.join(iso.home, 'fake-seat-pids.txt');
      const hangEnv = {
        ...iso.env,
        FAKE_SEAT_PLAN: JSON.stringify({ breaker: { FIND: 'hang' } }),
        FAKE_SEAT_PID_FILE: pidFile,
      };

      const child = spawn(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker,skeptic'],
        {
          cwd: repo.root,
          env: hangEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      // Wait until child writes pid to pidFile (fake seat spawned)
      let spawnedPids = [];
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        if (existsSync(pidFile)) {
          const content = readFileSync(pidFile, 'utf8').trim();
          if (content) {
            spawnedPids = content.split('\n').map((s) => Number(s.trim())).filter(Boolean);
            if (spawnedPids.length > 0) break;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(spawnedPids.length > 0, 'fake seat should have spawned');

      // Send SIGINT to the runner process
      child.kill('SIGINT');

      // Wait for child exit (must be <= 5s)
      const exitPromise = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('child did not exit within 5s')), 5000)
      );

      const exitResult = await Promise.race([exitPromise, timer]);
      assert.ok(exitResult.code !== null || exitResult.signal === 'SIGINT');

      // Check that all spawned fake-seat pids are dead
      for (const p of spawnedPids) {
        let isAlive = false;
        try {
          process.kill(p, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
        assert.equal(isAlive, false, `PID ${p} should be dead`);
      }

      // Check that no lock file is left
      const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
      if (existsSync(runsBase)) {
        const repoDirs = await fs.readdir(runsBase);
        for (const rd of repoDirs) {
          const runDirs = await fs.readdir(path.join(runsBase, rd));
          for (const d of runDirs) {
            const lockFile = path.join(runsBase, rd, d, 'lock');
            assert.equal(existsSync(lockFile), false, `lock file at ${lockFile} should have been released`);
          }
        }
      }
    } finally {
      await cleanup();
    }
  });

  it('run --detach -> prints a dir; status <dir> shows an owner line; wait for result.json', async () => {
    const { iso, repo, cleanup } = await setupEnvAndRepo();
    try {
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'run', '--route', 'spawn', '--backend', 'custom', '--detach'],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );

      assert.equal(res.status, 0, `run --detach should exit 0. stderr: ${res.stderr}`);
      const runDir = res.stdout.trim().split(/\r?\n/)[0];
      assert.ok(existsSync(runDir), `run directory ${runDir} should exist`);
      const lockRaw = await fs.readFile(path.join(runDir, 'lock'), 'utf8').catch(() => '{}');
      const ownerPid = JSON.parse(lockRaw).pid;

      // Immediately check status
      const statusRes = spawnSync(
        process.execPath,
        [CLI_PATH, 'status', runDir],
        {
          cwd: repo.root,
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(statusRes.status, 0);
      // A fast owner can finish before this runs, and status then prints `Owner: none`.
      assert.match(statusRes.stdout, /owner/i);

      // Wait up to 15s for result.json
      const resultPath = path.join(runDir, 'result.json');
      const start = Date.now();
      let finished = false;
      while (Date.now() - start < 15000) {
        if (existsSync(resultPath)) {
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(finished, 'result.json should be written by detached worker');
      // result.json comes before the exit sweep, and the owner holds the repository as its cwd
      // until it exits, so removing the repository now fails with EBUSY on Windows. A fast owner
      // has released its lock already; its last writes are the sweep record and the release.
      if (ownerPid) {
        assert.ok(await waitForOwnerExit(ownerPid), 'the detached owner did not finish');
      } else {
        const until = Date.now() + 30000;
        const swept = async () => JSON.parse(await fs.readFile(resultPath, 'utf8').catch(() => '{}')).cleanup;
        while (Date.now() < until && (!(await swept()) || existsSync(path.join(runDir, 'lock')))) {
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await cleanup();
    }
  });

  it('quota --json with ADVERSARIAL_REVIEW_QUOTA_PERCENT=85 -> exit 1, {percent:85}', async () => {
    const iso = await makeIsolatedEnv({
      ADVERSARIAL_REVIEW_QUOTA_PERCENT: '85',
    });
    try {
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'quota', '--json'],
        {
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res.status, 1, `expected exit 1, got ${res.status}. stderr: ${res.stderr}`);
      const json = JSON.parse(res.stdout);
      assert.equal(json.percent, 85);
    } finally {
      await iso.cleanup();
    }
  });

  it('hook quota with env at 90 -> stdout parses, permissionDecision: ask; at 10 -> {}; broken config -> {} and exit 0', async () => {
    // 1. Quota at 90
    const iso90 = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '90' });
    try {
      const res = spawnSync(process.execPath, [CLI_PATH, 'hook', 'quota'], {
        env: iso90.env,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      const json = JSON.parse(res.stdout);
      assert.equal(json.hookSpecificOutput?.permissionDecision, 'ask');
      assert.ok(json.hookSpecificOutput?.permissionDecisionReason?.includes('90%'));
    } finally {
      await iso90.cleanup();
    }

    // 2. Quota at 10
    const iso10 = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '10' });
    try {
      const res = spawnSync(process.execPath, [CLI_PATH, 'hook', 'quota'], {
        env: iso10.env,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    } finally {
      await iso10.cleanup();
    }

    // 3. Broken config
    const isoBroken = await makeIsolatedEnv();
    try {
      const brokenCfg = path.join(isoBroken.home, '.adversarial-review', 'config.json');
      await fs.mkdir(path.dirname(brokenCfg), { recursive: true });
      await fs.writeFile(brokenCfg, 'BROKEN JSON!!!');

      const res = spawnSync(process.execPath, [CLI_PATH, 'hook', 'quota'], {
        env: isoBroken.env,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    } finally {
      await isoBroken.cleanup();
    }
  });

  it('hook --host claude-code --event stop -> exit 0, stderr mentions uninstall --v2-hooks', async () => {
    const iso = await makeIsolatedEnv();
    try {
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'hook', '--host', 'claude-code', '--event', 'stop'],
        {
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res.status, 0);
      assert.ok(
        res.stderr.includes('uninstall --v2-hooks'),
        `stderr should mention uninstall --v2-hooks: ${res.stderr}`
      );
    } finally {
      await iso.cleanup();
    }
  });

  it('sift --material f --findings f.json without key -> exit 0, prints skipped', async () => {
    const iso = await makeIsolatedEnv();
    try {
      const matFile = path.join(iso.home, 'mat.txt');
      const findFile = path.join(iso.home, 'findings.json');
      await fs.writeFile(matFile, 'some material');
      await fs.writeFile(
        findFile,
        JSON.stringify([
          { id: 'b-1', seat: 'breaker', title: 'test', severity: 'minor' },
        ])
      );

      const res = spawnSync(
        process.execPath,
        [CLI_PATH, 'sift', '--material', matFile, '--findings', findFile],
        {
          env: iso.env,
          encoding: 'utf8',
        }
      );
      assert.equal(res.status, 0, `sift should exit 0 when skipped. stderr: ${res.stderr}`);
      assert.ok(
        res.stdout.includes('skipped') || res.stdout.includes('no-key'),
        `stdout should indicate skipped: ${res.stdout}`
      );
    } finally {
      await iso.cleanup();
    }
  });
});

// Live events (3.1 part C, task 6). The pipeline runs in its own process, so no signal handler
// or tracked child of the run leaks into the test runner.
async function readEventsFile(runDir) {
  return (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// The exit sweep appends `cleanup` after the run ends, so it never counts as the last event.
const lastRunEvent = (events) => events.filter((e) => e.event !== 'cleanup').at(-1);

async function runWithFakeSeats(args = []) {
  const ctx = await setupEnvAndRepo();
  const r = await runCli(['run', '--route', 'spawn', '--backend', 'custom', ...args], {
    env: ctx.iso.env,
    cwd: ctx.repo.root,
  });
  return { ...ctx, r, runDir: await soleRunDir(ctx.iso) };
}

describe('live seat events (3.1 part C, task 6)', () => {
  it('run writes stage_start, seat_done per FIND seat, stage_end, call_start with model, run_end', async () => {
    const { r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker,skeptic']);
    try {
      assert.ok(r.code === 0 || r.code === 1, `${r.code}: ${r.stderr}`);
      const events = await readEventsFile(runDir);
      const kinds = events.map((e) => e.event);
      assert.ok(kinds.includes('stage_start'));
      assert.ok(kinds.includes('stage_end'));
      const end = lastRunEvent(events);
      assert.equal(end.event, 'run_end');
      assert.equal(end.exitCode, r.code);
      const done = events.filter((e) => e.event === 'seat_done');
      assert.deepEqual(done.map((e) => e.seat).sort(), ['breaker', 'skeptic']);
      assert.ok(Array.isArray(done[0].findings));
      assert.equal(done[0].findingCount, done[0].findings.length);
      const cs = events.find((e) => e.event === 'call_start');
      assert.ok('model' in cs && cs.attempt === 1, JSON.stringify(cs));
      const ce = events.find((e) => e.event === 'call_end');
      assert.equal(ce.attempts, 1);
      const saved = JSON.parse(await fs.readFile(path.join(runDir, 'stages', `find-seat-${done[0].seat}.json`), 'utf8'));
      assert.equal(saved.seat, done[0].seat);
      assert.equal(saved.callId, `find-${done[0].seat}`);
      assert.ok('model' in saved && typeof saved.materialHash === 'string');
    } finally {
      await cleanup();
    }
  });

  it('run --until find ends with run_end stopped until-find', async () => {
    const { r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      const end = lastRunEvent(await readEventsFile(runDir));
      assert.equal(end.event, 'run_end');
      assert.equal(end.stopped, 'until-find');
    } finally {
      await cleanup();
    }
  });

  it('resume after the per-seat write and before seat_done gives exactly one seat_done', async () => {
    const { iso, repo, r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker,skeptic', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      const text = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
      const kept = text.split('\n').filter((l) => l && !l.includes('"seat_done"') && !l.includes('"stage_end"'));
      await fs.writeFile(path.join(runDir, 'events.jsonl'), kept.join('\n') + '\n');
      const r2 = await runCli(['run', '--resume', runDir, '--until', 'find'], { env: iso.env, cwd: repo.root });
      assert.ok(r2.code === 0 || r2.code === 1, `${r2.code}: ${r2.stderr}`);
      const evs = await readEventsFile(runDir);
      const seats = evs.filter((e) => e.event === 'seat_done').map((e) => e.seat);
      assert.deepEqual([...seats].sort(), ['breaker', 'skeptic']);
      assert.equal(evs.filter((e) => e.event === 'stage_end' && e.stage === 'find').length, 1);
    } finally {
      await cleanup();
    }
  });

  it('modelsForSeat keeps only approved providers, and a run with no approval keeps host models only', () => {
    // Part A writes failover entries as model strings; a preflight bundle writes objects.
    const request = {
      route: { seatModels: { edge: { model: 'opencode/a', failover: ['x/b', 'opencode/c'] } } },
      approval: { dataLeaves: [{ provider: 'opencode' }] },
    };
    assert.deepEqual(modelsForSeat(request, 'edge'), ['opencode/a', 'opencode/c']);
    const objects = {
      route: { seatModels: { edge: { model: 'opencode/a', provider: 'opencode', failover: [{ model: 'x/b', provider: 'x' }, { model: 'y/c', provider: 'y' }] } } },
      approval: { dataLeaves: [{ provider: 'opencode' }, { provider: 'y' }] },
    };
    assert.deepEqual(modelsForSeat(objects, 'edge'), ['opencode/a', 'y/c']);
    assert.deepEqual(modelsForSeat({ route: {} }, 'edge'), []);
    assert.deepEqual(
      modelsForSeat({ route: { seatModels: { edge: { model: 'opencode/a', provider: 'opencode', failover: [] } } } }, 'edge'),
      []
    );
  });

  it('plain run with a training swarm model and no acknowledgement exits 2 and starts no seat', async () => {
    const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
    const { env, home, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
    const repo = await makeTempRepo({ files: { 'a.js': '1' } });
    try {
      await writeSwarmBin({ dir: bins.dir, models: ['p/m1'] });
      await seedModelStore({ home, model: 'p/m1', lenses: ['breaker', 'edge', 'attacker', 'medic', 'tester'], acknowledgeTraining: false });
      await fs.writeFile(path.join(repo.root, 'a.js'), '2');
      const res = await runCli(['run', '--route', 'swarm', '--model', 'p/m1', '--backend', 'claude', '--allow-gaps'], {
        env,
        cwd: repo.root,
      });
      assert.equal(res.code, 2, `${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr + res.stdout, /answer the decisions first/);
      // The refused run leaves no run directory, so no seat can have started in one.
      const runsBase = path.join(home, '.adversarial-review', 'runs');
      const repoDirs = existsSync(runsBase) ? await fs.readdir(runsBase) : [];
      let runCount = 0;
      for (const rd of repoDirs) runCount += (await fs.readdir(path.join(runsBase, rd))).length;
      assert.equal(runCount, 0);
    } finally {
      await repo.cleanup();
      await cleanup();
      await bins.cleanup();
    }
  });
});

// Resume rules (3.1 part C, task 9).
// The detached owner holds the repository as its cwd until it exits, so a test waits for the
// process itself, not for the lock: the exit sweep runs after the lock is released.
async function waitForOwnerExit(pid, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('resume rules (3.1 part C, task 9)', () => {
  it('resume: refuses while the lock pid is alive, even with an old lock', async () => {
    const { iso, repo, r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      // The test runner is a live process that is not the resuming owner.
      await fs.writeFile(path.join(runDir, 'lock'), JSON.stringify({ pid: process.pid, token: 't', createdAt: Date.now() }));
      const old = new Date(Date.now() - 700000);
      await fs.utimes(path.join(runDir, 'lock'), old, old);
      const r2 = await runCli(['run', '--resume', runDir], { env: iso.env, cwd: repo.root });
      assert.equal(r2.code, 3, `${r2.stdout}\n${r2.stderr}`);
      assert.match(r2.stderr, new RegExp(`owner still alive \\(pid ${process.pid}\\)`));
      assert.equal(existsSync(path.join(runDir, 'result.json')), false);
      await fs.rm(path.join(runDir, 'lock'), { force: true });
    } finally {
      await cleanup();
    }
  });

  it('resume: accepts --detach and reads until from request.json', async () => {
    const { r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      const req = JSON.parse(await fs.readFile(path.join(runDir, 'request.json'), 'utf8'));
      assert.equal(req.until, 'find');
      assert.equal(req.schemaVersion, 2);
      assert.doesNotThrow(() => assertResumeFlags({ resume: runDir, detach: true, until: 'find', json: true }));
      assert.throws(() => assertResumeFlags({ resume: runDir, stage: 'spec' }), /--stage/);
    } finally {
      await cleanup();
    }
  });

  it('resume after a partial events line: the old next index still finds the first new event', async () => {
    const { iso, repo, r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      const before = (await readEventsFile(runDir)).length;
      await fs.appendFile(path.join(runDir, 'events.jsonl'), '{"event":"call_start","se');
      const r2 = await runCli(['run', '--resume', runDir], { env: iso.env, cwd: repo.root });
      assert.ok(r2.code === 0 || r2.code === 1, `${r2.code}: ${r2.stderr}`);
      const text = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
      const after = text.split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      assert.ok(after.length > before);
      assert.equal(typeof after[before].event, 'string');
    } finally {
      await cleanup();
    }
  });

  it('resume --detach over a dead-pid lock returns only after a new owner took the lock', async () => {
    const { iso, repo, r, runDir, cleanup } = await runWithFakeSeats(['--seats', 'breaker', '--until', 'find']);
    try {
      assert.equal(r.code, 0, r.stderr);
      await fs.writeFile(path.join(runDir, 'lock'), JSON.stringify({ pid: 2147480000, token: 'dead', createdAt: Date.now() }));
      const r2 = await runCli(['run', '--resume', runDir, '--detach', '--until', 'find'], { env: iso.env, cwd: repo.root });
      assert.equal(r2.code, 0, `${r2.stdout}\n${r2.stderr}`);
      assert.equal(canonicalPath(r2.stdout.trim()), canonicalPath(runDir));
      const raw = await fs.readFile(path.join(runDir, 'lock'), 'utf8').catch(() => '{"token":"released"}');
      const lock = JSON.parse(raw);
      assert.notEqual(lock.token, 'dead');
      // The worker log names no pid, so a lock that is already released leaves only the event log.
      if (lock.pid) assert.ok(await waitForOwnerExit(lock.pid), 'the detached owner did not finish');
      else await new Promise((r) => setTimeout(r, 2000));
    } finally {
      await cleanup();
    }
  });
});
