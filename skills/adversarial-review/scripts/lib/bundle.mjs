// Approved destinations of a run: which providers receive the material, and whether one trains on
// it. The preflight bundle records them with the user's answers.
import crypto from 'node:crypto';
import { decideRoute } from './route.mjs';
import { ConfigError } from './errors.mjs';
import { ENGINE_VERSION } from './version.mjs';

const providerOf = (model) => String(model).split('/')[0];

/**
 * The model list of one seat as entries. Part A writes failover entries as model strings; a
 * preflight bundle writes objects. A missing `trains` counts as true (spec G2-4).
 *
 * @param {object} seatModel
 * @returns {{ model: string, provider: string, trains: boolean }[]}
 */
export function seatEntries(seatModel) {
  if (!seatModel || !seatModel.model) return [];
  const entry = (e) => {
    const model = typeof e === 'string' ? e : e?.model;
    if (!model) return null;
    const provider = (typeof e === 'object' && e.provider) || providerOf(model);
    const trains = typeof e === 'object' && typeof e.trains === 'boolean' ? e.trains : true;
    return { model, provider, trains };
  };
  return [seatModel, ...(Array.isArray(seatModel.failover) ? seatModel.failover : [])]
    .map(entry)
    .filter(Boolean);
}

/**
 * One row per provider that can receive the material: every seat model and failover, the judge,
 * and Jev when the sift is on.
 *
 * @returns {{ provider: string, models: string[], trains: boolean, roles: string[] }[]}
 */
export function computeDataLeaves(seatModels, judge, siftOn) {
  const byProvider = new Map();
  const add = (e, role) => {
    if (!e || !e.provider || e.provider === 'host') return;
    const row = byProvider.get(e.provider) || { provider: e.provider, models: [], trains: false, roles: [] };
    if (e.model && !row.models.includes(e.model)) row.models.push(e.model);
    row.trains = row.trains || e.trains !== false;
    if (!row.roles.includes(role)) row.roles.push(role);
    byProvider.set(e.provider, row);
  };
  for (const [key, sm] of Object.entries(seatModels || {})) {
    if (key === 'judge') continue;
    seatEntries(sm).forEach((e, i) => add(e, i === 0 ? 'seat' : 'failover'));
  }
  if (judge) add(judge, 'judge');
  if (siftOn) add({ provider: 'jev', model: 'jev', trains: false }, 'sift');
  return [...byProvider.values()];
}

/**
 * The judge runs on the host backend (recorded user decision), and the host does not train.
 *
 * @param {string} hostBackend
 * @param {string|null} [model]
 */
export function hostJudge(hostBackend, model = null) {
  return {
    backend: hostBackend,
    model: model || (hostBackend === 'claude' ? 'opus' : null),
    provider: hostBackend === 'claude' ? 'anthropic' : hostBackend,
    trains: false,
  };
}

// --- Preflight decision bundle (spec C7, G2-4) ---------------------------------------------

// Key order and undefined fields must not change the hash, so the value goes through one JSON
// round trip and then every object's keys are sorted.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function hashBundle(bundle) {
  const { bundleHash, ...rest } = bundle;
  return crypto.createHash('sha256').update(canonical(JSON.parse(JSON.stringify(rest)))).digest('hex');
}

export function verifyBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new ConfigError('bundle is not a JSON object');
  if (bundle.version !== 1) throw new ConfigError(`bundle version ${JSON.stringify(bundle.version)} is not supported`);
  if (typeof bundle.bundleHash !== 'string' || hashBundle(bundle) !== bundle.bundleHash) {
    throw new ConfigError('bundleHash mismatch: the bundle changed after preflight wrote it');
  }
}

const usesSwarm = (route) => Object.values(route?.stages || {}).includes('swarm');

const routeIsOpen = (plan, config, flags) =>
  config.routeAsk === true && !flags.route && plan.hostAvailable !== false && plan.swarmAvailable === true;

/**
 * The questions a run needs before it starts. Each key is read from user config only, so a
 * project config cannot remove a decision.
 */
export function decisionsFor(plan, config = {}, dataLeaves = [], flags = {}) {
  const out = [];
  if (routeIsOpen(plan, config, flags)) {
    out.push({
      id: 'route',
      question: 'Which route do the seats take?',
      recommended: plan.routeDecision?.route || 'spawn',
      options: ['spawn', 'swarm'],
    });
  }
  const training = dataLeaves.filter((r) => r.trains).map((r) => r.provider);
  if (training.length > 0 && config.swarm?.acknowledgeTraining !== true) {
    out.push({
      id: 'privacy',
      question: `These providers can train on the material: ${training.join(', ')}. Send it to them?`,
      recommended: 'accept',
      options: ['accept', 'decline'],
    });
  }
  if (plan.routeRequested === 'swarm' && plan.discoveryCandidates === 0) {
    const why = (plan.discoveryErrors || []).join('; ');
    out.push({
      id: 'discovery',
      question: `Discovery found no swarm model${why ? ` (${why})` : ''}. Run on the host, or stop?`,
      recommended: 'spawn',
      options: ['spawn', 'stop'],
    });
  }
  return out;
}

// One row per seat in the object shape, so a bundle reader sees provider and trains for every model.
function normalizeSeatModels(seatModels = {}) {
  const out = {};
  for (const [key, sm] of Object.entries(seatModels)) {
    if (key === 'judge') continue;
    const [primary, ...failover] = seatEntries(sm);
    if (!primary) continue;
    out[key] = {
      ...primary,
      ...(sm.capability ? { capability: sm.capability } : {}),
      ...(sm.lensTier ? { lensTier: sm.lensTier } : {}),
      failover,
    };
  }
  return out;
}

function routeRow(decision, quota) {
  return {
    route: decision.route,
    reason: decision.reason,
    quotaPercent: quota?.percent ?? null,
    stages: decision.stages || {},
  };
}

function routeFor(choice, { plan, config, flags }) {
  return routeRow(
    decideRoute({
      config,
      flags: { ...flags, route: choice },
      material: plan.material,
      quota: plan.quota,
      host: { available: true },
      swarm: { available: true, model: 'any' },
    }),
    plan.quota
  );
}

// 4 x the slowest stored latency of a primary seat model; 600 s when none is known.
function estimateSec(seatModels, latencies = {}) {
  const ms = Object.values(seatModels)
    .map((s) => latencies[s.model])
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return ms.length > 0 ? Math.ceil((4 * Math.max(...ms)) / 1000) : 600;
}

/**
 * Build a new bundle from a resolved plan. `flags` are the run flags as given.
 *
 * @param {object} plan resolveRunPlan result
 * @param {object} flags
 * @param {{ config?: object, now?: () => number }} [options]
 */
export function buildBundle(plan, flags = {}, { config = plan.config || {}, now = Date.now } = {}) {
  const routeOpen = routeIsOpen(plan, config, flags);
  // An open route question can still pick the swarm, so its models are part of what is approved.
  const swarmPlanned = usesSwarm(plan.routeDecision) || plan.routeDecision?.route === 'swarm' || routeOpen;
  const seatModels = swarmPlanned ? normalizeSeatModels(plan.seatModels) : {};
  const siftOn = Boolean(plan.siftOn);
  const dataLeaves = computeDataLeaves(seatModels, plan.judge, siftOn);
  const m = plan.material || {};
  const bundle = {
    version: 1,
    createdAt: new Date(now()).toISOString(),
    engineVersion: ENGINE_VERSION,
    flags: { ...flags },
    material: {
      kind: m.kind,
      root: m.root,
      targetPath: m.targetPath ?? null,
      base: m.base ?? null,
      files: m.files ?? null,
      lines: m.lines ?? null,
      hash: m.hash,
    },
    requirements: plan.requirementsText || '',
    stage: plan.resolvedStage || plan.stageName,
    seats: (plan.chosen || []).map((s) => s.key),
    noSeat: plan.noSeat || [],
    route: routeRow(plan.routeDecision || { route: 'spawn', reason: 'default' }, plan.quota),
    routeChoices: {
      spawn: routeFor('spawn', { plan, config, flags }),
      ...(routeOpen ? { swarm: routeFor('swarm', { plan, config, flags }) } : {}),
    },
    seatModels,
    judge: plan.judge || null,
    sift: { enabled: siftOn },
    discoveryErrors: plan.discoveryErrors || [],
    warnings: plan.warnings || [],
    dataLeaves,
    estimateSec: estimateSec(seatModels, plan.latencies),
    decisions: decisionsFor(plan, config, dataLeaves, flags),
    answers: {},
  };
  bundle.bundleHash = hashBundle(bundle);
  return bundle;
}

/**
 * Apply one answer per decision and return a NEW bundle whose hash covers the answers.
 *
 * @param {object} bundle
 * @param {Record<string, string>} answers
 */
export function applyAnswers(bundle, answers = {}) {
  verifyBundle(bundle);
  const ids = new Set(bundle.decisions.map((d) => d.id));
  for (const id of Object.keys(answers)) {
    if (!ids.has(id)) throw new ConfigError(`unknown decision id: ${id}`);
  }
  for (const d of bundle.decisions) {
    if (!d.options.includes(answers[d.id])) {
      throw new ConfigError(`decision ${d.id} needs one answer from: ${d.options.join(', ')}`);
    }
  }

  const { bundleHash, ...rest } = bundle;
  const next = structuredClone(rest);
  const toSpawn = () => {
    next.route = { ...next.routeChoices.spawn };
    next.seatModels = {};
  };
  if (answers.route === 'swarm' && next.routeChoices.swarm) next.route = { ...next.routeChoices.swarm };
  if (answers.route === 'spawn' || answers.discovery === 'spawn') toSpawn();
  if (answers.discovery === 'stop') next.stop = true;
  if (answers.privacy === 'decline') {
    // A seat whose every model trains loses its swarm entry, and so runs on the host.
    const kept = {};
    for (const [key, sm] of Object.entries(next.seatModels)) {
      const { failover = [], ...head } = sm;
      const [primary, ...rest2] = [head, ...failover].filter((e) => e.trains === false);
      if (primary) kept[key] = { ...head, ...primary, failover: rest2 };
    }
    next.seatModels = kept;
    next.sift = { enabled: false };
    if (Object.keys(kept).length === 0) toSpawn();
  }
  if (!usesSwarm(next.route)) next.seatModels = {};
  next.dataLeaves = computeDataLeaves(next.seatModels, next.judge, next.sift?.enabled === true);
  next.answers = { ...answers };
  next.answeredFrom = bundleHash;
  next.bundleHash = hashBundle(next);
  return next;
}
