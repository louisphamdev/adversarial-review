// Pure route decision module (§19).
import { ConfigError } from './errors.mjs';

export const STAGE_NAMES = Object.freeze([
  'find',
  'table',
  'dispute',
  'lastcall',
  'patchSeats',
  'verifySeats',
  'ruling',
  'patchJudge',
  'verifyJudge',
]);

const FINDER_STAGES = Object.freeze([
  'find',
  'table',
  'dispute',
  'lastcall',
  'patchSeats',
  'verifySeats',
]);

const JUDGE_STAGES = Object.freeze([
  'ruling',
  'patchJudge',
  'verifyJudge',
]);

/**
 * Pure route decision evaluator (§19.1, §19.2).
 * Evaluates rules 1..5 in order when route is 'auto'.
 *
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {object} [options.flags]
 * @param {object} [options.material]
 * @param {number} [options.material.files]
 * @param {number} [options.material.lines]
 * @param {object} [options.quota]
 * @param {number|null} [options.quota.percent]
 * @param {object} [options.host]
 * @param {boolean} [options.host.available]
 * @param {object} [options.swarm]
 * @param {boolean} [options.swarm.available]
 * @param {string} [options.swarm.detail]
 * @param {string|null} [options.swarm.model]
 * @param {boolean} [options.swarm.free]
 * @param {string|null} [options.swarm.tier]
 * @returns {{ route: 'spawn' | 'swarm', reason: string, stages: Record<string, string> }}
 */
export function decideRoute({
  config = {},
  flags = {},
  material = { files: 0, lines: 0 },
  quota = { percent: null },
  host = { available: true },
  swarm = { available: true, detail: '', model: null, free: false, tier: null },
} = {}) {
  let routeChoice = 'auto';
  if (flags?.route !== undefined && flags.route !== null) {
    routeChoice = flags.route;
  } else if (config?.route !== undefined && config.route !== null) {
    routeChoice = config.route;
  }

  if (routeChoice !== 'auto' && routeChoice !== 'spawn' && routeChoice !== 'swarm') {
    throw new ConfigError(
      `Invalid route: "${routeChoice}". Expected "auto", "spawn", or "swarm".`
    );
  }

  let route = 'spawn';
  let reason = '';
  let isWideRule4 = false;

  const hostAvailable = host?.available !== false;
  const swarmAvailable = swarm?.available !== false;
  const hasCallableModel = Boolean(swarm?.model);
  const allowFree = Boolean(config?.swarm?.allowFree);
  const everyModelFree = Boolean(swarm?.free) && !allowFree;

  if (routeChoice === 'auto') {
    // Evaluate rules 1..5 in order (§19.2)
    const rule1Matches = !swarmAvailable || !hasCallableModel || everyModelFree;
    const rule2Matches = !hostAvailable;

    if (rule1Matches && rule2Matches) {
      throw new ConfigError(
        'Both host and swarm backends are unavailable. Run adversarial-review doctor to diagnose.'
      );
    }

    if (rule1Matches) {
      route = 'spawn';
      let detail = swarm?.detail;
      if (!detail) {
        if (!swarmAvailable) detail = 'backend does not resolve';
        else if (!hasCallableModel) detail = 'no callable model';
        else if (everyModelFree) detail = 'every callable model is free and swarm.allowFree is not true';
      }
      reason = `swarm-unavailable: ${detail}`;
    } else if (rule2Matches) {
      route = 'swarm';
      reason = 'host-unavailable';
    } else {
      // Swarm and host both available
      const threshold = typeof config?.quota?.threshold === 'number' ? config.quota.threshold : 80;
      const p = quota?.percent;
      const quotaKnown = typeof p === 'number' && Number.isFinite(p);

      if (quotaKnown && p >= threshold) {
        // Rule 3: Quota percent is known and >= threshold
        route = 'swarm';
        reason = `quota ${p}% >= ${threshold}%`;
      } else {
        const quotaSuffix = quotaKnown ? '' : ' (quota unknown)';
        const wideFiles = typeof config?.swarm?.wideFiles === 'number' ? config.swarm.wideFiles : 30;
        const wideLines = typeof config?.swarm?.wideLines === 'number' ? config.swarm.wideLines : 5000;
        const files = typeof material?.files === 'number' ? material.files : 0;
        const lines = typeof material?.lines === 'number' ? material.lines : 0;

        if (files > wideFiles || lines > wideLines) {
          // Rule 4: Wide material
          route = 'spawn';
          reason = `wide material: ${files} files, ${lines} lines${quotaSuffix}`;
          isWideRule4 = true;
        } else {
          // Rule 5: Otherwise
          route = 'spawn';
          reason = `default${quotaSuffix}`;
        }
      }
    }
  } else {
    // Explicit route ('spawn' | 'swarm')
    route = routeChoice;
    reason = flags?.route
      ? `--route ${flags.route}`
      : config?.route
        ? `config.route: ${config.route}`
        : `explicit ${routeChoice}`;
  }

  // Construct stages map (§19.1)
  const stages = {};

  if (isWideRule4) {
    stages.find = 'swarm';
    for (const stage of FINDER_STAGES) {
      if (stage !== 'find') stages[stage] = 'host';
    }
    for (const stage of JUDGE_STAGES) {
      stages[stage] = hostAvailable ? 'host' : 'swarm';
    }
  } else if (route === 'swarm') {
    for (const stage of FINDER_STAGES) {
      stages[stage] = 'swarm';
    }
    for (const stage of JUDGE_STAGES) {
      stages[stage] = hostAvailable ? 'host' : 'swarm';
    }
  } else {
    // route === 'spawn'
    for (const stage of FINDER_STAGES) {
      stages[stage] = 'host';
    }
    for (const stage of JUDGE_STAGES) {
      stages[stage] = hostAvailable ? 'host' : 'swarm';
    }
  }

  // Stage overrides from config.stages (§19.1)
  for (const stage of STAGE_NAMES) {
    if (config?.stages?.[stage]?.backend) {
      stages[stage] = config.stages[stage].backend;
    } else if (JUDGE_STAGES.includes(stage) && config?.stages?.ruling?.backend) {
      stages[stage] = config.stages.ruling.backend;
    }
  }

  return { route, reason, stages };
}
