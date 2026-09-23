import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { makeIsolatedEnv, makeFakeBins } from './helpers/isolated-env.mjs';
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
