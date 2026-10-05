import { loadSeats } from '../seats.mjs';
import { buildPrompt } from '../prompts.mjs';
// CLI models command (§20, §18.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  discover,
  probe,
  storableProbe,
  bench,
  research,
  readStore,
  updateStore,
  storeLensTiers,
  loadPrior,
  LENSES,
  LENS_DIR,
  lensMaterialPath,
  lensStage,
} from '../catalog.mjs';
import { BACKEND_NAMES, runSeatCall } from '../backends/index.mjs';
import { loadConfig } from '../config.mjs';
import { runChild as defaultRunChild } from '../proc.mjs';
import { stateDir } from '../paths.mjs';
import { ConfigError } from '../errors.mjs';
import { FINDINGS, PROBE } from '../schemas.mjs';
import { SWARM_LANE_TOOLS, makeLaneCall } from '../lane.mjs';
import { PROFILE_STEPS, writeProfileConfig } from '../sandbox.mjs';

const PROBE_PROMPT = 'Reply with one fenced JSON block and nothing else: {"ok":true}';
const PROBE_DEADLINE_MS = 90000;
const RESEARCH_DEADLINE_MS = 600000;

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

  const seatCall = (call, options) => runSeatCall(call, { backend: call.backend || backend, config, env, runChild, ...options });
  const defaultBenchCallFor = makeBenchCallFor({ config, runSeatCall: (call) => seatCall(call), backend });

  const probeCall = customProbeCall || defaultProbeCall;
  // The injected seam takes one object, so a lens-aware caller passes the lens through it.
  const benchCallFor = customBenchCall
    ? (lens) => (model) => customBenchCall({ backend, model, lens })
    : defaultBenchCallFor;

  if (sub === 'probe') {
    const limit = flags.limit ? Number(flags.limit) : 6;
    const { candidates } = await discover(backend, { config, env, runChild, stderr });
    const modelsToProbe = flags.model ? [flags.model] : candidates.slice(0, limit);
    const laneCall = (model) => probeCall({ backend, model, prompt: PROBE_PROMPT, schema: PROBE });
    const results = await probe({
      models: modelsToProbe,
      laneCall,
      deadlineMs: PROBE_DEADLINE_MS,
    });
    await fs.mkdir(stateDir(env), { recursive: true });
    // A deadline miss or a rate limit is not stored, so the next run probes that model again.
    await updateStore(stateDir(env), (cur) => {
      for (const entry of Object.values(results)) {
        if (!storableProbe(entry)) continue;
        const key = `${backend}:${entry.model}`;
        cur[key] = { ...cur[key], ...entry, backend };
      }
      return cur;
    });
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
    const lenses = parseLenses(flags.lenses);
    const { candidates } = await discover(backend, { config, env, runChild, stderr });
    const modelsToBench = flags.model ? [flags.model] : candidates.slice(0, limit);
    const res = await bench({
      models: modelsToBench,
      lenses,
      benchCallFor,
      deadlineMs: config.swarm?.researchDeadlineMs ?? RESEARCH_DEADLINE_MS,
    });
    for (const [model, byLens] of Object.entries(res)) {
      const tiers = Object.fromEntries(Object.entries(byLens).map(([lens, r]) => [lens, r.tier]));
      await storeLensTiers(stateDir(env), { backend, model, tiers, measured: Object.keys(byLens) });
    }
    if (flags.json) {
      stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (modelsToBench.length === 0) {
      stdout.write(`No model to bench for backend "${backend}"\n`);
    } else {
      for (const [model, byLens] of Object.entries(res)) {
        const total = Object.values(byLens).reduce((sum, r) => sum + (r.score || 0), 0);
        stdout.write(`Bench result for ${model}: score ${total} over ${Object.keys(byLens).length} lenses\n`);
        for (const [lens, r] of Object.entries(byLens)) {
          stdout.write(`  - ${lens}: ${r.tier} (score ${r.score}, invented ${r.invented})\n`);
        }
      }
    }
    return 0;
  }

  if (sub === 'research') {
    const model = flags.model || positionals[1];
    if (!model) {
      stderr.write('usage: adversarial-review models research <provider/model> [--seats a,b]\n');
      return 2;
    }
    const seats = parseLenses(flags.seats);
    const prior = await loadPrior({ stateDir: stateDir(env) });
    const store = await readStore(stateDir(env));
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-research-'));
    try {
      const benchRoot = path.join(runDir, 'sandbox', 'bench');
      const laneFor = {};
      for (const lens of seats) {
        const treeDir = path.join(benchRoot, lens);
        await fs.cp(path.join(LENS_DIR, lens), treeDir, { recursive: true });
        const { cwd } = await writeProfileConfig({
          runDir,
          profileKey: `bench-${lens}`,
          treeDir,
          steps: PROFILE_STEPS.bench,
        });
        laneFor[lens] = makeLaneCall({
          config,
          env,
          runDir,
          cwd,
          stage: 'FIND',
          schema: FINDINGS,
          prompt: lensFindPrompt(lens, { treeDir }),
          timeoutMs: config.timeouts?.find || 1200000,
          callIdPrefix: `research-${lens}`,
          backend,
          runSeatCall: seatCall,
        });
      }
      const { cwd: probeCwd } = await writeProfileConfig({
        runDir,
        profileKey: 'probe',
        treeDir: benchRoot,
        steps: PROFILE_STEPS.probe,
      });
      const defaultProbeLane = makeLaneCall({
        config,
        env,
        runDir,
        cwd: probeCwd,
        stage: 'FIND',
        schema: PROBE,
        prompt: PROBE_PROMPT,
        timeoutMs: 30000,
        callIdPrefix: 'research-probe',
        backend,
        runSeatCall: seatCall,
      });

      const res = await research(model, {
        seats,
        prior,
        store,
        deadlineMs: config.swarm?.researchDeadlineMs ?? RESEARCH_DEADLINE_MS,
        probeLane: customProbeCall
          ? (m) => customProbeCall({ backend, model: m, prompt: PROBE_PROMPT, schema: PROBE })
          : defaultProbeLane,
        benchCallFor: customBenchCall ? benchCallFor : (lens) => laneFor[lens],
      });

      if (res.accepted) {
        await storeLensTiers(stateDir(env), {
          backend,
          model,
          tiers: res.lenses,
          measured: res.benched,
          extra: storableProbe(res.probe) ? res.probe : {},
        });
      }

      if (flags.json) {
        stdout.write(JSON.stringify(res, null, 2) + '\n');
      } else {
        stdout.write(`Research for ${model}: ${res.accepted ? 'accepted' : 'rejected'}\n`);
        if (res.seats.length > 0) stdout.write(`  seats: ${res.seats.join(', ')}\n`);
        for (const reason of res.reasons) stdout.write(`  - ${reason}\n`);
      }
      return 0;
    } finally {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Default: list/table
  const store = await readStore(stateDir(env));
  const { candidates } = await discover(backend, { config, env, runChild, stderr });

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

const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

// Spec §12: a FIND prompt without a tools block is refused, and a bench seat is always weak, so a
// bench score measures the same prompt that a swarm lane gets.
function lensFindPrompt(lens, { treeDir, build = buildPrompt }) {
  return build('FIND', {
    seat: { ...loadSeats().get(lens), capability: 'weak' },
    tools: [...SWARM_LANE_TOOLS],
    materialPath: lensMaterialPath(lens, treeDir),
    repoRoot: treeDir,
    budget: 20,
    reviewStage: lensStage(lens),
  });
}

function parseLenses(value) {
  if (!value) return [...LENSES];
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = list.filter((l) => !LENSES.includes(l));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown lens: ${unknown.join(', ')}. Allowed: ${LENSES.join(', ')}`);
  }
  return list.length > 0 ? list : [...LENSES];
}

// Spec §20.4: the bench is the lens seat's real FIND on its fixture. A shortened prompt or a
// short timeout scores every model 0 and marks it unusable, which hides the whole swarm.
export function makeBenchCallFor({ config = {}, runSeatCall: callSeat, buildPrompt: build = buildPrompt, backend = 'opencode' }) {
  return (lens) => async (model) => {
    const treeDir = path.join(LENS_DIR, lens);
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-bench-'));
    try {
      await fs.mkdir(path.join(runDir, 'calls'), { recursive: true });
      await fs.mkdir(path.join(runDir, 'cwd'), { recursive: true });
      return await callSeat({
        backend,
        callId: `bench-${lens}-${safeId(model)}`,
        prompt: lensFindPrompt(lens, { treeDir, build }),
        schema: FINDINGS,
        root: treeDir,
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
