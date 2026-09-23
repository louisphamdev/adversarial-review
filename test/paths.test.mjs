import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  homeDir,
  stateDir,
  normalizeWinPath,
  canonicalPath,
  safeName,
  repoKey,
  runsDir,
  isInside,
} from '../skills/adversarial-review/scripts/lib/paths.mjs';
import { makeIsolatedEnv, makeTempRepo } from './helpers/isolated-env.mjs';

test('paths module', async (t) => {
  await t.test('normalizeWinPath', () => {
    assert.equal(normalizeWinPath('\\\\?\\C:\\Users\\A\\Repo'), 'c:/users/a/repo');
    assert.equal(normalizeWinPath('C:\\Users\\A\\Repo'), 'c:/users/a/repo');
    assert.equal(normalizeWinPath('\\\\?\\UNC\\server\\share\\Repo'), '//server/share/repo');
    assert.equal(normalizeWinPath('c:/users/a/repo'), 'c:/users/a/repo');
    assert.equal(normalizeWinPath(''), '');
  });

  await t.test('canonicalPath', async () => {
    assert.equal(canonicalPath('\\\\?\\C:\\Users\\A\\Repo', 'win32'), 'c:/users/a/repo');
    const { root, cleanup } = await makeTempRepo({ git: false });
    try {
      const real = fs.realpathSync.native(root);
      assert.equal(canonicalPath(root, 'linux'), real);
      assert.equal(canonicalPath(root, 'darwin'), real.toLowerCase());
    } finally {
      await cleanup();
    }
  });

  await t.test('safeName', () => {
    assert.equal(safeName('normal-name_1.2'), 'normal-name_1.2');
    assert.equal(safeName('my repo (1) : test * ?'), 'my_repo__1____test____');
    assert.equal(safeName(''), '');
  });

  await t.test('repoKey', async () => {
    const { root: dir1, cleanup: c1 } = await makeTempRepo({ git: false });
    const { root: dir2, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const key1a = repoKey(dir1);
      const key1b = repoKey(dir1);
      const key2 = repoKey(dir2);

      assert.equal(key1a, key1b);
      assert.notEqual(key1a, key2);
      assert.match(key1a, /^[0-9a-f]{12}-/);
      assert.match(key2, /^[0-9a-f]{12}-/);

      // Root directory handling
      const posixRootKey = repoKey('/', 'linux');
      assert.match(posixRootKey, /^[0-9a-f]{12}-root$/);

      const winRootKey = repoKey('C:\\', 'win32');
      assert.match(winRootKey, /^[0-9a-f]{12}-root$/);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('homeDir and stateDir', async () => {
    const { env, home, cleanup } = await makeIsolatedEnv();
    try {
      assert.equal(homeDir(env), home);
      assert.equal(stateDir(env), path.join(home, '.adversarial-review'));

      // Fallback when ADVERSARIAL_REVIEW_HOME is unset
      const customHome = '/custom/test/home';
      assert.equal(homeDir({ HOME: customHome }), customHome);
      assert.equal(homeDir({ USERPROFILE: customHome }), customHome);
    } finally {
      await cleanup();
    }
  });

  await t.test('runsDir', async () => {
    const { env, home, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const expectedBase = path.join(home, '.adversarial-review', 'runs');
      assert.equal(runsDir(env), expectedBase);

      const expectedRepoRuns = path.join(expectedBase, repoKey(root));
      assert.equal(runsDir(env, root), expectedRepoRuns);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('isInside', async () => {
    const { root, cleanup } = await makeTempRepo({ git: false });
    try {
      const subFile = path.join(root, 'sub', 'file.txt');
      fs.mkdirSync(path.dirname(subFile), { recursive: true });
      fs.writeFileSync(subFile, 'test');

      assert.equal(isInside(subFile, root), true);
      assert.equal(isInside(path.dirname(subFile), root), true);
      assert.equal(isInside(root, root), true);

      const outsideDir = path.dirname(root);
      assert.equal(isInside(outsideDir, root), false);

      // Windows paths containment
      assert.equal(
        isInside('c:/repo/.adversarial-review/config.json', 'c:/repo', 'win32'),
        true
      );
      assert.equal(
        isInside('c:/other/config.json', 'c:/repo', 'win32'),
        false
      );
    } finally {
      await cleanup();
    }
  });
});
