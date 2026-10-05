import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeTempRepo } from './helpers/isolated-env.mjs';
import {
  hashRepo,
  compareBaseline,
  writeIntegrity,
  readIntegrity,
  safeGitArgs,
} from '../skills/adversarial-review/scripts/lib/integrity.mjs';

// The escape keeps this source file ASCII. Git quotes an accented name in `ls-files` unless
// `-z` is used, so this assertion is what proves the flag is there.
const ACCENTED = 'caf\u00e9.txt';

test('hashRepo covers tracked, untracked non-ignored, .git/config and .git/hooks; skips ignored', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': '1', '.gitignore': 'ignored.txt\n', [ACCENTED]: 'x' } });
  try {
    await writeFile(path.join(repo.root, 'new.js'), 'n');
    await writeFile(path.join(repo.root, 'ignored.txt'), 'i');
    const { files } = await hashRepo(repo.root);
    assert.ok(files['a.js'] && files['new.js'] && files[ACCENTED]);
    assert.ok(files['.git/config']);
    assert.equal(files['ignored.txt'], undefined);
  } finally { await repo.cleanup(); }
});

test('a deleted tracked file is "deleted", never a throw', async () => {
  const repo = await makeTempRepo({ files: { 'a.js': '1', 'b.js': '2' } });
  try {
    await rm(path.join(repo.root, 'b.js'));
    const { files } = await hashRepo(repo.root);
    assert.equal(files['b.js'], 'deleted');
  } finally { await repo.cleanup(); }
});

test('compareBaseline lists added, removed, modified', () => {
  const r = compareBaseline({ files: { a: '1', b: '2', c: '3' } }, { files: { a: '1', b: '9', d: '4', c: 'deleted' } });
  assert.deepEqual(r, { added: ['d'], removed: ['c'], modified: ['b'] });
});

test('integrity files are atomic and a 0-byte baseline reads as corrupt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ar-int-'));
  try {
    assert.equal((await readIntegrity(dir)).error, 'missing');
    await writeIntegrity(dir, { baseline: { files: { a: '1' } }, state: { keepSandbox: false, integrityChanged: false } });
    const ok = await readIntegrity(dir);
    assert.equal(ok.error, null);
    assert.equal(ok.baseline.files.a, '1');
    await writeFile(path.join(dir, 'integrity', 'baseline.json'), '');
    assert.equal((await readIntegrity(dir)).error, 'corrupt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('safeGitArgs disables fsmonitor and hooks', () => {
  assert.deepEqual(safeGitArgs('/e'), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/e']);
});
