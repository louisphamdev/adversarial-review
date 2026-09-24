// CLI recommend command (§19.4).
import { loadConfig } from '../config.mjs';
import { resolveMaterial } from '../material.mjs';
import { readQuota } from '../quota.mjs';
import { decideRoute } from '../route.mjs';
import { resolveExecutable } from '../proc.mjs';
import { pick, discover, readStore, loadPrior } from '../catalog.mjs';
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
  const swarmExe = await resolveExecutable(swarmBackendName, env);

  let pickedSwarm = null;
  if (swarmExe) {
    try {
      const { candidates } = await discover(swarmBackendName, { config, env });
      const store = await readStore(stateDir(env));
      const prior = await loadPrior({ stateDir: stateDir(env) });
      pickedSwarm = await pick({
        candidates,
        store,
        prior,
        route: 'auto',
        allowFree: config.swarm?.allowFree,
      });
    } catch {
      pickedSwarm = null;
    }
  }

  const host = { available: Boolean(hostExe) };
  const swarm = {
    available: Boolean(swarmExe),
    detail: swarmExe ? '' : 'backend not found on PATH',
    model: pickedSwarm?.model || null,
    free: pickedSwarm?.free ?? false,
    tier: pickedSwarm?.tier ?? 'standard',
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
  };

  let question;
  if (decision.route === 'swarm') {
    const qPct = quota.percent !== null ? `Quota is at ${quota.percent}%. ` : '';
    if (swarm.free) {
      question = `${qPct}I recommend swarm: ${swarm.model} (measured ${swarm.tier} tier, free, so its provider can train on the material; slower). Swarm, or spawn?`;
    } else {
      question = `${qPct}I recommend swarm: ${swarm.model} (measured ${swarm.tier} tier). Swarm, or spawn?`;
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
