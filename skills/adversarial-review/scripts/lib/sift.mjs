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
  if (siftCfg.keyFile && typeof readFile === 'function') {
    try {
      const text = await readFile(siftCfg.keyFile, 'utf8');
      const prefix = `${envName}=`;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(prefix)) {
          const val = trimmed.slice(prefix.length).trim();
          if (val.length > 0) return val;
        }
      }
    } catch {
      // Missing or unreadable key file counts as absent key.
    }
  }
  return null;
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
    const signal = AbortSignal.timeout(timeoutMs);
    const url = siftCfg.url || DEFAULT_URL;
    const model = siftCfg.model || DEFAULT_MODEL;
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
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal.aborted) {
        return { status: 'skipped', reason: 'timeout', rows: [], readingOrder: [] };
      }
      return { status: 'skipped', reason: 'network', rows: [], readingOrder: [] };
    }

    if (!res.ok) {
      await res.text().catch(() => {});
      return { status: 'skipped', reason: `http-${res.status}`, rows: [], readingOrder: [] };
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal.aborted) {
        return { status: 'skipped', reason: 'timeout', rows: [], readingOrder: [] };
      }
      return { status: 'skipped', reason: 'network', rows: [], readingOrder: [] };
    }

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

    const result = {
      status: 'used',
      rows,
      readingOrder,
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
