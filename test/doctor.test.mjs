import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeIsolatedEnv, makeFakeBins } from './helpers/isolated-env.mjs';
import { writeSwarmBin } from './helpers/run-fixture.mjs';
import { main } from '../skills/adversarial-review/scripts/lib/cli/main.mjs';

function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

test('doctor reads host installs from the manifest, not from guessed paths', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)', opencode: 'opencode v2.0.9' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const state = path.join(home, '.adversarial-review');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'install-v3.json'), JSON.stringify({
      version: 3,
      files: {
        [path.join(home, '.agents', 'skills', 'adversarial-review', 'x.md')]: { hash: 'h', owners: ['user:opencode', 'user:codex'] },
        [path.join(home, 'repo', '.agents', 'skills', 'adversarial-review', 'y.md')]: { hash: 'h', owners: [`project:${path.join(home, 'repo')}:gemini`] },
      },
    }));
    const stdout = sink();
    const code = await main(['doctor'], { env, cwd: home, stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.match(stdout.text, /opencode: installed \(user\)/);
    assert.match(stdout.text, /codex: installed \(user\)/);
    assert.match(stdout.text, /gemini: installed \(project/);
    assert.match(stdout.text, /claude-code: not installed/);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor reports the opencode exe, isolation, and fails on an opencode major version that is not 2', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ opencode: '1.9.0', claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const stdout = sink();
    const code = await main(['doctor'], { env, stdout, stderr: sink() });
    const text = stdout.text;
    assert.match(text, /isolation: sandbox copy \+ permission profile/);
    assert.match(text, /os-isolation: none/);
    assert.match(text, /opencode: major version 1 is not supported \(need 2\.x\)/);
    // The old v1 seat agent file is absent here, so the line must not appear at all.
    assert.doesNotMatch(text, /opencode seat agent/);
    assert.equal(code, 1);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor keeps exit 0 when the opencode version string holds no dotted triple', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ opencode: 'some garbage', claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const stdout = sink();
    const code = await main(['doctor'], { env, stdout, stderr: sink() });
    const text = stdout.text;
    // The exe was found and its version was read, so the parse branch really ran.
    assert.match(text, /opencode: .*\[some garbage\]/);
    // An unreadable version says nothing about the major, so it is not a failure.
    assert.doesNotMatch(text, /major version/);
    assert.equal(code, 0);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor lists the v1 seat agent only when the old file is on disk', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ opencode: 'opencode v2.0.9', claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const agents = path.join(home, '.config', 'opencode', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, 'adversarial-review-seat.md'), '# old\n');
    const stdout = sink();
    const code = await main(['doctor'], { env, stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.match(stdout.text, /opencode seat agent \(v1, unused\): present/);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor removes sandbox/xdg of a run with no live lock and keeps the one a live pid holds', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ opencode: 'opencode v2.0.9', claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const runs = path.join(home, '.adversarial-review', 'runs', 'abc123-repo');
    const stale = path.join(runs, '20260101T000000Z-aaaa');
    const held = path.join(runs, '20260101T000001Z-bbbb');
    for (const dir of [stale, held]) {
      await mkdir(path.join(dir, 'sandbox', 'xdg', 'canary', 'zai'), { recursive: true });
      await writeFile(path.join(dir, 'sandbox', 'xdg', 'canary', 'zai', 'opencode.json'), '{}');
      await mkdir(path.join(dir, 'sandbox', 'tree'), { recursive: true });
    }
    await writeFile(path.join(stale, 'lock'), JSON.stringify({ pid: 0x7fffffff, token: 't', createdAt: Date.now() }));
    await writeFile(path.join(held, 'lock'), JSON.stringify({ pid: process.pid, token: 't', createdAt: Date.now() }));

    const stdout = sink();
    const code = await main(['doctor'], { env, stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.match(stdout.text, /stale sandbox\/xdg removed: 1/);
    assert.equal(existsSync(path.join(stale, 'sandbox', 'xdg')), false);
    // The tree of a cleaned run stays: only the key directory is stale state.
    assert.equal(existsSync(path.join(stale, 'sandbox', 'tree')), true);
    assert.equal(existsSync(path.join(held, 'sandbox', 'xdg')), true);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor --probe says so instead of throwing when no callable model is stored', async () => {
  const { env, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ opencode: 'opencode v2.0.9', claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    const stdout = sink();
    const code = await main(['doctor', '--probe'], { env, stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.match(stdout.text, /canary: no callable model stored/);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});

test('doctor --probe runs the canary on the fastest stored callable model and reports an escape', async () => {
  const { env, home, cleanup } = await makeIsolatedEnv();
  const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
  env[bins.pathKey] = bins.pathEnv;
  try {
    await writeSwarmBin({ dir: bins.dir, models: ['opencode/fast', 'opencode/slow'], escapeSandbox: true });
    const state = path.join(home, '.adversarial-review');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'models.json'), JSON.stringify({
      version: 4,
      'opencode:opencode/slow': { backend: 'opencode', model: 'opencode/slow', callable: true, latencyMs: 9000 },
      'opencode:opencode/fast': { backend: 'opencode', model: 'opencode/fast', callable: true, latencyMs: 100 },
      'opencode:opencode/broken': { backend: 'opencode', model: 'opencode/broken', callable: false, latencyMs: 1 },
    }, null, 2));

    const stdout = sink();
    const code = await main(['doctor', '--probe'], { env, stdout, stderr: sink() });
    assert.equal(code, 0);
    assert.match(stdout.text, /canary: failed \(opencode\/fast\)/);
  } finally {
    await bins.cleanup();
    await cleanup();
  }
});
