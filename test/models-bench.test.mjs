import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeBenchCallFor } from '../skills/adversarial-review/scripts/lib/cli/models.mjs';

test('bench runs the lens seat FIND on its own fixture, with the FIND timeout', async () => {
  let seen;
  const benchCallFor = makeBenchCallFor({
    config: { timeouts: { find: 1200000 } },
    env: process.env,
    runSeatCall: async (call) => { seen = call; return { ok: true, value: { findings: [] } }; },
  });
  await benchCallFor('breaker')('a/b');
  assert.match(seen.prompt, /Stage: FIND/);
  assert.match(seen.prompt, /rt-breaker|Breaker/);
  assert.ok(
    seen.prompt.includes(path.join('lenses', 'breaker', 'material.js')),
    'prompt names the lens fixture file'
  );
  assert.equal(seen.timeoutMs, 1200000);
  assert.equal(path.basename(seen.root), 'breaker');
  assert.equal(seen.model, 'a/b');
});

test('bench builds the prompt with the swarm lane tools and a weak seat', async () => {
  let ctx;
  const benchCallFor = makeBenchCallFor({
    config: {},
    env: process.env,
    runSeatCall: async () => ({ ok: true, value: { findings: [] } }),
    buildPrompt: (stage, c) => { ctx = { stage, ...c }; return 'prompt'; },
  });
  await benchCallFor('historian')('a/b');
  assert.equal(ctx.stage, 'FIND');
  assert.deepEqual(ctx.tools, ['read', 'glob', 'grep']);
  assert.equal(ctx.seat.capability, 'weak');
  assert.equal(ctx.seat.key, 'historian');
  assert.equal(ctx.reviewStage, 'spec');
  assert.ok(ctx.materialPath.endsWith('material.md'));
});

test('bench scores each lens; a failure that is not a refusal is unmeasured', async () => {
  const { bench } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  const benchCallFor = (lens) => async (model) => {
    if (lens === 'attacker') return { ok: false, errorType: 'rate-limited' };
    if (lens === 'medic') return { ok: false, errorType: 'provider-refused' };
    return { ok: true, value: { findings: [] } };
  };
  const r = await bench({ models: ['m'], lenses: ['edge', 'attacker', 'medic'], benchCallFor, deadlineMs: 1000 });
  assert.equal(r.m.edge.tier, 'unusable');
  assert.equal(r.m.attacker.tier, 'unmeasured');
  assert.equal(r.m.medic.tier, 'unusable');
});

test('bench scores a model that finds every seeded defect as top', async () => {
  const { bench, loadLensKey } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  const key = await loadLensKey('edge');
  const findings = key.map((d) => ({ title: d.keywords[0], line: String(d.lines[0]) }));
  const benchCallFor = () => async () => ({ ok: true, value: { findings } });
  const r = await bench({ models: ['m'], lenses: ['edge'], benchCallFor, deadlineMs: 1000 });
  assert.equal(r.m.edge.score, key.length);
  assert.equal(r.m.edge.invented, 0);
  assert.equal(r.m.edge.tier, 'top');
});

test('research rejects only an explicit tool_call false; a missing models.dev entry goes on to the probe', async () => {
  const { research } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  const deps = { probeLane: async () => ({ ok: true, value: { ok: true }, costComplete: false }), benchCallFor: () => async () => ({ ok: true, value: { findings: [] } }) };
  const rejected = await research('p/m', { seats: ['edge'], prior: new Map([['p/m', { toolCall: false }]]), store: {}, deadlineMs: 1000, ...deps });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reasons[0], /tool calls/);
  const unknown = await research('p/x', { seats: ['edge'], prior: new Map(), store: {}, deadlineMs: 1000, ...deps });
  assert.equal(unknown.accepted, true);
  assert.ok('edge' in unknown.lenses);
});

test('research reuses a stored lens younger than 7 days', async () => {
  const { research } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  let benched = 0;
  const store = { 'opencode:p/m': { lenses: { edge: 'top' }, lensMeasuredAt: { edge: Date.now() } } };
  const r = await research('p/m', { seats: ['edge'], prior: new Map(), store, deadlineMs: 1000, probeLane: async () => ({ ok: true, value: { ok: true } }), benchCallFor: () => async () => { benched++; return { ok: true, value: { findings: [] } }; } });
  assert.equal(benched, 0);
  assert.equal(r.lenses.edge, 'top');
  // The caller stamps `lensMeasuredAt` from this list, so a reused lens must not appear in it.
  assert.deepEqual(r.benched, []);
});

test('research re-benches a stored lens older than 7 days and reports a failed probe', async () => {
  const { research } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  let benched = 0;
  const old = Date.now() - 8 * 86400000;
  const store = { 'opencode:p/m': { lenses: { edge: 'top' }, lensMeasuredAt: { edge: old } } };
  const stale = await research('p/m', {
    seats: ['edge'], prior: new Map(), store, deadlineMs: 1000,
    probeLane: async () => ({ ok: true, value: { ok: true } }),
    benchCallFor: () => async () => { benched++; return { ok: true, value: { findings: [] } }; },
  });
  assert.equal(benched, 1);
  assert.equal(stale.lenses.edge, 'unusable');
  assert.deepEqual(stale.seats, []);
  assert.deepEqual(stale.benched, ['edge']);

  const dead = await research('p/m', {
    seats: ['edge'], prior: new Map(), store: {}, deadlineMs: 1000,
    probeLane: async () => ({ ok: false, errorType: 'not-found' }),
    benchCallFor: () => async () => { throw new Error('bench must not run'); },
  });
  assert.equal(dead.accepted, false);
  assert.match(dead.reasons[0], /probe failed: not-found/);
  assert.deepEqual(dead.benched, []);
});

test('models research stores the measured lens tiers and keeps the timestamps of the others', async () => {
  const { modelsCommand } = await import('../skills/adversarial-review/scripts/lib/cli/models.mjs');
  const { makeIsolatedEnv } = await import('./helpers/isolated-env.mjs');
  const { readStore, updateStore } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  const iso = await makeIsolatedEnv();
  let out = '';
  const io = { stdout: { write: (c) => { out += c; } }, stderr: { write: () => {} } };
  try {
    const dir = path.join(iso.home, '.adversarial-review');
    await fs.mkdir(dir, { recursive: true });
    const kept = Date.now() - 1000;
    await updateStore(dir, (cur) => {
      cur['opencode:p/m'] = { lenses: { tester: 'light' }, lensMeasuredAt: { tester: kept } };
      return cur;
    });

    const key = JSON.parse(await fs.readFile(
      path.join('skills', 'adversarial-review', 'bench', 'lenses', 'edge', 'answer-key.json'), 'utf8'));
    const code = await modelsCommand({ seats: 'edge,breaker' }, ['research', 'p/m'], {
      env: iso.env,
      probeCall: async () => ({ ok: true, value: { ok: true }, latencyMs: 12 }),
      benchCall: async ({ lens }) => ({
        ok: true,
        value: { findings: lens === 'edge' ? key.map((d) => ({ title: d.keywords[0], line: String(d.lines[0]) })) : [] },
      }),
      ...io,
    });

    assert.equal(code, 0);
    assert.match(out, /Research for p\/m: accepted/);
    assert.match(out, /seats: edge/);
    const stored = (await readStore(dir))['opencode:p/m'];
    assert.equal(stored.lenses.edge, 'top');
    assert.equal(stored.lenses.breaker, 'unusable');
    assert.equal(stored.callable, true);
    assert.equal(stored.lensMeasuredAt.tester, kept, 'an unmeasured lens keeps its own timestamp');
    assert.ok(stored.lensMeasuredAt.edge > kept);
  } finally {
    await iso.cleanup();
  }
});

// The 7-day window only means something if a reused lens keeps its original timestamp. A run that
// re-stamped every requested lens would let a weekly `models research` keep a score alive forever.
test('models research keeps the timestamp of a requested lens it reused instead of benching', async () => {
  const { modelsCommand } = await import('../skills/adversarial-review/scripts/lib/cli/models.mjs');
  const { makeIsolatedEnv } = await import('./helpers/isolated-env.mjs');
  const { readStore, updateStore } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
  const iso = await makeIsolatedEnv();
  const io = { stdout: { write: () => {} }, stderr: { write: () => {} } };
  try {
    const dir = path.join(iso.home, '.adversarial-review');
    await fs.mkdir(dir, { recursive: true });
    const kept = Date.now() - 1000;
    await updateStore(dir, (cur) => {
      cur['opencode:p/m'] = { lenses: { edge: 'top' }, lensMeasuredAt: { edge: kept } };
      return cur;
    });

    const lensesBenched = [];
    const code = await modelsCommand({ seats: 'edge,breaker' }, ['research', 'p/m'], {
      env: iso.env,
      probeCall: async () => ({ ok: true, value: { ok: true }, latencyMs: 12 }),
      benchCall: async ({ lens }) => {
        lensesBenched.push(lens);
        return { ok: true, value: { findings: [] } };
      },
      ...io,
    });

    assert.equal(code, 0);
    assert.deepEqual(lensesBenched, ['breaker'], 'a fresh lens is not benched again');
    const stored = (await readStore(dir))['opencode:p/m'];
    assert.equal(stored.lenses.edge, 'top');
    assert.equal(stored.lensMeasuredAt.edge, kept, 'a reused lens keeps its original timestamp');
    assert.ok(stored.lensMeasuredAt.breaker > kept, 'the benched lens gets a new timestamp');
  } finally {
    await iso.cleanup();
  }
});

test('models research without a model argument is a usage error', async () => {
  const { modelsCommand } = await import('../skills/adversarial-review/scripts/lib/cli/models.mjs');
  const { makeIsolatedEnv } = await import('./helpers/isolated-env.mjs');
  const iso = await makeIsolatedEnv();
  let err = '';
  try {
    const code = await modelsCommand({}, ['research'], {
      env: iso.env,
      stdout: { write: () => {} },
      stderr: { write: (c) => { err += c; } },
    });
    assert.equal(code, 2);
    assert.match(err, /usage: adversarial-review models research/);
  } finally {
    await iso.cleanup();
  }
});

test('makeLaneCall hands runSeatCall the profile cwd, the lane mode, and a safe call id', async () => {
  const { makeLaneCall } = await import('../skills/adversarial-review/scripts/lib/lane.mjs');
  const { makeIsolatedEnv } = await import('./helpers/isolated-env.mjs');
  const iso = await makeIsolatedEnv();
  let seen;
  try {
    const runDir = path.join(iso.home, 'run');
    const cwd = path.join(runDir, 'sandbox', 'profiles', 'bench-edge');
    const lane = makeLaneCall({
      config: { a: 1 },
      env: iso.env,
      runDir,
      cwd,
      stage: 'FIND',
      prompt: 'find',
      schema: { type: 'object' },
      callIdPrefix: 'bench-edge',
      runSeatCall: async (call, options) => { seen = { call, options }; return { ok: true }; },
    });
    const res = await lane('opencode/zen-x');

    assert.deepEqual(res, { ok: true });
    assert.equal(seen.call.callId, 'bench-edge-opencode_zen-x');
    assert.equal(seen.call.cwd, cwd);
    assert.equal(seen.call.root, cwd);
    assert.equal(seen.call.runDir, runDir);
    assert.equal(seen.call.timeoutMs, 90000);
    assert.deepEqual(seen.call.lane, { mode: 'zen', cwd, xdgHome: undefined, stage: 'FIND' });
    assert.equal(seen.options.backend, 'opencode');
    assert.deepEqual(seen.options.config, { a: 1 });
    // The lane writes its transcript under runDir/calls, so the directory must exist first.
    await fs.access(path.join(runDir, 'calls'));
  } finally {
    await iso.cleanup();
  }
});
