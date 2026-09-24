import { runChild as defaultRunChild } from './proc.mjs';
// Model discovery, models.dev prior registry caching, bench scoring, and model selection.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isValidModel } from './config.mjs';
import { acquireLock } from './lockfile.mjs';
import { writeFileAtomic, readJsonSafe } from './fsx.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ANSWER_KEY_PATH = path.resolve(__dirname, '../../bench/answer-key.json');

// Discovers models for a given backend, trimming lines and validating model syntax.
export async function discover(backendName, { config = {}, runChild = defaultRunChild, env, stderr } = {}) {
  if (backendName === 'opencode') {
    if (typeof runChild !== 'function') {
      return { candidates: [], authoritative: true, error: 'runChild required' };
    }
    try {
      const res = await runChild({ cmd: 'opencode', args: ['models'], env });
      if (res.code !== 0 || res.spawnError || res.timedOut) {
        return {
          candidates: [],
          authoritative: true,
          error: res.spawnError?.message || res.stderr || 'opencode models failed',
        };
      }
      const candidates = [];
      const lines = String(res.stdout || '').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (isValidModel(line)) {
          candidates.push(line);
        } else {
          const warning = `catalog: dropping invalid model id '${line}'`;
          if (stderr?.write) {
            stderr.write(warning + '\n');
          } else {
            console.warn(warning);
          }
        }
      }
      return { candidates, authoritative: true };
    } catch (err) {
      return { candidates: [], authoritative: true, error: err.message };
    }
  }

  if (backendName === 'claude') {
    return { candidates: ['opus', 'sonnet', 'haiku'], authoritative: false };
  }

  if (backendName === 'codex') {
    const configured = config?.backends?.codex?.models;
    if (Array.isArray(configured) && configured.length > 0) {
      return {
        candidates: configured.filter((m) => isValidModel(m)),
        authoritative: false,
      };
    }
    if (typeof runChild === 'function') {
      try {
        const res = await runChild({ cmd: 'codex', args: ['debug', 'models'], env });
        if (res && res.code === 0 && res.stdout) {
          const parsed = String(res.stdout)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s && isValidModel(s));
          if (parsed.length > 0) {
            return { candidates: parsed, authoritative: true };
          }
        }
      } catch {
        // Fall back to default on parse or execution failure.
      }
    }
    return { candidates: ['default'], authoritative: false };
  }

  if (backendName === 'gemini' || backendName === 'custom') {
    const configured = config?.backends?.[backendName]?.models;
    if (Array.isArray(configured) && configured.length > 0) {
      return {
        candidates: configured.filter((m) => isValidModel(m)),
        authoritative: false,
      };
    }
    return { candidates: ['default'], authoritative: false };
  }

  return {
    candidates: [],
    authoritative: false,
    error: `Unknown backend: ${backendName}`,
  };
}

// Loads model metadata from models.dev with a 24-hour cache and a 10-second timeout.
export async function loadPrior({ stateDir, fetchImpl, now = Date.now } = {}) {
  const currentTime = typeof now === 'function' ? now() : (now ?? Date.now());
  const cacheFile = path.join(stateDir, 'cache', 'models-dev.json');
  const TTL_MS = 24 * 60 * 60 * 1000;

  try {
    const st = await fs.stat(cacheFile);
    const text = await fs.readFile(cacheFile, 'utf8');
    const data = JSON.parse(text);
    const cachedAt = typeof data._cachedAt === 'number' ? data._cachedAt : st.mtimeMs;
    if (currentTime >= cachedAt && currentTime - cachedAt < TTL_MS) {
      return parseModelsDev(data);
    }
  } catch {
    // Cache miss, unparseable, or stale; continue to fetch.
  }

  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) return new Map();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetchFn('https://models.dev/api.json', { signal: ac.signal });
    if (!res || !res.ok) return new Map();
    const data = await res.json();
    data._cachedAt = currentTime;
    await fs.mkdir(path.join(stateDir, 'cache'), { recursive: true });
    await writeFileAtomic(cacheFile, JSON.stringify(data));
    const d = new Date(currentTime);
    await fs.utimes(cacheFile, d, d).catch(() => {});
    return parseModelsDev(data);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

// Parses raw models.dev registry payload into a normalized model metadata map.
function parseModelsDev(apiData) {
  const map = new Map();
  if (!apiData || typeof apiData !== 'object') return map;

  for (const [providerKey, providerObj] of Object.entries(apiData)) {
    if (!providerObj || typeof providerObj !== 'object') continue;
    const models = providerObj.models || {};
    for (const [modelKey, modelObj] of Object.entries(models)) {
      if (!modelObj || typeof modelObj !== 'object') continue;
      const id = `${providerKey}/${modelKey}`;
      const free = Boolean(
        modelObj.free ??
          (modelObj.cost && modelObj.cost.input === 0 && modelObj.cost.output === 0)
      );
      const toolCall = Boolean(
        modelObj.tool_call ?? modelObj.toolCall ?? modelObj.tools ?? false
      );
      const reasoning = Boolean(modelObj.reasoning ?? false);
      const context = Number(modelObj.limit?.context ?? modelObj.context ?? 0);
      let textOnly = true;
      if (modelObj.textOnly !== undefined) {
        textOnly = Boolean(modelObj.textOnly);
      } else {
        const outMods = modelObj.modalities?.output || modelObj.output || modelObj.modalities;
        if (Array.isArray(outMods) && outMods.length > 0) {
          if (!outMods.includes('text')) textOnly = false;
        }
      }
      map.set(id, { free, toolCall, reasoning, context, textOnly });
    }
  }
  return map;
}

// Reads the model measurement store, returning version 3 object if missing.
export async function readStore(stateDir) {
  const filePath = path.join(stateDir, 'models.json');
  const res = await readJsonSafe(filePath);
  if (!res.ok || !res.value || typeof res.value !== 'object') {
    return { version: 3 };
  }
  return res.value;
}

// Serializes updates into models.json holding models.lock with onBusy: 'wait'.
export async function updateStore(stateDir, entries) {
  const lockPath = path.join(stateDir, 'models.lock');
  const filePath = path.join(stateDir, 'models.json');
  const lock = await acquireLock(lockPath, { onBusy: 'wait' });

  try {
    const current = await readStore(stateDir);
    current.version = 3;
    if (Array.isArray(entries)) {
      for (const item of entries) {
        const key =
          item.key || (item.backend && item.model ? `${item.backend}:${item.model}` : item.model);
        if (key) {
          current[key] = { ...current[key], ...item };
        }
      }
    } else if (entries && typeof entries === 'object') {
      for (const [k, v] of Object.entries(entries)) {
        if (k === 'version') continue;
        current[k] = { ...current[k], ...v };
      }
    }
    await writeFileAtomic(filePath, JSON.stringify(current, null, 2) + '\n');
  } finally {
    await lock.release();
  }
}

// Deterministic bipartite defect matching with ±2 line buffer and keyword validation.
export function scoreBench(findings, answerKey) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { score: 0, invented: 0, tier: 'unusable' };
  }
  if (!Array.isArray(answerKey) || answerKey.length === 0) {
    return { score: 0, invented: findings.length, tier: 'unusable' };
  }

  // Build adjacency list for bipartite matching between findings and defect items.
  const adj = Array.from({ length: findings.length }, () => []);

  for (let fIdx = 0; fIdx < findings.length; fIdx++) {
    const f = findings[fIdx];
    const text = [f.title, f.detail, f.evidence, f.doneWhen]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    const fLineNums = String(f.line || '').match(/\d+/g)?.map(Number) || [];
    const evNums = String(f.evidence || '').match(/\b\d+\b/g)?.map(Number) || [];

    for (let dIdx = 0; dIdx < answerKey.length; dIdx++) {
      const d = answerKey[dIdx];
      const minLine = Math.min(...d.lines) - 2;
      const maxLine = Math.max(...d.lines) + 2;

      const lineMatch = fLineNums.some((n) => n >= minLine && n <= maxLine);
      const evMatch = evNums.some((n) => n >= minLine && n <= maxLine);
      const kwMatch = d.keywords.some((kw) => text.includes(kw.toLowerCase()));

      if ((lineMatch || evMatch) && kwMatch) {
        adj[fIdx].push(dIdx);
      }
    }
  }

  // Maximum bipartite matching via augmenting path search.
  const matchDefectToFinding = new Map();
  function dfs(findingIdx, visited) {
    for (const defectIdx of adj[findingIdx]) {
      if (visited.has(defectIdx)) continue;
      visited.add(defectIdx);
      if (
        !matchDefectToFinding.has(defectIdx) ||
        dfs(matchDefectToFinding.get(defectIdx), visited)
      ) {
        matchDefectToFinding.set(defectIdx, findingIdx);
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < findings.length; i++) {
    dfs(i, new Set());
  }

  const score = matchDefectToFinding.size;
  const invented = findings.length - score;

  let tier;
  if ((score === 5 || score === 6) && invented === 0) {
    tier = 'top';
  } else if (score >= 4 && invented <= 1) {
    tier = 'standard';
  } else if (score >= 2 && invented <= 3) {
    tier = 'light';
  } else {
    tier = 'unusable';
  }

  return { score, invented, tier };
}

// Executes lightweight probe calls on candidates up to the configured limit.
export async function probe({ backend, models = [], probeCall, limit = 6 }) {
  const targets = models.slice(0, limit);
  const entries = {};

  for (const model of targets) {
    const start = Date.now();
    let res;
    let latencyMs = 0;
    try {
      res = await probeCall({
        backend,
        model,
        prompt: 'Reply with JSON: {"ok":true}',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      });
      latencyMs = res?.latencyMs ?? (Date.now() - start);
    } catch (err) {
      latencyMs = Date.now() - start;
      res = { ok: false, error: err.message };
    }

    const callable =
      res?.callable ?? (res?.ok === true || (!res?.error && res?.value != null));
    const contract = res?.contract ?? (res?.ok === true);
    const key = `${backend}:${model}`;

    entries[key] = {
      backend,
      model,
      callable: Boolean(callable),
      latencyMs,
      contract: Boolean(contract),
      measuredAt: Date.now(),
    };
  }
  return entries;
}

// Executes bench runs on candidates against the seeded defect fixture and answer key.
export async function bench({
  backend,
  models = [],
  benchCall,
  answerKey,
  limit = 6,
}) {
  const targets = models.slice(0, limit);
  const entries = {};

  let activeAnswerKey = answerKey;
  if (!activeAnswerKey) {
    const keyRes = await readJsonSafe(DEFAULT_ANSWER_KEY_PATH);
    activeAnswerKey = keyRes.ok ? keyRes.value : [];
  }

  for (const model of targets) {
    const start = Date.now();
    let res;
    let latencyMs = 0;
    try {
      res = await benchCall({ backend, model });
      latencyMs = res?.latencyMs ?? (Date.now() - start);
    } catch (err) {
      latencyMs = Date.now() - start;
      res = { ok: false, error: err.message };
    }

    const callable = res?.callable ?? (res?.ok !== false || res?.raw != null);
    const contract = res?.ok !== false && res?.contract !== false && !res?.error;
    let score = 0;
    let invented = 0;
    let tier = 'unusable';

    if (callable && contract) {
      const findings = res?.value?.findings || res?.findings || [];
      const scored = scoreBench(findings, activeAnswerKey);
      score = scored.score;
      invented = scored.invented;
      tier = scored.tier;
    }

    const key = `${backend}:${model}`;
    entries[key] = {
      backend,
      model,
      callable: Boolean(callable),
      latencyMs,
      contract: Boolean(contract),
      score,
      invented,
      tier,
      measuredAt: Date.now(),
    };
  }
  return entries;
}

// Selects the optimal candidate according to measurements, prior ordering, and route constraints.
export async function pick({
  candidates = [],
  store = {},
  prior = new Map(),
  route = 'auto',
  allowFree = false,
  maxAgeDays = 7,
  probeLimit = 6,
  probeFn,
  now = Date.now,
} = {}) {
  const currentTime = typeof now === 'function' ? now() : (now ?? Date.now());

  // Step 1: Filter discovered candidates against prior modalities and route rules.
  let available = candidates.slice();
  available = available.filter((c) => {
    const p = prior instanceof Map ? prior.get(c) : prior?.[c];
    if (p && (p.toolCall === false || p.textOnly === false)) {
      return false;
    }
    return true;
  });

  if (route === 'auto' && !allowFree) {
    available = available.filter((c) => {
      const p = prior instanceof Map ? prior.get(c) : prior?.[c];
      const s =
        store[c] ||
        Object.entries(store).find(([k]) => k.endsWith(':' + c) || k === c)?.[1];
      const isFree = Boolean(p?.free ?? s?.free ?? false);
      return !isFree;
    });
  }

  // Step 2 & 3: Find fresh, measured, usable candidates.
  const tierRank = { top: 1, standard: 2, light: 3 };
  const measuredUsable = [];

  for (const c of available) {
    const entry =
      store[c] ||
      Object.entries(store).find(([k]) => k.endsWith(':' + c) || k === c)?.[1];
    if (!entry || !entry.measuredAt) continue;

    const ageDays = (currentTime - entry.measuredAt) / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) continue;
    if (entry.callable === false || entry.tier === 'unusable') continue;

    if (tierRank[entry.tier]) {
      const p = prior instanceof Map ? prior.get(c) : prior?.[c];
      const isFree = Boolean(p?.free ?? entry.free ?? false);
      const context = Number(p?.context ?? entry.context ?? 0);
      const latency = Number(entry.latencyMs ?? 999999);
      measuredUsable.push({
        candidate: c,
        entry,
        tier: entry.tier,
        free: isFree,
        context,
        latency,
      });
    }
  }

  if (measuredUsable.length > 0) {
    measuredUsable.sort((a, b) => {
      const rankDiff = tierRank[a.tier] - tierRank[b.tier];
      if (rankDiff !== 0) return rankDiff;

      if (route === 'swarm' && a.free !== b.free) {
        return a.free ? -1 : 1;
      }
      if (b.context !== a.context) {
        return b.context - a.context;
      }
      return a.latency - b.latency;
    });

    const best = measuredUsable[0];
    return {
      model: best.candidate,
      tier: best.tier,
      measured: true,
      free: best.free,
      reason: 'measured fresh candidate',
    };
  }

  // Step 4: Fallback to probing unmeasured candidates in prior order.
  const notUnusable = available.filter((c) => {
    const entry =
      store[c] ||
      Object.entries(store).find(([k]) => k.endsWith(':' + c) || k === c)?.[1];
    if (entry && entry.tier === 'unusable') return false;
    return true;
  });

  notUnusable.sort((a, b) => {
    const pa = prior instanceof Map ? prior.get(a) : prior?.[a];
    const pb = prior instanceof Map ? prior.get(b) : prior?.[b];
    const freeA = pa?.free ? 1 : 0;
    const freeB = pb?.free ? 1 : 0;
    if (freeB !== freeA) return freeB - freeA;

    const ctxA = pa?.context ?? 0;
    const ctxB = pb?.context ?? 0;
    if (ctxB !== ctxA) return ctxB - ctxA;

    const rA = pa?.reasoning ? 1 : 0;
    const rB = pb?.reasoning ? 1 : 0;
    return rB - rA;
  });

  const targets = notUnusable.slice(0, probeLimit);
  if (typeof probeFn === 'function') {
    for (const candidate of targets) {
      try {
        const res = await probeFn(candidate);
        const isCallable = res?.callable ?? (res?.ok === true || res === true);
        if (isCallable) {
          const p = prior instanceof Map ? prior.get(candidate) : prior?.[candidate];
          return {
            model: candidate,
            tier: 'unmeasured',
            measured: false,
            free: Boolean(p?.free),
            reason: 'probed fallback',
          };
        }
      } catch {
        // Continue probing next candidate on error.
      }
    }
  }

  return null;
}
