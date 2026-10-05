// Approved destinations of a run: which providers receive the material, and whether one trains on it.

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
