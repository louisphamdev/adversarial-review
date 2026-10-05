import {
  FINDINGS,
  TABLE,
  REBUTTAL,
  LASTCALL,
  RULING,
  PATCH_SEAT,
  PATCH_JUDGE,
  VERIFY_SEAT,
  VERIFY_JUDGE,
} from './schemas.mjs';
import { buildPrompt } from './prompts.mjs';
import { findingEvent } from './contain.mjs';
import { compareSift } from './sift.mjs';
import { loadSeats } from './seats.mjs';
import { normalizeId, normalizeItemIds, itemIdsOf, parsePlan, sectionDelta, normalizePlanText } from './plan-sections.mjs';
import { diffRanges, interdiff, isChangedLine, normalizeSeatPath } from './verify-diff.mjs';
import { deriveLedger, applyRound, selectRegression, countsAsRound, versionAtLeast, closingListHashOf } from './ledger.mjs';
import { ENGINE_VERSION } from './version.mjs';

export { normalizeId };

// Relayed adversarial review table runner across all stages.
export async function runTable({
  request = {},
  seats = [],
  judge,
  runAgent,
  log = () => {},
  checkpoint,
  loadCheckpoint,
  seatCheckpoint,
  loadSeatCheckpoint,
  onSeatDone,
  sift,
}) {
  const allSeatsMap = loadSeats();
  const resolvedSeats = seats.map((s) => {
    if (typeof s === 'string') return allSeatsMap.get(s) || { key: s, body: '', lens: '' };
    return s;
  });

  const resolvedJudge =
    judge || allSeatsMap.get('judge') || { key: 'judge', body: '', lens: 'adjudicator' };

  const chosenKeys = new Set(resolvedSeats.map((s) => s.key));
  const noSeat =
    request.noSeat ||
    Array.from(allSeatsMap.keys()).filter((k) => k !== 'judge' && !chosenKeys.has(k));

  const deadSeats = [];
  const recordDead = (seatKey, stageName) => {
    deadSeats.push({ seat: seatKey, stage: stageName });
  };

  // STAGE 1: FIND
  let allFindings = [];
  let notRead = [];
  let findCheckpoint = null;

  if (typeof loadCheckpoint === 'function') {
    findCheckpoint = await loadCheckpoint('find');
  }

  if (findCheckpoint) {
    allFindings = findCheckpoint.findings || [];
    notRead = findCheckpoint.notRead || [];
    if (Array.isArray(findCheckpoint.deadSeats)) {
      for (const d of findCheckpoint.deadSeats) {
        deadSeats.push(d);
      }
    }
  } else {
    // Each seat is its own promise, so its result is checkpointed and announced as it returns.
    const findResults = await Promise.all(
      resolvedSeats.map(async (seat) => {
        const saved =
          typeof loadSeatCheckpoint === 'function' ? await loadSeatCheckpoint(seat.key) : null;
        if (saved && Array.isArray(saved.findings)) return { seat, saved };

        const prompt = buildPrompt('FIND', {
          seat,
          request,
          materialPath: request.materialPath,
          repoRoot: request.repoRoot,
          budget: request.budget,
          requirements: request.requirements,
        });
        const res = await runAgent({ stage: 'FIND', seat, prompt, schema: FINDINGS });
        if (!res || !res.ok || !res.value || !Array.isArray(res.value.findings)) {
          return { seat, dead: true };
        }
        const findings = res.value.findings.map((f, idx) => ({
          id: `${seat.key}-${idx + 1}`,
          seat: seat.key,
          ...f,
        }));
        const notReadSeat = Array.isArray(res.value.notRead) ? res.value.notRead : [];
        if (typeof seatCheckpoint === 'function') {
          await seatCheckpoint(seat.key, {
            seat: seat.key,
            callId: `find-${seat.key}`,
            model: res.model ?? null,
            findings,
            notRead: notReadSeat,
          });
        }
        if (typeof onSeatDone === 'function') {
          try {
            await onSeatDone({
              seat: seat.key,
              callId: `find-${seat.key}`,
              model: res.model ?? null,
              findings: await Promise.all(findings.map((f) => findingEvent(f, request.repoRoot))),
            });
          } catch (err) {
            // An event failure never stops the table; the table is the result, the event is a view.
            log(`seat_done event failed for ${seat.key}: ${err && err.message ? err.message : err}`);
          }
        }
        return { seat, saved: { findings, notRead: notReadSeat } };
      })
    );

    let aliveFindCount = 0;
    for (const r of findResults) {
      if (r.dead) {
        recordDead(r.seat.key, 'FIND');
        continue;
      }
      aliveFindCount++;
      allFindings.push(...r.saved.findings);
      for (const nr of r.saved.notRead || []) {
        notRead.push(`${r.seat.key}: ${nr}`);
      }
    }

    if (aliveFindCount === 0 && resolvedSeats.length > 0) {
      return {
        findings: [],
        lastCall: [],
        disputes: [],
        seams: [],
        fixRisks: [],
        ruling: null,
        gaps: { noSeat, deadSeats, notRead },
        gateVerdict: 'BLOCK',
        exitCode: 3,
        reason: 'all-seats-dead',
        blockingCount: 0,
        sift: null,
        unknownSources: 0,
      };
    }

    if (typeof checkpoint === 'function') {
      await checkpoint('find', {
        findings: allFindings,
        notRead,
        deadSeats: deadSeats.filter((d) => d.stage === 'FIND'),
      });
    }
  }

  let siftResult = null;
  let siftPromise = null;

  // STAGE 3: TABLE
  let disputes = [];
  let seams = [];
  let fixRisks = [];
  let tableCheckpoint = null;

  if (allFindings.length > 0) {
    if (typeof loadCheckpoint === 'function') {
      tableCheckpoint = await loadCheckpoint('table');
    }

    if (tableCheckpoint) {
      disputes = tableCheckpoint.disputes || [];
      seams = tableCheckpoint.seams || [];
      fixRisks = tableCheckpoint.fixRisks || [];
      if (Array.isArray(tableCheckpoint.deadSeats)) {
        for (const d of tableCheckpoint.deadSeats) {
          if (!deadSeats.some((x) => x.seat === d.seat && x.stage === d.stage)) {
            deadSeats.push(d);
          }
        }
      }
    } else {
      const tableResults = await Promise.all(
        resolvedSeats.map(async (seat) => {
          const prompt = buildPrompt('TABLE', {
            seat,
            request,
            findings: allFindings,
            materialPath: request.materialPath,
            repoRoot: request.repoRoot,
            budget: request.budget,
          });
          const res = await runAgent({ stage: 'TABLE', seat, prompt, schema: TABLE });
          return { seat, res };
        })
      );

      for (const { seat, res } of tableResults) {
        if (!res || !res.ok || !res.value) {
          recordDead(seat.key, 'TABLE');
        } else {
          const positions = Array.isArray(res.value.positions) ? res.value.positions : [];
          for (const p of positions) {
            if (p.position === 'dispute') {
              if (
                allFindings.some(
                  (f) =>
                    normalizeId(f.id) === normalizeId(p.id) &&
                    normalizeId(f.seat) !== normalizeId(seat.key)
                )
              ) {
                disputes.push({ ...p, challenger: seat.key });
              }
            }
          }
          if (Array.isArray(res.value.missedBetweenLenses)) {
            for (const m of res.value.missedBetweenLenses) {
              seams.push(`${seat.key}: ${m}`);
            }
          }
          if (Array.isArray(res.value.fixRisks)) {
            for (const fr of res.value.fixRisks) {
              fixRisks.push(`${seat.key}: ${fr}`);
            }
          }
        }
      }

      if (typeof checkpoint === 'function') {
        await checkpoint('table', {
          disputes,
          seams,
          fixRisks,
          deadSeats: deadSeats.filter((d) => d.stage === 'TABLE'),
        });
      }
    }
  }

  // STAGE 4: DISPUTE
  let rebuttals = [];
  let disputeCheckpoint = null;

  if (allFindings.length > 0 && disputes.length > 0) {
    if (typeof loadCheckpoint === 'function') {
      disputeCheckpoint = await loadCheckpoint('dispute');
    }

    if (disputeCheckpoint) {
      rebuttals = disputeCheckpoint.rebuttals || [];
      if (Array.isArray(disputeCheckpoint.deadSeats)) {
        for (const d of disputeCheckpoint.deadSeats) {
          if (!deadSeats.some((x) => x.seat === d.seat && x.stage === d.stage)) {
            deadSeats.push(d);
          }
        }
      }
    } else {
      const contestedMap = new Map();
      for (const d of disputes) {
        if (!contestedMap.has(d.id)) {
          contestedMap.set(d.id, []);
        }
        contestedMap.get(d.id).push({ seat: d.challenger, reason: d.reason });
      }

      const contested = Array.from(contestedMap.entries()).map(([id, challengers]) => ({
        id,
        challengers,
      }));

      const disputeResults = await Promise.all(
        contested.map(async (c) => {
          const f = allFindings.find((x) => x.id === c.id);
          const ownerSeat = resolvedSeats.find((s) => s.key === f?.seat) || {
            key: f?.seat || 'unknown',
            body: '',
            lens: '',
          };
          const prompt = buildPrompt('DISPUTE', {
            seat: ownerSeat,
            request,
            finding: f,
            challengers: c.challengers,
            materialPath: request.materialPath,
            repoRoot: request.repoRoot,
          });
          const callId = `dispute-${ownerSeat.key}-${normalizeId(c.id)}`;
          const res = await runAgent({
            stage: 'DISPUTE',
            seat: ownerSeat,
            prompt,
            schema: REBUTTAL,
            callId,
            findingId: c.id,
          });
          return { c, f, ownerSeat, res };
        })
      );

      for (const { c, f, ownerSeat, res } of disputeResults) {
        if (!res || !res.ok || !res.value) {
          recordDead(ownerSeat.key, 'DISPUTE');
          rebuttals.push({
            id: c.id,
            finding: f?.title || '',
            challengers: c.challengers,
            standsFirm: true,
            rebuttal: 'no answer',
          });
        } else {
          rebuttals.push({
            id: c.id,
            finding: f?.title || '',
            challengers: c.challengers,
            standsFirm: res.value.standsFirm ?? true,
            rebuttal: res.value.rebuttal ?? '',
          });
        }
      }

      if (typeof checkpoint === 'function') {
        await checkpoint('dispute', {
          rebuttals,
          deadSeats: deadSeats.filter((d) => d.stage === 'DISPUTE'),
        });
      }
    }
  }

  // The sift starts after DISPUTE: the `survives` decision needs the challenges.
  if (sift && sift.loaded) {
    siftResult = sift.loaded;
  } else if (allFindings.length === 0) {
    siftResult = { status: 'skipped', reason: 'no-findings', rows: [], readingOrder: [] };
  } else if (sift && typeof sift.start === 'function') {
    siftPromise = Promise.resolve()
      .then(() => sift.start(allFindings, { rebuttals }))
      .catch(() => ({ status: 'skipped', reason: 'failed', rows: [], readingOrder: [] }));
  }

  try {
    // STAGE 5: LAST CALL
    let lastCallItems = [];
    let lastcallCheckpoint = null;

    if (typeof loadCheckpoint === 'function') {
      lastcallCheckpoint = await loadCheckpoint('lastcall');
    }

    if (lastcallCheckpoint) {
      lastCallItems = lastcallCheckpoint.lastCall || [];
      if (Array.isArray(lastcallCheckpoint.deadSeats)) {
        for (const d of lastcallCheckpoint.deadSeats) {
          if (!deadSeats.some((x) => x.seat === d.seat && x.stage === d.stage)) {
            deadSeats.push(d);
          }
        }
      }
    } else {
      const lastCallResults = await Promise.all(
        resolvedSeats.map(async (seat) => {
          const prompt = buildPrompt('LASTCALL', {
            seat,
            request,
            materialPath: request.materialPath,
            repoRoot: request.repoRoot,
          });
          const res = await runAgent({ stage: 'LASTCALL', seat, prompt, schema: LASTCALL });
          return { seat, res };
        })
      );

      for (const { seat, res } of lastCallResults) {
        if (!res || !res.ok || !res.value) {
          recordDead(seat.key, 'LASTCALL');
        } else {
          const items = Array.isArray(res.value.notYetSaid) ? res.value.notYetSaid : [];
          items.forEach((txt, idx) => {
            lastCallItems.push({
              id: `${seat.key}-lc${idx + 1}`,
              seat: seat.key,
              text: txt,
            });
          });
        }
      }

      if (typeof checkpoint === 'function') {
        await checkpoint('lastcall', {
          lastCall: lastCallItems,
          deadSeats: deadSeats.filter((d) => d.stage === 'LASTCALL'),
        });
      }
    }

    if (siftPromise) siftResult = await siftPromise;

    // STAGE 6: RULING
    const judgePrompt = buildPrompt('RULING', {
      seat: resolvedJudge,
      request,
      materialPath: request.materialPath,
      repoRoot: request.repoRoot,
      budget: request.budget,
      requirements: request.requirements,
      findings: allFindings,
      rebuttals,
      seams,
      fixRisks,
      lastCall: lastCallItems,
      readingOrder: siftResult?.readingOrder || [],
      sift: siftResult,
      noSeat,
      deadSeats,
      notRead,
    });

    const judgeRes = await runAgent({
      stage: 'RULING',
      seat: resolvedJudge,
      prompt: judgePrompt,
      schema: RULING,
    });

    if (!judgeRes || !judgeRes.ok || !judgeRes.value) {
      return {
        findings: allFindings,
        lastCall: lastCallItems,
        disputes: rebuttals,
        seams,
        fixRisks,
        ruling: null,
        gaps: { noSeat, deadSeats, notRead },
        gateVerdict: 'BLOCK',
        exitCode: 3,
        blockingCount: 0,
        sift: siftResult,
        unknownSources: 0,
      };
    }

    const ruling = judgeRes.value;

    // Clean sources in closingList
    const knownIds = new Set([
      ...allFindings.map((f) => normalizeId(f.id)),
      ...lastCallItems.map((lc) => normalizeId(lc.id)),
    ]);

    let unknownSources = 0;
    if (Array.isArray(ruling.closingList)) {
      for (const item of ruling.closingList) {
        if (Array.isArray(item.sources)) {
          const cleaned = [];
          const seenSources = new Set();
          for (const rawSrc of item.sources) {
            const norm = normalizeId(rawSrc);
            if (!knownIds.has(norm)) {
              unknownSources++;
            } else {
              if (!seenSources.has(norm)) {
                seenSources.add(norm);
                cleaned.push(norm);
              }
            }
          }
          item.sources = cleaned;
        }
      }
    }
    ruling.unknownSources = unknownSources;

    // Compare sift after ruling
    if (siftResult && typeof compareSift === 'function') {
      const comp = compareSift(siftResult, ruling, allFindings);
      siftResult.disagreements = comp.disagreements || [];
    }

    const blockingList = (ruling.closingList || []).filter(
      (item) => item.severity === 'critical' || item.severity === 'important'
    );
    const blockingCount = blockingList.length;

    let gateVerdict = 'PASS';
    let exitCode = 0;

    if (blockingCount > 0 || ruling.verdict === 'blocked') {
      gateVerdict = 'BLOCK';
      exitCode = 1;
    } else if (deadSeats.length > 0) {
      if (request.allowGaps) {
        gateVerdict = 'PASS';
        exitCode = 0;
      } else {
        gateVerdict = 'BLOCK';
        exitCode = 1;
      }
    }

    if (typeof checkpoint === 'function') {
      await checkpoint('ruling', ruling);
    }

    return {
      findings: allFindings,
      lastCall: lastCallItems,
      disputes: rebuttals,
      seams,
      fixRisks,
      ruling,
      gaps: { noSeat, deadSeats, notRead },
      gateVerdict,
      exitCode,
      blockingCount,
      sift: siftResult,
      unknownSources,
    };
  } finally {
    // Abort, then wait for the sift at most 2 s, so no sift request runs after the lock is released.
    if (sift && typeof sift.abort === 'function') sift.abort();
    if (siftPromise) {
      let t;
      await Promise.race([siftPromise, new Promise((r) => { t = setTimeout(r, 2000); })]);
      clearTimeout(t);
    }
  }
}

function ownerSeatsOf(item) {
  return [...new Set((item?.sources || []).map((s) => normalizeId(s).split('-')[0]).filter(Boolean))];
}

export async function runPatchReview({ state = {}, plan = '', runAgent, records = [], config = {}, router = null, maxRounds = 3 }) {
  const closingList = state.ruling?.closingList || [];
  const findings = state.findings || [];
  const stage = state.request?.stage || 'code';
  const { ids, byId } = itemIdsOf(closingList);
  const ledger = deriveLedger(records, closingList, findings, stage);
  const counted = records.filter(countsAsRound);
  // Baseline: the latest record that is not judgeDead and carries sections (counted or skipped).
  const baseline = records.filter((r) => r && !r.judgeDead && r.sections && versionAtLeast(r.engineVersion)).at(-1) || null;
  const baseSections = baseline?.sections || {};
  const openIds = ids.filter((id) => ledger.items[id].state === 'open');
  const planText = normalizePlanText(plan);
  const samePlan = baseline && normalizePlanText(baseline.plan) === planText;
  const describeOpen = () =>
    openIds.map((id) => `${id} open: ${ledger.items[id].demands.filter((d) => d.status !== 'met').map((d) => d.text).join(' | ') || ledger.items[id].lastObjections.join(' | ')}`).join('\n');

  if (closingList.length === 0) {
    const record = { stage: 'patch-review', round: counted.length, skipped: 'no-items', decision: 'APPLY', engineVersion: ENGINE_VERSION };
    return { decision: 'APPLY', exitCode: 0, record, ledger, message: 'No closing items: nothing to review.' };
  }
  // Step 2 runs before the cap: the same plan at the cap is still "already applied".
  if (baseline && openIds.length === 0 && samePlan) {
    return { decision: 'APPLY', exitCode: 0, record: null, ledger, message: 'Plan already applied: every item is settled.' };
  }
  if (counted.length >= maxRounds) {
    const message = openIds.length
      ? `Round cap ${maxRounds} reached. Open items:\n${describeOpen()}`
      : `Round cap ${maxRounds} reached. Raise --max-rounds to review a changed plan.`;
    return { decision: 'REVISE', exitCode: 1, record: null, ledger, message };
  }

  const round = counted.length + 1;
  const parsed = parsePlan(planText, ids, { mustHave: ids });
  const sections = parsed.sections;
  const delta = baseline ? sectionDelta(baseSections, sections) : { changed: [], changedLines: {}, text: '', cut: false };
  const threshold = typeof config.sift?.routerThreshold === 'number' ? config.sift.routerThreshold : 0.3;
  const reg = baseline
    ? await selectRegression(ledger, delta, router, { threshold })
    : { list: [], router: 'not-needed', fallbackIds: [] };

  const reviewedIds = [...new Set([...openIds, ...reg.list.map((e) => e.id)])];
  const base = {
    stage: 'patch-review',
    round,
    plan: planText,
    preamble: parsed.preamble,
    sections,
    closingListHash: closingListHashOf(closingList),
    engineVersion: ENGINE_VERSION,
  };
  if (reviewedIds.length === 0) {
    const record = { ...base, skipped: 'no-open-items', decision: 'APPLY', delta, regressionList: [], router: reg.router };
    return { decision: 'APPLY', exitCode: 0, record, ledger, message: 'No open item and no regression to review.' };
  }

  const regressionList = reg.list.map((e) => ({ id: e.id, doneWhen: byId[e.id]?.doneWhen || '', sectionText: sections[e.id] || '', reason: e.reason }));
  const openItems = openIds.map((id) => ({
    id,
    item: byId[id]?.item || '',
    doneWhen: byId[id]?.doneWhen || '',
    priorDemands: [
      ...ledger.items[id].demands.filter((d) => d.status !== 'met').map((d) => d.text),
      ...ledger.items[id].lastObjections,
    ],
    sectionText: sections[id] || '',
  }));

  const askedFor = new Map();
  for (const id of reviewedIds) {
    for (const seatKey of [...ownerSeatsOf(byId[id]), 'skeptic']) {
      if (!askedFor.has(seatKey)) askedFor.set(seatKey, []);
      askedFor.get(seatKey).push(id);
    }
  }

  const seatsMap = loadSeats();
  // Round 1 (no baseline) is a first pass. Later rounds pass ctx.reReview (Part D renders it).
  const ctxFor = (forIds) =>
    !baseline
      ? {
          plan: planText,
          // n carries the ledger id, so a subset keeps the labels of a renumbered list.
          closingList: closingList.flatMap((c, i) => (forIds.includes(ids[i]) ? [{ ...c, n: Number(ids[i].slice(1)) }] : [])),
        }
      : {
          reReview: {
            pass: 're-review',
            openItems: openItems.filter((o) => forIds.includes(o.id)),
            regressionList: regressionList.filter((r) => forIds.includes(r.id)),
            delta: delta.text,
            deltaCut: delta.cut,
            round,
          },
        };

  const seatResponses = await Promise.all(
    [...askedFor.entries()].map(async ([key, forIds]) => {
      const seat = seatsMap.get(key) || { key, body: '', lens: '' };
      const prompt = buildPrompt('PATCH_SEAT', { seat, state, ...ctxFor(forIds) });
      const res = await runAgent({ stage: 'PATCH_SEAT', seat, prompt, schema: PATCH_SEAT });
      const ok = res?.ok && Array.isArray(res.value?.items);
      return { seat: key, askedFor: forIds, items: ok ? res.value.items : null, error: ok ? null : res?.error || 'no-answer' };
    })
  );

  const judgeSeat = seatsMap.get('judge') || { key: 'judge', body: '', lens: 'adjudicator' };
  const judgePrompt = buildPrompt('PATCH_JUDGE', { seat: judgeSeat, state, ...ctxFor(reviewedIds), seatResponses });
  const judgeRes = await runAgent({ stage: 'PATCH_JUDGE', seat: judgeSeat, prompt: judgePrompt, schema: PATCH_JUDGE });
  const record = { ...base, reviewedIds, delta, regressionList, router: reg.router, fallbackIds: reg.fallbackIds, seatResponses };

  if (!judgeRes?.ok || !judgeRes.value) {
    return {
      decision: 'REVISE',
      exitCode: 3,
      record: { ...record, judge: null, judgeDead: true, error: judgeRes?.error || 'judge failed' },
      ledger,
      message: 'The judge died. The round does not count. Run patch-review again.',
    };
  }

  const fullRecord = { ...record, judge: judgeRes.value };
  const nextLedger = applyRound(ledger, fullRecord);
  fullRecord.decision = nextLedger.last.decision;
  fullRecord.blocking = nextLedger.last.blocking;
  fullRecord.advisory = nextLedger.last.advisory;
  fullRecord.itemStates = Object.fromEntries(ids.map((id) => [id, nextLedger.items[id].state]));
  fullRecord.blockingCount = ids.filter((id) => nextLedger.items[id].state === 'open').length;
  const conv = convergence(counted.at(-1), fullRecord.blockingCount, (r) => Object.values(r.itemStates || {}).filter((s) => s === 'open').length);
  fullRecord.converging = conv.converging;
  const lines = ids.map((id) => {
    const it = nextLedger.items[id];
    if (it.state !== 'open') return `${id} ${it.state}`;
    const why = it.demands.filter((d) => d.status !== 'met').map((d) => d.text);
    return `${id} open: ${(why.length ? why : it.lastObjections).join(' | ')}`;
  });
  if (conv.line) lines.push(conv.line);
  return {
    decision: fullRecord.decision,
    exitCode: fullRecord.decision === 'APPLY' ? 0 : 1,
    record: fullRecord,
    ledger: nextLedger,
    message: lines.join('\n'),
  };
}

// A loop that opens as many blocking items as it closes never ends, so the host must cut scope.
function convergence(prev, count, countOf) {
  if (!prev || count === 0) return { converging: true, line: '' };
  const before = Number.isInteger(prev.blockingCount) ? prev.blockingCount : countOf(prev);
  if (count < before) return { converging: true, line: '' };
  const items = count === 1 ? 'item' : 'items';
  return { converging: false, line: `Not converging: ${count} blocking ${items} this round, ${before} in the round before. Stop the loop and cut the scope of the change.` };
}

const VERIFY_DELTA_CAP = 12000;
const RETRY_REASONS = new Set(['seat-dead', 'no-answer', 'no-regression-answer']);

function capDelta(text) {
  const s = String(text ?? '');
  return s.length > VERIFY_DELTA_CAP ? { delta: `${s.slice(0, VERIFY_DELTA_CAP - 9)}\n...(cut)`, deltaCut: true } : { delta: s, deltaCut: false };
}

// A verify record counts when it is 3.1 or later, has a judge answer and items, and the judge did not die.
export function countsAsVerify(r) {
  return Boolean(r && versionAtLeast(r.engineVersion) && r.items && r.judge && !r.judgeDead);
}

export async function runVerify({ state = {}, diffParts, recollect = null, runAgent, records = [] }) {
  const closingList = state.ruling?.closingList || [];
  const findings = state.findings || [];
  const { ids, byId } = itemIdsOf(closingList);
  const known = new Map(findings.map((f) => [normalizeId(f.id), f]));
  const prior = records.filter(countsAsVerify).at(-1) || null;
  const round = prior ? prior.round + 1 : 1;
  const seatsMap = loadSeats();

  // owners: item id -> [{ seat, findingIds, itemOnly }]
  const owners = new Map();
  for (const id of ids) {
    const srcs = (byId[id].sources || []).map(normalizeId).filter((s) => known.has(s));
    if (srcs.length === 0) {
      owners.set(id, [{ seat: 'skeptic', findingIds: [], itemOnly: true }]);
      continue;
    }
    const bySeat = new Map();
    for (const s of srcs) {
      const seat = known.get(s).seat || s.split('-')[0];
      if (!bySeat.has(seat)) bySeat.set(seat, []);
      bySeat.get(seat).push(s);
    }
    owners.set(id, [...bySeat].map(([seat, findingIds]) => ({ seat, findingIds, itemOnly: false })));
  }

  // Which items to ask, and with which pass.
  let targetIds = ids;
  let pass = 'first';
  let deltaText = diffParts.diff;
  let reasked = null;
  if (prior) {
    const notMet = ids.filter((id) => prior.items[id]?.status !== 'met');
    if (prior.diffHash === diffParts.diffHash) {
      const retry = notMet.filter((id) => RETRY_REASONS.has(prior.items[id]?.reason));
      if (notMet.length > 0 && (retry.length === 0 || prior.reasked === diffParts.diffHash)) {
        return { verdict: 'BLOCK', exitCode: 1, record: null, message: `Verify stopped: nothing changed since the last verify. Open: ${notMet.join(', ')}` };
      }
      targetIds = notMet.length > 0 ? retry : [];
      reasked = diffParts.diffHash;
    } else {
      targetIds = notMet;
    }
    pass = 're-review';
    deltaText = interdiff(prior, diffParts) || diffParts.diff;
  }
  const { delta, deltaCut } = capDelta(deltaText);

  const items = {};
  for (const id of ids) items[id] = prior?.items[id] && !targetIds.includes(id) ? prior.items[id] : { status: 'not-met', evidence: '', reason: 'no-answer' };

  const perSeat = new Map();
  for (const id of targetIds) {
    for (const o of owners.get(id)) {
      if (!perSeat.has(o.seat)) perSeat.set(o.seat, []);
      perSeat.get(o.seat).push({ id, ...o });
    }
  }
  const newInDiffRaw = [];
  const seatResponses = await Promise.all(
    [...perSeat].map(async ([seatKey, list]) => {
      const seat = seatsMap.get(seatKey) || { key: seatKey, body: '', lens: '' };
      const ctx = pass === 'first'
        ? { diff: delta, findings: list.flatMap((o) => (o.itemOnly ? [{ id: o.id, title: byId[o.id].item, doneWhen: byId[o.id].doneWhen }] : o.findingIds.map((f) => known.get(f)))) }
        : {
            reReview: {
              pass: 're-review',
              openItems: list.map((o) => ({ id: o.id, item: byId[o.id].item || '', doneWhen: byId[o.id].doneWhen || '', priorDemands: [prior.items[o.id]?.evidence || ''].filter(Boolean), sectionText: '' })),
              regressionList: [],
              delta,
              deltaCut,
              round,
            },
          };
      const prompt = buildPrompt('VERIFY_SEAT', { seat, ...ctx, state });
      const res = await runAgent({ stage: 'VERIFY_SEAT', seat, prompt, schema: VERIFY_SEAT });
      const ok = res?.ok && Array.isArray(res.value?.items);
      if (ok && Array.isArray(res.value.newInDiff)) newInDiffRaw.push(...res.value.newInDiff.map((e) => ({ ...e, seat: seatKey })));
      return { seat: seatKey, list, items: ok ? res.value.items : null, error: ok ? null : res?.error || 'no-answer' };
    })
  );

  // A seat may answer with its finding id or with the item id the prompt shows; the finding id wins.
  const answerFor = (sr, o, w, id) =>
    (o.itemOnly ? undefined : sr.items.find((a) => normalizeId(a.id) === w)) ??
    sr.items.find((a) => normalizeItemIds(a.id, ids).includes(id));

  for (const id of targetIds) {
    let met = true;
    let reason = null;
    const evidence = [];
    for (const o of owners.get(id)) {
      const sr = seatResponses.find((r) => r.seat === o.seat);
      if (!sr || sr.error) {
        met = false;
        reason = 'seat-dead';
        continue;
      }
      for (const w of o.itemOnly ? [id] : o.findingIds) {
        const ans = answerFor(sr, o, w, id);
        if (!ans) {
          met = false;
          reason = reason || 'no-answer';
        } else {
          evidence.push(ans.evidence);
          if (ans.status !== 'met') {
            met = false;
            reason = reason || 'not-met';
          }
        }
      }
    }
    items[id] = { status: met ? 'met' : 'not-met', evidence: evidence.join(' | '), reason: met ? null : reason };
  }

  // Final regression pass: every item of each owner seat, explicit `holds` required.
  let finalPass = null;
  if (ids.every((id) => items[id].status === 'met')) {
    const bySeat = new Map();
    for (const id of ids) {
      for (const o of owners.get(id)) {
        if (!bySeat.has(o.seat)) bySeat.set(o.seat, []);
        if (!bySeat.get(o.seat).includes(id)) bySeat.get(o.seat).push(id);
      }
    }
    const full = capDelta(diffParts.diff);
    finalPass = {};
    await Promise.all(
      [...bySeat].map(async ([seatKey, list]) => {
        const seat = seatsMap.get(seatKey) || { key: seatKey, body: '', lens: '' };
        const reReview = {
          pass: 're-review',
          openItems: [],
          regressionList: list.map((id) => ({ id, doneWhen: byId[id].doneWhen || '', sectionText: '', reason: 'final-pass' })),
          delta: full.delta,
          deltaCut: full.deltaCut,
          round,
        };
        const prompt = buildPrompt('VERIFY_SEAT', { seat, reReview, state });
        const res = await runAgent({ stage: 'VERIFY_SEAT', seat, prompt, schema: VERIFY_SEAT });
        const reg = res?.ok && Array.isArray(res.value?.regression) ? res.value.regression : null;
        if (res?.ok && Array.isArray(res.value?.newInDiff)) newInDiffRaw.push(...res.value.newInDiff.map((e) => ({ ...e, seat: seatKey })));
        for (const id of list) {
          const a = reg?.find((x) => normalizeItemIds(x.id, ids).includes(id));
          const holds = a?.status === 'holds';
          const status = holds ? 'holds' : a?.status === 'broken' ? 'broken' : 'no-regression-answer';
          finalPass[id] = { seat: seatKey, status, evidence: a?.evidence || '' };
          if (!holds) items[id] = { status: 'not-met', evidence: a?.evidence || '', reason: status === 'broken' ? 'regression' : 'no-regression-answer' };
        }
      })
    );
  }

  // Two seats that report the same claim on the same line give one entry.
  const claimKey = (e) => JSON.stringify([e.claim, normalizeSeatPath(e.file), Number(e.line), e.side]);
  const uniqueClaims = [...new Map(newInDiffRaw.map((e) => [claimKey(e), e])).values()];
  const ranges = diffRanges(diffParts.diff);
  const candidates = uniqueClaims.filter((e) => isChangedLine({ ranges, untracked: diffParts.untracked, entry: e }));
  const advisory = uniqueClaims.filter((e) => !candidates.includes(e));
  // The judge rules only on blocking candidates, shown under the seat that reported each one.
  const judgeResponses = seatResponses.map((sr) => ({ seat: sr.seat, items: sr.items, newInDiff: [] }));
  for (const c of candidates) {
    let sr = judgeResponses.find((r) => r.seat === c.seat);
    if (!sr) judgeResponses.push((sr = { seat: c.seat, items: [], newInDiff: [] }));
    sr.newInDiff.push(c);
  }

  const judgeSeat = seatsMap.get('judge') || { key: 'judge', body: '', lens: 'adjudicator' };
  const judgeCtx = pass === 'first'
    ? { diff: delta }
    : { reReview: { pass: 're-review', openItems: targetIds.map((id) => ({ id, item: byId[id].item || '', doneWhen: byId[id].doneWhen || '', priorDemands: [prior.items[id]?.evidence || ''].filter(Boolean), sectionText: '' })), regressionList: finalPass ? ids.map((id) => ({ id, doneWhen: byId[id].doneWhen || '', sectionText: '', reason: 'final-pass' })) : [], delta, deltaCut, round } };
  if (judgeCtx.reReview && judgeCtx.reReview.openItems.length === 0 && judgeCtx.reReview.regressionList.length === 0) {
    judgeCtx.reReview.regressionList = ids.map((id) => ({ id, doneWhen: byId[id].doneWhen || '', sectionText: '', reason: 'status-only' }));
  }
  const judgePrompt = buildPrompt('VERIFY_JUDGE', { seat: judgeSeat, ...judgeCtx, seatResponses: judgeResponses, closingList, state });
  const judgeRes = await runAgent({ stage: 'VERIFY_JUDGE', seat: judgeSeat, prompt: judgePrompt, schema: VERIFY_JUDGE });
  const record = {
    stage: 'verify',
    round,
    baseSha: diffParts.baseSha,
    diff: diffParts.diff,
    untracked: diffParts.untracked,
    diffHash: diffParts.diffHash,
    pass,
    reasked,
    items,
    finalPass,
    newInDiff: { candidates, advisory, judged: judgeRes?.value?.newInDiff || [] },
    seatResponses,
    closingListHash: closingListHashOf(closingList),
    engineVersion: ENGINE_VERSION,
  };
  if (!judgeRes?.ok || !judgeRes.value) {
    return { verdict: 'BLOCK', exitCode: 3, record: { ...record, judge: null, judgeDead: true, verdict: 'BLOCK' }, message: 'The judge died during verify. The round does not count.' };
  }

  // Tree change during verify: the seats saw a diff that is no longer the working tree.
  let treeChanged = false;
  if (typeof recollect === 'function') {
    const again = await recollect();
    treeChanged = again.diffHash !== diffParts.diffHash;
  }
  const accepted = (judgeRes.value.newInDiff || []).filter((j) => j.verdict === 'accepted' && candidates.some((c) => c.claim === j.claim));
  const allMet = ids.every((id) => items[id].status === 'met');
  const verdict = allMet && accepted.length === 0 && !treeChanged ? 'PASS' : 'BLOCK';
  const lines = ids.map((id) => `${id} ${items[id].status}${items[id].reason ? ` (${items[id].reason})` : ''}`);
  if (treeChanged) lines.push('The tree changed during verify. Run verify again.');
  const blockingCount = ids.filter((id) => items[id].status !== 'met').length + accepted.length;
  const conv = convergence(prior, blockingCount, (r) => Object.values(r.items || {}).filter((i) => i?.status !== 'met').length);
  if (conv.line) lines.push(conv.line);
  return {
    verdict,
    exitCode: verdict === 'PASS' ? 0 : 1,
    record: { ...record, judge: judgeRes.value, verdict, treeChanged, blockingCount, converging: conv.converging },
    message: lines.join('\n'),
  };
}
