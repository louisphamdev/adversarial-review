import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
