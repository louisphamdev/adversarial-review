import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  siftFindings,
  findKey,
  buildState,
  buildQuestions,
  compareSift,
  clusterFindings,
  VERDICTS,
  SEVERITY,
  TYPESAFE_API_URL,
  TYPESAFE_DEFAULT_MODEL,
} from '../skills/adversarial-review/scripts/lib/sift.mjs';

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
    server.on('error', reject);
  });
}

describe('sift module', () => {
  describe('buildState and buildQuestions', () => {
    it('buildState contains material once and findings with ids and seats', () => {
      const material = 'const x = 1;';
      const findings = [
        { id: 'b-1', seat: 'breaker', claim: 'off-by-one', evidence: 'file.js:1' },
        { id: 'e-1', seat: 'edge', title: 'empty array', evidence: 'file.js:2' },
      ];
      const state = buildState(material, findings);
      assert.ok(state.includes('MATERIAL\nconst x = 1;\n\nFINDINGS\n'));
      assert.ok(state.includes('b-1 [breaker] off-by-one | file.js:1'));
      assert.ok(state.includes('e-1 [edge] empty array | file.js:2'));
      // Material appears exactly once
      assert.equal(state.split('const x = 1;').length, 2);
    });

    it('buildQuestions creates verdict and severity questions with exact criteria', () => {
      const findings = [{ id: 'b-1', seat: 'breaker', claim: 'bad null' }];
      const questions = buildQuestions(findings);

      assert.deepEqual(questions['b-1_verdict'], {
        type: 'choice',
        instructions: 'b-1',
        criteria: VERDICTS,
      });
      assert.deepEqual(questions['b-1_severity'], {
        type: 'score',
        instructions: 'b-1 severity',
        criteria: SEVERITY,
      });
      assert.deepEqual(Object.keys(VERDICTS), ['confirmed', 'disputed', 'refuted', 'advisory']);
      assert.deepEqual(SEVERITY, ['advisory', 'should fix', 'blocks release']);
    });
  });

  describe('findKey', () => {
    it('returns null on empty env and empty keyFile', async () => {
      assert.equal(await findKey({}, {}), null);
      assert.equal(await findKey({ apiKeyEnv: 'JEV_API_KEY' }, {}), null);
    });

    it('returns null on whitespace-only key in env', async () => {
      assert.equal(await findKey({}, { JEV_API_KEY: '   ' }), null);
    });

    it('trims and returns key from env', async () => {
      assert.equal(await findKey({}, { JEV_API_KEY: '  secret-k  ' }), 'secret-k');
    });

    it('reads key from keyFile with CRLF line JEV_API_KEY=k\\r\\n', async () => {
      const readFile = async (filePath) => {
        assert.equal(filePath, '/custom/path.env');
        return 'OTHER_VAR=abc\r\nJEV_API_KEY=k\r\nFOO=bar';
      };
      const key = await findKey({ keyFile: '/custom/path.env' }, {}, readFile);
      assert.equal(key, 'k');
    });

    it('returns null when keyFile line has empty value', async () => {
      const readFile = async () => 'JEV_API_KEY=   \r\n';
      const key = await findKey({ keyFile: '/custom/path.env' }, {}, readFile);
      assert.equal(key, null);
    });

    it('returns null when readFile throws', async () => {
      const readFile = async () => {
        throw new Error('ENOENT');
      };
      const key = await findKey({ keyFile: '/missing.env' }, {}, readFile);
      assert.equal(key, null);
    });
  });

  describe('siftFindings behavior', () => {
    it('used: sends expected request and parses verdict, severity, and readingOrder', async () => {
      let receivedHeaders = null;
      let receivedBody = null;

      const server = await createServer(async (req, res) => {
        receivedHeaders = req.headers;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'm',
            answers: {
              'b-1_verdict': { choice: 'refuted', confidence: 0.4 },
              'b-1_severity': { score: 1.8 },
            },
            usage: { input_tokens: 10, output_tokens: 0 },
          }),
        );
      });

      try {
        const material = { kind: 'diff', text: 'diff --git a/x b/x\n+test' };
        const findings = [{ id: 'b-1', seat: 'breaker', claim: 'null error', evidence: 'x:1' }];
        const result = await siftFindings({
          material,
          findings,
          config: { url: server.url },
          env: { JEV_API_KEY: 'k' },
        });

        assert.equal(result.status, 'used');
        assert.equal(result.model, 'm');
        assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 0 });
        assert.deepEqual(result.readingOrder, ['b-1']);
        assert.equal(result.rows.length, 1);
        assert.deepEqual(result.rows[0], {
          id: 'b-1',
          seat: 'breaker',
          verdict: 'refuted',
          confidence: 0.4,
          severity: 1.8,
        });

        // Verify request details
        assert.equal(receivedHeaders.authorization, 'Bearer k');
        assert.ok(receivedBody.state.includes('diff --git a/x b/x\n+test'));
        assert.equal(receivedBody.state.split('diff --git a/x b/x\n+test').length, 2);
        assert.ok('b-1_verdict' in receivedBody.questions);
        assert.ok('b-1_severity' in receivedBody.questions);
      } finally {
        await server.close();
      }
    });

    it('no-key: skips when env is empty or whitespace-only', async () => {
      const material = { kind: 'diff', text: 'diff' };
      const findings = [{ id: 'b-1', seat: 'breaker', claim: 'c' }];

      const resEmpty = await siftFindings({
        material,
        findings,
        config: {},
        env: {},
      });
      assert.deepEqual(resEmpty, { status: 'skipped', reason: 'no-key', rows: [], readingOrder: [] });

      const resWhitespace = await siftFindings({
        material,
        findings,
        config: {},
        env: { JEV_API_KEY: '   ' },
      });
      assert.deepEqual(resWhitespace, { status: 'skipped', reason: 'no-key', rows: [], readingOrder: [] });
    });

    it('key from keyFile with CRLF line JEV_API_KEY=k\\r\\n works', async () => {
      const server = await createServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer k');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            answers: {
              'b-1_verdict': { choice: 'confirmed', confidence: 0.9 },
              'b-1_severity': { score: 1.0 },
            },
          }),
        );
      });

      try {
        const result = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
          config: { url: server.url, keyFile: '/env/file' },
          env: {},
          readFile: async () => 'JEV_API_KEY=k\r\n',
        });
        assert.equal(result.status, 'used');
      } finally {
        await server.close();
      }
    });

    it('http 500 skips with http-500', async () => {
      const server = await createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal server error');
      });

      try {
        const result = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
          config: { url: server.url },
          env: { JEV_API_KEY: 'k' },
        });
        assert.equal(result.status, 'skipped');
        assert.equal(result.reason, 'http-500');
      } finally {
        await server.close();
      }
    });

    it('stalled body times out within 1.3 s when timeoutMs is 300', async () => {
      const server = await createServer((req, res) => {
        // Write head and never finish or send body
        res.writeHead(200, { 'Content-Type': 'application/json' });
      });

      try {
        const start = Date.now();
        const result = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
          config: { url: server.url, timeoutMs: 300 },
          env: { JEV_API_KEY: 'k' },
        });
        const elapsed = Date.now() - start;

        assert.equal(result.status, 'skipped');
        assert.equal(result.reason, 'timeout');
        assert.ok(elapsed < 1300, `Expected timeout < 1.3s, took ${elapsed}ms`);
      } finally {
        await server.close();
      }
    });

    it('skips on directory material with material-is-directory', async () => {
      const result = await siftFindings({
        material: { kind: 'dir', text: '' },
        findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
        config: {},
        env: { JEV_API_KEY: 'k' },
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'material-is-directory');
    });

    it('skips on state over budget (> 100000 chars) with state-over-budget', async () => {
      const findings = [{ id: 'b-1', seat: 'breaker', claim: 'c' }];
      // Build material such that state is exactly 100001 chars
      const baseState = buildState('', findings);
      const needed = 100001 - baseState.length;
      const result = await siftFindings({
        material: { kind: 'diff', text: 'a'.repeat(needed) },
        findings,
        config: {},
        env: { JEV_API_KEY: 'k' },
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'state-over-budget');
    });

    it('skips on zero findings with no-findings', async () => {
      const result = await siftFindings({
        material: { kind: 'diff', text: 'diff' },
        findings: [],
        config: {},
        env: { JEV_API_KEY: 'k' },
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'no-findings');
    });

    it('skips when enabled is false with disabled', async () => {
      const result = await siftFindings({
        material: { kind: 'diff', text: 'diff' },
        findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
        config: { enabled: false },
        env: { JEV_API_KEY: 'k' },
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'disabled');
    });

    it('skips on malformed JSON or missing answers with bad-response', async () => {
      const server1 = await createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('invalid json');
      });

      try {
        const res1 = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
          config: { url: server1.url },
          env: { JEV_API_KEY: 'k' },
        });
        assert.equal(res1.status, 'skipped');
        assert.equal(res1.reason, 'bad-response');
      } finally {
        await server1.close();
      }

      const server2 = await createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'm' })); // No answers
      });

      try {
        const res2 = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
          config: { url: server2.url },
          env: { JEV_API_KEY: 'k' },
        });
        assert.equal(res2.status, 'skipped');
        assert.equal(res2.reason, 'bad-response');
      } finally {
        await server2.close();
      }
    });

    it('skips on network error with network', async () => {
      const result = await siftFindings({
        material: { kind: 'diff', text: 'diff' },
        findings: [{ id: 'b-1', seat: 'breaker', claim: 'c' }],
        config: { url: 'http://127.0.0.1:1' }, // Unused port fails immediately
        env: { JEV_API_KEY: 'k' },
      });
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'network');
    });

    it('orders readingOrder by confidence ascending for confidences < lowConfidence', async () => {
      const server = await createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            answers: {
              'b-1_verdict': { choice: 'confirmed', confidence: 0.5 },
              'b-1_severity': { score: 1.0 },
              'b-2_verdict': { choice: 'disputed', confidence: 0.2 },
              'b-2_severity': { score: 1.0 },
              'b-3_verdict': { choice: 'confirmed', confidence: 0.7 },
              'b-3_severity': { score: 1.0 },
            },
          }),
        );
      });

      try {
        const result = await siftFindings({
          material: { kind: 'diff', text: 'diff' },
          findings: [
            { id: 'b-1', seat: 'breaker', claim: 'c1' },
            { id: 'b-2', seat: 'breaker', claim: 'c2' },
            { id: 'b-3', seat: 'breaker', claim: 'c3' },
          ],
          config: { url: server.url, lowConfidence: 0.6 },
          env: { JEV_API_KEY: 'k' },
        });
        assert.equal(result.status, 'used');
        assert.deepEqual(result.readingOrder, ['b-2', 'b-1']);
      } finally {
        await server.close();
      }
    });
  });

  describe('compareSift', () => {
    it('detects judge keeping a finding that Jev refuted with confidence >= 0.8', () => {
      const sift = {
        status: 'used',
        rows: [{ id: 'b-1', seat: 'breaker', verdict: 'refuted', confidence: 0.9, severity: 0.5 }],
      };
      const ruling = {
        closingList: [{ sources: ['b-1', 'x-lc1'] }],
      };
      const findings = [{ id: 'b-1', seat: 'breaker' }];

      const res = compareSift(sift, ruling, findings);
      assert.equal(res.disagreements.length, 1);
      assert.equal(res.disagreements[0].id, 'b-1');
      assert.equal(res.disagreements[0].verdict, 'refuted');
    });

    it('ignores sources with no sift row (e.g. last-call items)', () => {
      const sift = {
        status: 'used',
        rows: [{ id: 'b-1', seat: 'breaker', verdict: 'confirmed', confidence: 0.9, severity: 1.0 }],
      };
      const ruling = {
        closingList: [{ sources: ['b-1', 'x-lc1'] }],
      };
      const findings = [{ id: 'b-1', seat: 'breaker' }];

      const res = compareSift(sift, ruling, findings);
      assert.equal(res.disagreements.length, 0);
    });

    it('detects judge dropping a finding that Jev confirmed with confidence >= 0.8 and severity >= 1.5', () => {
      const sift = {
        status: 'used',
        rows: [
          { id: 'b-1', seat: 'breaker', verdict: 'confirmed', confidence: 0.85, severity: 1.6 },
          { id: 'b-2', seat: 'breaker', verdict: 'confirmed', confidence: 0.85, severity: 1.2 }, // severity too low
          { id: 'b-3', seat: 'breaker', verdict: 'confirmed', confidence: 0.7, severity: 1.8 }, // confidence too low
        ],
      };
      const ruling = {
        closingList: [], // All dropped
      };
      const findings = [
        { id: 'b-1', seat: 'breaker' },
        { id: 'b-2', seat: 'breaker' },
        { id: 'b-3', seat: 'breaker' },
      ];

      const res = compareSift(sift, ruling, findings);
      assert.equal(res.disagreements.length, 1);
      assert.equal(res.disagreements[0].id, 'b-1');
      assert.equal(res.disagreements[0].verdict, 'confirmed');
    });

    it('returns empty disagreements when sift was skipped or ruling is missing', () => {
      assert.deepEqual(compareSift({ status: 'skipped' }, { closingList: [] }, []), {
        disagreements: [],
      });
      assert.deepEqual(compareSift(null, { closingList: [] }, []), { disagreements: [] });
      assert.deepEqual(compareSift({ status: 'used', rows: [] }, null, []), { disagreements: [] });
    });
  });

  describe('clusterFindings and TypeSafe native routing', () => {
    it('clusterFindings groups findings on same file and line, selecting highest confidence/severity canonical', () => {
      const findings = [
        { id: 'b-1', seat: 'breaker', file: 'src/app.js', line: 42, claim: 'null pointer' },
        { id: 'e-1', seat: 'edge', file: 'src/app.js', line: 42, claim: 'undefined input' },
        { id: 'm-1', seat: 'medic', file: 'src/other.js', line: 10, claim: 'missing rollback' },
      ];
      const rows = [
        { id: 'b-1', severity: 1.0, confidence: 0.7 },
        { id: 'e-1', severity: 2.0, confidence: 0.9 }, // higher severity and confidence
        { id: 'm-1', severity: 1.5, confidence: 0.8 },
      ];

      const clusters = clusterFindings(findings, rows);
      assert.equal(clusters.length, 1);
      assert.equal(clusters[0].key, 'src/app.js:42');
      assert.equal(clusters[0].canonical, 'e-1');
      assert.deepEqual(clusters[0].duplicates, ['b-1']);
      assert.equal(clusters[0].count, 2);
    });

    it('findKey falls back to TYPESAFE_API_KEY when JEV_API_KEY is not set', async () => {
      const key = await findKey({}, { TYPESAFE_API_KEY: 'ts_test_key_123' });
      assert.equal(key, 'ts_test_key_123');
    });

    it('siftFindings routes to native TypeSafe endpoint when TYPESAFE_API_KEY is present without JEV_API_KEY', async () => {
      let requestedUrl = null;
      let requestedBody = null;
      const server = await createServer(async (req, res) => {
        requestedUrl = req.url;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requestedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            answers: {
              'b-1_verdict': { choice: 'confirmed', confidence: 0.95 },
              'b-1_severity': { score: 2.0 },
              'b-2_verdict': { choice: 'refuted', confidence: 0.9 },
              'b-2_severity': { score: 0.5 },
            },
          }),
        );
      });

      try {
        const material = { kind: 'diff', text: 'code diff' };
        const findings = [
          { id: 'b-1', seat: 'breaker', file: 'a.js', line: 5, claim: 'leak' },
          { id: 'b-2', seat: 'breaker', file: 'b.js', line: 10, claim: 'false alarm' },
        ];
        const result = await siftFindings({
          material,
          findings,
          config: { url: server.url },
          env: { TYPESAFE_API_KEY: 'ts_secret' },
        });

        assert.equal(result.status, 'used');
        assert.deepEqual(result.highConfidenceConfirmed, ['b-1']);
        assert.deepEqual(result.filteredOut, ['b-2']);
        assert.equal(result.clusters.length, 0);
      } finally {
        await server.close();
      }
    });
  });
});
