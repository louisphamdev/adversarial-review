// Patch plan sections, item ids, and the per-section delta. Pure: no IO.
import { ConfigError } from './errors.mjs';

export const DELTA_CAP = 12000;
export const SECTION_LINE_CAP = 2000;

// Normalizes finding, last-call, or seat identifiers: trim, lowercase, strip leading rt-.
export function normalizeId(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().toLowerCase();
  return trimmed.replace(/^rt-/, '');
}

const ITEM_HEAD = /^##\s*C0*(\d+)\b/i;
const CROSS_HEAD = /^##\s*Cross-cutting\s*$/i;
const SHAPE =
  'Required shape: one "## C<n>" section per closing item, plus an optional "## Cross-cutting" section.';

export function itemIdsOf(closingList = []) {
  const ns = closingList.map((c) => c?.n);
  const ok = ns.every((n) => Number.isInteger(n) && n > 0) && new Set(ns).size === ns.length;
  const ids = closingList.map((c, i) => `C${ok ? c.n : i + 1}`);
  const byId = Object.fromEntries(ids.map((id, i) => [id, closingList[i]]));
  return { ids, byId, renumbered: !ok && closingList.length > 0 };
}

// With letters in the id, a bare number never binds: `breaker-2` is a finding id, not item 2.
const PREFIXED_REF = /(?:^|[^0-9A-Za-z])(?:C|Item\s*|#)0*([1-9]\d*)(?![0-9])/gi;
const ANY_REF = /(?:^|[^0-9A-Za-z])(?:C|Item\s*|#)?0*([1-9]\d*)(?![0-9])/gi;

export function normalizeItemIds(raw, itemIds = []) {
  const s = String(raw ?? '');
  if (/^\s*cross(-cutting)?\s*$/i.test(s)) return ['cross'];
  const known = new Set(itemIds);
  const out = [];
  for (const m of s.matchAll(/[A-Za-z]/.test(s) ? PREFIXED_REF : ANY_REF)) {
    const id = `C${Number(m[1])}`;
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function normalizePlanText(planText) {
  return String(planText ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function parsePlan(planText, itemIds = [], { mustHave = [] } = {}) {
  const known = new Set(itemIds);
  const sections = {};
  const preamble = [];
  let current = null;
  let buf = [];
  const close = () => {
    if (current) sections[current] = buf.join('\n').trim();
  };
  let inFence = false;
  for (const line of normalizePlanText(planText).split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    let next = null;
    const m = inFence ? null : line.match(ITEM_HEAD);
    if (m) next = `C${Number(m[1])}`;
    else if (!inFence && CROSS_HEAD.test(line)) next = 'cross';
    if (!next) {
      (current ? buf : preamble).push(line);
      continue;
    }
    if (next !== 'cross' && !known.has(next)) {
      throw new ConfigError(`Plan section "## ${next}" names no closing item. ${SHAPE}`);
    }
    if (next === current || Object.hasOwn(sections, next)) {
      throw new ConfigError(`Plan has two "## ${next}" sections. ${SHAPE}`);
    }
    close();
    current = next;
    buf = [];
  }
  close();
  const missing = mustHave.filter((id) => !Object.hasOwn(sections, id));
  if (missing.length > 0) {
    throw new ConfigError(`Plan has no section for ${missing.join(', ')}. ${SHAPE}`);
  }
  return { preamble: preamble.join('\n').trim(), sections };
}

function lineDiff(a, b) {
  if (a.length > SECTION_LINE_CAP || b.length > SECTION_LINE_CAP) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['-', a[i++]]);
    } else {
      ops.push(['+', b[j++]]);
    }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function renderBlock(id, ops) {
  const keep = new Set();
  ops.forEach((o, k) => {
    if (o[0] !== ' ') for (let x = k - 2; x <= k + 2; x++) keep.add(x);
  });
  const out = [`--- ${id}`];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1 && out.length > 1) out.push('...');
    out.push(`${o[0]}${o[1]}`);
    last = k;
  });
  return out.join('\n');
}

const splitLines = (s) => (s ? String(s).split('\n') : []);

export function sectionDelta(prev = {}, next = {}) {
  const ids = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const changed = [];
  const changedLines = {};
  const blocks = [];
  for (const id of ids) {
    const ops = lineDiff(splitLines(prev[id]), splitLines(next[id]));
    const delta = ops.filter((o) => o[0] !== ' ');
    if (delta.length === 0) continue;
    changed.push(id);
    changedLines[id] = [...delta.filter((o) => o[0] === '-'), ...delta.filter((o) => o[0] === '+')].map((o) => o[1]);
    blocks.push(renderBlock(id, ops));
  }
  let text = blocks.join('\n');
  let cut = false;
  if (text.length > DELTA_CAP) {
    cut = true;
    const share = Math.max(0, Math.floor(DELTA_CAP / blocks.length) - 12);
    text = blocks.map((b) => (b.length > share ? `${b.slice(0, share)}\n...(cut)` : b)).join('\n');
    if (text.length > DELTA_CAP) text = `${text.slice(0, DELTA_CAP - 9)}\n...(cut)`;
  }
  return { changed, changedLines, text, cut };
}
