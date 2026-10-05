import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createEventParser, summarizeEvents, extract } from '../skills/adversarial-review/scripts/lib/backends/opencode.mjs';
import { runSeatCall } from '../skills/adversarial-review/scripts/lib/backends/index.mjs';
import { judgeCanary } from '../skills/adversarial-review/scripts/lib/canary.mjs';

const ev = (o) => JSON.stringify(o) + '\n';

test('parser joins a line split across chunks, also inside a multi-byte character', () => {
  const got = [];
  const p = createEventParser((e) => got.push(e));
  // E_ACUTE is 2 bytes in UTF-8. Building it by code point keeps this file ASCII.
  const E_ACUTE = String.fromCharCode(0xe9);
  const word = `caf${E_ACUTE}`;
  const line = ev({ type: 'text', part: { type: 'text', text: word } });
  const buf = Buffer.from(line, 'utf8');
  const cut = buf.indexOf(Buffer.from(E_ACUTE, 'utf8')) + 1; // inside the 2-byte character
  p.push(buf.subarray(0, cut));
  p.push(buf.subarray(cut));
  p.end();
  assert.equal(got.length, 1);
  assert.equal(got[0].part.text, word);
});

test('parser skips a line that is not JSON and parses the tail at end', () => {
  const got = [];
  const p = createEventParser((e) => got.push(e));
  p.push('not json\n' + JSON.stringify({ type: 'step_start' }));
  p.end();
  assert.deepEqual(got.map((e) => e.type), ['step_start']);
});

test('summarizeEvents: cost complete only when every step_finish has a finite cost', () => {
  const ok = summarizeEvents([
    { type: 'step_start' },
    { type: 'step_finish', part: { cost: 0, tokens: { input: 10, output: 2 } } },
  ]);
  assert.equal(ok.costTotal, 0);
  assert.equal(ok.tokensTotal, 12);
  assert.equal(ok.costComplete, true);
  assert.equal(ok.stepCount, 1);
  const missing = summarizeEvents([{ type: 'step_finish', part: { tokens: { input: 5, output: 1 } } }]);
  assert.equal(missing.costComplete, false);
  assert.equal(summarizeEvents([]).costComplete, false);
});

test('summarizeEvents counts refused tool calls and maps provider errors', () => {
  const s = summarizeEvents([
    { type: 'tool_use', part: { tool: 'write', state: { status: 'error', error: 'Permission denied: edit' } } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'external_directory refused' } } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } },
    { type: 'error', error: { type: 'provider.auth', status: 403, message: 'switched off' } },
  ]);
  assert.equal(s.toolRefusals, 2);
  assert.equal(s.errorType, 'provider-refused');
  assert.equal(s.status, 403);
  assert.equal(summarizeEvents([{ type: 'error', error: { status: 429, message: 'x' } }]).errorType, 'rate-limited');
  assert.equal(summarizeEvents([{ type: 'error', error: { message: 'Rate limit hit' } }]).errorType, 'rate-limited');
});

test('extract returns the text of the last assistant message, or a typed error', () => {
  const events = [
    { type: 'text', messageID: 'm1', part: { type: 'text', text: 'old' } },
    { type: 'step_start', messageID: 'm2' },
    { type: 'text', messageID: 'm2', part: { type: 'text', text: '```json\n{"ok":true}\n' } },
    { type: 'text', messageID: 'm2', part: { type: 'text', text: '```' } },
  ];
  assert.equal(extract({ stdout: '', events }), '```json\n{"ok":true}\n```');
  assert.deepEqual(
    extract({ stdout: '', events: [{ type: 'step_start', messageID: 'm1' }, { type: 'tool_use', messageID: 'm1', part: { tool: 'read' } }] }),
    { error: 'bad-output', message: 'step cap reached' }
  );
  assert.deepEqual(extract({ stdout: '', events: [{ type: 'text', messageID: 'm1', part: { type: 'text', text: '  ' } }] }), { error: 'empty-answer', message: 'the last message has no text' });
  assert.equal(extract({ stdout: 'plain fenced text', events: [] }), 'plain fenced text');
  const err = extract({ stdout: '', events: [{ type: 'error', error: { status: 403, message: 'no' } }] });
  assert.equal(err.error, 'provider-refused');
});

test('runSeatCall returns the parsed event list, which the canary judges', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'ar-evt-'));
  try {
    const runDir = path.join(tmp, 'run');
    const cwd = path.join(runDir, 'cwd');
    await mkdir(cwd, { recursive: true });

    const ndjson =
      ev({ type: 'tool_use', part: { tool: 'write', state: { status: 'error', error: 'Permission denied: edit' } } }) +
      ev({ type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'external_directory refused' } } }) +
      ev({ type: 'error', error: { status: 403, message: 'switched off' } });

    const fakeRunChild = async ({ onStdout }) => {
      onStdout(Buffer.from(ndjson, 'utf8'));
      return { code: 0, signal: null, stdout: ndjson, stderr: '', timedOut: false, spawnError: null };
    };

    const res = await runSeatCall(
      { callId: 'c-events', prompt: 'p', root: tmp, runDir, cwd, model: 'zen/free', lane: { mode: 'zen', cwd, stage: 'FIND' } },
      { backend: { name: 'opencode', exe: 'fake-opencode' }, runChild: fakeRunChild, env: {} }
    );

    assert.equal(res.events.length, 3);
    assert.equal(res.toolRefusals, 2);
    assert.equal(judgeCanary({ events: res.events, stdout: res.raw, nonce: 'N', targetsFound: [] }), 'passed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
