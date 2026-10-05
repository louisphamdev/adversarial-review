import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStageTarget, routeKeyOf, buildSeatObjects } from '../skills/adversarial-review/scripts/lib/cli/run.mjs';

const base = {
  hostBackend: 'claude',
  swarmBackend: 'opencode',
  config: { stages: {} },
  seatModels: { breaker: { model: 'opencode/m1', capability: 'strong' } },
};

test('routeKeyOf maps every pipeline stage to its route key', () => {
  assert.equal(routeKeyOf('FIND'), 'find');
  assert.equal(routeKeyOf('LASTCALL'), 'lastcall');
  assert.equal(routeKeyOf('RULING'), 'ruling');
  assert.equal(routeKeyOf('PATCH_SEAT'), 'patchSeats');
  assert.equal(routeKeyOf('PATCH_JUDGE'), 'patchJudge');
  assert.equal(routeKeyOf('VERIFY_SEAT'), 'verifySeats');
  assert.equal(routeKeyOf('VERIFY_JUDGE'), 'verifyJudge');
});

test('patch and verify seats follow the swarm route', () => {
  const stagesRoute = { patchSeats: 'swarm', verifyJudge: 'host' };
  const seat = { key: 'breaker', tier: 'strong' };
  assert.deepEqual(resolveStageTarget({ ...base, stagesRoute, stage: 'PATCH_SEAT', seat }), { backend: 'opencode', model: 'opencode/m1', routeKey: 'patchSeats' });
  assert.deepEqual(resolveStageTarget({ ...base, stagesRoute, stage: 'VERIFY_JUDGE', seat: { key: 'judge', tier: 'strong' } }), { backend: 'claude', model: 'opus', routeKey: 'verifyJudge', effort: 'high' });
});

test('a config model for the stage wins; a named backend passes through', () => {
  const config = { stages: { find: { model: 'x/y' } } };
  const r = resolveStageTarget({ ...base, config, stagesRoute: { find: 'opencode' }, stage: 'FIND', seat: { key: 'edge', tier: 'standard' } });
  assert.deepEqual(r, { backend: 'opencode', model: 'x/y', routeKey: 'find' });
});

test('claude seats get the tier model', () => {
  const r = resolveStageTarget({ ...base, stagesRoute: { table: 'host' }, stage: 'TABLE', seat: { key: 'edge', tier: 'standard' } });
  assert.deepEqual(r, { backend: 'claude', model: 'sonnet', routeKey: 'table', effort: 'medium' });
});

test('effort follows the tier for claude and codex, and only config for opencode', () => {
  const seat = { key: 'breaker', tier: 'strong' };
  assert.equal(resolveStageTarget({ ...base, stagesRoute: { find: 'host' }, stage: 'FIND', seat }).effort, 'high');
  assert.equal(resolveStageTarget({ ...base, hostBackend: 'codex', stagesRoute: { find: 'host' }, stage: 'FIND', seat: { key: 'edge', tier: 'light' } }).effort, 'low');
  assert.equal(resolveStageTarget({ ...base, stagesRoute: { find: 'swarm' }, stage: 'FIND', seat }).effort, undefined);
  const config = { stages: { find: { effort: 'max' } } };
  assert.equal(resolveStageTarget({ ...base, config, stagesRoute: { find: 'swarm' }, stage: 'FIND', seat }).effort, 'max');
});

test('a swarm stage takes the seat model', () => {
  const r = resolveStageTarget({ ...base, stagesRoute: { find: 'swarm' }, stage: 'FIND', seat: { key: 'breaker', tier: 'strong' } });
  assert.equal(r.backend, 'opencode');
  assert.equal(r.model, 'opencode/m1');
});

test('a seat missing from seatModels runs on the host with a warning', () => {
  const r = resolveStageTarget({ ...base, stagesRoute: { find: 'swarm' }, stage: 'FIND', seat: { key: 'edge', tier: 'standard' } });
  assert.equal(r.backend, 'claude');
  assert.match(r.warning, /edge/);
});

test('judge stages are always the host, whatever the route and config', () => {
  for (const stage of ['RULING', 'PATCH_JUDGE', 'VERIFY_JUDGE']) {
    const r = resolveStageTarget({
      ...base,
      config: { stages: { ruling: { backend: 'opencode' } } },
      stagesRoute: { ruling: 'swarm', patchJudge: 'swarm', verifyJudge: 'swarm' },
      stage,
      seat: { key: 'judge', tier: 'strong' },
    });
    assert.equal(r.backend, 'claude', stage);
  }
});

test('seat objects carry capability and, for a swarm FIND seat, the context pack', () => {
  const seatModels = {
    breaker: { model: 'opencode/m1', capability: 'strong' },
    edge: { model: 'opencode/m2', capability: 'weak' },
    judge: { backend: 'host', capability: 'strong' },
  };
  const objs = buildSeatObjects({ seatKeys: ['breaker', 'edge', 'tester'], seatModels, stagesRoute: { find: 'swarm' }, hostBackend: 'claude', packText: 'PACK' });
  const by = Object.fromEntries(objs.map((o) => [o.key, o]));
  assert.equal(by.breaker.capability, 'strong');
  assert.equal(by.edge.capability, 'weak');
  assert.equal(by.edge.contextPack, 'PACK');
  assert.equal(by.tester.capability, 'strong', 'a host seat on sonnet is strong');
  assert.equal(by.tester.contextPack, undefined, 'a host seat gets no pack');
  assert.ok(typeof by.edge.body === 'string' && by.edge.body.length > 0, 'the seat file body is kept');
});
