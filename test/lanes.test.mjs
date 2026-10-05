import test from 'node:test';
import assert from 'node:assert/strict';
import {
  laneCap,
  createLanePool,
  readMachine,
  laneProvider,
  laneOutcome,
} from '../skills/adversarial-review/scripts/lib/lanes.mjs';

const cfg = { lanes: { reserveRamMb: 2048, laneRamMb: 400 }, maxParallel: null };

test('spec example: 16 logical, 6 GB free, 400 MB per lane gives 10', () => {
  const r = laneCap({ machine: { freeRamMb: 6144, logicalCores: 16 }, config: cfg, callsReady: 12, providerState: { p: { cap: 12 } }, provider: 'p' });
  assert.equal(r.cap, 10);
  assert.equal(r.parts.ramCap, 10);
});

test('low RAM never gives 0 when work is ready', () => {
  const r = laneCap({ machine: { freeRamMb: 2560, logicalCores: 16 }, config: cfg, callsReady: 6, providerState: {}, provider: 'p' });
  assert.equal(r.cap, 1);
  assert.equal(laneCap({ machine: { freeRamMb: 100, logicalCores: 1 }, config: cfg, callsReady: 0, providerState: {}, provider: 'p' }).cap, 0);
});

test('maxParallel is an upper limit only; a non-positive value is ignored', () => {
  const m = { freeRamMb: 64000, logicalCores: 16 };
  assert.equal(laneCap({ machine: m, config: { ...cfg, maxParallel: 3 }, callsReady: 9, providerState: {}, provider: 'p' }).cap, 3);
  assert.equal(laneCap({ machine: m, config: { ...cfg, maxParallel: 0 }, callsReady: 9, providerState: {}, provider: 'p' }).cap, 9);
});

test('two rate limits cut a provider cap from 8 to 2, and 3 successes raise it by 1', async () => {
  const pool = createLanePool({ readMachine: () => ({ freeRamMb: 64000, logicalCores: 16 }), config: cfg, seatCount: 8 });
  let rel = await pool.acquire('p'); rel('rate-limited');
  rel = await pool.acquire('p'); rel('rate-limited');
  assert.equal(pool.snapshot().providers.p.cap, 2);
  for (let i = 0; i < 3; i++) { rel = await pool.acquire('p'); rel('ok'); }
  assert.equal(pool.snapshot().providers.p.cap, 3);
});

test('acquire waits at the cap and wakes waiters in arrival order', async () => {
  const pool = createLanePool({ readMachine: () => ({ freeRamMb: 64000, logicalCores: 1 }), config: cfg, seatCount: 4 });
  const order = [];
  const r1 = await pool.acquire('p');
  const w2 = pool.acquire('p').then((r) => { order.push(2); return r; });
  const w3 = pool.acquire('p').then((r) => { order.push(3); return r; });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, []);
  r1('ok');
  (await w2)('ok');
  (await w3)('ok');
  assert.deepEqual(order, [2, 3]);
});

test('snapshot carries the cap and the parts that the last start used', async () => {
  const pool = createLanePool({ readMachine: () => ({ freeRamMb: 6144, logicalCores: 16 }), config: cfg, seatCount: 8 });
  assert.equal(pool.snapshot().cap, null);
  const rel = await pool.acquire('p');
  const snap = pool.snapshot();
  assert.equal(snap.running, 1);
  // The global gate: RAM, cores, and maxParallel. The provider limit stays in `parts`.
  assert.equal(snap.cap, 10);
  assert.equal(snap.parts.ramCap, 10);
  assert.equal(snap.parts.cpuCap, 16);
  assert.equal(snap.parts.providerCap, 8);
  rel('ok');
});

test('a release counts only once', async () => {
  const pool = createLanePool({ readMachine: () => ({ freeRamMb: 64000, logicalCores: 16 }), config: cfg, seatCount: 8 });
  const rel = await pool.acquire('p');
  rel('ok'); rel('ok');
  assert.equal(pool.snapshot().running, 0);
  assert.equal(pool.snapshot().providers.p.running, 0);
});

// A running lane is a real OS process that holds real RAM, so the free reading falls as
// lanes start. The pool must not subtract those lanes a second time through the cap.
test('a free-RAM reading that falls per running lane still reaches the documented 10 lanes', async () => {
  let pool = null;
  const read = () => ({
    freeRamMb: 6144 - 400 * (pool ? pool.snapshot().running : 0),
    logicalCores: 16,
  });
  pool = createLanePool({ readMachine: read, config: cfg, seatCount: 10 });

  const held = [];
  for (let i = 0; i < 10; i++) pool.acquire('p').then((rel) => held.push(rel));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(held.length, 10);
  assert.equal(pool.snapshot().running, 10);
  for (const rel of held) rel('ok');
});

// Host and swarm providers run at the same time, so one provider's reduced cap must never
// be weighed against the count of lanes that every other provider is running.
test('a halved provider cap does not block a different provider', async () => {
  const pool = createLanePool({
    readMachine: () => ({ freeRamMb: 64000, logicalCores: 16 }),
    config: cfg,
    seatCount: 8,
  });

  let rel = await pool.acquire('oc'); rel('rate-limited');
  rel = await pool.acquire('oc'); rel('rate-limited');
  assert.equal(pool.snapshot().providers.oc.cap, 2);

  const hostHeld = [await pool.acquire('host'), await pool.acquire('host'), await pool.acquire('host')];
  assert.equal(pool.snapshot().running, 3);

  let started = false;
  pool.acquire('oc').then((r) => { started = true; r('ok'); });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(started, true, 'opencode runs no lane of its own, so its cap of 2 must admit it');
  for (const r of hostHeld) r('ok');
});

test('laneProvider separates the host from each swarm provider', () => {
  assert.equal(laneProvider({ backendName: 'claude', hostBackend: 'claude', model: 'opus' }), 'host');
  assert.equal(laneProvider({ backendName: 'opencode', hostBackend: 'claude', model: 'acme/example-model' }), 'acme');
  assert.equal(laneProvider({ backendName: 'opencode', hostBackend: 'claude', model: null }), 'opencode');
});

test('laneOutcome maps a seat result to a lane outcome', () => {
  assert.equal(laneOutcome({ ok: false, errorType: 'rate-limited' }), 'rate-limited');
  assert.equal(laneOutcome({ ok: true, errorType: null }), 'ok');
  assert.equal(laneOutcome({ ok: false, errorType: 'timeout' }), 'error');
  assert.equal(laneOutcome(undefined), 'error');
});

test('readMachine never throws and returns numbers', () => {
  const m = readMachine();
  assert.ok(Number.isFinite(m.freeRamMb) && m.freeRamMb > 0);
  assert.ok(Number.isInteger(m.logicalCores) && m.logicalCores > 0);
});
