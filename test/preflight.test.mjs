import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  buildBundle,
  hashBundle,
  verifyBundle,
  applyAnswers,
  computeDataLeaves,
  decisionsFor,
} from '../skills/adversarial-review/scripts/lib/bundle.mjs';
import { preflightCommand } from '../skills/adversarial-review/scripts/lib/cli/preflight.mjs';
import { makeIsolatedEnv, makeTempRepo, makeFakeBins } from './helpers/isolated-env.mjs';
import { runCli } from './helpers/run-cli.mjs';
import { writeStubBackend, writeSwarmBin, seedModelStore } from './helpers/run-fixture.mjs';

const seatModels = {
  edge: {
    model: 'opencode/big-pickle',
    provider: 'opencode',
    trains: true,
    failover: [{ model: 'acme/x', provider: 'acme', trains: false }],
  },
  breaker: { model: 'opencode/ling', provider: 'opencode', trains: true, failover: [] },
};
const judge = { backend: 'claude', model: 'opus', provider: 'anthropic', trains: false };
const plan = {
  material: { kind: 'file', root: '/r', targetPath: '/r/a', hash: 'h1', files: 1, lines: 10 },
  stageName: 'code',
  chosen: [{ key: 'edge' }, { key: 'breaker' }],
  noSeat: [],
  routeDecision: { route: 'swarm', reason: 'quota', stages: { find: 'swarm', ruling: 'host' } },
  quota: { percent: 50 },
  seatModels,
  judge,
  discoveryErrors: [],
  hostAvailable: true,
  swarmAvailable: true,
  routeRequested: 'auto',
  discoveryCandidates: 3,
};
const quietConfig = { routeAsk: false };

function ioSink(env) {
  let out = '';
  let err = '';
  return {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

test('dataLeaves covers primaries, failovers, and the judge', () => {
  const rows = computeDataLeaves(seatModels, judge, false);
  assert.deepEqual(rows.map((r) => r.provider).sort(), ['acme', 'anthropic', 'opencode']);
  assert.equal(rows.find((r) => r.provider === 'opencode').trains, true);
  assert.equal(rows.find((r) => r.provider === 'acme').trains, false);
});

test('a missing trains field counts as training', () => {
  const rows = computeDataLeaves({ s: { model: 'p/m', provider: 'p', failover: [] } }, judge, false);
  assert.equal(rows.find((r) => r.provider === 'p').trains, true);
});

test('privacy decision appears unless acknowledged in user config', () => {
  const rows = computeDataLeaves(seatModels, judge, false);
  assert.ok(decisionsFor(plan, { routeAsk: false }, rows).some((d) => d.id === 'privacy'));
  assert.ok(!decisionsFor(plan, { routeAsk: false, swarm: { acknowledgeTraining: true } }, rows).some((d) => d.id === 'privacy'));
});

test('route decision appears only with routeAsk, both routes, and no --route flag', () => {
  const rows = computeDataLeaves(seatModels, judge, false);
  assert.ok(decisionsFor(plan, { routeAsk: true }, rows, {}).some((d) => d.id === 'route'));
  assert.ok(!decisionsFor(plan, { routeAsk: true }, rows, { route: 'swarm' }).some((d) => d.id === 'route'));
  assert.ok(!decisionsFor({ ...plan, swarmAvailable: false }, { routeAsk: true }, rows, {}).some((d) => d.id === 'route'));
});

test('discovery decision appears when --route swarm found no candidate', () => {
  const d = decisionsFor({ ...plan, routeRequested: 'swarm', discoveryCandidates: 0 }, quietConfig, [], { route: 'swarm' });
  assert.deepEqual(d.find((x) => x.id === 'discovery').options, ['spawn', 'stop']);
});

test('bundle hash covers answers; a hand edit is refused', () => {
  const b = buildBundle(plan, {}, { config: quietConfig, now: () => 0 });
  verifyBundle(b);
  assert.equal(b.bundleHash, hashBundle(b));
  assert.equal(b.version, 1);
  assert.equal(b.estimateSec, 600);
  const edited = { ...b, seats: ['edge'] };
  assert.throws(() => verifyBundle(edited), /bundleHash/);
});

test('privacy=decline removes every training model; a seat with none moves to the host', () => {
  const b = buildBundle(plan, {}, { config: quietConfig, now: () => 0 });
  const a = applyAnswers(b, { privacy: 'decline' });
  verifyBundle(a);
  assert.equal(a.answeredFrom, b.bundleHash);
  assert.notEqual(a.bundleHash, b.bundleHash);
  assert.equal(a.seatModels.edge.model, 'acme/x');
  assert.deepEqual(a.seatModels.edge.failover, []);
  assert.equal(a.seatModels.breaker, undefined, 'a seat with no approved model runs on the host');
  assert.ok(a.dataLeaves.every((r) => r.trains !== true));
});

test('privacy=decline turns the sift off', () => {
  const b = buildBundle({ ...plan, siftOn: true }, {}, { config: quietConfig, now: () => 0 });
  assert.ok(b.dataLeaves.some((r) => r.provider === 'jev'));
  const a = applyAnswers(b, { privacy: 'decline' });
  assert.equal(a.sift.enabled, false);
  assert.ok(!a.dataLeaves.some((r) => r.provider === 'jev'));
});

test('privacy=decline with no swarm model left moves the route to spawn', () => {
  const only = { breaker: seatModels.breaker };
  const b = buildBundle({ ...plan, chosen: [{ key: 'breaker' }], seatModels: only }, {}, { config: quietConfig, now: () => 0 });
  const a = applyAnswers(b, { privacy: 'decline' });
  assert.equal(a.route.route, 'spawn');
  assert.deepEqual(a.seatModels, {});
  assert.ok(Object.values(a.route.stages).every((v) => v === 'host'));
});

test('applyAnswers refuses a missing or unknown answer', () => {
  const b = buildBundle(plan, {}, { config: quietConfig, now: () => 0 });
  assert.throws(() => applyAnswers(b, {}), /privacy/);
  assert.throws(() => applyAnswers(b, { privacy: 'maybe' }), /privacy/);
  assert.throws(() => applyAnswers(b, { privacy: 'accept', nope: 'x' }), /nope/);
});

test('--answer with a second =, an empty side, or an unknown id exits 2', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  try {
    const bundlePath = path.join(home, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(buildBundle(plan, {}, { config: quietConfig, now: () => 0 })));
    for (const bad of ['privacy=a=b', 'nope=accept', '=accept', 'privacy=']) {
      const io = ioSink(env);
      const code = await preflightCommand({ 'answer-bundle': bundlePath, answer: [bad] }, [], io);
      assert.equal(code, 2, bad);
    }
    const io = ioSink(env);
    assert.equal(await preflightCommand({ 'answer-bundle': bundlePath, answer: ['privacy=decline'] }, [], io), 0, io.err);
    const answered = JSON.parse(await readFile(io.out.trim(), 'utf8'));
    assert.deepEqual(answered.answers, { privacy: 'decline' });
  } finally {
    await cleanup();
  }
});

// The CLI half runs the real command in its own process, with the fake custom host backend.
async function setupRepo() {
  const bins = await makeFakeBins({});
  const iso = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ git: true, files: { 'index.js': 'console.log("a");\n' } });
  await writeFile(path.join(repo.root, 'index.js'), 'console.log("b");\n');
  await writeStubBackend({ home: iso.home });
  return {
    iso,
    repo,
    cleanup: async () => {
      await repo.cleanup();
      await iso.cleanup();
      await bins.cleanup();
    },
  };
}

test('preflight --json writes a bundle, starts no seat, and refuses an existing --out', async () => {
  const { iso, repo, cleanup } = await setupRepo();
  try {
    const r = await runCli(['preflight', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--json'], {
      env: iso.env,
      cwd: repo.root,
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(existsSync(out.path));
    assert.deepEqual(out.bundle.decisions, []);
    assert.equal(out.bundle.bundleHash, JSON.parse(await readFile(out.path, 'utf8')).bundleHash);
    assert.equal(existsSync(path.join(iso.home, '.adversarial-review', 'runs')), false, 'preflight creates no run');
    const again = await runCli(['preflight', '--route', 'spawn', '--backend', 'custom', '--out', out.path], {
      env: iso.env,
      cwd: repo.root,
    });
    assert.equal(again.code, 2, again.stderr);
  } finally {
    await cleanup();
  }
});

test('preflight and a plain run warn about a large material and do not block', async () => {
  const { iso, repo, cleanup } = await setupRepo();
  try {
    const { mkdir } = await import('node:fs/promises');
    for (const dir of ['api', 'web']) {
      await mkdir(path.join(repo.root, dir));
      for (let i = 0; i < 16; i++) await writeFile(path.join(repo.root, dir, `f${i}.js`), dir === 'api' ? 'a\nb\n' : 'c\n');
    }
    const pre = await runCli(['preflight', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--json'], { env: iso.env, cwd: repo.root });
    assert.equal(pre.code, 0, pre.stderr);
    const { bundle } = JSON.parse(pre.stdout);
    assert.equal(bundle.warnings.length, 1);
    assert.match(bundle.warnings[0], /in 33 files .*Run one table per subsystem: api 32 lines, web 16 lines, \. 2 lines\.$/);
    assert.match(pre.stderr, /Warning: The material is large/);
    const run = await runCli(['run', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--until', 'find'], { env: iso.env, cwd: repo.root });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /Warning: The material is large/);
  } finally {
    await cleanup();
  }
});

test('run --from-preflight: unanswered exits 2, drift exits 2, an answered bundle is the request', async () => {
  const { iso, repo, cleanup } = await setupRepo();
  try {
    const pre = await runCli(['preflight', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--until', 'find', '--json'], {
      env: iso.env,
      cwd: repo.root,
    });
    assert.equal(pre.code, 0, pre.stderr);
    const { path: bundlePath, bundle } = JSON.parse(pre.stdout);

    // A hand-made open decision: the hash is recomputed, so only the missing answer refuses it.
    const open = { ...bundle, decisions: [{ id: 'privacy', question: 'q', recommended: 'accept', options: ['accept', 'decline'] }] };
    delete open.bundleHash;
    const { hashBundle: hb } = await import('../skills/adversarial-review/scripts/lib/bundle.mjs');
    open.bundleHash = hb(open);
    const openPath = path.join(iso.home, 'open.json');
    await writeFile(openPath, JSON.stringify(open));
    const r1 = await runCli(['run', '--from-preflight', openPath], { env: iso.env, cwd: repo.root });
    assert.equal(r1.code, 2, r1.stderr);
    assert.match(r1.stderr, /answer the decisions first/);

    const flagged = await runCli(['run', '--from-preflight', bundlePath, '--seats', 'edge'], { env: iso.env, cwd: repo.root });
    assert.equal(flagged.code, 2, flagged.stderr);

    const r3 = await runCli(['run', '--from-preflight', bundlePath, '--json'], { env: iso.env, cwd: repo.root });
    assert.equal(r3.code, 0, r3.stderr);
    const runsBase = path.join(iso.home, '.adversarial-review', 'runs');
    const repoDir = (await readdir(runsBase))[0];
    const runDir = path.join(runsBase, repoDir, (await readdir(path.join(runsBase, repoDir)))[0]);
    const req = JSON.parse(await readFile(path.join(runDir, 'request.json'), 'utf8'));
    assert.equal(req.approval.source, 'preflight');
    assert.equal(req.approval.bundleHash, bundle.bundleHash);
    assert.deepEqual(req.approval.dataLeaves, bundle.dataLeaves);
    assert.deepEqual(req.seats, bundle.seats);
    assert.ok(req.seats.includes('breaker'));
    assert.equal(req.until, 'find');

    await writeFile(path.join(repo.root, 'index.js'), 'console.log("c");\n');
    const r2 = await runCli(['run', '--from-preflight', bundlePath], { env: iso.env, cwd: repo.root });
    assert.equal(r2.code, 2, r2.stderr);
    assert.match(r2.stderr, /material changed since preflight/);
  } finally {
    await cleanup();
  }
});

test('privacy=decline through the CLI: no lane call reaches the swarm and every seat runs on the host', async () => {
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
  const iso = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ git: true, files: { 'index.js': 'console.log("a");\n' } });
  const log = path.join(bins.dir, 'calls.log');
  try {
    await writeFile(path.join(repo.root, 'index.js'), 'console.log("b");\n');
    await writeSwarmBin({ dir: bins.dir, models: ['p/m1'], logFile: log });
    await seedModelStore({ home: iso.home, model: 'p/m1', lenses: ['breaker'], acknowledgeTraining: false });
    await writeStubBackend({ home: iso.home });
    const pre = await runCli(
      ['preflight', '--route', 'swarm', '--model', 'p/m1', '--backend', 'custom', '--seats', 'breaker', '--json'],
      { env: iso.env, cwd: repo.root }
    );
    assert.equal(pre.code, 0, pre.stderr);
    const { path: bundlePath, bundle } = JSON.parse(pre.stdout);
    assert.equal(bundle.seatModels.breaker.model, 'p/m1');
    assert.deepEqual(bundle.decisions.map((d) => d.id), ['privacy']);

    const ans = await runCli(['preflight', '--answer-bundle', bundlePath, '--answer', 'privacy=decline'], { env: iso.env, cwd: repo.root });
    assert.equal(ans.code, 0, ans.stderr);
    const answeredPath = ans.stdout.trim();

    const r = await runCli(['run', '--from-preflight', answeredPath, '--detach'], { env: iso.env, cwd: repo.root });
    assert.equal(r.code, 0, r.stderr);
    const runDir = r.stdout.trim();
    const start = Date.now();
    while (!existsSync(path.join(runDir, 'result.json')) && Date.now() - start < 30000) {
      await new Promise((res) => setTimeout(res, 200));
    }
    // The detached owner records its exit sweep last; wait for it so the temp home can go.
    let events = [];
    while (Date.now() - start < 40000) {
      events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (events.some((e) => e.event === 'cleanup')) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    await new Promise((res) => setTimeout(res, 500));
    const starts = events.filter((e) => e.event === 'call_start');
    assert.ok(starts.length > 0);
    assert.ok(starts.every((e) => e.model !== 'p/m1'), JSON.stringify(starts));
    const req = JSON.parse(await readFile(path.join(runDir, 'request.json'), 'utf8'));
    assert.equal(req.sift.enabled, false);
    assert.ok(req.approval.dataLeaves.every((row) => row.trains !== true));
    const laneCalls = (await readFile(log, 'utf8')).split('\n').filter((l) => /^run\b/.test(l));
    assert.deepEqual(laneCalls, [], 'no lane call reached the swarm executable');
  } finally {
    await repo.cleanup();
    await iso.cleanup();
    await bins.cleanup();
  }
});

// Both routes are open and training is not acknowledged; only the quota moves the recommendation.
async function plainRunWithBothRoutes(quotaPercent) {
  const bins = await makeFakeBins({});
  const iso = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv, ADVERSARIAL_REVIEW_QUOTA_PERCENT: String(quotaPercent) });
  const repo = await makeTempRepo({ git: true, files: { 'index.js': 'console.log("a");\n' } });
  try {
    await writeFile(path.join(repo.root, 'index.js'), 'console.log("b");\n');
    await writeSwarmBin({ dir: bins.dir, models: ['p/m1'] });
    await seedModelStore({ home: iso.home, model: 'p/m1', lenses: ['breaker'], acknowledgeTraining: false });
    await writeStubBackend({ home: iso.home });
    const r = await runCli(['run', '--model', 'p/m1', '--backend', 'custom', '--seats', 'breaker', '--until', 'find'], { env: iso.env, cwd: repo.root });
    return { r, ran: existsSync(path.join(iso.home, '.adversarial-review', 'runs')) };
  } finally {
    await repo.cleanup();
    await iso.cleanup();
    await bins.cleanup();
  }
}

test('a plain run with no --route takes the recommended spawn route and asks nothing', async () => {
  const { r, ran } = await plainRunWithBothRoutes(10);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /answer the decisions first/);
  assert.equal(ran, true);
});

test('a plain run whose recommended route is the swarm stops on the privacy decision only', async () => {
  const { r, ran } = await plainRunWithBothRoutes(90);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /answer the decisions first/);
  assert.match(r.stderr, /privacy: .*swarm\.acknowledgeTraining/);
  assert.doesNotMatch(r.stderr, /route: /);
  assert.equal(ran, false);
});

test('run --from-preflight --allow-drift --detach finishes on changed material', async () => {
  const { iso, repo, cleanup } = await setupRepo();
  try {
    const pre = await runCli(['preflight', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--until', 'find', '--json'], {
      env: iso.env,
      cwd: repo.root,
    });
    assert.equal(pre.code, 0, pre.stderr);
    const { path: bundlePath } = JSON.parse(pre.stdout);
    await writeFile(path.join(repo.root, 'index.js'), 'console.log("drifted");\n');
    const r = await runCli(['run', '--from-preflight', bundlePath, '--allow-drift', '--detach'], { env: iso.env, cwd: repo.root });
    assert.equal(r.code, 0, r.stderr);
    const runDir = r.stdout.trim();
    const req = JSON.parse(await readFile(path.join(runDir, 'request.json'), 'utf8'));
    assert.equal(req.allowDrift, true);
    // The detached owner stops at FIND and records its exit sweep last.
    const start = Date.now();
    let done = false;
    while (!done && Date.now() - start < 30000) {
      const text = existsSync(path.join(runDir, 'events.jsonl')) ? await readFile(path.join(runDir, 'events.jsonl'), 'utf8') : '';
      done = text.includes('"cleanup"');
      if (!done) await new Promise((res) => setTimeout(res, 200));
    }
    await new Promise((res) => setTimeout(res, 500));
    const events = (await readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const end = events.filter((e) => e.event !== 'cleanup').at(-1);
    assert.equal(end.event, 'run_end', JSON.stringify(events.slice(-3)));
    assert.equal(end.stopped, 'until-find');
  } finally {
    await cleanup();
  }
});
