// Lane count from the machine and from provider rate limits (spec 3.1-A, A11).
import os from 'node:os';

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export function laneCap({ machine, config = {}, callsReady, providerState = {}, provider }) {
  const reserve = Number(config.lanes?.reserveRamMb ?? 2048);
  const perLane = Math.max(1, Number(config.lanes?.laneRamMb ?? 400));
  const ramCap = Math.max(1, Math.floor((Number(machine.freeRamMb) - reserve) / perLane));
  const cpuCap = Math.max(1, Number(machine.logicalCores) || 1);
  const providerCap = providerState[provider]?.cap ?? Infinity;
  const maxParallel = posInt(config.maxParallel) ?? Infinity;
  let cap = Math.min(callsReady, ramCap, cpuCap, providerCap, maxParallel);
  if (callsReady >= 1) cap = Math.max(cap, 1);
  return { cap, parts: { ramCap, cpuCap, providerCap, maxParallel } };
}

// The host and each swarm provider hold their own rate limit, so a lane belongs to the
// provider that answers the call, not to the backend that spawns it.
export function laneProvider({ backendName, hostBackend, model }) {
  if (backendName === hostBackend) return 'host';
  if (model) return String(model).split('/')[0];
  return backendName;
}

export function laneOutcome(res) {
  if (res?.errorType === 'rate-limited') return 'rate-limited';
  return res?.ok ? 'ok' : 'error';
}

export function readMachine() {
  try {
    return { freeRamMb: Math.floor(os.freemem() / (1024 * 1024)), logicalCores: os.cpus().length || 4 };
  } catch {
    return { freeRamMb: 4096, logicalCores: 4 };
  }
}

export function createLanePool({ readMachine: read = readMachine, config = {}, seatCount = 1 }) {
  const providers = {};
  const waiters = [];
  let running = 0;
  let last = null;
  const state = (p) => (providers[p] ??= { cap: Math.max(1, seatCount), okStreak: 0, running: 0 });

  // One reading for the whole pool. A running lane holds real RAM, so a later reading has
  // already subtracted it; sizing the cap from that shrunken value would subtract it twice
  // and stall the pool far below the count the machine can carry.
  let machine = null;
  const readOnce = () => (machine ||= read());

  const canStart = (p) => {
    const s = state(p);
    // Only the parts are used: `cap` folds in this provider's own limit, which must never be
    // weighed against `running`, the count across every provider.
    const { parts } = laneCap({ machine: readOnce(), config, callsReady: 1, providerState: providers, provider: p });
    const globalCap = Math.min(parts.ramCap, parts.cpuCap, parts.maxParallel);
    if (running >= globalCap || s.running >= s.cap) return false;
    last = { cap: globalCap, parts };
    return true;
  };

  const start = (p) => {
    running++;
    state(p).running++;
    let done = false;
    return (outcome = 'ok') => {
      if (done) return;
      done = true;
      running--;
      const s = state(p);
      s.running--;
      if (outcome === 'rate-limited') {
        s.cap = Math.max(1, Math.floor(s.cap / 2));
        s.okStreak = 0;
      } else if (outcome === 'ok') {
        s.okStreak++;
        if (s.okStreak >= 3) {
          s.cap = Math.min(Math.max(1, seatCount), s.cap + 1);
          s.okStreak = 0;
        }
      } else {
        s.okStreak = 0;
      }
      pump();
    };
  };

  // Arrival order: a head that cannot start blocks the queue behind it.
  const pump = () => {
    while (waiters.length > 0 && canStart(waiters[0].provider)) {
      const w = waiters.shift();
      w.resolve(start(w.provider));
    }
  };

  return {
    acquire(provider = 'default') {
      if (waiters.length === 0 && canStart(provider)) return Promise.resolve(start(provider));
      return new Promise((resolve) => waiters.push({ provider, resolve }));
    },
    snapshot() {
      return {
        running,
        cap: last ? last.cap : null,
        parts: last ? { ...last.parts } : null,
        providers: structuredClone(providers),
      };
    },
  };
}
