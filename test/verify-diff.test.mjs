import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBase,
  resolveBase,
  collectDiff,
  unquoteGitPath,
  normalizeSeatPath,
  splitFileBlocks,
  diffRanges,
  interdiff,
  isChangedLine,
} from '../skills/adversarial-review/scripts/lib/verify-diff.mjs';

const blockA = [
  'diff --git a/lib/a.mjs b/lib/a.mjs',
  'index 1..2 100644',
  '--- a/lib/a.mjs',
  '+++ b/lib/a.mjs',
  '@@ -10,4 +10,4 @@',
  ' keep',
  '-if (!ok) throw new Error("guard");',
  '+doWork();',
  ' keep',
  ' keep',
].join('\n');
const blockCafe = [
  'diff --git a/lib/café.mjs b/lib/café.mjs',
  '--- a/lib/café.mjs',
  '+++ b/lib/café.mjs',
  '@@ -1,0 +1,2 @@',
  '+one',
  '+two',
].join('\n');
const blockSpace = [
  'diff --git "a/a b.mjs" "b/a b.mjs"',
  '--- "a/a b.mjs"',
  '+++ "b/a b.mjs"',
  '@@ -3,1 +3,1 @@',
  '-old',
  '+new',
].join('\n');

describe('validateBase', () => {
  it('accepts ref names and refuses option injection', () => {
    assert.equal(validateBase('HEAD~1'), 'HEAD~1');
    assert.equal(validateBase('origin/main'), 'origin/main');
    assert.throws(() => validateBase('--output=x'), (e) => e.exitCode === 2);
    assert.throws(() => validateBase('a;b'), (e) => e.exitCode === 2);
  });
});

describe('paths', () => {
  it('unquotes git C-style paths, octal UTF-8 included', () => {
    assert.equal(unquoteGitPath('"a b.mjs"'), 'a b.mjs');
    assert.equal(unquoteGitPath('"caf\\303\\251.mjs"'), 'café.mjs');
  });
  it('normalizes a seat path', () => {
    assert.equal(normalizeSeatPath('.\\lib\\a.mjs'), 'lib/a.mjs');
    assert.equal(normalizeSeatPath('./lib/a.mjs'), 'lib/a.mjs');
  });
});

describe('splitFileBlocks and diffRanges', () => {
  const diff = [blockA, blockCafe, blockSpace].join('\n');
  it('keys blocks by normalized path', () => {
    const m = splitFileBlocks(diff);
    assert.ok(m.has('lib/a.mjs'));
    assert.ok(m.has('lib/café.mjs'));
    assert.ok(m.has('a b.mjs'));
  });
  it('gives added and removed ranges', () => {
    const r = diffRanges(diff);
    assert.deepEqual(r.get('lib/a.mjs').removed, [[11, 11]]);
    assert.deepEqual(r.get('lib/a.mjs').added, [[11, 11]]);
    assert.deepEqual(r.get('lib/café.mjs').added, [[1, 2]]);
  });
  it('keys a rename block by both paths', () => {
    const ren = ['diff --git a/old.mjs b/new.mjs', 'similarity index 90%', 'rename from old.mjs', 'rename to new.mjs', '--- a/old.mjs', '+++ b/new.mjs', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n');
    const m = splitFileBlocks(ren);
    assert.ok(m.has('old.mjs') && m.has('new.mjs'));
  });
});

describe('isChangedLine', () => {
  const ranges = diffRanges(blockA);
  it('accepts a removed line with side old', () => {
    assert.equal(isChangedLine({ ranges, untracked: [], entry: { file: 'lib/a.mjs', line: 11, side: 'old' } }), true);
  });
  it('refuses a context line', () => {
    assert.equal(isChangedLine({ ranges, untracked: [], entry: { file: 'lib/a.mjs', line: 13, side: 'new' } }), false);
  });
  it('accepts any line of an untracked new file', () => {
    assert.equal(isChangedLine({ ranges, untracked: ['lib/new.mjs'], entry: { file: './lib/new.mjs', line: 40, side: 'new' } }), true);
  });
});

describe('interdiff', () => {
  it('includes a reverted file', () => {
    const t = interdiff({ diff: [blockA, blockCafe].join('\n'), untracked: [] }, { diff: blockCafe, untracked: [] });
    assert.match(t, /reverted: lib\/a\.mjs/);
  });
  it('includes untracked changes', () => {
    const t = interdiff({ diff: blockA, untracked: [] }, { diff: blockA, untracked: ['x.mjs'] });
    assert.match(t, /untracked added: x\.mjs/);
  });
  it('is empty for equal diffs', () => {
    assert.equal(interdiff({ diff: blockA, untracked: [] }, { diff: blockA, untracked: [] }), '');
  });
});

describe('collectDiff and resolveBase', () => {
  const fakeFs = (files) => ({
    lstat: async (p) => {
      const k = Object.keys(files).find((f) => p.replace(/\\/g, '/').endsWith(f));
      if (!k) throw new Error('ENOENT');
      return { isSymbolicLink: () => false, size: files[k].length };
    },
    readlink: async () => '',
    readFile: async (p) => Buffer.from(files[Object.keys(files).find((f) => p.replace(/\\/g, '/').endsWith(f))]),
  });
  it('runs git with core.quotepath=false, reads -z names, hashes untracked content, and never touches the index', async () => {
    const calls = [];
    const runChild = async ({ cmd, args }) => {
      calls.push([cmd, ...args]);
      if (args.includes('diff')) return { code: 0, stdout: `${blockA}\n`, stderr: '' };
      return { code: 0, stdout: 'new.mjs\0', stderr: '' };
    };
    const r1 = await collectDiff('/repo', 'abc123', runChild, { fsImpl: fakeFs({ 'new.mjs': 'one' }) });
    const r2 = await collectDiff('/repo', 'abc123', runChild, { fsImpl: fakeFs({ 'new.mjs': 'two' }) });
    assert.equal(r1.untracked[0].path, 'new.mjs');
    assert.match(r1.untracked[0].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(r1.diffHash, r2.diffHash, 'an untracked-only edit changes the hash');
    assert.match(interdiff(r1, r2), /untracked changed: new\.mjs/);
    assert.ok(calls.every((c) => !c.includes('add')));
    assert.ok(calls[0].includes('core.quotepath=false'));
    assert.ok(calls[1].includes('-z'));
  });
  it('resolveBase uses --end-of-options and refuses option injection', async () => {
    const calls = [];
    const runChild = async ({ args }) => {
      calls.push(args);
      return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    };
    assert.equal(await resolveBase('/r', 'HEAD~1', runChild), 'deadbeef');
    assert.ok(calls[0].includes('--end-of-options'));
    assert.ok(calls[0].includes('HEAD~1^{commit}'));
    await assert.rejects(() => resolveBase('/r', '--output=x', runChild), (e) => e.exitCode === 2);
  });
  it('keys a deleted file by its --- path and a binary block by its diff --git line', () => {
    const del = ['diff --git a/gone.mjs b/gone.mjs', 'deleted file mode 100644', '--- a/gone.mjs', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');
    const bin = ['diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ'].join('\n');
    const m = splitFileBlocks(`${del}\n${bin}`);
    assert.ok(m.has('gone.mjs'));
    assert.ok(m.has('img.png'));
    assert.equal(m.has('/dev/null'), false);
    const r = diffRanges(del);
    assert.equal(isChangedLine({ ranges: r, untracked: [], entry: { file: 'gone.mjs', line: 2, side: 'old' } }), true);
  });
  it('keys a quoted binary block by both paths of its diff --git line', () => {
    const bin = ['diff --git "a/my img.png" "b/my img.png"', 'Binary files "a/my img.png" and "b/my img.png" differ'].join('\n');
    assert.deepEqual([...splitFileBlocks(bin).keys()], ['my img.png']);
    const mode = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n');
    assert.ok(splitFileBlocks(mode).has('run.sh'));
  });
  it('exits 2 outside a git repository', async () => {
    const runChild = async () => ({ code: 128, stdout: '', stderr: 'not a git repository' });
    await assert.rejects(() => collectDiff('/x', 'abc', runChild), (e) => e.exitCode === 2 && /git repository/.test(e.message));
  });
  it('exits 2 on an empty diff with no untracked file', async () => {
    const runChild = async () => ({ code: 0, stdout: '', stderr: '' });
    await assert.rejects(() => collectDiff('/x', 'abc', runChild), (e) => e.exitCode === 2);
  });
});
