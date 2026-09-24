import { loadSeats } from '../seats.mjs';
import { buildPrompt } from '../prompts.mjs';
// CLI models command (§20, §18.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discover, probe, bench, readStore, updateStore } from '../catalog.mjs';
import { BACKEND_NAMES, runSeatCall } from '../backends/index.mjs';
import { loadConfig } from '../config.mjs';
import { runChild as defaultRunChild } from '../proc.mjs';
import { stateDir } from '../paths.mjs';
import { ConfigError } from '../errors.mjs';
import { FINDINGS } from '../schemas.mjs';

export async function modelsCommand(
  flags = {},
  positionals = [],
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runChild = defaultRunChild,
    probeCall: customProbeCall,
    benchCall: customBenchCall,
  } = {}
) {
  const backend = flags.backend || 'opencode';
  if (!BACKEND_NAMES.includes(backend)) {
    throw new ConfigError(`Unknown backend: "${backend}". Allowed: ${BACKEND_NAMES.join(', ')}`);
  }

  const { config } = loadConfig({ env, flags, stderr });
  const sub = positionals[0];

  const defaultProbeCall = async ({ backend, model, prompt, schema }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-probe-'));
    try {
      await fs.mkdir(path.join(tmp, 'calls'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'cwd'), { recursive: true });
      return await runSeatCall(
        {
          callId: `probe-${String(model).replace(/[^A-Za-z0-9._-]/g, '_')}`,
          prompt,
          schema,
          root: tmp,
          runDir: tmp,
          cwd: path.join(tmp, 'cwd'),
          model,
          timeoutMs: 30000,
        },
        { backend, config, env, runChild }
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  };

  const defaultBenchCall = makeBenchCall({ config, env, runSeatCall: (call) => runSeatCall(call, { backend: call.backend, config, env, runChild }) });

  const probeCall = customProbeCall || defaultProbeCall;
  const benchCall = customBenchCall || defaultBenchCall;

  if (sub === 'probe') {
    const limit = flags.limit ? Number(flags.limit) : 6;
    const { candidates } = await discover(backend, { config, runChild, stderr });
    const modelsToProbe = flags.model ? [flags.model] : candidates.slice(0, limit);
    const results = await probe({
      backend,
      models: modelsToProbe,
      probeCall,
      limit,
    });
    await fs.mkdir(stateDir(env), { recursive: true });
    await updateStore(stateDir(env), results);
    if (flags.json) {
      stdout.write(JSON.stringify(results, null, 2) + '\n');
    } else {
      const entries = Object.values(results);
      stdout.write(`Probed ${entries.length} models for ${backend}:\n`);
      for (const r of entries) {
        stdout.write(`  - ${r.model}: ${r.callable ? 'callable' : 'failed'} (${r.latencyMs || 0}ms)\n`);
      }
    }
    return 0;
  }

  if (sub === 'bench') {
    const limit = flags.limit ? Number(flags.limit) : 6;
    const { candidates } = await discover(backend, { config, runChild, stderr });
    const modelsToBench = flags.model ? [flags.model] : candidates.slice(0, limit);
    const res = await bench({
      backend,
      models: modelsToBench,
      benchCall,
      limit,
    });
    await fs.mkdir(stateDir(env), { recursive: true });
    await updateStore(stateDir(env), res);
    if (flags.json) {
      stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      const entry = Object.values(res)[0];
      const score = entry?.score ?? 0;
      stdout.write(`Bench result for ${flags.model || entry?.model || 'default'}: score ${score}\n`);
    }
    return 0;
  }

  // Default: list/table
  const store = await readStore(stateDir(env));
  const { candidates } = await discover(backend, { config, runChild, stderr });

  if (flags.json) {
    stdout.write(JSON.stringify({ backend, candidates, store }, null, 2) + '\n');
  } else {
    stdout.write(`Models for backend "${backend}":\n`);
    if (candidates.length === 0) {
      stdout.write('  (no models discovered)\n');
    } else {
      for (const m of candidates) {
        const stored = store[m];
        const tier = stored?.tier ? ` [${stored.tier}]` : '';
        const callable = stored?.callable !== undefined ? (stored.callable ? ' (callable)' : ' (uncallable)') : '';
        stdout.write(`  - ${m}${tier}${callable}\n`);
      }
    }
  }

  return 0;
}

const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bench');

// Spec §20.4: the bench is the breaker seat's real FIND on the fixture. A shortened prompt or a
// short timeout scores every model 0 and marks it unusable, which hides the whole swarm.
export function makeBenchCall({ config, runSeatCall: callSeat }) {
  return async ({ backend, model }) => {
    const seat = loadSeats().get('breaker');
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-bench-'));
    try {
      await fs.mkdir(path.join(runDir, 'calls'), { recursive: true });
      await fs.mkdir(path.join(runDir, 'cwd'), { recursive: true });
      const prompt = buildPrompt('FIND', {
        seat,
        materialPath: path.join(BENCH_DIR, 'defects.js'),
        repoRoot: BENCH_DIR,
        budget: 20,
        reviewStage: 'code',
      });
      return await callSeat({
        backend,
        callId: `bench-${String(model).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        prompt,
        schema: FINDINGS,
        root: BENCH_DIR,
        runDir,
        cwd: path.join(runDir, 'cwd'),
        model,
        timeoutMs: config.timeouts?.find || 1200000,
      });
    } finally {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
