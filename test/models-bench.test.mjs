import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeBenchCall } from '../skills/adversarial-review/scripts/lib/cli/models.mjs';

test('bench runs the breaker seat FIND on the bundled fixture, with the FIND timeout', async () => {
  let seen;
  const benchCall = makeBenchCall({
    config: { timeouts: { find: 1200000 } },
    env: process.env,
    runSeatCall: async (call) => { seen = call; return { ok: true, value: { findings: [] } }; },
  });
  await benchCall({ backend: 'opencode', model: 'a/b' });
  assert.match(seen.prompt, /Stage: FIND/);
  assert.match(seen.prompt, /rt-breaker|Breaker/);
  assert.ok(seen.prompt.includes(path.join('bench', 'defects.js')), 'prompt names the fixture file');
  assert.equal(seen.timeoutMs, 1200000);
  assert.equal(path.basename(seen.root), 'bench');
  assert.equal(seen.model, 'a/b');
});
