import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeIsolatedEnv } from './helpers/isolated-env.mjs';
import {
  discover,
  loadPrior,
  readStore,
  updateStore,
  storeLensTiers,
  scoreBench,
  bench,
  loadLensKey,
} from '../skills/adversarial-review/scripts/lib/catalog.mjs';

describe('catalog module', () => {
  describe('discover', () => {
    it('opencode discover with fake runChild returning raw text -> trims, drops invalid, authoritative', async () => {
      const calls = [];
      const fakeRunChild = async ({ cmd, args }) => {
        calls.push({ cmd, args });
        return {
          code: 0,
          signal: null,
          stdout: 'a/b\r\nbad id!\r\nc/d#high\r\n',
          stderr: '',
          timedOut: false,
        };
      };

      const warnings = [];
      const stderr = {
        write: (msg) => warnings.push(msg),
      };

      const res = await discover('opencode', {
        config: { backends: { opencode: { exe: '/x/opencode' } } },
        runChild: fakeRunChild,
        stderr,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, '/x/opencode');
      assert.deepEqual(calls[0].args, ['models']);
      assert.deepEqual(res.candidates, ['a/b', 'c/d#high']);
      assert.equal(res.authoritative, true);
      assert.equal(res.error, undefined);
    });

    it('opencode discover keeps the error and names a wrapper flag as the hint', async () => {
      const fakeRunChild = async () => ({ code: 1, signal: null, stdout: '', stderr: 'ERROR Unrecognized flag: --yolo in command opencode models', timedOut: false });
      const res = await discover('opencode', { config: { backends: { opencode: { exe: '/x/opencode' } } }, runChild: fakeRunChild, stderr: { write: () => {} } });
      assert.deepEqual(res.candidates, []);
      assert.match(res.error, /Unrecognized flag/);
      assert.match(res.hint, /wrapper/);
      assert.ok(res.notes.some((n) => /Unrecognized flag/.test(n)));
    });

    it('opencode discover without an executable gives a note with the searched locations', async () => {
      const res = await discover('opencode', { config: {}, env: { PATH: '', USERPROFILE: '/nohome', HOME: '/nohome' }, exists: async () => false, runChild: async () => { throw new Error('must not run'); }, stderr: { write: () => {} } });
      assert.deepEqual(res.candidates, []);
      assert.ok(res.notes.some((n) => /opencode executable not found/.test(n)));
    });

    it('opencode discover writes every note to the stderr it receives', async () => {
      const lines = [];
      const res = await discover('opencode', {
        config: {},
        env: { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\u' },
        exists: async () => false,
        runChild: async () => { throw new Error('must not run'); },
        stderr: { write: (msg) => lines.push(msg) },
      });
      assert.deepEqual(res.candidates, []);
      assert.ok(
        lines.some((l) => /^note: opencode executable not found/.test(l)),
        `expected a note line, got ${JSON.stringify(lines)}`
      );
    });

    it('opencode discover writes the failure note to stderr for a non-zero exit', async () => {
      const lines = [];
      const fakeRunChild = async () => ({ code: 1, signal: null, stdout: '', stderr: 'ERROR Unrecognized flag: --yolo in command opencode models', timedOut: false });
      await discover('opencode', {
        config: { backends: { opencode: { exe: '/x/opencode' } } },
        runChild: fakeRunChild,
        stderr: { write: (msg) => lines.push(msg) },
      });
      assert.ok(lines.some((l) => /^note: discovery failed:.*Unrecognized flag/.test(l)));
    });

    it('opencode discover bounds the models call and names a timeout', async () => {
      // A first-run opencode under a fresh home never answers `models`, and the G2-2 order puts
      // that call on every route, so an unbounded call hangs the whole engine.
      let passed = null;
      const fakeRunChild = async (opts) => {
        passed = opts;
        return { code: null, signal: null, stdout: '', stderr: '', timedOut: true };
      };
      const res = await discover('opencode', {
        config: { backends: { opencode: { exe: '/x/opencode' } } },
        runChild: fakeRunChild,
        stderr: { write: () => {} },
      });
      assert.ok(passed.timeoutMs > 0, 'the models call carries a timeout');
      assert.deepEqual(res.candidates, []);
      assert.ok(
        res.notes.some((n) => /did not answer/.test(n)),
        `expected a timeout note, got ${JSON.stringify(res.notes)}`
      );
    });

    it('claude backend returns hardcoded models with authoritative: false', async () => {
      const res = await discover('claude', { config: {} });
      assert.deepEqual(res.candidates, ['opus', 'sonnet', 'haiku']);
      assert.equal(res.authoritative, false);
    });

    it('codex backend uses config if present, else parses codex debug models slugs', async () => {
      // With config
      const withCfg = await discover('codex', {
        config: { backends: { codex: { models: ['o3-mini', 'o1', 'bad id!'] } } },
      });
      assert.deepEqual(withCfg.candidates, ['o3-mini', 'o1']);
      assert.equal(withCfg.authoritative, false);

      // Without config, running debug models
      const calls = [];
      const fakeRunChild = async ({ cmd, args }) => {
        calls.push({ cmd, args });
        return {
          code: 0,
          stdout: 'slug-1\nslug-2\n',
          stderr: '',
          timedOut: false,
        };
      };
      const withoutCfg = await discover('codex', {
        config: {},
        runChild: fakeRunChild,
      });
      assert.equal(calls[0].cmd, 'codex');
      assert.deepEqual(calls[0].args, ['debug', 'models']);
      assert.deepEqual(withoutCfg.candidates, ['slug-1', 'slug-2']);
      assert.equal(withoutCfg.authoritative, true);

      // On debug models parse failure falls back to default
      const failingRunChild = async () => ({
        code: 1,
        stdout: '',
        stderr: 'command not found',
        timedOut: false,
      });
      const fallback = await discover('codex', {
        config: {},
        runChild: failingRunChild,
      });
      assert.deepEqual(fallback.candidates, ['default']);
      assert.equal(fallback.authoritative, false);
    });

    it('gemini and custom backend fall back to default or use user config', async () => {
      const gemDefault = await discover('gemini', { config: {} });
      assert.deepEqual(gemDefault.candidates, ['default']);
      assert.equal(gemDefault.authoritative, false);

      const customConfig = await discover('custom', {
        config: { backends: { custom: { models: ['custom-model-1'] } } },
      });
      assert.deepEqual(customConfig.candidates, ['custom-model-1']);
      assert.equal(customConfig.authoritative, false);
    });
  });

  describe('scoreBench', () => {
    const answerKey = [
      { id: 'd1', lines: [10, 12], keywords: ['loop', 'bound'] },
      { id: 'd2', lines: [20, 22], keywords: ['discount', 'vip'] },
      { id: 'd3', lines: [30, 32], keywords: ['shipping', 'zero'] },
      { id: 'd4', lines: [40, 42], keywords: ['rates', 'currency'] },
      { id: 'd5', lines: [50, 52], keywords: ['round', 'floor'] },
      { id: 'd6', lines: [60, 62], keywords: ['async', 'await'] },
    ];

    it('fixed sets: 6 hits 0 invented -> top', () => {
      const findings = [
        { title: 'loop issue', line: '10', detail: 'bound error', evidence: 'items', doneWhen: 'x' },
        { title: 'vip check', line: '21', detail: 'discount inverted', evidence: 'tier', doneWhen: 'x' },
        { title: 'zero shipping', line: '30', detail: 'eats 0', evidence: 'fee', doneWhen: 'x' },
        { title: 'currency math', line: '41', detail: 'missing rates', evidence: 'rates', doneWhen: 'x' },
        { title: 'floor round', line: '51', detail: 'wrong operator', evidence: 'round', doneWhen: 'x' },
        { title: 'await call', line: '61', detail: 'unawaited async call', evidence: 'async', doneWhen: 'x' },
      ];
      const res = scoreBench(findings, answerKey);
      assert.equal(res.score, 6);
      assert.equal(res.invented, 0);
      assert.equal(res.tier, 'top');
    });

    it('fixed sets: 4 hits 1 invented -> standard', () => {
      const findings = [
        { title: 'loop issue', line: '10', detail: 'bound error' },
        { title: 'vip check', line: '21', detail: 'discount inverted' },
        { title: 'zero shipping', line: '30', detail: 'eats 0' },
        { title: 'currency math', line: '41', detail: 'missing rates' },
        { title: 'hallucinated defect', line: '85', detail: 'completely made up' },
      ];
      const res = scoreBench(findings, answerKey);
      assert.equal(res.score, 4);
      assert.equal(res.invented, 1);
      assert.equal(res.tier, 'standard');
    });

    it('fixed sets: 2 hits 3 invented -> light', () => {
      const findings = [
        { title: 'loop issue', line: '10', detail: 'bound error' },
        { title: 'vip check', line: '21', detail: 'discount inverted' },
        { title: 'fake 1', line: '80', detail: 'unrelated' },
        { title: 'fake 2', line: '81', detail: 'unrelated' },
        { title: 'fake 3', line: '82', detail: 'unrelated' },
      ];
      const res = scoreBench(findings, answerKey);
      assert.equal(res.score, 2);
      assert.equal(res.invented, 3);
      assert.equal(res.tier, 'light');
    });

    it('fixed sets: 3 hits 4 invented -> unusable', () => {
      const findings = [
        { title: 'loop issue', line: '10', detail: 'bound error' },
        { title: 'vip check', line: '21', detail: 'discount inverted' },
        { title: 'zero shipping', line: '30', detail: 'eats 0' },
        { title: 'fake 1', line: '80', detail: 'unrelated' },
        { title: 'fake 2', line: '81', detail: 'unrelated' },
        { title: 'fake 3', line: '82', detail: 'unrelated' },
        { title: 'fake 4', line: '83', detail: 'unrelated' },
      ];
      const res = scoreBench(findings, answerKey);
      assert.equal(res.score, 3);
      assert.equal(res.invented, 4);
      assert.equal(res.tier, 'unusable');
    });

    it('one finding matching two defects counts once', () => {
      // Finding mentions both loop and discount keywords and line overlaps
      const finding = {
        title: 'loop and discount',
        line: '12',
        detail: 'bound error with vip discount',
      };
      const res = scoreBench([finding], answerKey);
      assert.equal(res.score, 1);
      assert.equal(res.invented, 0);
    });

    it('empty findings or answer key returns unusable tier', () => {
      const res1 = scoreBench([], answerKey);
      assert.deepEqual(res1, { score: 0, invented: 0, tier: 'unusable' });

      const res2 = scoreBench([{ title: 'something' }], []);
      assert.deepEqual(res2, { score: 0, invented: 1, tier: 'unusable' });
    });

    it('scores against bundled fixture defects.js and answer-key.json', async () => {
      const keyPath = path.resolve('skills/adversarial-review/bench/answer-key.json');
      const keyData = JSON.parse(await fs.readFile(keyPath, 'utf8'));
      assert.equal(keyData.length, 6);

      const findings = [
        { title: 'unawaited promise', line: '8', detail: 'getExchangeRates is async and not awaited', evidence: 'rates = getExchangeRates()' },
        { title: 'off by one in items loop', line: '15', detail: 'loop bound <= items.length throws undefined', evidence: 'for (let i = 0; i <= items.length; i++)' },
        { title: 'inverted vip discount check', line: '22', detail: 'non-vip gets discount condition inverted', evidence: 'order.customer?.tier !== "vip"' },
        { title: 'shipping fee eats 0 default', line: '28', detail: 'logical || eats zero falsy shippingFee', evidence: 'options.shippingFee || 15' },
        { title: 'missing currency rates check', line: '32', detail: 'rates[currency] is undefined resulting in NaN math', evidence: 'exchangeRate = rates[currency]' },
        { title: 'wrong rounding operator', line: '36', detail: 'Math.floor used instead of Math.round for currency rounding', evidence: 'Math.floor(convertedSubtotal * 100) / 100' },
      ];

      const res = scoreBench(findings, keyData);
      assert.equal(res.score, 6);
      assert.equal(res.invented, 0);
      assert.equal(res.tier, 'top');
    });
  });

  describe('loadPrior', () => {
    it('fetches api.json and caches it for 24h', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const stateDir = path.join(home, '.state');
        await fs.mkdir(stateDir, { recursive: true });

        const mockApi = {
          openai: {
            models: {
              'gpt-4o': {
                tool_call: true,
                reasoning: false,
                limit: { context: 128000 },
                cost: { input: 2.5, output: 10 },
              },
              'o3-mini': {
                tool_call: true,
                reasoning: true,
                limit: { context: 200000 },
                cost: { input: 1.1, output: 4.4 },
              },
            },
          },
          freecorp: {
            models: {
              'free-model': {
                tool_call: true,
                reasoning: false,
                limit: { context: 32000 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        };

        let fetchCount = 0;
        const fakeFetch = async (url) => {
          fetchCount++;
          return {
            ok: true,
            json: async () => mockApi,
          };
        };

        const now = 1727100000000;
        const prior1 = await loadPrior({ stateDir, fetchImpl: fakeFetch, now });
        assert.equal(fetchCount, 1);
        assert.equal(prior1.size, 3);
        assert.deepEqual(prior1.get('openai/gpt-4o'), {
          free: false,
          toolCall: true,
          reasoning: false,
          context: 128000,
          textOnly: true,
          cost: { input: 2.5, output: 10 },
        });
        assert.equal(prior1.get('freecorp/free-model').free, true);

        // Second call within 24h uses cache and does not call fetch
        const prior2 = await loadPrior({
          stateDir,
          fetchImpl: fakeFetch,
          now: now + 3600 * 1000, // +1 hour
        });
        assert.equal(fetchCount, 1);
        assert.equal(prior2.size, 3);

        // Call after 25h refreshes cache
        const prior3 = await loadPrior({
          stateDir,
          fetchImpl: fakeFetch,
          now: now + 25 * 3600 * 1000, // +25 hours
        });
        assert.equal(fetchCount, 2);
        assert.equal(prior3.size, 3);
      } finally {
        await cleanup();
      }
    });

    it('offline / network failure returns empty map without throwing', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const stateDir = path.join(home, '.state');
        const failingFetch = async () => {
          throw new Error('fetch failed ENOTFOUND');
        };
        const prior = await loadPrior({ stateDir, fetchImpl: failingFetch });
        assert.ok(prior instanceof Map);
        assert.equal(prior.size, 0);
      } finally {
        await cleanup();
      }
    });
  });

  describe('readStore and updateStore', () => {
    it('readStore returns empty store with version: 4 if file does not exist', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const stateDir = path.join(home, '.state');
        const store = await readStore(stateDir);
        assert.equal(store.version, 4);
      } finally {
        await cleanup();
      }
    });

    it('two concurrent updateStore calls with different keys -> both keys present', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const stateDir = path.join(home, '.state');
        await fs.mkdir(stateDir, { recursive: true });

        const entryA = {
          'opencode:model-a': {
            callable: true,
            latencyMs: 120,
            contract: true,
            tier: 'top',
            score: 6,
            invented: 0,
            measuredAt: Date.now(),
          },
        };
        const entryB = {
          'opencode:model-b': {
            callable: true,
            latencyMs: 250,
            contract: true,
            tier: 'standard',
            score: 4,
            invented: 1,
            measuredAt: Date.now(),
          },
        };

        await Promise.all([
          updateStore(stateDir, entryA),
          updateStore(stateDir, entryB),
        ]);

        const finalStore = await readStore(stateDir);
        assert.equal(finalStore.version, 4);
        assert.ok(finalStore['opencode:model-a'], 'model-a must be present');
        assert.ok(finalStore['opencode:model-b'], 'model-b must be present');
        assert.equal(finalStore['opencode:model-a'].tier, 'top');
        assert.equal(finalStore['opencode:model-b'].tier, 'standard');
      } finally {
        await cleanup();
      }
    });
  });


  describe('3.1 pool and assignment', () => {
    const prior = new Map([
      ['opencode/big-pickle', { free: true }],
      ['opencode/paid-x', { free: false }],
    ]);

    it('free comes from price data, never the name', async () => {
      const { buildPool } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const { pool } = buildPool({
        candidates: ['opencode/big-pickle', 'opencode/paid-x', 'opencode/looks-free', 'opencode/unknown-free', 'acme/a/b'],
        prior, store: {}, named: [],
        probeResults: {
          'opencode/unknown-free': { costComplete: true, costTotal: 0, tokensTotal: 12 },
          'opencode/looks-free': { costComplete: false, costTotal: 0, tokensTotal: 12 },
        },
      });
      assert.deepEqual(pool.map((p) => p.model).sort(), ['opencode/big-pickle', 'opencode/unknown-free']);
      assert.equal(pool.find((p) => p.model === 'opencode/unknown-free').freeSource, 'probe');
    });

    it('named models join whatever the provider; bad names become notes', async () => {
      const { buildPool, cleanNamed } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const c = cleanNamed([' acme/a/b ', '', 'nonslash', 'ACME/A/B', 'p/'], ['acme/a/b']);
      assert.deepEqual(c.named, ['acme/a/b']);
      assert.equal(c.notes.length, 2);
      const { pool } = buildPool({ candidates: ['acme/a/b'], prior: new Map(), store: {}, named: c.named, probeResults: {} });
      assert.deepEqual(pool, [{ model: 'acme/a/b', provider: 'acme', free: false, freeSource: null, named: true }]);
    });

    it('probe runs all models at once, honors the deadline, and storable() keeps only final answers', async () => {
      const { probe, storableProbe } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const started = [];
      const laneCall = async (m) => {
        started.push(m);
        if (m === 'slow') await new Promise((r) => setTimeout(r, 300));
        if (m === 'refused') return { ok: false, errorType: 'provider-refused' };
        return { ok: true, value: { ok: true }, costTotal: 0, tokensTotal: 5, costComplete: true };
      };
      const t0 = Date.now();
      const r = await probe({ models: ['fast', 'slow', 'refused'], laneCall, deadlineMs: 100 });
      assert.ok(Date.now() - t0 < 250);
      assert.deepEqual(started.sort(), ['fast', 'refused', 'slow']);
      assert.equal(r.fast.callable, true);
      assert.equal(r.slow.errorType, 'timeout');
      assert.equal(storableProbe(r.fast), true);
      assert.equal(storableProbe(r.refused), true);
      assert.equal(storableProbe(r.slow), false);
      assert.equal(storableProbe({ errorType: 'rate-limited' }), false);
    });

    it('assignSeats: strong seats first, distinct models, failover up to 2, unusable never assigned', async () => {
      const { assignSeats } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const pool = ['m1', 'm2', 'm3'].map((m) => ({ model: m, provider: 'opencode', free: true }));
      const store = {
        'opencode:m1': { callable: true, latencyMs: 10, lenses: { breaker: 'top', edge: 'unusable' } },
        'opencode:m2': { callable: true, latencyMs: 20, lenses: { breaker: 'standard', edge: 'standard' } },
        'opencode:m3': { callable: true, latencyMs: 5 },
      };
      const seats = [{ key: 'edge', tier: 'standard' }, { key: 'breaker', tier: 'strong' }];
      const r = assignSeats({ seats, pool, store });
      assert.equal(r.breaker.model, 'm1');
      assert.equal(r.breaker.capability, 'strong');
      assert.notEqual(r.edge.model, 'm1');
      assert.equal(r.edge.capability, 'weak');
      assert.ok(r.edge.failover.length <= 2 && !r.edge.failover.includes('m1'));
      assert.deepEqual(assignSeats({ seats, pool: [], store }), {});
    });

    it('updateStore runs an updater under the lock and refuses to overwrite a corrupt file', async () => {
      const { updateStore, readStore } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const dir = path.join(home, 'state'); await fs.mkdir(dir, { recursive: true });
        await updateStore(dir, (cur) => ({ ...cur, 'opencode:m': { misbehaved: 1, lenses: { edge: 'top' } } }));
        await updateStore(dir, (cur) => ({ ...cur, 'opencode:m': { ...cur['opencode:m'], misbehaved: (cur['opencode:m'].misbehaved || 0) + 1, lenses: { ...cur['opencode:m'].lenses, breaker: 'light' } } }));
        const s = await readStore(dir);
        assert.equal(s.version, 4);
        assert.equal(s['opencode:m'].misbehaved, 2);
        assert.deepEqual(s['opencode:m'].lenses, { edge: 'top', breaker: 'light' });
        await fs.writeFile(path.join(dir, 'models.json'), '{broken');
        await assert.rejects(updateStore(dir, (c) => c));
        assert.equal(await fs.readFile(path.join(dir, 'models.json'), 'utf8'), '{broken');
      } finally { await cleanup(); }
    });

    it('a version-3 top-level tier reads as the breaker lens', async () => {
      const { readStore } = await import('../skills/adversarial-review/scripts/lib/catalog.mjs');
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const dir = path.join(home, 'state'); await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ version: 3, 'opencode:m': { tier: 'top' } }));
        assert.equal((await readStore(dir))['opencode:m'].lenses.breaker, 'top');
      } finally { await cleanup(); }
    });

    it('a second bench run moves the stored breaker lens', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const dir = path.join(home, 'state');
        await fs.mkdir(dir, { recursive: true });
        const key = await loadLensKey('breaker');
        const findAll = key.map((d) => ({ title: d.keywords[0], line: String(d.lines[0]) }));
        // The CLI `models bench` path: bench() -> storeLensTiers().
        const runBench = async (hits) => {
          const res = await bench({
            models: ['m'],
            lenses: ['breaker'],
            benchCallFor: () => async () => ({ ok: true, value: { findings: findAll.slice(0, hits) } }),
            deadlineMs: 1000,
          });
          await storeLensTiers(dir, {
            backend: 'opencode',
            model: 'm',
            tiers: { breaker: res.m.breaker.tier },
          });
          return (await readStore(dir))['opencode:m'];
        };

        assert.equal((await runBench(2)).lenses.breaker, 'light');
        assert.equal((await runBench(key.length)).lenses.breaker, 'top');
      } finally { await cleanup(); }
    });

    it('updateStore in object form merges lensMeasuredAt per lens, like lenses', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const dir = path.join(home, 'state');
        await fs.mkdir(dir, { recursive: true });
        await updateStore(dir, { 'opencode:m': { lenses: { edge: 'top' }, lensMeasuredAt: { edge: 111 } } });
        await updateStore(dir, { 'opencode:m': { lenses: { medic: 'light' }, lensMeasuredAt: { medic: 222 } } });
        const stored = (await readStore(dir))['opencode:m'];
        assert.deepEqual(stored.lenses, { edge: 'top', medic: 'light' });
        assert.deepEqual(stored.lensMeasuredAt, { edge: 111, medic: 222 });
      } finally { await cleanup(); }
    });

    it('storeLensTiers stamps only the lenses the caller measured', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const dir = path.join(home, 'state');
        await fs.mkdir(dir, { recursive: true });
        await updateStore(dir, { 'opencode:m': { lenses: { edge: 'top' }, lensMeasuredAt: { edge: 111 } } });
        await storeLensTiers(dir, {
          backend: 'opencode',
          model: 'm',
          tiers: { edge: 'top', medic: 'light', racer: 'unmeasured' },
          measured: ['medic'],
          now: () => 999,
        });
        const stored = (await readStore(dir))['opencode:m'];
        assert.deepEqual(stored.lenses, { edge: 'top', medic: 'light' });
        assert.deepEqual(stored.lensMeasuredAt, { edge: 111, medic: 999 });
      } finally { await cleanup(); }
    });
  });
});
