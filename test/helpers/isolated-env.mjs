// Every test that runs engine code must pass this env down. Without it the engine reads the
// developer's real home directory, config, and runs.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function makeIsolatedEnv(extra = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'ar-home-'));
  const env = {
    ...process.env,
    ADVERSARIAL_REVIEW_HOME: home,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
  delete env.JEV_API_KEY;
  delete env.ADVERSARIAL_REVIEW_QUOTA_PERCENT;
  Object.assign(env, extra);
  return { env, home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// files: { 'rel/path.js': 'content' }. With git: true, the files are committed once.
export async function makeTempRepo({ git: useGit = true, files = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  if (useGit) {
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init', '--allow-empty']);
  }
  return { root, git: (args) => git(root, args), cleanup: () => rm(root, { recursive: true, force: true }) };
}
