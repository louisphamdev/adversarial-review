// CLI recommend command (§19.4).
import { loadConfig } from '../config.mjs';
import { resolveMaterial } from '../material.mjs';
import { resolveSeats } from '../seats.mjs';
import { readQuota } from '../quota.mjs';
import { decideRoute } from '../route.mjs';
import { resolveExecutable } from '../proc.mjs';
import { resolveOpencodeExe } from '../backends/opencode.mjs';
import { cleanNamed, buildPool, assignSeats, discover, readStore, loadPrior } from '../catalog.mjs';
import { stateDir } from '../paths.mjs';

export async function recommendCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  const { config } = loadConfig({ env, flags, stderr });

  let material = { files: 0, lines: 0 };
  try {
    material = await resolveMaterial({ target: flags.target, cwd });
  } catch {
    // Tolerant of non-repo when just recommending
  }

  const quota = await readQuota({
    config,
    env,
    stateDir: stateDir(env),
  });

  const hostBackendName = config.hostBackend || 'claude';
  const swarmBackendName = config.swarm?.backend || 'opencode';

  const hostExe = await resolveExecutable(hostBackendName, env);
  // discover() resolves opencode the same way. A plain PATH lookup here would miss a
  // configured or fixed-path install, skip discovery, and print no note.
  const swarmExe =
    swarmBackendName === 'opencode'
      ? (await resolveOpencodeExe(config, env)).exe
      : await resolveExecutable(swarmBackendName, env);

  const notes = [];
  let seatModels = {};
  let pool = [];
  if (swarmExe) {
    try {
      const { candidates, notes: discNotes } = await discover(swarmBackendName, { config, env, stderr });
      notes.push(...(discNotes || []));
      const store = await readStore(stateDir(env));
      const prior = await loadPrior({ stateDir: stateDir(env) });
      const named = cleanNamed(config.swarm?.models || [], candidates);
      notes.push(...named.notes);
      // recommend never probes: an unprobed model cannot be proven free, so only the stored
      // measurements and the named list decide what the pool holds.
      const built = buildPool({ candidates, prior, store, named: named.named, probeResults: {} });
      pool = built.pool;
      notes.push(...built.notes);
      const { chosen } = resolveSeats({ projectSeats: config.projectSeats });
      seatModels = assignSeats({ seats: chosen, pool, store });
    } catch (err) {
      notes.push(`swarm pool unavailable: ${err.message}`);
      seatModels = {};
    }
  }

  for (const note of notes) {
    if (stderr?.write) stderr.write(`note: ${note}\n`);
  }

  const assigned = Object.values(seatModels);
  const first = assigned[0] || null;
  const poolOf = (model) => pool.find((p) => p.model === model) || null;

  const host = { available: Boolean(hostExe) };
  const swarm = {
    available: Boolean(swarmExe),
    detail: swarmExe ? '' : 'backend not found on PATH',
    model: first?.model || null,
    free: Boolean(poolOf(first?.model)?.free),
    tier: first?.lensTier || 'unmeasured',
  };

  const decision = decideRoute({
    config,
    flags: { ...flags, route: 'auto' },
    material,
    quota,
    host,
    swarm,
  });

  const threshold = typeof config?.quota?.threshold === 'number' ? config.quota.threshold : 80;

  const signals = {
    quotaPercent: quota.percent,
    quotaSource: quota.source,
    threshold,
    files: material.files || 0,
    lines: material.lines || 0,
    swarmBackend: swarmBackendName,
    swarmModel: swarm.model,
    swarmModelTier: swarm.tier,
    swarmModelFree: swarm.free,
    seatModels,
    notes,
  };

  let question;
  if (decision.route === 'swarm') {
    const qPct = quota.percent !== null ? `Quota is at ${quota.percent}%. ` : '';
    const seatCount = assigned.length;
    if (swarm.free) {
      question = `${qPct}I recommend swarm: ${swarm.model} (measured ${swarm.tier} tier, free, so its provider can train on the material; slower), ${seatCount} seats assigned. Swarm, or spawn?`;
    } else {
      question = `${qPct}I recommend swarm: ${swarm.model} (measured ${swarm.tier} tier), ${seatCount} seats assigned. Swarm, or spawn?`;
    }
  } else {
    question = `I recommend spawn (${decision.reason}). Spawn, or swarm?`;
  }

  const result = {
    route: decision.route,
    reason: decision.reason,
    signals,
    question,
  };

  stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}
