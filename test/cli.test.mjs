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
import { readRecords } from '../skills/adversarial-review/scripts/lib/cli/closing.mjs';

// A run directory under the isolated state root, with a ruling of one closing item.
async function makeRunDirWithRuling(home) {
  const runDir = path.join(home, '.adversarial-review', 'runs', 'repo', 'run1');
  await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
  const ruling = { verdict: 'blocked', closingList: [{ n: 1, item: 'x', severity: 'important', doneWhen: 'y', sources: [] }], coverage: '' };
  await fs.writeFile(path.join(runDir, 'stages', 'ruling.json'), JSON.stringify(ruling));
  return runDir;
}

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

    it('watch is routed: usage line in help, bad --since exits 2', async () => {
      const help = createMockIO();
      await main(['--help'], help);
      assert.ok(help.stdout.text.includes('adversarial-review watch <run-dir> [--since <n>] [--timeout <sec>] [--json]'));
      const iso = await makeIsolatedEnv();
      try {
        const io = createMockIO();
        const runDir = path.join(iso.home, '.adversarial-review', 'runs', 'r', 'x');
        const code = await main(['watch', runDir, '--since', 'abc'], { env: iso.env, ...io });
        assert.equal(code, 2);
        assert.match(io.stderr.text, /--since/);
      } finally {
        await iso.cleanup();
      }
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

    it('models list writes the discovery notes to stderr (A2)', async () => {
      const iso = await makeIsolatedEnv();
      const io = createMockIO();
      try {
        const noPath = Object.fromEntries(
          Object.entries(iso.env).filter(([k]) => k.toLowerCase() !== 'path')
        );
        const code = await modelsCommand({ backend: 'opencode' }, [], {
          env: { ...noPath, PATH: '', USERPROFILE: iso.home },
          runChild: async () => {
            throw new Error('must not run');
          },
          ...io,
        });
        assert.equal(code, 0, `expected 0, got ${code}. err: ${io.stderr.text}`);
        assert.ok(io.stdout.text.includes('(no models discovered)'));
        assert.match(io.stderr.text, /note: opencode executable not found/);
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

    it('patch-review and verify refuse a lock whose owner pid is alive, even when it is old (C8)', async () => {
      const iso = await makeIsolatedEnv();
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      try {
        const dummyRun = await makeRunDirWithRuling(iso.home);
        const lockPath = path.join(dummyRun, 'lock');
        await fs.writeFile(lockPath, JSON.stringify({ pid: child.pid, token: 't', createdAt: Date.now() - 3600 * 1000 }));
        const old = new Date(Date.now() - 3600 * 1000);
        await fs.utimes(lockPath, old, old);
        const planFile = path.join(iso.home, 'plan.md');
        await fs.writeFile(planFile, '## C1\nx\n');
        const io1 = createMockIO();
        assert.equal(await main(['patch-review', dummyRun, '--plan', planFile], { env: iso.env, ...io1 }), 3);
        assert.match(io1.stderr.text, /owner still alive/);
        const io2 = createMockIO();
        assert.equal(await main(['verify', dummyRun], { env: iso.env, ...io2 }), 3);
        assert.match(io2.stderr.text, /owner still alive/);
        assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, child.pid, 'the lock was not taken over');
      } finally {
        child.kill();
        await iso.cleanup();
      }
    });

    it('patch-review rejects --max-rounds 0 with exit 2', async () => {
      const iso = await makeIsolatedEnv();
      try {
        const dummyRun = await makeRunDirWithRuling(iso.home);
        const planFile = path.join(iso.home, 'plan.md');
        await fs.writeFile(planFile, '## C1\nx\n');
        const io = createMockIO();
        const code = await main(['patch-review', dummyRun, '--plan', planFile, '--max-rounds', '0'], { env: iso.env, ...io });
        assert.equal(code, 2);
        assert.match(io.stderr.text, /max-rounds/);
      } finally {
        await iso.cleanup();
      }
    });

    it('readRecords reads in numeric order and refuses a gap or an unreadable record', async () => {
      const iso = await makeIsolatedEnv();
      try {
        const dummyRun = await makeRunDirWithRuling(iso.home);
        const stages = path.join(dummyRun, 'stages');
        for (const n of [1, 2, 10, 3, 4, 5, 6, 7, 8, 9]) await fs.writeFile(path.join(stages, `patch-review-${n}.json`), JSON.stringify({ n }));
        assert.deepEqual((await readRecords(dummyRun, 'patch-review')).map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        await fs.writeFile(path.join(stages, 'verify-1.json'), '{}');
        await fs.writeFile(path.join(stages, 'verify-3.json'), '{}');
        await assert.rejects(() => readRecords(dummyRun, 'verify'), (e) => e.exitCode === 2 && /verify-3\.json/.test(e.message));
        await fs.writeFile(path.join(stages, 'verify-2.json'), '{not json');
        await assert.rejects(() => readRecords(dummyRun, 'verify'), (e) => e.exitCode === 2 && /verify-2\.json/.test(e.message));
      } finally {
        await iso.cleanup();
      }
    });

    it('verify with --base --output=x returns exit 2', async () => {
      const iso = await makeIsolatedEnv();
      try {
        const dummyRun = await makeRunDirWithRuling(iso.home);
        const io = createMockIO();
        assert.equal(await main(['verify', dummyRun, '--base', '--output=x'], { env: iso.env, ...io }), 2);
        const io2 = createMockIO();
        assert.equal(await main(['verify', dummyRun, '--base=--output=x'], { env: iso.env, ...io2 }), 2);
      } finally {
        await iso.cleanup();
      }
    });

    it('verify refuses a --base in round 2 that resolves to another commit than round 1', async () => {
      const iso = await makeIsolatedEnv();
      const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
      try {
        await fs.writeFile(path.join(repo.root, 'a.js'), 'x = 2;\n');
        repo.git(['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'second']);
        const dummyRun = await makeRunDirWithRuling(iso.home);
        await fs.writeFile(path.join(dummyRun, 'request.json'), JSON.stringify({ repoRoot: repo.root }));
        const first = repo.git(['rev-parse', 'HEAD~1']).trim();
        const record = { round: 1, baseSha: first, items: {}, judge: { verdict: 'BLOCK' }, diffHash: 'h', engineVersion: ENGINE_VERSION };
        await fs.writeFile(path.join(dummyRun, 'stages', 'verify-1.json'), JSON.stringify(record));
        const io = createMockIO();
        assert.equal(await main(['verify', dummyRun, '--base', 'HEAD'], { env: iso.env, ...io }), 2);
        assert.match(io.stderr.text, /verifies against/);
      } finally {
        await iso.cleanup();
        await repo.cleanup();
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
      await writeFile(join(state, 'config.json'), JSON.stringify({ version: 3, hostBackend: 'claude', swarm: { backend: 'opencode', models: ['p/good-model'] } }));
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

  it('finds the swarm backend through backends.opencode.exe when PATH has no opencode', async () => {
    const iso = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '85' });
    const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
    const ocBins = await makeFakeBins({
      opencode: { version: 'opencode v2.0.9', models: ['p/good-model', 'p/other'] },
    });
    iso.env[bins.pathKey] = bins.pathEnv;
    const exe = path.join(ocBins.dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
    const io = createMockIO();
    try {
      const state = join(iso.home, '.adversarial-review');
      await mkdir(state, { recursive: true });
      await writeFile(join(state, 'config.json'), JSON.stringify({
        version: 3,
        hostBackend: 'claude',
        swarm: { backend: 'opencode', models: ['p/good-model'] },
        backends: { opencode: { exe } },
      }));
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
      await ocBins.cleanup();
      await bins.cleanup();
      await iso.cleanup();
      await repo.cleanup();
    }
  });

  it('prints a discovery note when the configured swarm executable fails', async () => {
    const iso = await makeIsolatedEnv({ ADVERSARIAL_REVIEW_QUOTA_PERCENT: '85' });
    const bins = await makeFakeBins({ claude: '2.1.280 (Claude Code)' });
    iso.env[bins.pathKey] = bins.pathEnv;
    const exe = path.join(iso.home, 'nowhere', 'opencode.exe');
    const repo = await makeTempRepo({ git: true, files: { 'a.js': 'x = 1;\n' } });
    const io = createMockIO();
    try {
      const state = join(iso.home, '.adversarial-review');
      await mkdir(state, { recursive: true });
      await writeFile(join(state, 'config.json'), JSON.stringify({
        version: 3,
        hostBackend: 'claude',
        swarm: { backend: 'opencode', models: ['p/good-model'] },
        backends: { opencode: { exe } },
      }));
      const code = await main(['recommend', '--target', 'a.js', '--json'], { env: iso.env, cwd: repo.root, ...io });
      assert.equal(code, 0);
      assert.match(io.stderr.text, /note: discovery failed/);
    } finally {
      await bins.cleanup();
      await iso.cleanup();
      await repo.cleanup();
    }
  });
});

describe('status per seat (3.1 part C, task 8)', () => {
  async function statusJson(runDir, env) {
    const io = createMockIO();
    const code = await main(['status', runDir, '--json'], { env, ...io });
    assert.equal(code, 0, io.stderr.text);
    return JSON.parse(io.stdout.text);
  }

  async function makeRunDir(home) {
    const runDir = path.join(home, '.adversarial-review', 'runs', 'repo-key', '20261004T000000Z-bbbbbbbb');
    await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
    return runDir;
  }

  it('status: per-call model, attempt, idleFor, and owner state', async () => {
    const iso = await makeIsolatedEnv();
    try {
      const runDir = await makeRunDir(iso.home);
      await fs.writeFile(path.join(runDir, 'lock'), JSON.stringify({ pid: process.pid, token: 't', createdAt: Date.now() }));
      const now = Date.now();
      await fs.writeFile(
        path.join(runDir, 'events.jsonl'),
        [
          { event: 'call_start', stage: 'FIND', seat: 'edge', callId: 'find-edge', model: 'opencode/a', attempt: 1, ts: now - 50000 },
          { event: 'seat_output', callId: 'find-edge', seat: 'edge', bytes: 10, lastOutputAt: now - 20000, ts: now - 20000 },
          { event: 'call_start', stage: 'FIND', seat: 'edge', callId: 'find-edge', model: 'opencode/b', attempt: 2, ts: now - 10000 },
          { event: 'seat_done', stage: 'FIND', seat: 'breaker', callId: 'find-breaker', findings: [], findingCount: 0, ts: now - 5000 },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n'
      );
      const out = await statusJson(runDir, iso.env);
      const edge = out.calls.find((c) => c.callId === 'find-edge');
      assert.equal(edge.model, 'opencode/b');
      assert.equal(edge.attempt, 2);
      assert.equal(edge.status, 'running');
      assert.ok(edge.idleFor >= 9 && edge.idleFor <= 12, String(edge.idleFor));
      const breaker = out.calls.find((c) => c.callId === 'find-breaker');
      assert.equal(breaker.status, 'done');
      assert.equal(breaker.idleFor, null);
      assert.equal(out.eventCount, 4);
      assert.equal(out.owner, 'alive');
      assert.equal(out.finished, false);
    } finally {
      await iso.cleanup();
    }
  });

  it('status: a per-seat FIND file is not the current stage, and a hung owner reads hung', async () => {
    const iso = await makeIsolatedEnv();
    try {
      const runDir = await makeRunDir(iso.home);
      await fs.writeFile(path.join(runDir, 'stages', 'find-seat-edge.json'), JSON.stringify({ seat: 'edge', findings: [] }));
      await fs.writeFile(
        path.join(runDir, 'events.jsonl'),
        JSON.stringify({ event: 'call_start', stage: 'FIND', seat: 'breaker', callId: 'find-breaker', model: null, attempt: 1, ts: Date.now() }) + '\n'
      );
      await fs.writeFile(path.join(runDir, 'lock'), JSON.stringify({ pid: process.pid, token: 't', createdAt: Date.now() }));
      const old = new Date(Date.now() - 700000);
      await fs.utimes(path.join(runDir, 'lock'), old, old);
      const out = await statusJson(runDir, iso.env);
      assert.equal(out.stage, 'FIND');
      assert.equal(out.owner, 'hung');
    } finally {
      await iso.cleanup();
    }
  });
});
