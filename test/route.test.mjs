import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, STAGE_NAMES } from '../skills/adversarial-review/scripts/lib/route.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';

test('route module', async (t) => {
  await t.test('exports STAGE_NAMES with all 9 stages', () => {
    assert.deepEqual(STAGE_NAMES, [
      'find',
      'table',
      'dispute',
      'lastcall',
      'patchSeats',
      'verifySeats',
      'ruling',
      'patchJudge',
      'verifyJudge',
    ]);
  });

  await t.test('Rule 1: swarm unavailable when backend does not resolve', () => {
    const res = decideRoute({
      host: { available: true },
      swarm: { available: false, detail: 'opencode binary not found' },
    });
    assert.equal(res.route, 'spawn');
    assert.ok(res.reason.startsWith('swarm-unavailable:'));
    assert.ok(res.reason.includes('opencode binary not found'));
    assert.equal(res.stages.find, 'host');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('Rule 1: swarm unavailable when catalog finds no callable model', () => {
    const res = decideRoute({
      host: { available: true },
      swarm: { available: true, model: null, detail: 'no callable model in catalog' },
    });
    assert.equal(res.route, 'spawn');
    assert.ok(res.reason.startsWith('swarm-unavailable:'));
    assert.equal(res.stages.find, 'host');
  });

  await t.test('Rule 1: swarm unavailable when swarm model free with allowFree:false', () => {
    const res = decideRoute({
      config: { swarm: { allowFree: false } },
      host: { available: true },
      swarm: { available: true, model: 'test/free-model', free: true },
    });
    assert.equal(res.route, 'spawn');
    assert.ok(res.reason.startsWith('swarm-unavailable'));
    assert.equal(res.stages.find, 'host');
  });

  await t.test('Rule 1 does not match if model is free but allowFree is true', () => {
    const res = decideRoute({
      config: { swarm: { allowFree: true } },
      host: { available: true },
      swarm: { available: true, model: 'test/free-model', free: true },
      quota: { percent: 90 },
    });
    assert.equal(res.route, 'swarm');
    assert.equal(res.reason, 'quota 90% >= 80%');
  });

  await t.test('Rules 1 and 2: both host and swarm unavailable throws ConfigError naming doctor', () => {
    assert.throws(
      () => {
        decideRoute({
          host: { available: false },
          swarm: { available: false, detail: 'opencode missing' },
        });
      },
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.exitCode, 2);
        assert.ok(err.message.includes('doctor'));
        return true;
      }
    );

    assert.throws(
      () => {
        decideRoute({
          host: { available: false },
          swarm: { available: true, model: null },
        });
      },
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.includes('doctor'));
        return true;
      }
    );
  });

  await t.test('Rule 2: host unavailable -> swarm with stages.ruling === swarm', () => {
    const res = decideRoute({
      host: { available: false },
      swarm: { available: true, model: 'test/model', free: false },
    });
    assert.equal(res.route, 'swarm');
    assert.equal(res.reason, 'host-unavailable');
    assert.equal(res.stages.find, 'swarm');
    assert.equal(res.stages.table, 'swarm');
    assert.equal(res.stages.dispute, 'swarm');
    assert.equal(res.stages.lastcall, 'swarm');
    assert.equal(res.stages.patchSeats, 'swarm');
    assert.equal(res.stages.verifySeats, 'swarm');
    assert.equal(res.stages.ruling, 'swarm');
    assert.equal(res.stages.patchJudge, 'swarm');
    assert.equal(res.stages.verifyJudge, 'swarm');
  });

  await t.test('Rule 3: quota percent known and >= threshold (including 83 >= 80 and 0 >= 0)', () => {
    const res83 = decideRoute({
      config: { quota: { threshold: 80 } },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
      quota: { percent: 83 },
    });
    assert.equal(res83.route, 'swarm');
    assert.equal(res83.reason, 'quota 83% >= 80%');
    assert.equal(res83.stages.find, 'swarm');
    assert.equal(res83.stages.table, 'swarm');
    assert.equal(res83.stages.ruling, 'host'); // Judge kept on host per §19.1

    const res0 = decideRoute({
      config: { quota: { threshold: 0 } },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
      quota: { percent: 0 },
    });
    assert.equal(res0.route, 'swarm');
    assert.equal(res0.reason, 'quota 0% >= 0%');

    const res80 = decideRoute({
      config: { quota: { threshold: 80 } },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
      quota: { percent: 80 },
    });
    assert.equal(res80.route, 'swarm');
    assert.equal(res80.reason, 'quota 80% >= 80%');
  });

  await t.test('Rule 4: wide material -> find swarm and table host', () => {
    const resFiles = decideRoute({
      config: { swarm: { wideFiles: 30, wideLines: 5000 } },
      material: { files: 31, lines: 100 },
      quota: { percent: 50 },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(resFiles.route, 'spawn');
    assert.equal(resFiles.reason, 'wide material: 31 files, 100 lines');
    assert.equal(resFiles.stages.find, 'swarm');
    assert.equal(resFiles.stages.table, 'host');
    assert.equal(resFiles.stages.dispute, 'host');
    assert.equal(resFiles.stages.lastcall, 'host');
    assert.equal(resFiles.stages.patchSeats, 'host');
    assert.equal(resFiles.stages.verifySeats, 'host');
    assert.equal(resFiles.stages.ruling, 'host');
    assert.equal(resFiles.stages.patchJudge, 'host');
    assert.equal(resFiles.stages.verifyJudge, 'host');

    const resLines = decideRoute({
      config: { swarm: { wideFiles: 30, wideLines: 5000 } },
      material: { files: 5, lines: 5001 },
      quota: { percent: 50 },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(resLines.route, 'spawn');
    assert.equal(resLines.reason, 'wide material: 5 files, 5001 lines');
    assert.equal(resLines.stages.find, 'swarm');
    assert.equal(resLines.stages.table, 'host');
  });

  await t.test('Rule 4: wide material with quota unknown ends with (quota unknown)', () => {
    const res = decideRoute({
      material: { files: 40, lines: 1000 },
      quota: { percent: null },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'spawn');
    assert.equal(res.reason, 'wide material: 40 files, 1000 lines (quota unknown)');
    assert.equal(res.stages.find, 'swarm');
    assert.equal(res.stages.table, 'host');
  });

  await t.test('Rule 5: default otherwise with known quota under threshold', () => {
    const res = decideRoute({
      material: { files: 10, lines: 500 },
      quota: { percent: 45 },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'spawn');
    assert.equal(res.reason, 'default');
    assert.equal(res.stages.find, 'host');
    assert.equal(res.stages.table, 'host');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('Rule 5: default otherwise with quota unknown ends with (quota unknown)', () => {
    const res = decideRoute({
      material: { files: 10, lines: 500 },
      quota: { percent: null },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'spawn');
    assert.equal(res.reason, 'default (quota unknown)');
    assert.equal(res.stages.find, 'host');
    assert.equal(res.stages.table, 'host');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('Explicit route spawn', () => {
    const res = decideRoute({
      flags: { route: 'spawn' },
      material: { files: 100, lines: 50000 },
      quota: { percent: 99 },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'spawn');
    assert.equal(res.stages.find, 'host');
    assert.equal(res.stages.table, 'host');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('Explicit route swarm', () => {
    const res = decideRoute({
      flags: { route: 'swarm' },
      material: { files: 1, lines: 10 },
      quota: { percent: 10 },
      host: { available: true },
      swarm: { available: true, model: 'test/model', free: true },
    });
    assert.equal(res.route, 'swarm');
    assert.equal(res.stages.find, 'swarm');
    assert.equal(res.stages.table, 'swarm');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('Explicit route swarm with host unavailable puts judge on swarm', () => {
    const res = decideRoute({
      flags: { route: 'swarm' },
      host: { available: false },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'swarm');
    assert.equal(res.stages.find, 'swarm');
    assert.equal(res.stages.ruling, 'swarm');
    assert.equal(res.stages.patchJudge, 'swarm');
    assert.equal(res.stages.verifyJudge, 'swarm');
  });

  await t.test('Invalid route flag throws ConfigError', () => {
    assert.throws(
      () => {
        decideRoute({ flags: { route: 'invalid-route' } });
      },
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.exitCode, 2);
        return true;
      }
    );
  });

  await t.test('config.stages overrides per stage: config.stages.find.backend=opencode', () => {
    const res = decideRoute({
      flags: { route: 'spawn' },
      config: {
        stages: {
          find: { backend: 'opencode' },
        },
      },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.route, 'spawn');
    assert.equal(res.stages.find, 'opencode');
    assert.equal(res.stages.table, 'host');
    assert.equal(res.stages.ruling, 'host');
  });

  await t.test('config.stages.ruling.backend overrides judge stages when not individually configured', () => {
    const res = decideRoute({
      flags: { route: 'spawn' },
      config: {
        stages: {
          ruling: { backend: 'custom-judge' },
          patchJudge: { backend: 'patch-custom' },
        },
      },
      host: { available: true },
      swarm: { available: true, model: 'test/model' },
    });
    assert.equal(res.stages.ruling, 'custom-judge');
    assert.equal(res.stages.patchJudge, 'patch-custom');
    assert.equal(res.stages.verifyJudge, 'custom-judge'); // Inherited from stages.ruling.backend
  });
});
