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

// A hermetic PATH: fake vendor CLIs plus the directory of git, nothing else. Tests that pass
// on the developer machine only because a real `claude` or `opencode` is installed break in CI.
// A value is a version string, or { version, models: [ids] } for a CLI that lists models.
export async function makeFakeBins(names = { claude: '2.1.280 (Claude Code)' }) {
  const { chmod } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'ar-bin-'));
  for (const [name, spec] of Object.entries(names)) {
    const version = typeof spec === 'string' ? spec : spec.version;
    const models = typeof spec === 'string' ? [] : spec.models || [];
    const body =
      `const a = process.argv.slice(2);\n` +
      `if (a.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\n` +
      `if (a[0] === 'models') { console.log(${JSON.stringify(models.join('\n'))}); process.exit(0); }\n` +
      `console.log('\`\`\`json\\n{"ok":true}\\n\`\`\`');\n`;
    if (process.platform === 'win32') {
      await writeFile(path.join(dir, `${name}.mjs`), body);
      await writeFile(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0\\${name}.mjs" %*\r\n`);
    } else {
      const file = path.join(dir, name);
      await writeFile(file, `#!${process.execPath}\n${body}`);
      await chmod(file, 0o755);
    }
  }
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const gitExe = process.platform === 'win32' ? 'git.exe' : 'git';
  const { existsSync } = await import('node:fs');
  const gitDir = (process.env[pathKey] || '').split(path.delimiter).find((d) => d && existsSync(path.join(d, gitExe)));
  const pathEnv = [dir, gitDir].filter(Boolean).join(path.delimiter);
  return { dir, pathKey, pathEnv, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
