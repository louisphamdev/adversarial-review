import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from '../skills/adversarial-review/scripts/lib/cli/args.mjs';
import { main } from '../skills/adversarial-review/scripts/lib/cli/main.mjs';
import { modelsCommand } from '../skills/adversarial-review/scripts/lib/cli/models.mjs';
import { makeIsolatedEnv, makeTempRepo, makeFakeBins } from './helpers/isolated-env.mjs';
import { ENGINE_VERSION } from '../skills/adversarial-review/scripts/lib/version.mjs';

function createMockIO({ stdinData = '' } = {}) {
  let out = '';
  let err = '';
  return {
    stdout: {
      write: (chunk) => {
        out += chunk;
        return true;
      },
      get text() {
        return out;
      },
    },
    stderr: {
      write: (chunk) => {
        err += chunk;
        return true;
      },
      get text() {
        return err;
      },
    },
    stdin: {
      read: () => stdinData,
      [Symbol.asyncIterator]: async function* () {
        if (stdinData) yield Buffer.from(stdinData);
      },
    },
  };
}

describe('cli unit and command tests', () => {
  describe('args.mjs parseArgs', () => {
    it('parses command, flags, and positionals with camelCase and kebab-case', () => {
      const res = parseArgs(['run', '--route', 'spawn', '--allow-gaps', '--stage', 'spec', 'extra']);
      assert.equal(res.command, 'run');
      assert.equal(res.flags.route, 'spawn');
      assert.equal(res.flags['allow-gaps'], true);
      assert.equal(res.flags.allowGaps, true);
      assert.equal(res.flags.stage, 'spec');
      assert.deepEqual(res.positionals, ['extra']);
    });

    it('rejects unknown flag in strict mode with exitCode 2', () => {
      assert.throws(
        () => parseArgs(['run', '--nonexistent-flag']),
        (err) => err.exitCode === 2 || err.name === 'ConfigError' || err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      );
    });

    it('recognizes top level version and help flags', () => {
      const v = parseArgs(['--version']);
      assert.equal(v.command, 'version');

      const h = parseArgs(['--help']);
      assert.equal(h.command, 'help');
    });
  });

  describe('main dispatcher top-level', () => {
    it('--version prints version and exits 0', async () => {
      const io = createMockIO();
      const code = await main(['--version'], io);
      assert.equal(code, 0);
      assert.ok(io.stdout.text.includes(ENGINE_VERSION));
    });

    it('--help prints usage and exits 0', async () => {
      const io = createMockIO();
      const code = await main(['--help'], io);
      assert.equal(code, 0);
      assert.ok(io.stdout.text.includes('Usage:'));
      assert.ok(io.stdout.text.includes('run'));
    });

    it('unknown command returns 2', async () => {
      const io = createMockIO();
      const code = await main(['foobar'], io);
      assert.equal(code, 2);
      assert.ok(io.stderr.text.includes('Unknown command'));
    });
  });

  describe('recommend command', () => {
    it('prints recommendation JSON with route, reason, signals, and question', async () => {
      const iso = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '85' });
      const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
      const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
      iso.env[bins.pathKey] = bins.pathEnv;
      const io = createMockIO();
      try {
        const code = await main(['recommend', '--target', 'a.js', '--json'], {
          env: iso.env,
          cwd: repo.root,
          ...io,
        });
        assert.equal(code, 0, `expected 0, got ${code}. err: ${io.stderr.text}`);
        const parsed = JSON.parse(io.stdout.text);
        assert.ok(parsed.route === 'spawn' || parsed.route === 'swarm');
        assert.ok(typeof parsed.reason === 'string');
        assert.ok(parsed.signals);
        assert.ok(typeof parsed.question === 'string');
      } finally {
        await bins.cleanup();
        await iso.cleanup();
        await repo.cleanup();
      }
    });

    it('recommend command sets swarm.model to null when no swarm model picked, not default (C1)', async () => {
      const iso = await makeIsolatedEnv();
      const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
      const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
      iso.env[bins.pathKey] = bins.pathEnv;
      const io = createMockIO();
      try {
        const code = await main(['recommend', '--target', 'a.js', '--json'], {
          env: iso.env,
          cwd: repo.root,
          ...io,
        });
        assert.equal(code, 0, `expected 0, got ${code}. err: ${io.stderr.text}`);
        const parsed = JSON.parse(io.stdout.text);
        assert.equal(parsed.signals.swarmModel, null);
      } finally {
        await bins.cleanup();
        await iso.cleanup();
        await repo.cleanup();
      }
    });
  });

  describe('quota command', () => {
    it('returns exit 0 below threshold and exit 1 at/above threshold', async () => {
      const isoLow = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '20' });
      const ioLow = createMockIO();
      try {
        const codeLow = await main(['quota', '--gate', '80'], { env: isoLow.env, ...ioLow });
        assert.equal(codeLow, 0);
      } finally {
        await isoLow.cleanup();
      }

      const isoHigh = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '90' });
      const ioHigh = createMockIO();
      try {
        const codeHigh = await main(['quota', '--gate', '80'], { env: isoHigh.env, ...ioHigh });
        assert.equal(codeHigh, 1);
      } finally {
        await isoHigh.cleanup();
      }
    });

    it('returns exit 3 when quota is unknown', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const code = await main(['quota'], { env: iso.env, ...io });
        assert.equal(code, 3);
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe('doctor command', () => {
    it('reports environment and backend status', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const code = await main(['doctor'], { env: iso.env, ...io });
        assert.ok(code === 0 || code === 1);
        assert.ok(io.stdout.text.includes('Node:'));
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe('models command', () => {
    it('returns exit 2 on unknown backend', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const code = await main(['models', '--backend', 'not-a-backend'], {
          env: iso.env,
          ...io,
        });
        assert.equal(code, 2);
      } finally {
        await iso.cleanup();
      }
    });

    it('models probe runs without crash, iterates entries, and persists store (C2)', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      const probeCall = async ({ backend, model }) => ({
        ok: true,
        callable: true,
        latencyMs: 42,
      });
      try {
        const code = await modelsCommand({ backend: 'claude', model: 'claude-test' }, ['probe'], {
          env: iso.env,
          probeCall,
          ...io,
        });
        assert.equal(code, 0, `expected 0, got ${code}. err: ${io.stderr.text}`);
        assert.ok(io.stdout.text.includes('claude-test: callable (42ms)'));
        const storeFile = path.join(iso.home, '.adversarial-review', 'models.json');
        const content = JSON.parse(await fs.readFile(storeFile, 'utf8'));
        assert.ok(content['claude:claude-test']);
      } finally {
        await iso.cleanup();
      }
    });

    it('models bench runs without crash, extracts score, and persists store (C2)', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      const benchCall = async ({ backend, model }) => ({
        ok: true,
        findings: [
          { title: 'loop issue', line: 15, evidence: 'line 15 loop' },
        ],
      });
      try {
        const code = await modelsCommand({ backend: 'claude', model: 'claude-test' }, ['bench'], {
          env: iso.env,
          benchCall,
          ...io,
        });
        assert.equal(code, 0, `expected 0, got ${code}. err: ${io.stderr.text}`);
        assert.ok(io.stdout.text.includes('Bench result for claude-test: score'));
        const storeFile = path.join(iso.home, '.adversarial-review', 'models.json');
        const content = JSON.parse(await fs.readFile(storeFile, 'utf8'));
        assert.ok(content['claude:claude-test']);
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe('patch-review and verify command edge cases', () => {
    it('patch-review without plan file returns exit 2', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const dummyRun = path.join(iso.home, '.adversarial-review', 'runs', 'repo', 'run1');
        await fs.mkdir(dummyRun, { recursive: true });
        const code = await main(['patch-review', dummyRun], { env: iso.env, ...io });
        assert.equal(code, 2);
      } finally {
        await iso.cleanup();
      }
    });

    it('verify on directory without ruling returns exit 2', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const dummyRun = path.join(iso.home, '.adversarial-review', 'runs', 'repo', 'run1');
        await fs.mkdir(dummyRun, { recursive: true });
        const code = await main(['verify', dummyRun], { env: iso.env, ...io });
        assert.equal(code, 2);
      } finally {
        await iso.cleanup();
      }
    });
  });
});

describe('recommend picks a measured swarm model', () => {
  it('quota at 85% with a measured top model on the swarm backend routes to swarm', async () => {
    const iso = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '85' });
    const bins = await makeFakeBins({
      claude: '2.1.280 (Claude Code)',
      opencode: { version: 'opencode v2.0.9', models: ['p/good-model', 'p/other'] },
    });
    iso.env[bins.pathKey] = bins.pathEnv;
    const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
    const io = createMockIO();
    try {
      const state = join(iso.home, '.adversarial-review');
      await mkdir(state, { recursive: true });
      await writeFile(join(state, 'config.json'), JSON.stringify({ version: 3, hostBackend: 'claude', swarm: { backend: 'opencode', allowFree: true } }));
      await writeFile(join(state, 'models.json'), JSON.stringify({
        version: 3,
        'opencode:p/good-model': { backend: 'opencode', model: 'p/good-model', callable: true, contract: true, score: 6, invented: 0, tier: 'top', latencyMs: 100, measuredAt: Date.now() },
      }));
      const code = await main(['recommend', '--target', 'a.js', '--json'], { env: iso.env, cwd: repo.root, ...io });
      assert.equal(code, 0, io.stderr.text);
      const parsed = JSON.parse(io.stdout.text);
      assert.equal(parsed.signals.swarmModel, 'p/good-model');
      assert.equal(parsed.route, 'swarm');
    } finally {
      await bins.cleanup();
      await iso.cleanup();
      await repo.cleanup();
    }
  });
});
