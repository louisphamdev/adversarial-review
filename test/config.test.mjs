import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  MODEL_RE,
  isValidModel,
  DEFAULTS,
  loadConfig,
} from '../skills/adversarial-review/scripts/lib/config.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';
import { makeIsolatedEnv, makeTempRepo } from './helpers/isolated-env.mjs';

test('config module', async (t) => {
  await t.test('isValidModel', () => {
    assert.equal(isValidModel('intact/antigravity/gemini-3.8-flash'), true);
    assert.equal(isValidModel('xiaomi/mimo-v2.5-pro#high'), true);
    assert.equal(isValidModel('claude-opus-5-5'), true);

    assert.equal(isValidModel('--x'), false);
    assert.equal(isValidModel('a;b'), false);
    assert.equal(isValidModel('a b'), false);
    assert.equal(isValidModel('#x'), false);
    assert.equal(isValidModel('a#b#c'), false);
    assert.equal(isValidModel(''), false);
    assert.equal(isValidModel(null), false);
    assert.equal(isValidModel(undefined), false);
    assert.equal(isValidModel(123), false);
  });

  await t.test('DEFAULTS shape', () => {
    assert.equal(DEFAULTS.version, 3);
    assert.equal(DEFAULTS.hostBackend, null);
    assert.equal(DEFAULTS.route, 'auto');
    assert.equal(DEFAULTS.routeAsk, true);
    assert.equal(DEFAULTS.budget, 20);
    assert.equal(DEFAULTS.maxParallel, 4);
    assert.deepEqual(DEFAULTS.swarm, {
      backend: 'opencode',
      allowFree: false,
      wideFiles: 30,
      wideLines: 5000,
    });
    assert.equal(DEFAULTS.sift.enabled, true);
    assert.equal(DEFAULTS.sift.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(DEFAULTS.sift.model, 'typesafe/jev-1.13');
  });

  await t.test('default load with no files', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.version, 3);
      assert.equal(config.budget, 20);
      assert.equal(config.hostBackend, null);
      assert.equal(config.route, 'auto');
      assert.equal(warnings.length, 0);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project config only tightens and strips unallowed keys with warnings', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          seats: ['simplifier'],
          budget: 1,
          stages: { ruling: { model: 'haiku' } },
          sift: { url: 'http://evil' },
        }),
      },
    });
    try {
      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.deepEqual(config.projectSeats, ['simplifier']);
      assert.equal(config.budget, 20);
      assert.equal(config.sift.url, 'https://openrouter.ai/api/alpha/decisions');

      assert.equal(warnings.length, 2);
      assert.ok(warnings.some((w) => w.includes('stages')));
      assert.ok(warnings.some((w) => w.includes('sift')));
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project budget capping', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          budget: 999,
        }),
      },
    });
    try {
      const { config } = loadConfig({ env, repoRoot: root });
      assert.equal(config.budget, 200);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project requirementsFile survives', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          requirementsFile: 'REQ.md',
        }),
      },
    });
    try {
      const { config } = loadConfig({ env, repoRoot: root });
      assert.equal(config.requirementsFile, 'REQ.md');
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project requirementsFile traversing outside repo is ignored with warning (C6)', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          requirementsFile: '../../etc/passwd',
        }),
      },
    });
    try {
      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.requirementsFile, undefined);
      assert.ok(warnings.some((w) => w.includes('requirementsFile') && w.includes('outside repository root')));
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project requirementsFile symlinked outside repo is ignored with warning (C6)', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          requirementsFile: 'symlink-req.md',
        }),
      },
    });
    try {
      const outsideFile = path.join(path.dirname(root), 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'secret content');
      try {
        fs.symlinkSync(outsideFile, path.join(root, 'symlink-req.md'));
      } catch (err) {
        if (process.platform === 'win32') return;
        throw err;
      }
      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.requirementsFile, undefined);
      assert.ok(warnings.some((w) => w.includes('requirementsFile') && w.includes('outside repository root')));
      fs.unlinkSync(outsideFile);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('user config without version is ignored with a warning', async () => {
    const { env, home, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const userCfgPath = path.join(home, '.adversarial-review', 'config.json');
      fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });
      fs.writeFileSync(userCfgPath, JSON.stringify({ budget: 50 }));

      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.budget, 20); // user budget ignored because version is missing
      assert.ok(warnings.some((w) => w.includes('version')));
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('user config with broken JSON throws ConfigError', async () => {
    const { env, home, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const userCfgPath = path.join(home, '.adversarial-review', 'config.json');
      fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });
      fs.writeFileSync(userCfgPath, '{broken json');

      assert.throws(
        () => loadConfig({ env, repoRoot: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.exitCode, 2);
          assert.ok(err.message.includes(userCfgPath));
          return true;
        }
      );
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('project config with broken JSON is ignored with a warning', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': '{broken json',
      },
    });
    try {
      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.budget, 20);
      assert.ok(warnings.some((w) => w.includes('invalid JSON') || w.includes('ignored')));
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('symlinked project config pointing outside repo is ignored', async (ctx) => {
    if (process.platform === 'win32') {
      ctx.skip('Symlinks skip on win32');
      return;
    }
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root: evilRoot, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        'evil.json': JSON.stringify({ version: 3, seats: ['evil-seat'] }),
      },
    });
    const { root, cleanup: c3 } = await makeTempRepo({ git: false });
    try {
      const cfgDir = path.join(root, '.adversarial-review');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.symlinkSync(path.join(evilRoot, 'evil.json'), path.join(cfgDir, 'config.json'));

      const { config, warnings } = loadConfig({ env, repoRoot: root });
      assert.equal(config.projectSeats, undefined);
      assert.ok(warnings.some((w) => w.includes('outside repository root') || w.includes('ignored')));
    } finally {
      await c1();
      await c2();
      await c3();
    }
  });

  await t.test('flags win last over user config and defaults', async () => {
    const { env, home, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const userCfgPath = path.join(home, '.adversarial-review', 'config.json');
      fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });
      fs.writeFileSync(
        userCfgPath,
        JSON.stringify({
          version: 3,
          route: 'spawn',
          hostBackend: 'gemini',
          budget: 40,
        })
      );

      const flags = {
        route: 'swarm',
        backend: 'codex',
        budget: 60,
      };

      const { config } = loadConfig({ env, repoRoot: root, flags });
      assert.equal(config.route, 'swarm');
      assert.equal(config.hostBackend, 'codex');
      assert.equal(config.budget, 60);
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('model validation throws ConfigError for invalid models', async () => {
    const { env, home, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({ git: false });
    try {
      const userCfgPath = path.join(home, '.adversarial-review', 'config.json');
      fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });

      // Invalid stage model
      fs.writeFileSync(
        userCfgPath,
        JSON.stringify({
          version: 3,
          stages: { find: { model: '--bad-flag' } },
        })
      );
      assert.throws(
        () => loadConfig({ env, repoRoot: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.message.includes('stages.find.model'));
          return true;
        }
      );

      // Invalid backend models array
      fs.writeFileSync(
        userCfgPath,
        JSON.stringify({
          version: 3,
          backends: { custom: { models: ['valid/model', 'invalid;model'] } },
        })
      );
      assert.throws(
        () => loadConfig({ env, repoRoot: root }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.message.includes('backends.custom.models'));
          return true;
        }
      );

      // Invalid flag model
      fs.writeFileSync(userCfgPath, JSON.stringify({ version: 3 }));
      assert.throws(
        () => loadConfig({ env, repoRoot: root, flags: { model: '#invalid' } }),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.message.includes('flags.model'));
          return true;
        }
      );
    } finally {
      await c1();
      await c2();
    }
  });

  await t.test('stderr receives warnings if provided', async () => {
    const { env, cleanup: c1 } = await makeIsolatedEnv();
    const { root, cleanup: c2 } = await makeTempRepo({
      git: false,
      files: {
        '.adversarial-review/config.json': JSON.stringify({
          version: 3,
          unknownKey: 'val',
        }),
      },
    });
    try {
      const errOutput = [];
      const mockStderr = {
        write: (msg) => errOutput.push(msg),
      };
      const { warnings } = loadConfig({ env, repoRoot: root, stderr: mockStderr });
      assert.equal(warnings.length, 1);
      assert.equal(errOutput.length, 1);
      assert.ok(errOutput[0].includes('unknownKey'));
    } finally {
      await c1();
      await c2();
    }
  });
});
