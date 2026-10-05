// One resolver for `run` and `preflight`: everything a run decides before it has a run directory.
import path from 'node:path';
import fs from 'node:fs/promises';

import { loadConfig } from './config.mjs';
import { resolveMaterial } from './material.mjs';
import { resolveSeats } from './seats.mjs';
import { readQuota } from './quota.mjs';
import { decideRoute } from './route.mjs';
import { resolveBackend } from './backends/index.mjs';
import { assignSeats, buildPool, cleanNamed, discover, loadPrior, readStore } from './catalog.mjs';
import { hostJudge } from './bundle.mjs';
import { stateDir, isInside } from './paths.mjs';
import { ConfigError } from './errors.mjs';

// How old the models.dev prior is. A null means no prior was read at all, which is not the same
// as a fresh one: with no prior, no discovered model can be proven free.
async function priorAgeHours(dir) {
  try {
    const st = await fs.stat(path.join(dir, 'cache', 'models-dev.json'));
    return Math.round(((Date.now() - st.mtimeMs) / 3600000) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Step 1 of the G2-2 order: discovery and the candidate pool. It reads the executable, the
 * models.dev prior, and the local store; it calls no model and it needs no run directory, so it
 * runs on every route and its notes reach `request.route.discovery.notes` whatever the route is.
 */
export async function discoverPool({ config, env, flags, swarmBackend, swarmBackendObj }) {
  const notes = [];
  const disc = swarmBackendObj
    ? await discover(swarmBackend, { config, env })
    : { candidates: [], notes: ['opencode executable not found'] };
  notes.push(...(disc.notes || []));

  const prior = await loadPrior({ stateDir: stateDir(env) });
  const discovery = {
    error: disc.error ?? null,
    hint: disc.hint ?? null,
    priorAgeHours: await priorAgeHours(stateDir(env)),
  };
  const store = await readStore(stateDir(env));
  const named = cleanNamed(
    [...(flags.model ? [].concat(flags.model) : []), ...(config.swarm?.models || [])],
    disc.candidates
  );
  notes.push(...named.notes);
  const built = buildPool({ candidates: disc.candidates, prior, store, named: named.named, probeResults: {} });
  notes.push(...(built.notes || []));
  if (built.pool.length === 0) {
    notes.push('no model is both callable and free, and no model was named, so the swarm pool is empty');
  }
  return { notes, pool: built.pool, prior, named, discovery, candidates: (disc.candidates || []).length };
}

async function readRequirements({ config, flags, material, cwd, stderr }) {
  let text = '';
  if (config.requirementsFile) {
    try {
      const reqPath = path.resolve(material.root, config.requirementsFile);
      if (!isInside(reqPath, material.root)) {
        stderr.write(`warning: requirementsFile "${config.requirementsFile}" ignored: resolves outside repository root\n`);
      } else {
        text = await fs.readFile(reqPath, 'utf8');
      }
    } catch {}
  }
  if (flags['requirements-file'] || flags.requirementsFile) {
    try {
      text = await fs.readFile(path.resolve(cwd, flags['requirements-file'] || flags.requirementsFile), 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read requirements file: ${err.message}`);
    }
  }
  return text;
}

/**
 * Resolve a run from its flags without a run directory. The seat models come from the stored
 * measurements, with no probe: the plain run probes later and can only narrow this set.
 *
 * @param {object} flags run flags
 * @param {{ env?: object, cwd?: string, stderr?: object }} [ctx]
 */
export async function resolveRunPlan(flags = {}, { env = process.env, cwd = process.cwd(), stderr = process.stderr } = {}) {
  const stageName = flags.stage || 'code';
  let material;
  try {
    material = await resolveMaterial({ target: flags.target, base: flags.base, cwd });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to resolve material: ${err.message}`);
  }

  const { config, warnings: configWarnings } = loadConfig({ env, repoRoot: material.root, flags, stderr });
  const { chosen, noSeat, warnings: seatWarnings, stage: resolvedStage } = resolveSeats({
    stage: stageName,
    seatsFlag: flags.seats,
    projectSeats: config.projectSeats,
  });
  for (const w of [...configWarnings, ...seatWarnings]) {
    if (stderr?.write) stderr.write(`Warning: ${w}\n`);
  }

  const hostBackend = config.hostBackend || 'claude';
  const swarmBackend = config.swarm?.backend || 'opencode';
  const hostBackendObj = await resolveBackend(hostBackend, { config, env }).catch(() => null);
  const swarmBackendObj = await resolveBackend(swarmBackend, { config, env }).catch(() => null);

  const routeRequested = flags.route || config.route || 'auto';
  let quota = { percent: null };
  if (routeRequested === 'auto' || routeRequested === 'swarm') {
    quota = await readQuota({ config, env, stateDir: stateDir(env) });
  }

  const requirementsText = await readRequirements({ config, flags, material, cwd, stderr });

  const discovered = await discoverPool({ config, env, flags, swarmBackend, swarmBackendObj });
  const store = await readStore(stateDir(env));
  const seatModels =
    discovered.pool.length > 0 && routeRequested !== 'spawn'
      ? assignSeats({ seats: chosen, pool: discovered.pool, store })
      : {};
  // Stored probe latency per primary model; the bundle turns it into a time estimate.
  const latencies = {};
  for (const sm of Object.values(seatModels)) {
    const entry = store[`${swarmBackend}:${sm.model}`] || store[sm.model];
    if (typeof entry?.latencyMs === 'number') latencies[sm.model] = entry.latencyMs;
  }

  const assigned = Object.values(seatModels);
  const hostAvailable = Boolean(hostBackendObj);
  const swarmAvailable = assigned.length > 0;
  const routeDecision = decideRoute({
    config,
    flags,
    material,
    quota,
    host: { available: hostAvailable },
    swarm: {
      available: swarmAvailable,
      detail: swarmBackendObj ? 'no seat has a swarm model' : 'backend not found on PATH',
      model: assigned[0]?.model || null,
      free: discovered.pool.some((p) => p.free),
      tier: assigned[0]?.lensTier || 'unmeasured',
    },
  });

  return {
    material,
    config,
    stageName,
    resolvedStage,
    chosen,
    noSeat,
    hostBackend,
    swarmBackend,
    hostBackendObj,
    swarmBackendObj,
    routeRequested,
    routeDecision,
    quota,
    requirementsText,
    discovered,
    discoveryErrors: discovered.discovery.error
      ? [discovered.discovery.error]
      : swarmBackendObj
        ? []
        : [`${swarmBackend} executable not found`],
    discoveryCandidates: discovered.candidates,
    seatModels,
    latencies,
    hostAvailable,
    swarmAvailable,
    judge: hostJudge(hostBackend, config.stages?.ruling?.model || null),
    siftOn: config.sift?.enabled !== false,
  };
}
