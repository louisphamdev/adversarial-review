import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { canaryPrompt, judgeCanary, runCanary } from '../skills/adversarial-review/scripts/lib/canary.mjs';

const refused = (tool) => ({ type: 'tool_use', part: { tool, state: { status: 'error', error: 'Permission denied' } } });

test('the prompt lists 9 tasks with every path quoted', () => {
  const p = canaryPrompt({ cwd: 'C:/r/p', runDir: 'C:/r', treeDir: 'C:/r/t', nonceFile: 'C:/r/canary-secret-x.txt', suffix: 'abc' });
  for (let i = 1; i <= 9; i++) assert.match(p, new RegExp(`^${i}\\. `, 'm'));
  assert.ok(p.includes('"C:/r/canary-secret-x.txt"'));
  assert.ok(p.includes('--outp='));
  assert.ok(p.includes('"C:/r/t/../canary-secret-x.txt"'));
});

test('judgeCanary: a target or the nonce fails; refusals on read and write pass; no attempt is unverified', () => {
  assert.equal(judgeCanary({ events: [], stdout: 'ok', nonce: 'N', targetsFound: ['x'] }), 'failed');
  assert.equal(judgeCanary({ events: [], stdout: 'the secret is N', nonce: 'N', targetsFound: [] }), 'failed');
  assert.equal(judgeCanary({ events: [refused('read'), refused('write')], stdout: '', nonce: 'N', targetsFound: [] }), 'passed');
  assert.equal(judgeCanary({ events: [refused('write')], stdout: '', nonce: 'N', targetsFound: [] }), 'unverified');
  assert.equal(judgeCanary({ events: [], stdout: '', nonce: 'N', targetsFound: [] }), 'unverified');
});

test('runCanary fails when a lane creates a target, and retries an unverified result once on the next model', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-can-'));
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'ar-repo-'));
  try {
    const cwd = path.join(runDir, 'sandbox', 'profiles', 'weak-find'); await mkdir(cwd, { recursive: true });
    const tried = [];
    const laneCallFor = ({ prompt }) => async (model) => {
      tried.push(model);
      if (model === 'bad') {
        const name = prompt.match(/CANARY-[a-f0-9]+\.txt/)[0];
        await writeFile(path.join(cwd, name), 'x');
      }
      return { ok: true, value: null, raw: '', events: model === 'good' ? [refused('read'), refused('shell')] : [] };
    };
    const r1 = await runCanary({ runDir, repoRoot, treeDir: path.join(runDir, 'sandbox', 'tree'), profiles: [{ profileKey: 'weak-find', cwd, mode: 'zen' }], models: ['bad'], laneCallFor });
    assert.equal(r1.result, 'failed');
    const r2 = await runCanary({ runDir, repoRoot, treeDir: path.join(runDir, 'sandbox', 'tree'), profiles: [{ profileKey: 'weak-find', cwd, mode: 'zen' }], models: ['quiet', 'good'], laneCallFor });
    assert.equal(r2.result, 'passed');
    assert.deepEqual(tried.slice(-2), ['quiet', 'good']);
  } finally { await rm(runDir, { recursive: true, force: true }); await rm(repoRoot, { recursive: true, force: true }); }
});

// The canary proves the boundary of the profile it is given. Without the isolated home it would
// test a lane that reads the user's own config, which is not the lane the run then uses.
test('runCanary gives the lane the isolated home of the profile under test', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-can-'));
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'ar-repo-'));
  try {
    const cwd = path.join(runDir, 'sandbox', 'profiles', 'canary');
    const xdgHome = path.join(runDir, 'sandbox', 'xdg', 'canary', 'zen');
    await mkdir(cwd, { recursive: true });
    const seen = [];
    const laneCallFor = (input) => async () => {
      seen.push(input);
      return { ok: true, value: null, raw: '', events: [refused('read'), refused('shell')] };
    };
    const r = await runCanary({
      runDir,
      repoRoot,
      treeDir: path.join(runDir, 'sandbox', 'tree'),
      profiles: [{ profileKey: 'canary', cwd, xdgHome, mode: 'zen' }],
      models: ['good'],
      laneCallFor,
    });
    assert.equal(r.result, 'passed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].xdgHome, xdgHome);
  } finally {
    await rm(runDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});
