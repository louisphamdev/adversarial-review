// The one Jev client: request, timeout, concurrency, state cap, and the per-call log line.
import fs from 'node:fs/promises';
import path from 'node:path';

export const JEV_STATE_CAP = 6000;
export const DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_MODEL = 'typesafe/jev-1.13';
export const TYPESAFE_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';

// Env var takes precedence over keyFile; empty or whitespace-only values count as absent.
export async function findKey(config = {}, env = process.env, readFile = fs.readFile) {
  const siftCfg = (config && 'sift' in config && typeof config.sift === 'object') ? config.sift : (config || {});
  const envName = siftCfg.apiKeyEnv || 'JEV_API_KEY';
  const fromEnv = env?.[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  // Check TYPESAFE_API_KEY fallback if custom envName was not explicitly configured
  if (!siftCfg.apiKeyEnv && env?.TYPESAFE_API_KEY && typeof env.TYPESAFE_API_KEY === 'string' && env.TYPESAFE_API_KEY.trim().length > 0) {
    return env.TYPESAFE_API_KEY.trim();
  }
  if (siftCfg.keyFile && typeof readFile === 'function') {
    try {
      const text = await readFile(siftCfg.keyFile, 'utf8');
      const prefix = `${envName}=`;
      const fallbackPrefix = 'TYPESAFE_API_KEY=';
      let fallbackKey = null;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(prefix)) {
          const val = trimmed.slice(prefix.length).trim();
          if (val.length > 0) return val;
        } else if (!siftCfg.apiKeyEnv && trimmed.startsWith(fallbackPrefix)) {
          const val = trimmed.slice(fallbackPrefix.length).trim();
          if (val.length > 0) fallbackKey = val;
        }
      }
      if (fallbackKey) return fallbackKey;
    } catch {
      // Missing or unreadable key file counts as absent key.
    }
  }
  return null;
}

export function resolveJevTarget(siftCfg = {}, env = process.env) {
  const native =
    (!siftCfg.url && !siftCfg.model && env?.TYPESAFE_API_KEY && !env?.JEV_API_KEY) ||
    (siftCfg.url && siftCfg.url.includes('typesafe.ai'));
  return {
    url: siftCfg.url || (native ? TYPESAFE_API_URL : DEFAULT_URL),
    model: siftCfg.model || (native ? TYPESAFE_DEFAULT_MODEL : DEFAULT_MODEL),
  };
}

export function capText(text, max) {
  let s = String(text ?? '');
  if (s.length <= max) return s;
  s = s.slice(0, Math.max(0, max));
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function askJev({ url, model, key, state, questions, fetch: f = globalThis.fetch, signal, timeoutMs = 60000 }) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // A ref'd timer, not AbortSignal.timeout (unref'd): it must fire even when nothing else holds the loop.
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal,
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      return { ok: false, reason: `http-${res.status}` };
    }
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch (err) {
      if (ac.signal.aborted) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'bad-response' };
    }
    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
      return { ok: false, reason: 'bad-response' };
    }
    const out = { ok: true, answers: data.answers, ms: Date.now() - t0 };
    if (data.model) out.model = data.model;
    if (data.usage) out.usage = data.usage;
    return out;
  } catch {
    return { ok: false, reason: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Path segments and value shapes that never leave the machine (spec B8, shared with buildExcerpt).
export const SECRET_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg']);
export const SECRET_BASENAME = /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.tfstate.*|credentials.*|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|\.pgpass)$/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Fa-f0-9]{40,})/;

export function isSecretPath(p) {
  const segs = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.some((s) => SECRET_SEGMENTS.has(s.toLowerCase()) || SECRET_BASENAME.test(s));
}

export function redactSecretLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const pathLike = line.match(/[\w.~\-/\\]+/g) || [];
      return SECRET_VALUE.test(line) || pathLike.some((t) => t.includes('/') || t.includes('\\') || t.startsWith('.') ? isSecretPath(t) : false)
        ? '(line removed: secret pattern)'
        : line;
    })
    .join('\n');
}

export async function appendJevLog(runDir, entry) {
  if (!runDir) return;
  try {
    await fs.appendFile(path.join(runDir, 'jev.log.jsonl'), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    // The log is observation only.
  }
}

function probabilityOf(answer, label) {
  const p = answer?.probabilities?.[label];
  if (typeof p === 'number') return p;
  if (answer?.choice === label && typeof answer.confidence === 'number') return answer.confidence;
  return Number.NaN;
}

export async function makeJevRouter({ config = {}, env = process.env, fetch: f = globalThis.fetch, runDir, signal } = {}) {
  const siftCfg = config.sift || {};
  if (siftCfg.enabled === false) return null;
  const key = await findKey(siftCfg, env);
  if (!key) return null;
  const { url, model } = resolveJevTarget(siftCfg, env);
  const limit = Number.isInteger(siftCfg.concurrency) ? siftCfg.concurrency : 8;
  const timeoutMs = typeof siftCfg.timeoutMs === 'number' ? siftCfg.timeoutMs : 60000;
  const questions = {
    touches: {
      type: 'choice',
      instructions: 'Does the CHANGE alter code, a contract, or a behavior that the SETTLED ITEM depends on?',
      criteria: {
        yes: 'the change alters code, a contract, or a behavior that this item depends on',
        no: 'the change is unrelated to this item',
      },
    },
  };
  return async ({ items, deltaText }) => {
    const out = new Map();
    // One deadline for the whole router call; this function owns the timer and clears it.
    const overall = new AbortController();
    const onAbort = () => overall.abort();
    if (signal?.aborted) overall.abort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => overall.abort(), timeoutMs);
    try {
      await mapLimit(items, limit, async (it) => {
        const state = capText(
          redactSecretLines(
            [
              `CHANGE (plan delta of this round)\n${capText(deltaText, 3000)}`,
              `SETTLED ITEM ${it.id}\n${capText(it.item ?? '', 1000)}`,
              `DONE WHEN\n${capText(it.doneWhen ?? '', 1000)}`,
              `ANCHORS\n${capText(JSON.stringify(it.anchors ?? {}), 1000)}`,
            ].join('\n\n')
          ),
          JEV_STATE_CAP
        );
        const r = await askJev({ url, model, key, state, questions, fetch: f, signal: overall.signal, timeoutMs });
        await appendJevLog(runDir, { purpose: 'router', id: it.id, action: r.ok ? 'asked' : 'failed', ms: r.ms ?? null, stateChars: state.length });
        out.set(it.id, r.ok ? probabilityOf(r.answers.touches, 'yes') : null);
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return out;
  };
}
