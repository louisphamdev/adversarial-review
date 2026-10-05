import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeTempRepo } from './helpers/isolated-env.mjs';
import {
  isSecretName,
  decodeGitPath,
  createSandbox,
  writeProfileConfig,
  writeNamedConfig,
  removeSandbox,
  hasGlobChars,
  PROFILE_STEPS,
} from '../skills/adversarial-review/scripts/lib/sandbox.mjs';

// The escape keeps this source file ASCII. Git quotes an accented name unless `-z` is used,
// so this constant is what proves the flag and the octal decoder are both there.
const ACCENTED = 'caf\u00e9.txt';

test('isSecretName matches the base name and ignores case', () => {
  for (const n of [
    '.env', '.ENV.local', 'server.PEM', 'a.key', 'ID_RSA', 'id_ed25519.pub', 'id_ecdsa', 'id_dsa',
    'prod.tfvars', 'credentials.json', '.npmrc', '.netrc', '.git-credentials', '.pypirc',
    'x.pfx', 'x.jks', 'x.keystore', 'x.ppk', 'x.p12',
  ]) assert.ok(isSecretName(n), n);
  for (const n of ['env.js', 'keys.md', 'readme.txt']) assert.ok(!isSecretName(n), n);
});

test('decodeGitPath decodes the quoted octal form', () => {
  assert.equal(decodeGitPath('"caf\\303\\251.txt"'), ACCENTED);
  assert.equal(decodeGitPath('plain.txt'), 'plain.txt');
});

test('createSandbox copies tracked files, skips secrets, missing paths, and reserved names', async () => {
  const repo = await makeTempRepo({
    files: { 'src/a.js': 'export const a = 1;', '.env': 'SECRET=1', [ACCENTED]: 'c', '.ar-review/x': 'r', 'gone.js': 'g' },
  });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    await rm(path.join(repo.root, 'gone.js'));
    await writeFile(path.join(repo.root, 'untracked.js'), 'u');
    const r = await createSandbox({ repoRoot: repo.root, runDir, material: { kind: 'file', text: '' }, config: {} });
    assert.equal(r.overCap, null);
    assert.equal(await readFile(path.join(r.treeDir, 'src/a.js'), 'utf8'), 'export const a = 1;');
    assert.ok(existsSync(path.join(r.treeDir, ACCENTED)));
    assert.ok(!existsSync(path.join(r.treeDir, '.env')));
    assert.ok(!existsSync(path.join(r.treeDir, 'untracked.js')), 'untracked files are not copied unless the material holds them');
    assert.ok(!existsSync(path.join(r.treeDir, '.ar-review/x')));
    assert.equal(r.skippedSecrets, 1);
    assert.equal(r.skippedMissing, 1);
    await writeFile(path.join(r.treeDir, 'src/a.js'), 'changed');
    assert.equal(await readFile(path.join(repo.root, 'src/a.js'), 'utf8'), 'export const a = 1;', 'a copy is not a link');
  } finally {
    await repo.cleanup();
    await rm(runDir, { recursive: true, force: true });
  }
});

test('createSandbox copies an untracked file that the diff material adds', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': '1' } });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    await writeFile(path.join(repo.root, 'new.js'), 'n');
    const text = 'diff --git a/new.js b/new.js\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+n\n';
    const r = await createSandbox({ repoRoot: repo.root, runDir, material: { kind: 'diff', text }, config: {} });
    assert.equal(await readFile(path.join(r.treeDir, 'new.js'), 'utf8'), 'n');
    assert.equal(await readFile(path.join(r.treeDir, '.ar-review', 'material.diff'), 'utf8'), text);
  } finally {
    await repo.cleanup();
    await rm(runDir, { recursive: true, force: true });
  }
});

test('createSandbox reports a cap breach before copying anything', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': '1', 'b.js': '2' } });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const r = await createSandbox({ repoRoot: repo.root, runDir, material: { kind: 'file', text: '' }, config: { sandbox: { maxFiles: 1 } } });
    assert.deepEqual(r.overCap, { files: 2, bytes: 2 });
    assert.ok(!existsSync(path.join(runDir, 'sandbox', 'tree', 'a.js')));
  } finally {
    await repo.cleanup();
    await rm(runDir, { recursive: true, force: true });
  }
});

// `opencode debug config` lists `<cwd>/opencode.json` as a config document and `<cwd>/.opencode`
// as a directory of agents, commands, and plugins only. A rule list under `.opencode/` is never
// read, so the lane keeps the user's own permissions and the canary finds a real escape.
test('writeProfileConfig writes the config where opencode reads it, not under .opencode', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const { cwd } = await writeProfileConfig({ runDir, profileKey: 'probe', treeDir: 'C:\\r\\sandbox\\tree', steps: PROFILE_STEPS.probe });
    assert.ok(existsSync(path.join(cwd, 'opencode.json')), 'the project config document');
    assert.ok(!existsSync(path.join(cwd, '.opencode', 'opencode.json')), 'no rule list in the directory source');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('writeProfileConfig writes the ordered rule list with an exact shell allow', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const { cwd } = await writeProfileConfig({ runDir, profileKey: 'weak-find', treeDir: 'C:\\r\\sandbox\\tree', steps: PROFILE_STEPS['weak-find'] });
    const cfg = JSON.parse(await readFile(path.join(cwd, 'opencode.json'), 'utf8'));
    const rules = cfg.agents.build.permissions;
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(rules.some((r) => r.action === 'read' && r.resource === 'C:/r/sandbox/tree/*' && r.effect === 'allow'));
    assert.ok(rules.some((r) => r.action === 'external_directory' && r.resource === 'C:/r/sandbox/tree/*' && r.effect === 'allow'));
    const shell = rules.filter((r) => r.action === 'shell' && r.effect === 'allow');
    assert.deepEqual(shell.map((r) => r.resource), ['git --version']);
    assert.ok(rules.some((r) => r.action === 'subagent' && r.effect === 'deny'));
    assert.equal(cfg.agents.build.steps, 8);
    assert.equal(PROFILE_STEPS.canary, 10);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('writeNamedConfig keeps the provider block under sandbox/xdg so cleanup always removes it', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const { xdgHome } = await writeNamedConfig({
      runDir, profileKey: 'short', provider: 'acme', providerBlock: { options: { baseURL: 'http://127.0.0.1:1' } },
      treeDir: path.join(runDir, 'sandbox', 'tree'), steps: PROFILE_STEPS.short,
    });
    assert.equal(xdgHome, path.join(runDir, 'sandbox', 'xdg', 'short', 'acme'));
    const cfg = JSON.parse(await readFile(path.join(xdgHome, 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(cfg.provider.acme.options.baseURL, 'http://127.0.0.1:1');
    assert.equal(cfg.agents['ar-seat'].steps, 4);
    assert.deepEqual(cfg.agents['ar-seat'].permissions[0], { action: '*', resource: '*', effect: 'deny' });
    await removeSandbox(runDir, { keep: true });
    assert.ok(!existsSync(xdgHome));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('hasGlobChars flags permission metacharacters', () => {
  assert.ok(hasGlobChars('C:/a[1]/b'));
  assert.ok(!hasGlobChars('C:/Users/alice/.adversarial-review/runs/x'));
});

test('removeSandbox always deletes xdg, keeps the rest when asked, never touches integrity/', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    await mkdir(path.join(runDir, 'sandbox', 'xdg', 'p', 'acme'), { recursive: true });
    await mkdir(path.join(runDir, 'sandbox', 'tree'), { recursive: true });
    await mkdir(path.join(runDir, 'integrity'), { recursive: true });
    await removeSandbox(runDir, { keep: true });
    assert.ok(!existsSync(path.join(runDir, 'sandbox', 'xdg')));
    assert.ok(existsSync(path.join(runDir, 'sandbox', 'tree')));
    await removeSandbox(runDir, { keep: false });
    assert.ok(!existsSync(path.join(runDir, 'sandbox')));
    assert.ok(existsSync(path.join(runDir, 'integrity')));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
