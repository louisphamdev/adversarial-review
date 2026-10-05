import { runChild as defaultRunChild } from './proc.mjs';
// Model discovery, models.dev prior registry caching, bench scoring, and model selection.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isValidModel } from './config.mjs';
import { resolveOpencodeExe } from './backends/opencode.mjs';
import { acquireLock } from './lockfile.mjs';
import { writeFileAtomic, readJsonSafe } from './fsx.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This module owns the bench/lenses layout: the directory, the keyed material file of each lens,
// the answer key beside it, and the review stage the lens is scored at. A second resolution of
// the same paths in a caller is how a fixture move breaks one half and not the other.
export const LENS_DIR = path.resolve(__dirname, '../../bench/lenses');
const LENS_REUSE_MS = 7 * 86400000;
// The file that holds the keyed defects of a lens. Every other `material*` file in that directory
// is context the seat may read, so it must not become the named review target.
const LENS_MATERIAL = { keeper: 'material.sql', tester: 'material.test.js', historian: 'material.md' };
// Store keys whose value is a per-lens map, so a partial write must merge instead of replace.
const MERGED_MAPS = ['lenses', 'lensMeasuredAt'];

// One seeded fixture per lens lives under bench/lenses/<lens>/. The order is the order of
// `test/lens-fixtures.test.mjs`, which pins it.
export const LENSES = Object.freeze([
  'breaker',
  'edge',
  'attacker',
  'racer',
  'keeper',
  'medic',
  'tester',
  'historian',
  'simplifier',
]);

// Lens tier order used to rank a model for one seat. 'unusable' is filtered out before ranking.
const TIER_RANK = { top: 0, standard: 1, light: 2, unmeasured: 3 };
// Seats that pick their model first, so the best-ranked model is not taken by a weaker seat.
const STRONG_SEATS = new Set(['breaker', 'attacker', 'racer', 'keeper']);
const STORE_VERSION = 4;

const providerOf = (m) => String(m).split('/')[0];
// A tier the store does not know ranks as unmeasured: an unknown value must not make the sort
// comparator return NaN, because that leaves the seat order undefined.
const rankOf = (tier) => TIER_RANK[tier] ?? TIER_RANK.unmeasured;
// The breaker score of a store entry. A writer may set only `lenses.breaker`, so a reader of the
// top-level `tier` alone would call a measured model unmeasured and probe it again.
function warn(stderr, message) {
  if (stderr?.write) {
    stderr.write(message + '\n');
  } else {
    console.warn(message);
  }
}

const DISCOVER_TIMEOUT_MS = 30000;

// Discovers models for a given backend, trimming lines and validating model syntax.
export async function discover(
  backendName,
  { config = {}, runChild = defaultRunChild, env, stderr, exists } = {}
) {
  if (backendName === 'opencode') {
    if (typeof runChild !== 'function') {
      return { candidates: [], authoritative: true, error: 'runChild required', notes: [] };
    }
    const notes = [];
    // Every caller gets the diagnostics, so no call site has to remember to print notes.
    const reported = (result) => {
      for (const note of notes) warn(stderr, `note: ${note}`);
      return result;
    };
    try {
      const seam = exists ? { exists } : {};
      const { exe, searched } = await resolveOpencodeExe(config, env || process.env, seam);
      if (!exe) {
        notes.push(`opencode executable not found (searched: ${searched.join(', ')})`);
        return reported({
          candidates: [],
          authoritative: true,
          error: 'opencode executable not found',
          notes,
        });
      }
      // A first-run opencode under a fresh home never answers `models`, and discovery now runs on
      // every route, so an unbounded call here hangs every run (A-R15: a hang carries no message).
      const res = await runChild({ cmd: exe, args: ['models'], env, timeoutMs: DISCOVER_TIMEOUT_MS });
      if (res.code !== 0 || res.spawnError || res.timedOut) {
        const error = res.timedOut
          ? `opencode models did not answer within ${DISCOVER_TIMEOUT_MS / 1000}s; resolved executable: ${exe}`
          : `${String(res.spawnError?.message || res.stderr || 'opencode models failed').slice(0, 500)} (exit ${res.code})`;
        const hint = /Unrecognized flag/.test(res.stderr || '')
          ? `a wrapper on PATH adds a flag that opencode does not accept; resolved executable: ${exe}`
          : undefined;
        notes.push(`discovery failed: ${error}${hint ? ` - ${hint}` : ''}`);
        return reported({ candidates: [], authoritative: true, error, hint, notes });
      }
      const candidates = [];
      const lines = String(res.stdout || '').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (isValidModel(line)) {
          candidates.push(line);
        } else {
          warn(stderr, `catalog: dropping invalid model id '${line}'`);
        }
      }
      return reported({ candidates, authoritative: true, notes });
    } catch (err) {
      notes.push(`discovery failed: ${err.message}`);
      return reported({ candidates: [], authoritative: true, error: err.message, notes });
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
      const cost = modelObj.cost ?? null;
      map.set(id, { free, toolCall, reasoning, context, textOnly, cost });
    }
  }
  return map;
}

// A version-3 store wrote the breaker score as a top-level `tier`; reading it as `lenses.breaker`
// keeps that measurement usable. Migration only: it must never overwrite a lens score a writer set,
// so a writer that sets `lenses.breaker` without a `tier` keeps its value.
function migrateStore(store) {
  store.version = STORE_VERSION;
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== 'object') continue;
    if ('tier' in entry && entry.lenses?.breaker === undefined) {
      entry.lenses = { ...entry.lenses, breaker: entry.tier };
    }
  }
  return store;
}

// Reads the model measurement store. A missing or unreadable file reads as an empty v4 store.
export async function readStore(stateDir) {
  const filePath = path.join(stateDir, 'models.json');
  const res = await readJsonSafe(filePath);
  if (!res.ok || !res.value || typeof res.value !== 'object') {
    return { version: STORE_VERSION };
  }
  return migrateStore(res.value);
}

// Serializes updates into models.json holding models.lock with onBusy: 'wait'. An updater function
// sees the store as it is on disk inside the lock, so a read-modify-write cannot lose a concurrent
// increment. An object or array argument is merged per key instead, with `lenses` merged per lens.
export async function updateStore(stateDir, updaterOrEntries) {
  const lockPath = path.join(stateDir, 'models.lock');
  const filePath = path.join(stateDir, 'models.json');
  const lock = await acquireLock(lockPath, { onBusy: 'wait' });

  try {
    const res = await readJsonSafe(filePath);
    let current;
    if (res.ok && res.value && typeof res.value === 'object') {
      current = migrateStore(res.value);
    } else if (res.missing) {
      current = { version: STORE_VERSION };
    } else {
      // A parse error is not an empty store. Overwriting here would erase every measurement.
      throw new Error(`models.json is not readable (${res.error || 'parse error'}); not overwritten`);
    }

    let next;
    if (typeof updaterOrEntries === 'function') {
      next = updaterOrEntries(structuredClone(current));
    } else {
      next = structuredClone(current);
      const pairs = Array.isArray(updaterOrEntries)
        ? updaterOrEntries.map((item) => [
            item.key || (item.backend && item.model ? `${item.backend}:${item.model}` : item.model),
            item,
          ])
        : Object.entries(updaterOrEntries || {}).filter(([k]) => k !== 'version');
      for (const [key, value] of pairs) {
        if (!key) continue;
        const prev = next[key];
        next[key] = { ...prev, ...value };
        for (const map of MERGED_MAPS) {
          if (value?.[map]) next[key][map] = { ...prev?.[map], ...value[map] };
        }
      }
    }

    migrateStore(next);
    await writeFileAtomic(filePath, JSON.stringify(next, null, 2) + '\n');
  } finally {
    await lock.release();
  }
}

// Normalizes model ids named by --model or swarm.models. A rejected value becomes a note instead of
// an error, so one bad id does not lose the run.
export function cleanNamed(values = [], candidates = []) {
  const named = [];
  const notes = [];
  const seen = new Set();
  const canon = new Map(candidates.map((c) => [String(c).toLowerCase(), c]));

  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1 || !isValidModel(value)) {
      notes.push(`named model "${value}" rejected: expected provider/model`);
      continue;
    }
    const id = canon.get(value.toLowerCase()) || value;
    const dedupe = id.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    named.push(id);
  }
  return { named, notes };
}

// Builds the swarm pool. `free` comes from price data only: the model name is never read for it,
// which is why `store` is part of the declared input and stays unread.
export function buildPool({
  candidates = [],
  prior = new Map(),
  store = {},
  named = [],
  probeResults = {},
} = {}) {
  const notes = [];
  const priorOf = (m) => (prior instanceof Map ? prior.get(m) : prior?.[m]);
  const out = new Map();

  for (const model of candidates) {
    const p = priorOf(model);
    let free = false;
    let freeSource = null;
    if (p && p.cost && p.cost.input === 0 && p.cost.output === 0) {
      free = true;
      freeSource = 'models.dev';
    } else if (p && p.free === true && !p.cost) {
      free = true;
      freeSource = 'models.dev';
    } else if (!p) {
      // models.dev has no entry: the probe decides, and only a complete cost reading counts.
      const r = probeResults[model];
      if (r && r.costComplete === true && r.costTotal === 0 && r.tokensTotal > 0) {
        free = true;
        freeSource = 'probe';
      }
    }
    if (providerOf(model) === 'opencode' && free) {
      out.set(model, { model, provider: 'opencode', free, freeSource, named: false });
    }
  }

  // A named model joins whatever its provider and price.
  for (const model of named) {
    const existing = out.get(model);
    out.set(model, {
      model,
      provider: providerOf(model),
      free: existing?.free ?? false,
      freeSource: existing?.freeSource ?? null,
      named: true,
    });
  }

  return { pool: [...out.values()], notes };
}

// Probes every model at the same time. A model that has not answered at the deadline is
// callable: false for this run only, and storableProbe() keeps it out of the store.
export async function probe({ models = [], laneCall, deadlineMs = 90000 } = {}) {
  const entries = {};
  await Promise.all(
    models.map(async (model) => {
      const start = Date.now();
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, errorType: 'timeout' }), deadlineMs).unref?.();
      });
      let res;
      try {
        res = await Promise.race([laneCall(model), timeout]);
      } catch (err) {
        res = { ok: false, errorType: 'spawn', error: err.message };
      }
      entries[model] = {
        model,
        callable: Boolean(res?.ok),
        contract: Boolean(res?.ok && res.value),
        latencyMs: res?.latencyMs ?? Date.now() - start,
        costTotal: res?.costTotal ?? null,
        tokensTotal: res?.tokensTotal ?? null,
        costComplete: Boolean(res?.costComplete),
        errorType: res?.ok ? null : res?.errorType || 'bad-output',
        measuredAt: Date.now(),
      };
    })
  );
  return entries;
}

// Only a final answer is worth storing. A timeout or a rate limit says nothing about the model, so
// the next run probes it again.
export const storableProbe = (e) =>
  Boolean(e) &&
  (e.callable === true || e.errorType === 'provider-refused' || e.errorType === 'not-found');

// Assigns one model per finder seat. The judge seat is never in `seats`.
export function assignSeats({ seats = [], pool = [], store = {} } = {}) {
  const entryOf = (m) => store[`opencode:${m}`] || store[m] || {};
  const callable = pool.filter((p) => entryOf(p.model).callable !== false);
  const isStrong = (seat) => seat.tier === 'strong' || STRONG_SEATS.has(seat.key);
  const ordered = [...seats].sort((a, b) => Number(isStrong(b)) - Number(isStrong(a)));
  const held = new Set();
  const result = {};

  for (const seat of ordered) {
    const ranked = callable
      .map((p) => {
        const e = entryOf(p.model);
        return {
          p,
          tier: e.lenses?.[seat.key] ?? 'unmeasured',
          mis: e.misbehaved || 0,
          lat: e.latencyMs ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter((x) => x.tier !== 'unusable')
      .sort((a, b) => rankOf(a.tier) - rankOf(b.tier) || a.mis - b.mis || a.lat - b.lat);
    if (ranked.length === 0) continue;
    // Every model already held: the seat takes its best-ranked model again.
    const pick = ranked.find((x) => !held.has(x.p.model)) || ranked[0];
    held.add(pick.p.model);
    result[seat.key] = {
      model: pick.p.model,
      capability: pick.tier === 'top' ? 'strong' : 'weak',
      lensTier: pick.tier,
      failover: ranked
        .filter((x) => x !== pick)
        .slice(0, 2)
        .map((x) => x.p.model),
    };
  }
  return result;
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

// Reads one lens answer key. A missing or unreadable key scores every finding as invented, which
// scoreBench reports as `unusable`: a silent empty key must not read as a passing model.
export async function loadLensKey(lens) {
  const r = await readJsonSafe(path.join(LENS_DIR, lens, 'answer-key.json'));
  return r.ok && Array.isArray(r.value) ? r.value : [];
}

// The keyed material file of a lens, inside `treeDir` (the fixture directory or a copy of it).
export function lensMaterialPath(lens, treeDir = path.join(LENS_DIR, lens)) {
  return path.join(treeDir, LENS_MATERIAL[lens] || 'material.js');
}

// `historian` reviews a specification; every other lens reviews code.
export function lensStage(lens) {
  return lens === 'historian' ? 'spec' : 'code';
}

// Runs every (model, lens) pair at the same time. `benchCallFor(lens)(model)` answers one pair.
export async function bench({ models = [], lenses = LENSES, benchCallFor, deadlineMs = 600000 } = {}) {
  const out = {};
  const jobs = [];
  for (const model of models) {
    out[model] = {};
    for (const lens of lenses) {
      jobs.push(
        (async () => {
          const timeout = new Promise((resolve) => {
            setTimeout(() => resolve({ ok: false, errorType: 'timeout' }), deadlineMs).unref?.();
          });
          let res;
          try {
            res = await Promise.race([benchCallFor(lens)(model), timeout]);
          } catch {
            res = { ok: false, errorType: 'spawn' };
          }
          if (!res?.ok) {
            // A refusal or a missing model is a fact about the model. Every other failure says
            // nothing, so it stays unmeasured and the caller does not store it.
            const refused = res?.errorType === 'provider-refused' || res?.errorType === 'not-found';
            out[model][lens] = { score: 0, invented: 0, tier: refused ? 'unusable' : 'unmeasured' };
            return;
          }
          out[model][lens] = scoreBench(res.value?.findings || [], await loadLensKey(lens));
        })()
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

// Researches one named model: models.dev prior, then a probe, then the lenses of the named seats.
// A lens measured under 7 days ago is reused instead of benched again.
export async function research(
  model,
  { seats = LENSES, prior = new Map(), store = {}, deadlineMs = 600000, probeLane, benchCallFor, now = Date.now } = {}
) {
  const reasons = [];
  const p = prior instanceof Map ? prior.get(model) : prior?.[model];
  if (p && p.toolCall === false) {
    return { accepted: false, reasons: ['the model has no tool calls (models.dev tool_call: false)'], lenses: {}, seats: [], benched: [] };
  }
  if (p && p.textOnly === false) {
    return { accepted: false, reasons: ['the model has no text output (models.dev modalities)'], lenses: {}, seats: [], benched: [] };
  }

  const pr = await probe({ models: [model], laneCall: probeLane, deadlineMs: Math.min(90000, deadlineMs) });
  if (!pr[model].callable) {
    return { accepted: false, reasons: [`probe failed: ${pr[model].errorType}`], lenses: {}, seats: [], benched: [], probe: pr[model] };
  }

  const entry = store[`opencode:${model}`] || store[model] || {};
  const lenses = {};
  const todo = [];
  for (const lens of seats.filter((s) => LENSES.includes(s))) {
    const at = entry.lensMeasuredAt?.[lens];
    if (entry.lenses?.[lens] && at && now() - at < LENS_REUSE_MS) lenses[lens] = entry.lenses[lens];
    else todo.push(lens);
  }

  const b = todo.length ? await bench({ models: [model], lenses: todo, benchCallFor, deadlineMs }) : { [model]: {} };
  const benched = Object.keys(b[model]);
  for (const lens of benched) lenses[lens] = b[model][lens].tier;

  const taken = Object.entries(lenses)
    .filter(([, t]) => t === 'top' || t === 'standard')
    .map(([l]) => l);
  for (const [lens, t] of Object.entries(lenses)) if (!taken.includes(lens)) reasons.push(`${lens}: lens tier ${t}`);
  // `benched` is what the caller may re-stamp in `lensMeasuredAt`. A reused lens is absent from it,
  // so a weekly research run cannot keep an old score inside the 7-day window forever.
  return { accepted: true, reasons, lenses, seats: taken, benched, probe: pr[model] };
}

// Writes the lens tiers of one bench or research run. `measured` names the lenses this run really
// scored: only those get a new `lensMeasuredAt`, so a lens that `research` reused from the store
// keeps the timestamp that the 7-day reuse window is measured from.
export async function storeLensTiers(stateDir, { backend, model, tiers = {}, measured, extra = {}, now = Date.now } = {}) {
  const stamp = new Set(measured ?? Object.keys(tiers));
  const lenses = {};
  const lensMeasuredAt = {};
  const at = now();
  for (const [lens, tier] of Object.entries(tiers)) {
    // A lens this run did not measure is already in the store with its own timestamp. Skipping it
    // keeps the two maps aligned by construction: no tier can arrive here without a timestamp.
    if (!tier || tier === 'unmeasured' || !stamp.has(lens)) continue;
    lenses[lens] = tier;
    lensMeasuredAt[lens] = at;
  }
  if (Object.keys(lenses).length === 0 && Object.keys(extra).length === 0) return;
  await fs.mkdir(stateDir, { recursive: true });
  await updateStore(stateDir, { [`${backend}:${model}`]: { ...extra, backend, model, lenses, lensMeasuredAt } });
}
