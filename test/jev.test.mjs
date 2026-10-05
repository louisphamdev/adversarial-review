import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  askJev,
  capText,
  mapLimit,
  makeJevRouter,
  resolveJevTarget,
  isSecretPath,
  redactSecretLines,
  JEV_STATE_CAP,
} from '../skills/adversarial-review/scripts/lib/jev.mjs';

const okFetch = (answers) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ answers }) });

describe('askJev', () => {
  it('returns answers on success', async () => {
    const r = await askJev({ url: 'u', model: 'm', key: 'k', state: 's', questions: {}, fetch: okFetch({ a: 1 }) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.answers, { a: 1 });
  });
  it('maps HTTP, parse, and network failures without throwing', async () => {
    const http = await askJev({ url: 'u', model: 'm', key: 'k', state: 's', questions: {}, fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
    assert.deepEqual(http, { ok: false, reason: 'http-503' });
    const bad = await askJev({ url: 'u', model: 'm', key: 'k', state: 's', questions: {}, fetch: async () => ({ ok: true, status: 200, text: async () => 'nope' }) });
    assert.equal(bad.reason, 'bad-response');
    const net = await askJev({ url: 'u', model: 'm', key: 'k', state: 's', questions: {}, fetch: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(net.reason, 'network');
  });
  it('times out and reports timeout', async () => {
    const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const r = await askJev({ url: 'u', model: 'm', key: 'k', state: 's', questions: {}, fetch: hang, timeoutMs: 20 });
    assert.equal(r.reason, 'timeout');
  });
});

describe('capText', () => {
  it('cuts to the limit and drops a lone surrogate half', () => {
    assert.equal(capText('abcdef', 3), 'abc');
    const s = `ab${'\u{1F600}'}`; // 'a', 'b', high, low
    assert.equal(capText(s, 3), 'ab');
  });
});

describe('secret patterns', () => {
  it('match every segment in any case', () => {
    for (const p of ['.ENV', 'config/credentials.json', 'a\\.ssh\\config', 'x/.git/HEAD', 'deploy/id_rsa.pub', 'k.PEM']) assert.equal(isSecretPath(p), true, p);
    assert.equal(isSecretPath('lib/env.mjs'), false);
  });
  it('remove a line with a secret value or path', () => {
    assert.equal(redactSecretLines('Bearer abcdefghijklmnopqrstuv\nok'), '(line removed: secret pattern)\nok');
  });
});

describe('mapLimit', () => {
  it('never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    });
    assert.equal(peak, 2);
  });
});

describe('resolveJevTarget', () => {
  it('keeps the TypeSafe native rule', () => {
    const t = resolveJevTarget({}, { TYPESAFE_API_KEY: 'x' });
    assert.match(t.url, /typesafe\.ai/);
  });
});

describe('makeJevRouter', () => {
  it('returns null without a key', async () => {
    const r = await makeJevRouter({ config: { sift: { enabled: true } }, env: {} });
    assert.equal(r, null);
  });
  it('asks one question per item, caps the state, and logs no key', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-router-'));
    const bodies = [];
    const fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { touches: { choice: 'yes', probabilities: { yes: 0.7, no: 0.3 } } } }) };
    };
    const router = await makeJevRouter({ config: { sift: { enabled: true, url: 'https://x/systemone', model: 'm' } }, env: { JEV_API_KEY: 'secret-key-value' }, fetch, runDir });
    const answers = await router({ items: [{ id: 'C1', anchors: { files: [], symbols: [], sections: [] } }, { id: 'C2', anchors: { files: [], symbols: [], sections: [] } }], deltaText: 'x'.repeat(20000) });
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((b) => b.state.length <= JEV_STATE_CAP));
    assert.deepEqual(Object.keys(bodies[0].questions), ['touches']);
    assert.equal(answers.get('C1'), 0.7);
    try {
      const log = fs.readFileSync(path.join(runDir, 'jev.log.jsonl'), 'utf8');
      assert.equal(log.includes('secret-key-value'), false);
      assert.match(log, /"purpose":"router"/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
  it('removes secret lines from the outbound state', async () => {
    const bodies = [];
    const fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { touches: { probabilities: { yes: 0.1 } } } }) };
    };
    const router = await makeJevRouter({ config: { sift: { enabled: true, url: 'https://x', model: 'm' } }, env: { JEV_API_KEY: 'k' }, fetch });
    await router({ items: [{ id: 'C1', anchors: {} }], deltaText: 'edit config/.env too\ntoken sk-abcdefghijklmnopqrstu\nplain line' });
    assert.equal(bodies[0].state.includes('sk-abcdefghijklmnopqrstu'), false);
    assert.equal(bodies[0].state.includes('config/.env'), false);
    assert.match(bodies[0].state, /plain line/);
  });
  it('gives null for every item at the overall deadline', async () => {
    const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const router = await makeJevRouter({ config: { sift: { enabled: true, url: 'https://x', model: 'm', timeoutMs: 30 } }, env: { JEV_API_KEY: 'k' }, fetch: hang });
    const answers = await router({ items: [{ id: 'C1', anchors: {} }, { id: 'C2', anchors: {} }], deltaText: 'd' });
    assert.equal(answers.get('C1'), null);
    assert.equal(answers.get('C2'), null);
  });
  it('gives null for an item whose request fails', async () => {
    const router = await makeJevRouter({ config: { sift: { enabled: true, url: 'https://x', model: 'm' } }, env: { JEV_API_KEY: 'k' }, fetch: async () => ({ ok: false, status: 500, text: async () => '' }) });
    const answers = await router({ items: [{ id: 'C1', anchors: {} }], deltaText: 'd' });
    assert.equal(answers.get('C1'), null);
  });
});
