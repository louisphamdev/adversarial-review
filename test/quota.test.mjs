import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeIsolatedEnv } from './helpers/isolated-env.mjs';
import { parsePercent, readQuota, defaultReadCredentials } from '../skills/adversarial-review/scripts/lib/quota.mjs';

test('quota module', async (t) => {
  await t.test('parsePercent', () => {
    assert.equal(parsePercent(''), null);
    assert.equal(parsePercent('   '), null);
    assert.equal(parsePercent('83'), 83);
    assert.equal(parsePercent('{"percent":0}'), 0);
    assert.equal(parsePercent('{"percent": 85}'), 85);
    assert.equal(parsePercent('{"percent": "75"}'), 75);
    assert.equal(parsePercent('{"percent": -5}'), null);
    assert.equal(parsePercent('{"percent": 105}'), null);
    assert.equal(parsePercent('abc'), null);
    assert.equal(parsePercent('101'), null);
    assert.equal(parsePercent('-1'), null);
    assert.equal(parsePercent('0'), 0);
    assert.equal(parsePercent('100'), 100);
    assert.equal(parsePercent('83%'), 83);
    assert.equal(parsePercent(83), 83);
    assert.equal(parsePercent(0), 0);
    assert.equal(parsePercent(null), null);
    assert.equal(parsePercent(undefined), null);
  });

  await t.test('env ADVERSARIAL_REVIEW_QUOTA_PERCENT takes precedence', async () => {
    const { env, cleanup } = await makeIsolatedEnv({
      ADVERSARIAL_REVIEW_QUOTA_PERCENT: '0',
    });
    try {
      const res = await readQuota({
        config: { quota: { source: 'command', command: ['echo', '99'] } },
        env,
      });
      assert.equal(res.percent, 0);
      assert.equal(res.source, 'env');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('env ADVERSARIAL_REVIEW_QUOTA_PERCENT invalid evaluates to percent null', async () => {
    const { env, cleanup } = await makeIsolatedEnv({
      ADVERSARIAL_REVIEW_QUOTA_PERCENT: 'abc',
    });
    try {
      const res = await readQuota({ env });
      assert.equal(res.percent, null);
      assert.equal(res.source, 'env');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('env ADVERSARIAL_REVIEW_QUOTA_PERCENT empty string is ignored', async () => {
    const { env, cleanup } = await makeIsolatedEnv({
      ADVERSARIAL_REVIEW_QUOTA_PERCENT: '',
    });
    try {
      const res = await readQuota({
        config: { hostBackend: 'opencode' },
        env,
      });
      // Falls back to default source for non-claude hostBackend: none
      assert.equal(res.percent, null);
      assert.equal(res.source, 'none');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('source none returns percent null and source none', async () => {
    const { env, cleanup } = await makeIsolatedEnv();
    try {
      const res = await readQuota({
        config: { quota: { source: 'none' } },
        env,
      });
      assert.equal(res.percent, null);
      assert.equal(res.source, 'none');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('default source is claude-oauth when hostBackend is claude', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'test-token-123' } })
      );

      let requestedUrl = null;
      let requestedHeaders = null;

      const fakeFetch = async (url, opts) => {
        requestedUrl = url;
        requestedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ seven_day: { utilization: 83 } }),
        };
      };

      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeFetch,
        platform: 'linux',
      });

      assert.equal(res.percent, 83);
      assert.equal(res.source, 'claude-oauth');
      assert.equal(res.stale, false);
      assert.equal(requestedUrl, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(requestedHeaders['Authorization'], 'Bearer test-token-123');
      assert.equal(requestedHeaders['anthropic-beta'], 'oauth-2025-04-20');
    } finally {
      await cleanup();
    }
  });

  await t.test('claude-oauth stalled fetch aborts and returns percent null within timeout', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } })
      );

      const fakeStalledFetch = (url, opts) => {
        return new Promise((resolve, reject) => {
          if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }
        });
      };

      const start = Date.now();
      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeStalledFetch,
        oauthTimeoutMs: 200,
        platform: 'linux',
      });
      const elapsed = Date.now() - start;

      assert.equal(res.percent, null);
      assert.equal(res.source, 'claude-oauth');
      assert.equal(res.stale, false);
      assert.ok(elapsed < 2000, `Expected elapsed < 2000ms, got ${elapsed}ms`);
    } finally {
      await cleanup();
    }
  });

  await t.test('ten concurrent readQuota calls with a counting fake fetch -> fetch called once', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } })
      );

      let fetchCount = 0;
      const countingFetch = async () => {
        fetchCount++;
        // Small delay to simulate network latency and ensure others queue
        await new Promise((r) => setTimeout(r, 40));
        return {
          ok: true,
          status: 200,
          json: async () => ({ seven_day: { utilization: 65 } }),
        };
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          readQuota({
            config: { hostBackend: 'claude' },
            env,
            fetchImpl: countingFetch,
            platform: 'linux',
          })
        )
      );

      assert.equal(fetchCount, 1);
      for (const res of results) {
        assert.equal(res.percent, 65);
        assert.equal(res.source, 'claude-oauth');
        assert.equal(res.stale, false);
      }
    } finally {
      await cleanup();
    }
  });

  await t.test('cache hit within 120s does not call fetch', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const cacheDir = path.join(home, '.adversarial-review', 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, 'quota.json');
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          at: Date.now() - 30000, // 30 seconds old (< 120s)
          percent: 72,
          source: 'claude-oauth',
        })
      );

      let fetchCalled = false;
      const fakeFetch = async () => {
        fetchCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ seven_day: { utilization: 99 } }),
        };
      };

      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeFetch,
        platform: 'linux',
      });

      assert.equal(fetchCalled, false);
      assert.equal(res.percent, 72);
      assert.equal(res.source, 'claude-oauth');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('fetch 429 with 30-min-old cache falls back to stale cache', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const cacheDir = path.join(home, '.adversarial-review', 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, 'quota.json');
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          at: Date.now() - 30 * 60 * 1000, // 30 minutes old (< 1 hour)
          percent: 55,
          source: 'claude-oauth',
        })
      );

      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'token' } })
      );

      const fakeFetch429 = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: 'rate_limit' }),
      });

      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeFetch429,
        platform: 'linux',
      });

      assert.equal(res.percent, 55);
      assert.equal(res.source, 'claude-oauth');
      assert.equal(res.stale, true);
    } finally {
      await cleanup();
    }
  });

  await t.test('fetch 429 with 65-min-old cache does not use stale cache and returns percent null', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const cacheDir = path.join(home, '.adversarial-review', 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, 'quota.json');
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          at: Date.now() - 65 * 60 * 1000, // 65 minutes old (> 1 hour)
          percent: 55,
          source: 'claude-oauth',
        })
      );

      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'token' } })
      );

      const fakeFetch429 = async () => ({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeFetch429,
        platform: 'linux',
      });

      assert.equal(res.percent, null);
      assert.equal(res.source, 'claude-oauth');
      assert.equal(res.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('source command parses stdout number and JSON', async () => {
    const iso1 = await makeIsolatedEnv();
    try {
      const resNum = await readQuota({
        config: { quota: { source: 'command', command: ['my-quota'] } },
        env: iso1.env,
        runCommand: async (argv) => {
          assert.deepEqual(argv, ['my-quota']);
          return { code: 0, stdout: '48\n' };
        },
      });
      assert.equal(resNum.percent, 48);
      assert.equal(resNum.source, 'command');
      assert.equal(resNum.stale, false);
    } finally {
      await iso1.cleanup();
    }

    const iso2 = await makeIsolatedEnv();
    try {
      const resJson = await readQuota({
        config: { quota: { source: 'command', command: ['my-quota-json'] } },
        env: iso2.env,
        runCommand: async () => ({ code: 0, stdout: '{"percent": 88}\n' }),
      });
      assert.equal(resJson.percent, 88);
      assert.equal(resJson.source, 'command');
      assert.equal(resJson.stale, false);
    } finally {
      await iso2.cleanup();
    }
  });

  await t.test('source command empty output or non-zero exit evaluates to null', async () => {
    const { env, cleanup } = await makeIsolatedEnv();
    try {
      const resEmpty = await readQuota({
        config: { quota: { source: 'command', command: ['cmd'] } },
        env,
        runCommand: async () => ({ code: 0, stdout: '  \n' }),
      });
      assert.equal(resEmpty.percent, null);
      assert.equal(resEmpty.source, 'command');
      assert.equal(resEmpty.stale, false);

      const resFail = await readQuota({
        config: { quota: { source: 'command', command: ['cmd'] } },
        env,
        runCommand: async () => ({ code: 1, stdout: 'error' }),
      });
      assert.equal(resFail.percent, null);
      assert.equal(resFail.source, 'command');
      assert.equal(resFail.stale, false);
    } finally {
      await cleanup();
    }
  });

  await t.test('source command failure falls back to 30-min-old cache', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const cacheDir = path.join(home, '.adversarial-review', 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, 'quota.json');
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          at: Date.now() - 30 * 60 * 1000,
          percent: 63,
          source: 'command',
        })
      );

      const res = await readQuota({
        config: { quota: { source: 'command', command: ['cmd'] } },
        env,
        runCommand: async () => ({ code: 1, stdout: 'error' }),
      });

      assert.equal(res.percent, 63);
      assert.equal(res.source, 'command');
      assert.equal(res.stale, true);
    } finally {
      await cleanup();
    }
  });

  await t.test('readQuota never throws on filesystem or unhandled error', async () => {
    const res = await readQuota({
      config: { hostBackend: 'claude' },
      env: null,
      stateDir: '/dev/null/invalid-path/quota',
      fetchImpl: () => Promise.reject(new Error('boom')),
      readCredentials: () => Promise.reject(new Error('fs boom')),
    });
    assert.equal(res.percent, null);
    assert.equal(res.source, 'claude-oauth');
    assert.equal(res.stale, false);
  });

  await t.test('claude-oauth relies directly on fetchImpl with signal without timeoutPromise (C9)', async () => {
    const quotaSrc = await fs.readFile(
      new URL('../skills/adversarial-review/scripts/lib/quota.mjs', import.meta.url),
      'utf8'
    );
    assert.equal(quotaSrc.includes('timeoutPromise'), false, 'timeoutPromise must be removed from quota.mjs');

    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      const credDir = path.join(home, '.claude');
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(
        path.join(credDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } })
      );

      let abortListenersCount = null;
      let receivedSignal = null;
      const fakeFetch = async (url, opts) => {
        receivedSignal = opts.signal;
        const { getEventListeners } = await import('node:events');
        abortListenersCount = getEventListeners(opts.signal, 'abort').length;
        return {
          ok: true,
          status: 200,
          json: async () => ({ seven_day: { utilization: 42 } }),
        };
      };

      const res = await readQuota({
        config: { hostBackend: 'claude' },
        env,
        fetchImpl: fakeFetch,
        platform: 'linux',
      });
      assert.equal(res.percent, 42);
      assert.ok(receivedSignal);
      assert.equal(abortListenersCount, 0);
    } finally {
      await cleanup();
    }
  });
});
