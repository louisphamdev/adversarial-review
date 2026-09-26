import { readFile as defaultReadFile } from 'node:fs/promises';

// Criteria legend is sent with each question; keep labels concise to save tokens.
export const VERDICTS = {
  confirmed: 'evidence holds, failure is concrete',
  disputed: 'evidence partial or unverifiable',
  refuted: 'material proves it is not a defect',
  advisory: 'real but not blocking: naming, style, taste',
};

export const SEVERITY = ['advisory', 'should fix', 'blocks release'];

export const MAX_STATE_CHARS = 100000;
export const DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_MODEL = 'typesafe/jev-1.13';
export const TYPESAFE_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_LOW_CONFIDENCE = 0.6;

// Jev evaluates questions against state; material and each finding are written once.
export function buildState(materialText, findings) {
  const text = typeof materialText === 'object' && materialText !== null
    ? (materialText.text ?? '')
    : (materialText ?? '');
  const lines = (findings || []).map((f) => {
    const claim = f.claim ?? f.title ?? '';
    return `${f.id} [${f.seat}] ${claim}${f.evidence ? ` | ${f.evidence}` : ''}`;
  });
  return `MATERIAL\n${text}\n\nFINDINGS\n${lines.join('\n')}`;
}

// Question instructions point to finding id; the key and criteria carry the axis.
export function buildQuestions(findings) {
  const questions = {};
  for (const f of findings || []) {
    questions[`${f.id}_verdict`] = { type: 'choice', instructions: f.id, criteria: VERDICTS };
    questions[`${f.id}_severity`] = { type: 'score', instructions: `${f.id} severity`, criteria: SEVERITY };
  }
  return questions;
}

// Env var takes precedence over keyFile; empty or whitespace-only values count as absent.
export async function findKey(config = {}, env = process.env, readFile = defaultReadFile) {
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

// Clusters findings by file/line or claim to detect duplicate issues across seats.
export function clusterFindings(findings = [], rows = []) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const rowMap = new Map((rows || []).map((r) => [r.id, r]));

  const groups = new Map();
  for (const f of findings) {
    const file = f.file || (f.evidence ? f.evidence.split(':')[0].trim() : '') || 'unknown';
    let line = f.line != null ? String(f.line) : '';
    if (!line && f.evidence && f.evidence.includes(':')) {
      const match = f.evidence.match(/:(\d+)/);
      if (match) line = match[1];
    }
    const claimSnippet = (f.claim || f.title || '').slice(0, 30).toLowerCase().trim();
    const key = file !== 'unknown' && line ? `${file}:${line}` : `${file}#${claimSnippet}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const clusters = [];
  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      const sorted = [...group].sort((a, b) => {
        const ra = rowMap.get(a.id);
        const rb = rowMap.get(b.id);
        const scoreA = (ra?.severity ?? 0) * 10 + (ra?.confidence ?? 0);
        const scoreB = (rb?.severity ?? 0) * 10 + (rb?.confidence ?? 0);
        return scoreB - scoreA;
      });
      clusters.push({
        key,
        canonical: sorted[0].id,
        duplicates: sorted.slice(1).map((f) => f.id),
        count: group.length,
      });
    }
  }
  return clusters;
}

// Sifts findings with Jev; never throws and returns skipped status on any failure.
export async function siftFindings({
  material,
  findings,
  config = {},
  env = process.env,
  fetchImpl = fetch,
  fetch: fetchAlias,
  readFile = defaultReadFile,
  readFileImpl,
} = {}) {
  try {
    const siftCfg = (config && 'sift' in config && typeof config.sift === 'object') ? config.sift : (config || {});
    const fnFetch = fetchAlias || fetchImpl || globalThis.fetch;
    const fnReadFile = readFileImpl || readFile || defaultReadFile;

    if (siftCfg.enabled === false) {
      return { status: 'skipped', reason: 'disabled', rows: [], readingOrder: [] };
    }

    const key = await findKey(siftCfg, env, fnReadFile);
    if (!key) {
      return { status: 'skipped', reason: 'no-key', rows: [], readingOrder: [] };
    }

    if (!Array.isArray(findings) || findings.length === 0) {
      return { status: 'skipped', reason: 'no-findings', rows: [], readingOrder: [] };
    }

    if (material?.kind === 'dir' || material?.kind === 'directory') {
      return { status: 'skipped', reason: 'material-is-directory', rows: [], readingOrder: [] };
    }

    const materialText = typeof material === 'object' && material !== null ? (material.text ?? '') : (material ?? '');
    const state = buildState(materialText, findings);
    if (state.length > MAX_STATE_CHARS) {
      return { status: 'skipped', reason: 'state-over-budget', rows: [], readingOrder: [] };
    }

    const timeoutMs = typeof siftCfg.timeoutMs === 'number' ? siftCfg.timeoutMs : DEFAULT_TIMEOUT_MS;
    // A ref'd timer, not AbortSignal.timeout (unref'd): it must fire even when nothing else holds the loop.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    const isNativeTypeSafe = (!siftCfg.url && !siftCfg.model && (env?.TYPESAFE_API_KEY && !env?.JEV_API_KEY)) ||
                             (siftCfg.url && siftCfg.url.includes('typesafe.ai'));
    const url = siftCfg.url || (isNativeTypeSafe ? TYPESAFE_API_URL : DEFAULT_URL);
    const model = siftCfg.model || (isNativeTypeSafe ? TYPESAFE_DEFAULT_MODEL : DEFAULT_MODEL);
    const questions = buildQuestions(findings);

    let res;
    try {
      res = await fnFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, state, questions }),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal.aborted) {
        return { status: 'skipped', reason: 'timeout', rows: [], readingOrder: [] };
      }
      return { status: 'skipped', reason: 'network', rows: [], readingOrder: [] };
    }

    if (!res.ok) {
      clearTimeout(timer);
      await res.text().catch(() => {});
      return { status: 'skipped', reason: `http-${res.status}`, rows: [], readingOrder: [] };
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal.aborted) {
        return { status: 'skipped', reason: 'timeout', rows: [], readingOrder: [] };
      }
      return { status: 'skipped', reason: 'network', rows: [], readingOrder: [] };
    }

    clearTimeout(timer);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { status: 'skipped', reason: 'bad-response', rows: [], readingOrder: [] };
    }

    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
      return { status: 'skipped', reason: 'bad-response', rows: [], readingOrder: [] };
    }

    const rows = [];
    for (const f of findings) {
      const v = data.answers[`${f.id}_verdict`];
      const s = data.answers[`${f.id}_severity`];
      if (!v || !s || typeof v !== 'object' || typeof s !== 'object' || typeof v.choice !== 'string') {
        return { status: 'skipped', reason: 'bad-response', rows: [], readingOrder: [] };
      }
      const confidence = typeof v.confidence === 'number' ? Number(v.confidence.toFixed(3)) : 0;
      const severity = typeof s.score === 'number' ? Number(s.score.toFixed(2)) : 0;
      rows.push({
        id: f.id,
        seat: f.seat,
        verdict: v.choice,
        confidence,
        severity,
      });
    }

    rows.sort((a, b) => b.severity - a.severity || a.confidence - b.confidence);

    const lowConfidence = typeof siftCfg.lowConfidence === 'number' ? siftCfg.lowConfidence : DEFAULT_LOW_CONFIDENCE;
    const lowConfRows = rows.filter((r) => r.confidence < lowConfidence).sort((a, b) => a.confidence - b.confidence);
    const readingOrder = lowConfRows.map((r) => r.id);

    const filteredOut = rows.filter((r) => r.verdict === 'refuted' && r.confidence >= 0.85).map((r) => r.id);
    const highConfidenceConfirmed = rows.filter((r) => r.verdict === 'confirmed' && r.confidence >= 0.8).map((r) => r.id);
    const clusters = clusterFindings(findings, rows);

    const result = {
      status: 'used',
      rows,
      readingOrder,
      filteredOut,
      highConfidenceConfirmed,
      clusters,
    };
    if (data.model) result.model = data.model;
    if (data.usage) result.usage = data.usage;
    return result;
  } catch {
    return { status: 'skipped', reason: 'network', rows: [], readingOrder: [] };
  }
}

// Compares judge closingList sources with sift votes; non-sift ids are ignored.
export function compareSift(sift, ruling, findings = []) {
  if (!sift || sift.status !== 'used' || !Array.isArray(sift.rows) || !ruling || !Array.isArray(ruling.closingList)) {
    return { disagreements: [] };
  }

  const siftRowById = new Map();
  for (const row of sift.rows) {
    siftRowById.set(row.id, row);
  }

  const keptIds = new Set();
  for (const item of ruling.closingList) {
    if (Array.isArray(item?.sources)) {
      for (const src of item.sources) {
        keptIds.add(src);
      }
    }
  }

  const disagreements = [];
  const seenIds = new Set();

  for (const id of keptIds) {
    const row = siftRowById.get(id);
    if (!row) continue;
    if (row.verdict === 'refuted' && row.confidence >= 0.8) {
      seenIds.add(id);
      disagreements.push({
        id,
        type: 'judge-kept-refuted',
        reason: 'judge-kept-refuted',
        verdict: row.verdict,
        confidence: row.confidence,
        severity: row.severity,
      });
    }
  }

  const candidateFindings = Array.isArray(findings) && findings.length > 0 ? findings : sift.rows;
  for (const f of candidateFindings) {
    const id = f.id;
    if (keptIds.has(id) || seenIds.has(id)) continue;
    const row = siftRowById.get(id);
    if (!row) continue;
    if (row.verdict === 'confirmed' && row.confidence >= 0.8 && row.severity >= 1.5) {
      seenIds.add(id);
      disagreements.push({
        id,
        type: 'judge-dropped-confirmed',
        reason: 'judge-dropped-confirmed',
        verdict: row.verdict,
        confidence: row.confidence,
        severity: row.severity,
      });
    }
  }

  return { disagreements };
}
