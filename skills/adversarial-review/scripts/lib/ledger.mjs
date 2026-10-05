// Item states for patch-review. The round records own the state; everything here is pure.
import crypto from 'node:crypto';
import { itemIdsOf, normalizeItemIds, normalizeId } from './plan-sections.mjs';
import { ConfigError } from './errors.mjs';

export const RESTART_302 =
  'This run has patch-review records from 3.0.2. Start a new review with `adversarial-review run`, then send the plan to the new run.';

const SYMBOL = /^[A-Za-z_$][\w$.\-/]*$/;

export function anchorsFor(item = {}, findings = [], stage = 'code') {
  const byId = new Map(findings.map((f) => [normalizeId(f.id), f]));
  const files = [];
  const symbols = new Set();
  const sections = new Set();
  const unknownSources = [];
  const addFile = (file, from, to) => {
    if (!file) return;
    const norm = String(file).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
    files.push({ file: norm, from: from ?? null, to: to ?? null });
  };
  const scanSymbols = (t) => {
    for (const m of String(t ?? '').matchAll(/`([^`\n]{3,})`/g)) {
      const tok = m[1].trim();
      if (tok.length >= 3 && SYMBOL.test(tok)) symbols.add(tok);
    }
  };
  for (const src of item.sources || []) {
    const f = byId.get(normalizeId(src));
    if (!f) {
      unknownSources.push(src);
      continue;
    }
    const nums = String(f.line ?? '').match(/\d+/g)?.map(Number) || [];
    if (f.file) addFile(f.file, nums.length ? Math.min(...nums) : null, nums.length ? Math.max(...nums) : null);
    for (const m of String(f.evidence ?? '').matchAll(/([\w.\-/\\]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g)) {
      addFile(m[1], Number(m[2]), Number(m[3] ?? m[2]));
    }
    scanSymbols(f.evidence);
    scanSymbols(f.title);
    if (stage === 'spec') {
      for (const t of [f.evidence, f.title, f.detail]) {
        for (const m of String(t ?? '').matchAll(/(?:§\s*|section\s+)(\d+(?:\.\d+)*)/gi)) sections.add(`§${m[1]}`);
      }
    }
  }
  scanSymbols(item.item);
  return {
    files,
    symbols: [...symbols],
    sections: [...sections],
    none: files.length === 0 && symbols.size === 0 && sections.size === 0,
    unknownSources,
  };
}

export function anchorTokens(anchors) {
  const out = new Set();
  for (const f of anchors.files || []) {
    out.add(f.file);
    const base = f.file.split('/').pop();
    if (base) out.add(base);
  }
  for (const s of anchors.symbols || []) out.add(s);
  for (const s of anchors.sections || []) {
    out.add(s);
    out.add(`section ${s.slice(1)}`);
  }
  return [...out].filter((t) => t.length >= 3);
}

export function initLedger(closingList = [], findings = [], stage = 'code') {
  const { ids, byId } = itemIdsOf(closingList);
  const items = {};
  for (const id of ids) {
    items[id] = {
      item: byId[id]?.item ?? '',
      doneWhen: byId[id]?.doneWhen ?? '',
      state: 'open',
      settledAt: null,
      demands: [],
      lastObjections: [],
      anchors: anchorsFor(byId[id], findings, stage),
      reopened: [],
    };
  }
  return { version: 1, round: 0, sections: {}, items, advisory: [], last: null };
}

export function versionAtLeast(v, min = '3.1.0') {
  const a = String(v ?? '').split('.').map((x) => Number.parseInt(x, 10));
  const b = min.split('.').map(Number);
  if (a.length < 3 || a.some((x) => !Number.isInteger(x))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export function closingListHashOf(closingList = []) {
  const { ids, byId } = itemIdsOf(closingList);
  const canon = ids.map((id) => ({ id, item: byId[id]?.item ?? '', doneWhen: byId[id]?.doneWhen ?? '' }));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export function countsAsRound(record) {
  return Boolean(record && versionAtLeast(record.engineVersion) && record.judge && !record.judgeDead && !record.skipped);
}

export function applyRound(ledger, record) {
  const next = structuredClone(ledger);
  const ids = Object.keys(next.items);
  const round = record.round;
  const reviewed = [...new Set(record.reviewedIds || [])].filter((id) => ids.includes(id));
  const objections = new Map(reviewed.map((id) => [id, []]));
  const crossAffected = new Set();
  const object = (id, why) => {
    if (objections.has(id)) objections.get(id).push(why);
  };

  for (const sr of record.seatResponses || []) {
    const askedFor = (sr.askedFor || reviewed).filter((id) => objections.has(id));
    if (sr.error || !Array.isArray(sr.items)) {
      askedFor.forEach((id) => object(id, `${sr.seat}: seat-dead`));
      continue;
    }
    const answered = new Set();
    for (const it of sr.items) {
      const named = normalizeItemIds(it.id, ids);
      const sound = it.plan === 'sound';
      if (named.includes('cross')) {
        if (!sound) {
          const affects = (Array.isArray(it.affects) ? it.affects : []).flatMap((a) => normalizeItemIds(a, ids)).filter((x) => x !== 'cross');
          if (affects.length === 0) {
            // Absent, empty, or unknown affects: an unmapped objection on every reviewed item.
            reviewed.forEach((id) => object(id, `${sr.seat}: unmapped cross ${it.plan}: ${it.reason ?? ''}`));
          } else {
            affects.forEach((id) => {
              crossAffected.add(id);
              object(id, `${sr.seat}: cross ${it.plan}: ${it.reason ?? ''}`);
            });
          }
        }
        continue;
      }
      if (named.length === 0) {
        if (!sound) reviewed.forEach((id) => object(id, `${sr.seat}: unmapped ${it.id}: ${it.reason ?? ''}`));
        continue;
      }
      for (const id of named) {
        answered.add(id);
        if (!sound) object(id, `${sr.seat}: ${it.plan}: ${it.reason ?? ''}`);
      }
    }
    for (const id of askedFor) if (!answered.has(id)) object(id, `${sr.seat}: no-answer`);
  }

  const blocking = [];
  const advisory = [];
  const seen = new Set();
  for (const d of record.judge?.revise || []) {
    const text = String(d.item ?? '').trim();
    const named = normalizeItemIds(d.itemId ?? d.item, ids);
    if (named.length === 0) {
      advisory.push({ round, itemId: null, text, note: 'unknown-item' });
      continue;
    }
    for (const id of named) {
      const targets = id === 'cross' ? [...crossAffected] : [id];
      if (targets.length === 0) advisory.push({ round, itemId: id, text, note: 'no-objection' });
      for (const t of targets) {
        const key = `${t}\u0000${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (objections.get(t)?.length) blocking.push({ itemId: t, text, doneWhen: d.doneWhen ?? '' });
        else advisory.push({ round, itemId: t, text, note: 'no-objection' });
      }
    }
  }

  for (const pd of record.judge?.priorDemands || []) {
    const [id] = normalizeItemIds(pd.itemId, ids);
    const demand = id && next.items[id]?.demands.find((x) => x.text === String(pd.demand ?? '').trim());
    if (demand) demand.judgeStatus = pd.status;
  }

  for (const id of reviewed) {
    const it = next.items[id];
    const obj = objections.get(id);
    const blocks = blocking.filter((b) => b.itemId === id);
    it.lastObjections = obj;
    if (it.state === 'open') {
      if (obj.length === 0 && blocks.length === 0) {
        it.state = 'settled';
        it.settledAt = round;
        it.demands.forEach((x) => {
          x.status = 'met';
        });
      } else {
        for (const b of blocks) it.demands.push({ text: b.text, round, status: 'not-met' });
      }
    } else if (obj.length > 0) {
      it.state = 'open';
      it.settledAt = null;
      it.reopened.push({ round, reason: obj.join(' | ') });
      it.demands.push({ text: obj.join(' | '), round, status: 'not-met' });
      for (const x of blocks) it.demands.push({ text: x.text, round, status: 'not-met' });
    }
  }

  next.advisory.push(...advisory);
  next.round = round;
  if (record.sections) next.sections = { ...next.sections, ...record.sections };
  const decision = ids.some((id) => next.items[id].state === 'open') ? 'REVISE' : 'APPLY';
  next.last = { round, blocking, advisory, objections: Object.fromEntries(objections), decision };
  return next;
}

export function deriveLedger(records = [], closingList = [], findings = [], stage = 'code') {
  if (records.some((r) => r && !versionAtLeast(r.engineVersion))) throw new ConfigError(RESTART_302);
  const hash = closingListHashOf(closingList);
  const changed = records.find((r) => r.closingListHash && r.closingListHash !== hash);
  if (changed) {
    throw new ConfigError(`The ruling changed after round ${changed.round ?? '?'}. Start a new run with \`adversarial-review run\`.`);
  }
  let ledger = initLedger(closingList, findings, stage);
  for (const r of records) {
    if (!countsAsRound(r)) continue;
    ledger = applyRound(ledger, r);
  }
  return ledger;
}

export async function selectRegression(ledger, delta, router, { threshold = 0.3 } = {}) {
  const settled = Object.entries(ledger.items).filter(([, v]) => v.state === 'settled');
  if (!delta || delta.changed.length === 0 || settled.length === 0) {
    return { list: [], router: 'not-needed', fallbackIds: [] };
  }
  const lines = Object.values(delta.changedLines).flat();
  const list = [];
  const picked = new Set();
  for (const [id, it] of settled) {
    let reason = null;
    if (delta.changed.includes(id)) reason = 'own-section';
    else if (it.anchors.none) reason = 'no-anchors';
    else {
      const tok = anchorTokens(it.anchors).find((t) => lines.some((l) => l.includes(t)));
      if (tok) reason = `mentions:${tok}`;
    }
    if (reason) {
      picked.add(id);
      list.push({ id, reason });
    }
  }
  const rest = settled.filter(([id]) => !picked.has(id));
  if (rest.length === 0) return { list, router: 'not-needed', fallbackIds: [] };

  let answers = null;
  if (typeof router === 'function') {
    try {
      answers = await router({ items: rest.map(([id, it]) => ({ id, ...it })), deltaText: delta.text });
    } catch {
      answers = null;
    }
  }
  const fallbackIds = [];
  for (const [id] of rest) {
    const p = answers instanceof Map ? answers.get(id) : null;
    if (p === null || p === undefined) {
      fallbackIds.push(id);
      list.push({ id, reason: 'fallback' });
      continue;
    }
    const num = typeof p === 'number' && p >= 0 && p <= 1 ? p : 1;
    if (num >= threshold) list.push({ id, reason: `jev:${num.toFixed(2)}` });
  }
  return { list, router: fallbackIds.length ? 'fallback' : 'used', fallbackIds };
}
