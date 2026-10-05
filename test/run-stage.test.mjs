import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { makeIsolatedEnv, makeTempRepo, makeFakeBins } from './helpers/isolated-env.mjs';

const CLI = path.resolve('skills/adversarial-review/scripts/adversarial-review.mjs');
const FAKE = path.resolve('test/fixtures/fake-seat.mjs');

async function setup() {
  // A hermetic PATH, as in pipeline-cli.test.mjs: every run discovers the swarm executable
  // whatever the route is, so a real opencode on the developer PATH would answer these cases.
  const bins = await makeFakeBins({});
  const iso = await makeIsolatedEnv({ [bins.pathKey]: bins.pathEnv });
  const repo = await makeTempRepo({ git: true, files: { 'index.js': 'console.log(1);\n' } });
  await fs.writeFile(path.join(repo.root, 'index.js'), 'console.log(2);\n');
  const dir = path.join(iso.home, '.adversarial-review');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 3, hostBackend: 'custom', backends: { custom: { command: [process.execPath, FAKE] } } }));
  return { iso, repo, cleanup: async () => { await iso.cleanup(); await repo.cleanup(); await bins.cleanup(); } };
}
const runsRoot = (home) => path.join(home, '.adversarial-review', 'runs');
const allRunDirs = (home) => (existsSync(runsRoot(home))
  ? readdirSync(runsRoot(home)).flatMap((k) => readdirSync(path.join(runsRoot(home), k)).map((r) => path.join(runsRoot(home), k, r)))
  : []);

describe('review stage at run start and on resume', () => {
  it('--seats breaker --stage docs creates no run directory', async () => {
    const { iso, repo, cleanup } = await setup();
    try {
      const r = spawnSync(process.execPath, [CLI, 'run', '--route', 'spawn', '--backend', 'custom', '--seats', 'breaker', '--stage', 'docs'], { cwd: repo.root, env: iso.env, encoding: 'utf8' });
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(allRunDirs(iso.home), []);
    } finally { await cleanup(); }
  });

  it('--stage Spec stores spec in request.json', async () => {
    const { iso, repo, cleanup } = await setup();
    try {
      spawnSync(process.execPath, [CLI, 'run', '--route', 'spawn', '--backend', 'custom', '--stage', 'Spec', '--until', 'find'], { cwd: repo.root, env: iso.env, encoding: 'utf8' });
      const [dir] = allRunDirs(iso.home);
      assert.equal(JSON.parse(readFileSync(path.join(dir, 'request.json'), 'utf8')).stage, 'spec');
    } finally { await cleanup(); }
  });

  // Writes a stored legacy stage into a finished FIND run, then resumes it.
  async function resumeWithStoredStage(stored) {
    const { iso, repo, cleanup } = await setup();
    spawnSync(process.execPath, [CLI, 'run', '--route', 'spawn', '--backend', 'custom', '--until', 'find'], { cwd: repo.root, env: iso.env, encoding: 'utf8' });
    const [dir] = allRunDirs(iso.home);
    const reqPath = path.join(dir, 'request.json');
    const req = JSON.parse(readFileSync(reqPath, 'utf8'));
    req.stage = stored;
    await fs.writeFile(reqPath, JSON.stringify(req, null, 2));
    const r = spawnSync(process.execPath, [CLI, 'run', '--resume', dir], { cwd: repo.root, env: iso.env, encoding: 'utf8' });
    return { dir, reqPath, result: r, cleanup };
  }

  for (const stored of ['design', 'Spec']) {
    it(`resume of a run with a stored legacy stage "${stored}" does not stop and keeps the stored value`, async () => {
      const { reqPath, result, cleanup } = await resumeWithStoredStage(stored);
      try {
        assert.notEqual(result.status, 2, result.stderr);
        assert.equal(JSON.parse(readFileSync(reqPath, 'utf8')).stage, stored);
      } finally { await cleanup(); }
    });

    it(`resume of a run with a stored legacy stage "${stored}" uses the code prompt set`, async () => {
      const { dir, cleanup } = await resumeWithStoredStage(stored);
      try {
        const callsDir = path.join(dir, 'calls');
        const tableFile = readdirSync(callsDir).find((f) => f.startsWith('table-') && f.endsWith('.prompt.txt'));
        const prompt = readFileSync(path.join(callsDir, tableFile), 'utf8');
        assert.ok(prompt.includes('The material is source code or a diff of source code.'));
      } finally { await cleanup(); }
    });
  }
});
