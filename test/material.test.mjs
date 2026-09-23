import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveMaterial,
  hashMaterial,
  normalizeDiff,
} from '../skills/adversarial-review/scripts/lib/material.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';
import { canonicalPath } from '../skills/adversarial-review/scripts/lib/paths.mjs';
import { makeTempRepo } from './helpers/isolated-env.mjs';

describe('material module', () => {
  it('temp git repo with one commit, then modify a file and add an untracked file -> kind: diff, text lists untracked path, files >= 2', async () => {
    const { root, cleanup } = await makeTempRepo({
      git: true,
      files: { 'committed.txt': 'line 1\nline 2\n' },
    });
    try {
      // Modify committed file and add untracked file
      await writeFile(path.join(root, 'committed.txt'), 'line 1\nmodified line 2\nline 3\n');
      await writeFile(path.join(root, 'untracked.txt'), 'new untracked file content\n');

      const material = await resolveMaterial({ cwd: root });

      assert.equal(material.kind, 'diff');
      assert.equal(material.root, canonicalPath(root));
      assert.ok(typeof material.text === 'string');
      assert.ok(material.text.includes('untracked.txt'));
      assert.ok(material.text.includes('modified line 2'));
      assert.ok(material.files >= 2);
      assert.ok(material.lines > 0);
      assert.ok(typeof material.hash === 'string' && material.hash.length === 64);
    } finally {
      await cleanup();
    }
  });

  it('clean repo, no target -> throws ConfigError', async () => {
    const { root, cleanup } = await makeTempRepo({
      git: true,
      files: { 'file.txt': 'initial\n' },
    });
    try {
      await assert.rejects(
        resolveMaterial({ cwd: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      await cleanup();
    }
  });

  it('non-git dir with no target -> throws ConfigError', async () => {
    const { root, cleanup } = await makeTempRepo({ git: false, files: {} });
    try {
      await assert.rejects(
        resolveMaterial({ cwd: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      await cleanup();
    }
  });

  it('non-git dir with a file target -> root = parent dir', async () => {
    const { root, cleanup } = await makeTempRepo({
      git: false,
      files: {
        'sub/test.js': 'console.log("hello");\n',
      },
    });
    try {
      const targetPath = path.join(root, 'sub', 'test.js');
      const material = await resolveMaterial({ target: targetPath, cwd: root });

      assert.equal(material.kind, 'file');
      assert.equal(material.root, canonicalPath(path.join(root, 'sub')));
      assert.equal(material.targetPath, canonicalPath(targetPath));
      assert.equal(material.files, 1);
      assert.equal(material.lines, 1);
      assert.equal(material.text, 'console.log("hello");\n');
      assert.ok(typeof material.hash === 'string' && material.hash.length === 64);
    } finally {
      await cleanup();
    }
  });

  it('the same tree gives the same hash twice', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ar-tree-test-'));
    try {
      await mkdir(path.join(dir, 'nested', 'sub'), { recursive: true });
      await writeFile(path.join(dir, 'a.txt'), 'hello a\n');
      await writeFile(path.join(dir, 'nested', 'b.txt'), 'hello b\n');
      await writeFile(path.join(dir, 'nested', 'sub', 'c.txt'), 'hello c\n');

      const mat1 = await resolveMaterial({ target: dir, cwd: dir });
      const mat2 = await resolveMaterial({ target: dir, cwd: dir });

      assert.equal(mat1.kind, 'dir');
      assert.equal(mat2.kind, 'dir');
      assert.equal(mat1.files, 3);
      assert.equal(mat2.files, 3);
      assert.equal(mat1.hash, mat2.hash);
      assert.equal(mat1.text, undefined);

      const recomputedHash = await hashMaterial(mat1);
      assert.equal(recomputedHash, mat1.hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a CRLF diff and its LF form hash the same (test normalizeDiff directly)', () => {
    const crlfDiff = 'diff --git a/f b/f\r\n--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
    const lfDiff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n';

    const norm1 = normalizeDiff(crlfDiff);
    const norm2 = normalizeDiff(lfDiff);

    assert.equal(norm1, norm2);
    assert.ok(!norm1.includes('\r'));
  });

  it('nonexistent target throws ConfigError', async () => {
    const { root, cleanup } = await makeTempRepo({ git: false, files: {} });
    try {
      await assert.rejects(
        resolveMaterial({ target: 'does-not-exist.txt', cwd: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      await cleanup();
    }
  });

  it('hashMaterial recomputes hash accurately for diff, file, and dir', async () => {
    const { root, cleanup } = await makeTempRepo({
      git: true,
      files: { 'foo.txt': 'initial\n' },
    });
    try {
      await writeFile(path.join(root, 'foo.txt'), 'modified\n');
      const diffMat = await resolveMaterial({ cwd: root });
      const recomputedDiffHash = await hashMaterial(diffMat);
      assert.equal(recomputedDiffHash, diffMat.hash);

      const fileMat = await resolveMaterial({ target: path.join(root, 'foo.txt'), cwd: root });
      const recomputedFileHash = await hashMaterial(fileMat);
      assert.equal(recomputedFileHash, fileMat.hash);
    } finally {
      await cleanup();
    }
  });

  it('directory target in git repo sets root to git root, but non-git sets root to directory', async () => {
    const { root, cleanup } = await makeTempRepo({
      git: true,
      files: { 'src/app.js': 'console.log(1);\n' },
    });
    try {
      const mat = await resolveMaterial({ target: 'src', cwd: root });
      assert.equal(mat.kind, 'dir');
      assert.equal(mat.root, canonicalPath(root));
      assert.equal(mat.targetPath, canonicalPath(path.join(root, 'src')));
      assert.equal(mat.files, 1);
      assert.equal(mat.lines, 1);
    } finally {
      await cleanup();
    }

    const nonGitDir = await mkdtemp(path.join(tmpdir(), 'ar-nongit-'));
    try {
      await writeFile(path.join(nonGitDir, 'a.txt'), 'line 1\nline 2\n');
      const mat = await resolveMaterial({ target: nonGitDir, cwd: nonGitDir });
      assert.equal(mat.kind, 'dir');
      assert.equal(mat.root, canonicalPath(nonGitDir));
      assert.equal(mat.targetPath, canonicalPath(nonGitDir));
      assert.equal(mat.files, 1);
      assert.equal(mat.lines, 2);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
