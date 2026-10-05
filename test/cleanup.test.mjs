// Cleanup before a command exits (A14 item 3). The user requirement is that the lanes and their
// MCP processes are gone before the table exits, on every exit path.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnResolved, isPidAlive, isClosing, resetClosingForTests } from '../skills/adversarial-review/scripts/lib/proc.mjs';
import {
  acquireLockWithCleanup,
  makeExitHandler,
  runExitCleanup,
  setActiveRunDir,
  withExitCleanup,
} from '../skills/adversarial-review/scripts/lib/cleanup.mjs';
import { acquireLock } from '../skills/adversarial-review/scripts/lib/lockfile.mjs';
import { main } from '../skills/adversarial-review/scripts/lib/cli/main.mjs';
import { makeIsolatedEnv, makeFakeBins } from './helpers/isolated-env.mjs';

// A stub lane: one tracked child that starts a grandchild. A plain kill of the child leaves the
// grandchild running, which is exactly the leak this cleanup exists to stop.
async function startLaneStub() {
  // Every sweep in this file leaves the process closing, as it does at the end of a command.
  resetClosingForTests();
  const stub = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'process.stdout.write(g.pid + String.fromCharCode(10));',
    'setInterval(() => {}, 1000);',
  ].join('');
  const child = await spawnResolved(process.execPath, ['-e', stub], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const deadline = Date.now() + 10000;
  while (!out.trim() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const grandchildPid = Number(out.trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `no grandchild pid: ${out}`);
  return { pid: child.pid, grandchildPid };
}

async function makeRunDir() {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-cleanup-'));
  await mkdir(path.join(runDir, 'sandbox', 'xdg', 'weak-find', 'zen', 'opencode'), { recursive: true });
  await writeFile(path.join(runDir, 'sandbox', 'xdg', 'weak-find', 'zen', 'opencode', 'opencode.json'), '{}');
  return runDir;
}

async function assertCleaned(runDir, stub) {
  assert.equal(isPidAlive(stub.pid), false, 'the lane process is gone');
  assert.equal(isPidAlive(stub.grandchildPid), false, 'the process the lane started is gone');
  assert.equal(existsSync(path.join(runDir, 'sandbox', 'xdg')), false, 'the isolated config is gone');

  const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const cleanup = events.filter((e) => e.event === 'cleanup');
  assert.equal(cleanup.length, 1, JSON.stringify(events));
  assert.deepEqual(cleanup[0].stillAlive, []);
  assert.ok(cleanup[0].killed >= 1, `killed ${cleanup[0].killed}`);
  assert.ok(typeof cleanup[0].ts === 'number' || typeof cleanup[0].ts === 'string');

  const result = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.deepEqual(result.cleanup.stillAlive, []);
  assert.ok(result.cleanup.killed >= 1);
  assert.equal(result.gateVerdict, 'BLOCK', 'the rest of the result is untouched');
}

test('withExitCleanup kills every lane tree and records the sweep after a normal end', async () => {
  const runDir = await makeRunDir();
  try {
    const stub = await startLaneStub();
    const code = await withExitCleanup({ runDir }, async () => {
      await writeFile(
        path.join(runDir, 'result.json'),
        JSON.stringify({ gateVerdict: 'BLOCK', exitCode: 1 }, null, 2) + '\n'
      );
      return 1;
    });
    assert.equal(code, 1);
    await assertCleaned(runDir, stub);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('withExitCleanup kills every lane tree and records the sweep after a thrown error', async () => {
  const runDir = await makeRunDir();
  try {
    const stub = await startLaneStub();
    await assert.rejects(
      withExitCleanup({ runDir }, async () => {
        await writeFile(
          path.join(runDir, 'result.json'),
          JSON.stringify({ gateVerdict: 'BLOCK', exitCode: 3 }, null, 2) + '\n'
        );
        throw new Error('boom');
      }),
      /boom/
    );
    await assertCleaned(runDir, stub);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// A survivor is the one outcome the user must see: the run directory is gone from the terminal,
// so a pid that is only in the event log is a leak nobody reads about.
test('withExitCleanup runs once per command and names a survivor on stderr', async () => {
  const runDir = await makeRunDir();
  try {
    const lines = [];
    const stderr = { write: (s) => lines.push(s) };
    await withExitCleanup({ runDir, stderr }, async (cleanup) => {
      const first = await cleanup();
      const second = await cleanup();
      assert.equal(first, second, 'the sweep is memoized, so the body can run it early');
    });
    const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(events.length, 1, 'one cleanup event per command');
    assert.deepEqual(lines, [], 'nothing is printed when every pid is gone');
    assert.equal(existsSync(path.join(runDir, 'result.json')), false, 'no result is invented');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// Detach mode hands the run directory to a worker that rebuilds the same sandbox under the same
// path. A signal in the parent must sweep only its own processes, so the handler has to read the
// run directory when it fires, never the one that existed when it was installed.
test('the exit handler reads the run directory when it fires, not when it is installed', async () => {
  const runDir = await makeRunDir();
  try {
    setActiveRunDir(runDir);
    const released = [];
    const lockHolder = { lock: { release: async () => released.push('released') } };
    const handler = makeExitHandler({ stderr: { write: () => {} }, lockHolder });

    setActiveRunDir(null);
    await handler();

    assert.equal(
      existsSync(path.join(runDir, 'sandbox', 'xdg')),
      true,
      'the sandbox the worker owns survives the parent signal'
    );
    assert.equal(existsSync(path.join(runDir, 'events.jsonl')), false, 'no event is written for it');
    assert.deepEqual(released, ['released'], 'the lock is still released');
  } finally {
    setActiveRunDir(null);
    await rm(runDir, { recursive: true, force: true });
  }
});

// Three commands repeated this sequence. One helper keeps the sweep and the release in one order.
test('acquireLockWithCleanup takes the run lock and names the run directory for the sweep', async () => {
  const runDir = await makeRunDir();
  try {
    const lock = await acquireLockWithCleanup(runDir, { stderr: { write: () => {} } });
    assert.equal(existsSync(path.join(runDir, 'lock')), true, 'the run lock is held');
    await assert.rejects(
      acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' }),
      (err) => err.name === 'LockBusyError'
    );
    await lock.release();

    await runExitCleanup({ stderr: { write: () => {} } });
    assert.equal(
      existsSync(path.join(runDir, 'sandbox', 'xdg')),
      false,
      'the sweep knows which run directory to clean'
    );
  } finally {
    setActiveRunDir(null);
    await rm(runDir, { recursive: true, force: true });
  }
});

// A seat retry loop can outlive the command body. The sweep closes the process to new lanes
// before it reads the tracked pids, and keeps it closed (3.1 review C4).
test('runExitCleanup closes the process to new lanes and keeps it closed', async () => {
  resetClosingForTests();
  try {
    await runExitCleanup({ waitMs: 0 });
    assert.equal(isClosing(), true);
    await assert.rejects(
      spawnResolved(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
      (err) => err.code === 'ABORTED'
    );
  } finally {
    resetClosingForTests();
  }
});

// A busy lock belongs to a live owner. The command that lost the race must not sweep that
// owner's run directory on its way out: the lanes would lose their config mid-run.
test('acquireLockWithCleanup that loses the lock leaves the owner run directory alone', async () => {
  const runDir = await makeRunDir();
  const owner = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });
  try {
    const result = JSON.stringify({ gateVerdict: 'BLOCK', exitCode: 1 }, null, 2) + '\n';
    await writeFile(path.join(runDir, 'result.json'), result);
    await writeFile(path.join(runDir, 'events.jsonl'), '{"event":"start"}\n');
    const sink = { write: () => {} };
    await assert.rejects(
      withExitCleanup({ stderr: sink }, () => acquireLockWithCleanup(runDir, { stderr: sink })),
      (err) => err.name === 'LockBusyError'
    );
    assert.equal(existsSync(path.join(runDir, 'sandbox', 'xdg')), true, 'the owner keeps its lane config');
    assert.equal(await readFile(path.join(runDir, 'events.jsonl'), 'utf8'), '{"event":"start"}\n', 'no cleanup line');
    assert.equal(await readFile(path.join(runDir, 'result.json'), 'utf8'), result, 'the owner result is untouched');
  } finally {
    await owner.release();
    setActiveRunDir(null);
    await rm(runDir, { recursive: true, force: true });
  }
});

// `doctor --probe` and `models research|bench` open lanes through the same canary and lane-call
// path as `run`. A command that opens a lane and is not wrapped leaks every lane it starts.
const LANE_COMMANDS = [
  { argv: ['doctor'], exitCode: 0 },
  // The cheapest `models` path: it is refused before any model call, so the sweep is proved on
  // the error exit as well, without a 30 s model discovery.
  { argv: ['models', '--backend', 'no-such-backend'], exitCode: 2 },
];

for (const { argv, exitCode } of LANE_COMMANDS) {
  test(`${argv.join(' ')} sweeps the lanes it opened before it exits`, async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    // A fixed backend set: doctor exits 1 when the configured swarm backend is missing, so the real PATH must not decide.
    const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)', opencode: '2.0.8' });
    env[bins.pathKey] = bins.pathEnv;
    const sink = { write: () => true };
    const stub = await startLaneStub();
    try {
      const code = await main(argv, { env, cwd: home, stdout: sink, stderr: sink });
      assert.equal(code, exitCode);
      assert.equal(isPidAlive(stub.pid), false, 'the lane process is gone');
      assert.equal(isPidAlive(stub.grandchildPid), false, 'the process the lane started is gone');
    } finally {
      await bins.cleanup();
      await cleanup();
    }
  });
}
