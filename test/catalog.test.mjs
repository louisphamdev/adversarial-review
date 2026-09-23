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
  scoreBench,
  probe,
  bench,
  pick,
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
        config: {},
        runChild: fakeRunChild,
        stderr,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'opencode');
      assert.deepEqual(calls[0].args, ['models']);
      assert.deepEqual(res.candidates, ['a/b', 'c/d#high']);
      assert.equal(res.authoritative, true);
      assert.equal(res.error, undefined);
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
    it('readStore returns empty store with version: 3 if file does not exist', async () => {
      const { home, cleanup } = await makeIsolatedEnv();
      try {
        const stateDir = path.join(home, '.state');
        const store = await readStore(stateDir);
        assert.equal(store.version, 3);
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
        assert.equal(finalStore.version, 3);
        assert.ok(finalStore['opencode:model-a'], 'model-a must be present');
        assert.ok(finalStore['opencode:model-b'], 'model-b must be present');
        assert.equal(finalStore['opencode:model-a'].tier, 'top');
        assert.equal(finalStore['opencode:model-b'].tier, 'standard');
      } finally {
        await cleanup();
      }
    });
  });

  describe('pick', () => {
    const prior = new Map([
      ['provider/top-model', { free: false, toolCall: true, reasoning: true, context: 128000, textOnly: true }],
      ['provider/std-model', { free: false, toolCall: true, reasoning: false, context: 64000, textOnly: true }],
      ['provider/free-model', { free: true, toolCall: true, reasoning: true, context: 32000, textOnly: true }],
      ['provider/unmeasured-1', { free: false, toolCall: true, reasoning: true, context: 100000, textOnly: true }],
    ]);

    it('measured top wins over standard', async () => {
      const now = 1727100000000;
      const store = {
        version: 3,
        'opencode:provider/std-model': {
          callable: true,
          tier: 'standard',
          score: 4,
          invented: 1,
          measuredAt: now - 1000,
        },
        'opencode:provider/top-model': {
          callable: true,
          tier: 'top',
          score: 6,
          invented: 0,
          measuredAt: now - 1000,
        },
      };

      const picked = await pick({
        candidates: ['provider/std-model', 'provider/top-model'],
        store,
        prior,
        route: 'auto',
        now,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/top-model');
      assert.equal(picked.tier, 'top');
      assert.equal(picked.measured, true);
    });

    it('free model dropped on auto with allowFree: false', async () => {
      const now = 1727100000000;
      const store = {
        version: 3,
        'opencode:provider/free-model': {
          callable: true,
          tier: 'top',
          score: 6,
          invented: 0,
          free: true,
          measuredAt: now - 1000,
        },
        'opencode:provider/std-model': {
          callable: true,
          tier: 'standard',
          score: 4,
          invented: 1,
          free: false,
          measuredAt: now - 1000,
        },
      };

      const picked = await pick({
        candidates: ['provider/free-model', 'provider/std-model'],
        store,
        prior,
        route: 'auto',
        allowFree: false,
        now,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/std-model');
      assert.equal(picked.tier, 'standard');
    });

    it('all measured unusable -> probes unmeasured and returns measured: false', async () => {
      const now = 1727100000000;
      const store = {
        version: 3,
        'opencode:provider/bad-model': {
          callable: true,
          tier: 'unusable',
          score: 0,
          invented: 5,
          measuredAt: now - 1000,
        },
      };

      const probed = [];
      const fakeProbeFn = async (candidate) => {
        probed.push(candidate);
        return { callable: true, ok: true };
      };

      const picked = await pick({
        candidates: ['provider/bad-model', 'provider/unmeasured-1'],
        store,
        prior,
        route: 'swarm',
        probeFn: fakeProbeFn,
        now,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/unmeasured-1');
      assert.equal(picked.measured, false);
      assert.deepEqual(probed, ['provider/unmeasured-1']);
    });

    it('nothing callable -> null', async () => {
      const store = { version: 3 };
      const fakeProbeFn = async () => ({ callable: false, ok: false });

      const picked = await pick({
        candidates: ['provider/unmeasured-1'],
        store,
        prior,
        route: 'auto',
        probeFn: fakeProbeFn,
      });

      assert.equal(picked, null);
    });

    it('candidates without toolCall or non-text output in prior are excluded', async () => {
      const localPrior = new Map([
        ['provider/no-tool', { free: false, toolCall: false, reasoning: true, context: 64000, textOnly: true }],
        ['provider/image-only', { free: false, toolCall: true, reasoning: true, context: 64000, textOnly: false }],
        ['provider/valid', { free: false, toolCall: true, reasoning: true, context: 64000, textOnly: true }],
      ]);
      const probed = [];
      const fakeProbeFn = async (cand) => {
        probed.push(cand);
        return { callable: true };
      };

      const picked = await pick({
        candidates: ['provider/no-tool', 'provider/image-only', 'provider/valid'],
        store: { version: 3 },
        prior: localPrior,
        route: 'auto',
        probeFn: fakeProbeFn,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/valid');
      assert.deepEqual(probed, ['provider/valid']);
    });

    it('swarm route prefers free model among equal tiers', async () => {
      const now = 1727100000000;
      const store = {
        version: 3,
        'opencode:provider/paid-top': {
          callable: true,
          tier: 'top',
          score: 6,
          invented: 0,
          free: false,
          measuredAt: now - 1000,
        },
        'opencode:provider/free-top': {
          callable: true,
          tier: 'top',
          score: 5,
          invented: 0,
          free: true,
          measuredAt: now - 1000,
        },
      };

      const picked = await pick({
        candidates: ['provider/paid-top', 'provider/free-top'],
        store,
        prior,
        route: 'swarm',
        now,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/free-top');
    });

    it('stale measurement older than maxAgeDays triggers probe fallback', async () => {
      const now = 1727100000000;
      const eightDaysMs = 8 * 24 * 3600 * 1000;
      const store = {
        version: 3,
        'opencode:provider/stale-top': {
          callable: true,
          tier: 'top',
          score: 6,
          invented: 0,
          measuredAt: now - eightDaysMs,
        },
      };

      const probed = [];
      const fakeProbeFn = async (cand) => {
        probed.push(cand);
        return { callable: true };
      };

      const picked = await pick({
        candidates: ['provider/stale-top'],
        store,
        prior,
        route: 'auto',
        maxAgeDays: 7,
        probeFn: fakeProbeFn,
        now,
      });

      assert.ok(picked);
      assert.equal(picked.model, 'provider/stale-top');
      assert.equal(picked.measured, false);
      assert.deepEqual(probed, ['provider/stale-top']);
    });
  });

  describe('probe and bench runners', () => {
    it('probe measures callable, latency, contract, and measuredAt', async () => {
      const calls = [];
      const fakeProbeCall = async ({ backend, model }) => {
        calls.push({ backend, model });
        return { ok: true, value: { status: 'ok' }, error: null };
      };

      const res = await probe({
        backend: 'opencode',
        models: ['model-1', 'model-2'],
        probeCall: fakeProbeCall,
        limit: 1,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, 'model-1');
      const entry = res['opencode:model-1'];
      assert.ok(entry);
      assert.equal(entry.callable, true);
      assert.equal(entry.contract, true);
      assert.equal(typeof entry.latencyMs, 'number');
      assert.equal(typeof entry.measuredAt, 'number');
    });

    it('bench runs findings against answer key and stores scores and tier', async () => {
      const fakeBenchCall = async ({ backend, model }) => {
        return {
          ok: true,
          value: {
            findings: [
              { title: 'loop issue', line: '15', detail: 'bound error' },
              { title: 'vip check', line: '22', detail: 'discount inverted' },
            ],
          },
        };
      };

      const answerKey = [
        { id: 'loop', lines: [14, 17], keywords: ['loop', 'bound'] },
        { id: 'discount', lines: [21, 23], keywords: ['discount', 'vip'] },
      ];

      const res = await bench({
        backend: 'opencode',
        models: ['model-1'],
        benchCall: fakeBenchCall,
        answerKey,
        limit: 1,
      });

      const entry = res['opencode:model-1'];
      assert.ok(entry);
      assert.equal(entry.callable, true);
      assert.equal(entry.contract, true);
      assert.equal(entry.score, 2);
      assert.equal(entry.invented, 0);
      assert.equal(entry.tier, 'light');
    });

    it('bench marks tier unusable when contract fails', async () => {
      const failingBenchCall = async () => {
        return {
          ok: false,
          error: 'parse error in model response',
          raw: 'not valid json',
        };
      };

      const res = await bench({
        backend: 'opencode',
        models: ['model-bad'],
        benchCall: failingBenchCall,
        limit: 1,
      });

      const entry = res['opencode:model-bad'];
      assert.ok(entry);
      assert.equal(entry.callable, true);
      assert.equal(entry.contract, false);
      assert.equal(entry.tier, 'unusable');
    });

    it('bench loads default answer key if none provided', async () => {
      const benchCall = async () => ({
        ok: true,
        value: {
          findings: [
            { title: 'unawaited promise', line: '8', detail: 'async getExchangeRates not awaited', evidence: 'rates' },
          ],
        },
      });

      const res = await bench({
        backend: 'opencode',
        models: ['model-default-key'],
        benchCall,
        limit: 1,
      });

      const entry = res['opencode:model-default-key'];
      assert.ok(entry);
      assert.equal(entry.score, 1);
    });
  });
});
