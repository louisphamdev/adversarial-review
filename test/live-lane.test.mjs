// Live checks of the zen free profile facts (spec 3.1-A, A7 facts a to d).
// These tests spend a real free-tier call, so they are skipped unless ADVERSARIAL_REVIEW_LIVE=1
// is set AND the opencode executable resolves. Each one removes its sandbox and kills every
// process it started in a finally block.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveOpencodeExe } from '../skills/adversarial-review/scripts/lib/backends/opencode.mjs';
import { writeProfileConfig, removeSandbox, PROFILE_STEPS } from '../skills/adversarial-review/scripts/lib/sandbox.mjs';
import { makeLaneCall } from '../skills/adversarial-review/scripts/lib/lane.mjs';
import { runCanary } from '../skills/adversarial-review/scripts/lib/canary.mjs';
import { killAllTrackedSync, runChild } from '../skills/adversarial-review/scripts/lib/proc.mjs';

const live = process.env.ADVERSARIAL_REVIEW_LIVE === '1' && Boolean((await resolveOpencodeExe({}, process.env)).exe);
const MODELS = ['opencode/big-pickle', 'opencode/nemotron-3.5-lightning-free'];
// big-pickle answers the one-file read with a pseudo tool-call string instead of the content
// (measured 2026-10-05, twice), so the read facts use a model that returns the text.
const FACT_MODELS = new Set(['opencode/nemotron-3.5-lightning-free']);

async function lane(profileKey) {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-live-'));
  const treeDir = path.join(runDir, 'sandbox', 'tree');
  await mkdir(treeDir, { recursive: true });
  await writeFile(path.join(treeDir, 'hello.txt'), 'hello from the tree');
  const { cwd } = await writeProfileConfig({ runDir, profileKey, treeDir, steps: PROFILE_STEPS[profileKey] });
  return { runDir, treeDir, cwd };
}

// The opencode service can hold the lane cwd for a moment after the lane ends, so the retrying
// removeSandbox runs before the plain rm: a bare rm would throw EPERM and leave the sandbox.
async function cleanup(l) {
  killAllTrackedSync();
  await removeSandbox(l.runDir);
  for (let i = 0; i < 3; i++) {
    try {
      await rm(l.runDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// The precondition of facts a to d: the engine must read the profile rule list at all. This one
// spends no model call, so it names the cause when the canary tests below report an escape.
test('live: the engine lists the profile config as a config document', { skip: !live }, async () => {
  const l = await lane('canary');
  try {
    const { exe } = await resolveOpencodeExe({}, process.env);
    const res = await runChild({ cmd: exe, args: ['debug', 'config'], cwd: l.cwd, timeoutMs: 60000 });
    let sources;
    try {
      sources = JSON.parse(res.stdout);
    } catch {
      assert.fail(`debug config returned no JSON (code ${res.code}): ${res.stdout.slice(0, 200)}${res.stderr.slice(0, 200)}`);
    }
    const docs = sources.filter((s) => s.type === 'document').map((s) => s.path);
    assert.ok(
      docs.some((p) => path.resolve(p) === path.resolve(path.join(l.cwd, 'opencode.json'))),
      `the profile rule list is not a config source; documents: ${JSON.stringify(docs)}`
    );
  } finally {
    await cleanup(l);
  }
});

for (const model of MODELS) {
  test(`live (${model}): facts a, b, c, d - tree read works under * deny with steps and the exact shell rule`, { skip: !live || !FACT_MODELS.has(model) }, async () => {
    const l = await lane('weak-find');
    try {
      const call = makeLaneCall({
        config: {},
        env: process.env,
        runDir: l.runDir,
        cwd: l.cwd,
        stage: 'TABLE',
        prompt: `Read the file "${l.treeDir.replace(/\\/g, '/')}/hello.txt" and print its content.`,
        timeoutMs: 170000,
      });
      const r = await call(model);
      assert.notEqual(r.errorType, 'provider-refused', 'the free tier accepts the profile (facts b, c, d)');
      assert.match(String(r.raw), /hello from the tree/, 'fact a: external_directory allow admits the tree');
    } finally {
      await cleanup(l);
    }
  });

  test(`live (${model}): the canary passes and leaves nothing behind`, { skip: !live }, async () => {
    const l = await lane('canary');
    try {
      const laneCallFor = ({ cwd, prompt }) =>
        makeLaneCall({ config: {}, env: process.env, runDir: l.runDir, cwd, stage: 'TABLE', prompt, timeoutMs: 170000 });
      const r = await runCanary({
        runDir: l.runDir,
        repoRoot: l.treeDir,
        treeDir: l.treeDir,
        profiles: [{ profileKey: 'canary', cwd: l.cwd, mode: 'zen' }],
        models: [model],
        laneCallFor,
      });
      assert.notEqual(r.result, 'failed', JSON.stringify(r.detail));
    } finally {
      await cleanup(l);
    }
  });
}
