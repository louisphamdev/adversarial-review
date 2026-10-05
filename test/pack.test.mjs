import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeTempRepo } from './helpers/isolated-env.mjs';
import { createSandbox } from '../skills/adversarial-review/scripts/lib/sandbox.mjs';
import { definedNames, buildContextPack } from '../skills/adversarial-review/scripts/lib/pack.mjs';

test('definedNames finds definitions and drops keywords and short names', () => {
  const diff = '+function backoffDelay(n) {\n+  if (x) {\n+const retryCount = 3;\n+class Relay {\n+def go():\n+  ab(1) {\n';
  assert.deepEqual(definedNames(diff).sort(), ['Relay', 'backoffDelay', 'retryCount']);
});

test('a tracked secret that holds a changed identifier never reaches pack.txt', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': 'export function backoffDelay(n) { return n; }\n', '.env': 'backoffDelay=SECRET_VALUE\n', 'b.js': 'backoffDelay(2);\n' } });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-export function backoffDelay(n) { return n; }\n+export function backoffDelay(n) { return n * 2; }\n';
    const material = { kind: 'diff', text: diff };
    const { treeDir } = await createSandbox({ repoRoot: repo.root, runDir, material, config: {} });
    const r = await buildContextPack({ material, treeDir, repoRoot: repo.root, packChars: 60000 });
    const text = await readFile(r.path, 'utf8');
    assert.ok(text.includes('b.js'), 'the caller is in the pack');
    assert.ok(!text.includes('SECRET_VALUE'));
    assert.ok(r.skippedSecrets >= 1);
    assert.ok(r.chars <= 60000);
  } finally { await repo.cleanup(); await rm(runDir, { recursive: true, force: true }); }
});

// The callers come from `git grep` in the repository, not from the tree, so they need the same
// secret path rule as the tree itself.
test('a tracked file under a secret path never reaches pack.txt through the callers', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': 'export function backoffDelay(n) { return n; }\n', 'hosts.yml': 'backoffDelay: HOSTS_SECRET\n', '.ssh/config': 'backoffDelay SSH_SECRET\n', 'b.js': 'backoffDelay(2);\n' } });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-export function backoffDelay(n) { return n; }\n+export function backoffDelay(n) { return n * 2; }\n';
    const material = { kind: 'diff', text: diff };
    const { treeDir } = await createSandbox({ repoRoot: repo.root, runDir, material, config: {} });
    const r = await buildContextPack({ material, treeDir, repoRoot: repo.root, packChars: 60000 });
    const text = await readFile(r.path, 'utf8');
    assert.ok(text.includes('b.js'), 'the caller is in the pack');
    assert.ok(!text.includes('HOSTS_SECRET'));
    assert.ok(!text.includes('SSH_SECRET'));
  } finally { await repo.cleanup(); await rm(runDir, { recursive: true, force: true }); }
});

// The pack goes into every swarm prompt, so a path read from the material must stay in the tree.
test('a forged +++ line in a hunk never brings an outside file into pack.txt', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': 'export const a = 1;\n' } });
  const outside = await mkdtemp(path.join(tmpdir(), 'ar-out-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    await writeFile(path.join(outside, 'outside.txt'), 'OUTSIDE_SENTINEL');
    const rel = `../${path.basename(outside)}/outside.txt`;
    const diff = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-export const a = 1;\n--- a/x\n+++ ${rel}\n`;
    const material = { kind: 'diff', text: diff };
    const { treeDir } = await createSandbox({ repoRoot: repo.root, runDir, material, config: {} });
    const r = await buildContextPack({ material, treeDir, repoRoot: repo.root, packChars: 60000 });
    const text = await readFile(r.path, 'utf8');
    assert.ok(!text.includes('OUTSIDE_SENTINEL'));
    assert.ok(text.includes('a.js (full file)'), 'the real header still brings its file');
  } finally {
    await repo.cleanup();
    await rm(outside, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

// The tree is built by createSandbox, but readTree must hold on its own: a header path that
// leaves the tree is refused even when the file exists next to it.
test('readTree refuses a header path that leaves the tree', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const treeDir = path.join(runDir, 'sandbox', 'tree');
    await mkdir(treeDir, { recursive: true });
    await writeFile(path.join(runDir, 'sandbox', 'outside.txt'), 'OUTSIDE_SENTINEL');
    const diff = 'diff --git a/../outside.txt b/../outside.txt\n--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y\n';
    const r = await buildContextPack({ material: { kind: 'diff', text: diff }, treeDir, repoRoot: runDir, packChars: 60000, runChild: async () => ({ code: 1, stdout: '' }) });
    assert.ok(!(await readFile(r.path, 'utf8')).includes('OUTSIDE_SENTINEL'));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('the pack never exceeds its budget', async () => {
  const big = 'x'.repeat(5000) + '\n';
  const repo = await makeTempRepo({ files: { 'big.txt': big.repeat(10) } });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const material = { kind: 'file', text: big.repeat(10), path: path.join(repo.root, 'big.txt') };
    const { treeDir } = await createSandbox({ repoRoot: repo.root, runDir, material, config: {} });
    const r = await buildContextPack({ material, treeDir, repoRoot: repo.root, packChars: 3000 });
    assert.ok(r.chars <= 3000);
  } finally { await repo.cleanup(); await rm(runDir, { recursive: true, force: true }); }
});

// `sections.join('\n')` adds one separator per later section, so a budget check that counts only
// the blocks writes a file longer than the budget. The error is at most one char per section, and
// it shows only when the budget falls on a section boundary. A sweep walks over every boundary.
test('the budget holds at every boundary, separators included', async () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`f${i}.txt`] = 'y'.repeat(100 + i) + '\n';
  const repo = await makeTempRepo({ files });
  const runDir = await mkdtemp(path.join(tmpdir(), 'ar-run-'));
  try {
    const material = { kind: 'dir', text: '', path: repo.root };
    const { treeDir } = await createSandbox({ repoRoot: repo.root, runDir, material, config: {} });
    let maxSections = 0;
    for (let packChars = 600; packChars <= 800; packChars++) {
      const r = await buildContextPack({ material, treeDir, repoRoot: repo.root, packChars });
      const text = await readFile(r.path, 'utf8');
      assert.equal(text.length, r.chars, `reported chars disagree with pack.txt at budget ${packChars}`);
      assert.ok(r.chars <= packChars, `pack is ${r.chars} chars at budget ${packChars}`);
      maxSections = Math.max(maxSections, r.sections);
    }
    assert.ok(maxSections >= 3, `expected several sections, got ${maxSections}`);
  } finally { await repo.cleanup(); await rm(runDir, { recursive: true, force: true }); }
});
