import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { makeIsolatedEnv, makeTempRepo, makeFakeBins } from './helpers/isolated-env.mjs';
import { runCli } from './helpers/run-cli.mjs';
import {
  createResumableRunFixture,
  makeEditingStubBackend,
  writeStubBackend,
  writeSwarmBin,
  seedModelStore,
} from './helpers/run-fixture.mjs';
import { runsDir } from '../skills/adversarial-review/scripts/lib/paths.mjs';

test('run --route swarm with no opencode executable exits 2 and names it', async () => {
  // A hermetic PATH is the only way to prove the executable is absent: an empty PATH value
  // leaves the real `Path` of this machine in place on Windows.
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
  const { env, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ files: { 'a.js': '1' } });
  try {
    await writeFile(path.join(repo.root, 'a.js'), '2');
    const r = await runCli(['run', '--route', 'swarm', '--backend', 'claude'], { env, cwd: repo.root });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /opencode executable not found/);
  } finally {
    await repo.cleanup();
    await cleanup();
    await bins.cleanup();
  }
});

test('resume with a 0-byte baseline exits 2', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const runDir = await createResumableRunFixture({ env, home, baselineWritten: true });
    await writeFile(path.join(runDir, 'integrity', 'baseline.json'), '');
    const r = await runCli(['run', '--resume', runDir], { env });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /baseline/);
  } finally {
    await cleanup();
  }
});

test('a repository change during a stubbed run exits 3 with cause unknown; --allow-repo-change warns and records it', async () => {
  // Hermetic, like the cases above: a spawn run discovers the swarm executable too, so a real
  // opencode on the developer PATH would add its own latency to what this case measures.
  const bins = await makeFakeBins({});
  const { env, home, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ files: { 'a.js': '1' } });
  try {
    await writeFile(path.join(repo.root, 'a.js'), '2');
    await makeEditingStubBackend({ editFile: path.join(repo.root, 'a.js'), home });

    const r = await runCli(['run', '--route', 'spawn', '--backend', 'custom', '--allow-gaps'], { env, cwd: repo.root });
    assert.equal(r.code, 3, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /repository changed during the run, cause unknown/);

    const r2 = await runCli(['run', '--route', 'spawn', '--backend', 'custom', '--allow-gaps', '--allow-repo-change'], { env, cwd: repo.root });
    assert.notEqual(r2.code, 3, `${r2.stdout}\n${r2.stderr}`);
    assert.match(r2.stderr, /warning: repository changed/);
  } finally {
    await repo.cleanup();
    await cleanup();
    await bins.cleanup();
  }
});

test('run writes request.lane.tools and a strong judge assignment; resume fills lane.tools on an older run', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const runDir = await createResumableRunFixture({
      env,
      home,
      baselineWritten: false,
      withoutLaneTools: true,
      stubBackend: true,
    });
    const r = await runCli(['run', '--resume', runDir], { env });
    assert.ok(r.code === 0 || r.code === 1, `${r.code}: ${r.stdout}\n${r.stderr}`);
    const req = JSON.parse(await readFile(path.join(runDir, 'request.json'), 'utf8'));
    assert.deepEqual(req.lane.tools, ['Read', 'Grep', 'Glob']);
    assert.deepEqual(req.route.seatModels.judge, { backend: 'host', capability: 'strong' });
  } finally {
    await cleanup();
  }
});

test('a spawn run still records the discovery notes (G2-2 step 1, G2-10)', async () => {
  // Discovery is step 1 of the G2-2 order and runs whatever the route is, so the absence of the
  // swarm executable stays visible on a spawn run. A hermetic PATH is what makes it absent.
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
  const { env, home, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ files: { 'a.js': '1' } });
  try {
    await writeFile(path.join(repo.root, 'a.js'), '2');
    await writeStubBackend({ home });
    const r = await runCli(['run', '--route', 'spawn', '--backend', 'custom', '--allow-gaps'], {
      env,
      cwd: repo.root,
    });
    assert.ok(r.code === 0 || r.code === 1, `${r.code}: ${r.stdout}\n${r.stderr}`);
    const runs = await readdir(runsDir(env, repo.root));
    assert.equal(runs.length, 1, `one run directory expected, got ${runs.join(', ')}`);
    const req = JSON.parse(await readFile(path.join(runsDir(env, repo.root), runs[0], 'request.json'), 'utf8'));
    assert.ok(
      req.route.discovery.notes.some((n) => /opencode executable not found/.test(n)),
      `notes: ${JSON.stringify(req.route.discovery.notes)}`
    );
  } finally {
    await repo.cleanup();
    await cleanup();
    await bins.cleanup();
  }
});

// The lens seats of the `code` stage: these are the entries `research` looks for in the store.
const CODE_LENS_SEATS = ['breaker', 'edge', 'attacker', 'medic', 'tester'];

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

// The run directory a command just created, as the difference against the listing before it.
async function newRunDir(base, before) {
  const after = await readdir(base);
  const fresh = after.filter((d) => !before.includes(d));
  assert.equal(fresh.length, 1, `one new run directory expected, got ${fresh.join(', ')}`);
  return path.join(base, fresh[0]);
}

test('--route spawn builds no sandbox and calls no swarm model, with a non-empty pool', async () => {
  // The pool must be genuinely non-empty, or the route guard is not what the case measures: a
  // discoverable model plus --model puts it in the pool whatever its price.
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
  const { env, home, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ files: { 'a.js': '1' } });
  const log = path.join(bins.dir, 'calls.log');
  try {
    await writeSwarmBin({ dir: bins.dir, models: ['p/m1'], logFile: log });
    await writeFile(path.join(repo.root, 'a.js'), '2');
    await writeStubBackend({ home });

    const base = runsDir(env, repo.root);
    const before = await exists(base) ? await readdir(base) : [];
    // --keep-sandbox is what makes the absence of the tree proof: a sandbox built here would be
    // kept instead of deleted by the spawn cleanup, so the directory would still be on disk.
    const r = await runCli(
      ['run', '--route', 'spawn', '--model', 'p/m1', '--keep-sandbox', '--backend', 'custom', '--allow-gaps'],
      { env, cwd: repo.root }
    );
    assert.ok(r.code === 0 || r.code === 1, `${r.code}: ${r.stdout}\n${r.stderr}`);
    const runDir = await newRunDir(base, before);

    const req = JSON.parse(await readFile(path.join(runDir, 'request.json'), 'utf8'));
    assert.equal(await exists(path.join(runDir, 'sandbox')), false, 'a spawn run builds no sandbox tree');
    assert.equal(req.route.sandbox, null);

    const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    assert.ok(calls.length > 0, 'discovery must have reached the fake executable');
    assert.deepEqual(
      calls.filter((line) => /^run\b/.test(line)),
      [],
      `a spawn run calls no swarm model: ${JSON.stringify(calls)}`
    );

    // Last, because the case is vacuous without it: an empty pool skips the swarm steps whatever
    // the route, so the two assertions above would pass for the wrong reason.
    const notes = req.route.discovery.notes || [];
    assert.ok(
      !notes.some((n) => /swarm pool is empty/.test(n)),
      `the pool must not be empty for this case to mean anything: ${JSON.stringify(notes)}`
    );
    assert.ok(
      !notes.some((n) => /named model .* rejected/.test(n)),
      `p/m1 must reach the pool: ${JSON.stringify(notes)}`
    );
  } finally {
    await repo.cleanup();
    await cleanup();
    await bins.cleanup();
  }
});

test('a failed canary exits 3 and deletes the sandbox, or keeps it under --keep-sandbox', async () => {
  // One isolated environment per sub-case: the fake writes a canary target, so the two runs must
  // not share a state directory or a repository.
  // The fake answer is not a valid opencode event stream, so the probe reports bad-output. The
  // canary still runs, because the route is explicit and the canary gate reads the route and the
  // sandbox, not the seat assignment. Move that gate below the empty-seatModels check and this
  // case exits 2 instead.
  for (const keep of [false, true]) {
    const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
    const { env, home, cleanup } = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
    const repo = await makeTempRepo({ files: { 'a.js': '1' } });
    try {
      await writeSwarmBin({ dir: bins.dir, models: ['p/m1'], escapeSandbox: true });
      await seedModelStore({ home, model: 'p/m1', lenses: CODE_LENS_SEATS });
      await writeFile(path.join(repo.root, 'a.js'), '2');

      const base = runsDir(env, repo.root);
      const before = await exists(base) ? await readdir(base) : [];
      const args = ['run', '--route', 'swarm', '--model', 'p/m1', '--backend', 'claude', '--allow-gaps'];
      if (keep) args.push('--keep-sandbox');
      const r = await runCli(args, { env, cwd: repo.root });

      assert.equal(r.code, 3, `${r.code}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /wrote outside its sandbox/);
      const runDir = await newRunDir(base, before);
      assert.equal(
        await exists(path.join(runDir, 'sandbox')),
        keep,
        keep ? '--keep-sandbox keeps the tree of a failed canary' : 'a failed canary deletes the tree'
      );
    } finally {
      await repo.cleanup();
      await cleanup();
      await bins.cleanup();
    }
  }
});
