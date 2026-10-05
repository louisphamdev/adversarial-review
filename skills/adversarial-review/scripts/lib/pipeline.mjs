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
import { normalizeId, itemIdsOf, parsePlan, sectionDelta, normalizePlanText } from './plan-sections.mjs';
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

  // SIFT starts in parallel with stages 3-5
  let siftResult = null;
  let siftPromise = null;

  if (sift && sift.loaded) {
    siftResult = sift.loaded;
  } else if (allFindings.length === 0) {
    siftResult = { status: 'skipped', reason: 'no-findings', rows: [], readingOrder: [] };
  } else if (sift && typeof sift.start === 'function') {
    siftPromise = Promise.resolve()
      .then(() => sift.start(allFindings))
      .catch(() => ({
        status: 'skipped',
        reason: 'failed',
        rows: [],
        readingOrder: [],
      }));
  }

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

  if (siftPromise) {
    siftResult = await siftPromise;
    if (typeof checkpoint === 'function') {
      await checkpoint('sift', siftResult);
    }
  }

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
      ? { plan: planText, closingList: closingList.filter((_, i) => forIds.includes(ids[i])) }
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
  return {
    decision: fullRecord.decision,
    exitCode: fullRecord.decision === 'APPLY' ? 0 : 1,
    record: fullRecord,
    ledger: nextLedger,
    message: ids
      .map((id) => {
        const it = nextLedger.items[id];
        if (it.state !== 'open') return `${id} ${it.state}`;
        const why = it.demands.filter((d) => d.status !== 'met').map((d) => d.text);
        return `${id} open: ${(why.length ? why : it.lastObjections).join(' | ')}`;
      })
      .join('\n'),
  };
}

export async function runVerify({ state = {}, diff = '', runAgent }) {
  const closingList = state.ruling?.closingList || [];
  const findings = state.findings || [];

  const seatFindingsMap = new Map();
  for (const f of findings) {
    const owner = normalizeId(f.id).split('-')[0] || f.seat;
    if (!seatFindingsMap.has(owner)) {
      seatFindingsMap.set(owner, []);
    }
    seatFindingsMap.get(owner).push(f);
  }

  const seatsMap = loadSeats();
  const seatResponses = await Promise.all(
    Array.from(seatFindingsMap.entries()).map(async ([ownerKey, ownFindings]) => {
      const seat = seatsMap.get(ownerKey) || { key: ownerKey, body: '', lens: '' };
      const prompt = buildPrompt('VERIFY_SEAT', {
        seat,
        diff,
        findings: ownFindings,
        state,
      });
      const res = await runAgent({ stage: 'VERIFY_SEAT', seat, prompt, schema: VERIFY_SEAT });
      return {
        seat: ownerKey,
        items: res?.ok && Array.isArray(res.value?.items) ? res.value.items : [],
        newInDiff: res?.ok && Array.isArray(res.value?.newInDiff) ? res.value.newInDiff : [],
        error: res?.ok ? null : res?.error,
      };
    })
  );

  const judgeSeat = seatsMap.get('judge') || { key: 'judge', body: '', lens: 'adjudicator' };
  const judgePrompt = buildPrompt('VERIFY_JUDGE', {
    seat: judgeSeat,
    diff,
    seatResponses,
    closingList,
    state,
  });

  const judgeRes = await runAgent({
    stage: 'VERIFY_JUDGE',
    seat: judgeSeat,
    prompt: judgePrompt,
    schema: VERIFY_JUDGE,
  });

  if (!judgeRes || !judgeRes.ok || !judgeRes.value) {
    return {
      verdict: 'BLOCK',
      exitCode: 3,
      record: {
        stage: 'verify',
        diff,
        seatResponses,
        judge: null,
        error: judgeRes?.error || 'judge failed',
      },
    };
  }

  const verdict = judgeRes.value.verdict === 'PASS' ? 'PASS' : 'BLOCK';
  const exitCode = verdict === 'PASS' ? 0 : 1;

  return {
    verdict,
    exitCode,
    record: {
      stage: 'verify',
      diff,
      seatResponses,
      judge: judgeRes.value,
    },
  };
}
