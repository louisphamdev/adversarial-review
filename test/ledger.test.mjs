import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorsFor,
  initLedger,
  applyRound,
  deriveLedger,
  selectRegression,
  versionAtLeast,
  countsAsRound,
} from '../skills/adversarial-review/scripts/lib/ledger.mjs';
import { sectionDelta } from '../skills/adversarial-review/scripts/lib/plan-sections.mjs';
import { ENGINE_VERSION } from '../skills/adversarial-review/scripts/lib/version.mjs';

const closing = [
  { n: 1, item: 'Fix `parseToken`', doneWhen: 'd1', sources: ['breaker-1'] },
  { n: 2, item: 'Fix limits', doneWhen: 'd2', sources: ['edge-1'] },
];
const findings = [
  { id: 'breaker-1', seat: 'breaker', file: 'lib/auth.mjs', line: '10-12', evidence: 'lib/auth.mjs:11 `parseToken`', title: 't' },
  { id: 'edge-1', seat: 'edge', file: 'lib/limits.mjs', line: '5', evidence: 'see lib/limits.mjs:5', title: 't' },
];
const sound = (ids) => ids.map((id) => ({ id, plan: 'sound', reason: 'ok' }));
const rec = (round, seatResponses, revise = [], extra = {}) => ({
  round,
  reviewedIds: extra.reviewedIds || ['C1', 'C2'],
  seatResponses,
  judge: { revise, priorDemands: [] },
  engineVersion: ENGINE_VERSION,
  sections: extra.sections || {},
  ...extra,
});

describe('anchorsFor', () => {
  it('collects files, symbols, and sections', () => {
    const a = anchorsFor(closing[0], findings, 'code');
    assert.ok(a.files.some((f) => f.file === 'lib/auth.mjs' && f.from === 10 && f.to === 12));
    assert.ok(a.symbols.includes('parseToken'));
    assert.equal(a.none, false);
    const s = anchorsFor({ item: 'x', sources: ['h-1'] }, [{ id: 'h-1', evidence: 'see §4.3' }], 'spec');
    assert.deepEqual(s.sections, ['§4.3']);
  });
  it('marks none when nothing anchors the item', () => {
    const a = anchorsFor({ item: 'x', sources: ['zz-9'] }, findings, 'code');
    assert.equal(a.none, true);
    assert.deepEqual(a.unknownSources, ['zz-9']);
  });
});

describe('applyRound', () => {
  const asked = ['C1', 'C2'];
  it('settles items with explicit sound answers from every asked seat', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1, [
      { seat: 'breaker', askedFor: asked, items: sound(asked), error: null },
      { seat: 'skeptic', askedFor: asked, items: sound(asked), error: null },
    ]));
    assert.equal(l.items.C1.state, 'settled');
    assert.equal(l.last.decision, 'APPLY');
  });
  it('keeps every item open when a seat answers nothing', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1, [
      { seat: 'skeptic', askedFor: asked, items: [], error: null },
    ]));
    assert.equal(l.items.C1.state, 'open');
    assert.equal(l.items.C2.state, 'open');
    assert.equal(l.last.decision, 'REVISE');
  });
  it('keeps items open when a seat dies', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1, [
      { seat: 'breaker', askedFor: ['C1'], items: null, error: 'timeout' },
      { seat: 'skeptic', askedFor: asked, items: sound(asked), error: null },
    ]));
    assert.equal(l.items.C1.state, 'open');
    assert.equal(l.items.C2.state, 'settled');
  });
  it('turns a judge demand with no seat objection into advisory', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: sound(asked), error: null }],
      [{ itemId: 'C1', item: 'add a test', doneWhen: 'x' }]
    ));
    assert.equal(l.items.C1.state, 'settled');
    assert.equal(l.last.advisory.length, 1);
  });
  it('normalizes judge itemId c1 and blocks with a seat objection', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: [{ id: 'C1', plan: 'breaks-my-lens', reason: 'r' }, { id: 'C2', plan: 'sound', reason: 'ok' }], error: null }],
      [{ itemId: 'c1', item: 'add rollback', doneWhen: 'x' }]
    ));
    assert.equal(l.items.C1.state, 'open');
    assert.equal(l.last.blocking.length, 1);
    assert.ok(l.items.C1.demands.some((d) => d.text === 'add rollback'));
  });
  it('does not let a cross demand block an item without a cross objection', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: [{ id: 'C1', plan: 'oversized', reason: 'r' }, { id: 'C2', plan: 'sound', reason: 'ok' }], error: null }],
      [{ itemId: 'cross', item: 'shared change', doneWhen: 'x' }]
    ));
    assert.equal(l.items.C2.state, 'settled');
  });
  it('applies a cross objection only to the items it affects', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1, [
      { seat: 'skeptic', askedFor: asked, items: [...sound(asked), { id: 'cross', plan: 'collides', reason: 'r', affects: ['C2'] }], error: null },
    ]));
    assert.equal(l.items.C1.state, 'settled');
    assert.equal(l.items.C2.state, 'open');
  });
  it('does not keep an item open on a judge not-met ruling alone', () => {
    const l0 = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: [{ id: 'C1', plan: 'breaks-my-lens', reason: 'r' }, { id: 'C2', plan: 'sound', reason: 'ok' }], error: null }],
      [{ itemId: 'C1', item: 'add rollback', doneWhen: 'x' }]
    ));
    const l1 = applyRound(l0, {
      ...rec(2, [{ seat: 'skeptic', askedFor: ['C1'], items: sound(['C1']), error: null }], [], { reviewedIds: ['C1'] }),
      judge: { revise: [], priorDemands: [{ itemId: 'C1', demand: 'add rollback', status: 'not-met', evidence: 'e' }] },
    });
    assert.equal(l1.items.C1.state, 'settled');
  });
  it('treats affects [] and affects [foo] as unmapped objections on every reviewed item', () => {
    for (const affects of [[], ['foo']]) {
      const l = applyRound(initLedger(closing, findings, 'code'), rec(1, [
        { seat: 'skeptic', askedFor: asked, items: [...sound(asked), { id: 'cross', plan: 'collides', reason: 'r', affects }], error: null },
      ]));
      assert.equal(l.items.C1.state, 'open', JSON.stringify(affects));
      assert.equal(l.items.C2.state, 'open', JSON.stringify(affects));
    }
  });
  it('reopens a listed settled item on an objection', () => {
    const l0 = applyRound(initLedger(closing, findings, 'code'), rec(1, [{ seat: 'skeptic', askedFor: asked, items: sound(asked), error: null }]));
    const l1 = applyRound(l0, rec(2, [{ seat: 'skeptic', askedFor: ['C2'], items: [{ id: 'C2', plan: 'breaks-my-lens', reason: 'regressed' }], error: null }], [], { reviewedIds: ['C2'] }));
    assert.equal(l1.items.C2.state, 'open');
    assert.equal(l1.items.C2.reopened.length, 1);
    assert.equal(l1.items.C2.item, 'Fix limits');
    assert.equal(l1.items.C1.state, 'settled');
  });
});

describe('rule 0', () => {
  it('compares versions as numbers', () => {
    assert.equal(versionAtLeast('3.10.0'), true);
    assert.equal(versionAtLeast('3.9.0', '3.10.0'), false);
    assert.equal(versionAtLeast('3.0.9'), false);
    assert.equal(versionAtLeast(undefined), false);
  });
  it('counts only judged, live, unskipped 3.1 records', () => {
    assert.equal(countsAsRound(rec(1, [])), true);
    assert.equal(countsAsRound({ ...rec(1, []), judge: null, judgeDead: true }), false);
    assert.equal(countsAsRound({ ...rec(1, []), skipped: 'no-open-items' }), false);
  });
});

describe('applyRound demands', () => {
  const asked = ['C1', 'C2'];
  it('a cross demand blocks the items that a same-round cross objection names', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: [...sound(asked), { id: 'cross', plan: 'collides', reason: 'r', affects: ['C2'] }], error: null }],
      [{ itemId: 'Cross-cutting', item: 'split the shared helper', doneWhen: 'x' }]
    ));
    assert.deepEqual(l.last.blocking.map((b) => b.itemId), ['C2']);
    assert.equal(l.items.C1.state, 'settled');
  });
  it('records a demand with no known item as advisory unknown-item', () => {
    const l = applyRound(initLedger(closing, findings, 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: asked, items: [{ id: 'C1', plan: 'oversized', reason: 'r' }, { id: 'C2', plan: 'sound', reason: 'ok' }], error: null }],
      [{ itemId: 'logging', item: 'add a log line', doneWhen: 'x' }]
    ));
    assert.equal(l.last.blocking.length, 0);
    assert.equal(l.last.advisory[0].note, 'unknown-item');
  });

  const three = [1, 2, 3].map((n) => ({ n, item: `item ${n}`, doneWhen: `d${n}`, sources: [] }));
  const all = ['C1', 'C2', 'C3'];
  const round2 = (objectOn, revise) => {
    const l0 = applyRound(initLedger(three, [], 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: all, items: all.map((id) => ({ id, plan: 'oversized', reason: 'r1' })), error: null }], [], { reviewedIds: all }));
    const items = all.map((id) => ({ id, plan: objectOn.includes(id) ? 'breaks-my-lens' : 'sound', reason: 'r2' }));
    return applyRound(l0, rec(2, [{ seat: 'skeptic', askedFor: all, items, error: null }], revise, { reviewedIds: all }));
  };
  it('an empty or missing itemId falls back to a leading C<n> label of the item text only', () => {
    for (const d of [
      { itemId: '', item: 'C2: also cover item 3', doneWhen: 'x' },
      { itemId: '  ', item: 'C2: x', doneWhen: 'x' },
      { item: 'C2: x', doneWhen: 'x' },
    ]) {
      const l = round2(['C2', 'C3'], [d]);
      assert.deepEqual(l.last.blocking.map((b) => b.itemId), ['C2'], JSON.stringify(d));
      assert.ok(!l.items.C3.demands.some((x) => x.text === d.item.trim()), JSON.stringify(d));
    }
    const control = round2(['C3'], [{ itemId: '', item: 'C2: also cover item 3', doneWhen: 'x' }]);
    assert.equal(control.last.blocking.length, 0);
    assert.deepEqual(control.last.advisory.map((a) => [a.itemId, a.note]), [['C2', 'no-objection']]);
  });
  it('a seat answer with a finding id such as breaker-2 never binds to C2', () => {
    const l0 = applyRound(initLedger(three, [], 'code'), rec(1,
      [{ seat: 'skeptic', askedFor: all, items: all.map((id) => ({ id, plan: 'oversized', reason: 'r1' })), error: null }], [], { reviewedIds: all }));
    const round2With = (plan) => applyRound(l0, rec(2,
      [{ seat: 'skeptic', askedFor: all, items: [{ id: 'C1', plan: 'sound', reason: 'ok' }, { id: 'breaker-2', plan, reason: 'r2' }, { id: 'C3', plan: 'sound', reason: 'ok' }], error: null }],
      [], { reviewedIds: all }));
    // A sound answer under a finding id does not settle C2: C2 stays open as unanswered.
    const sound = round2With('sound');
    assert.equal(sound.items.C2.state, 'open');
    assert.equal(sound.items.C1.state, 'settled');
    // An objection under a finding id is unmapped, so it holds every reviewed item, not C2 alone.
    const objecting = round2With('breaks-my-lens');
    for (const id of all) assert.equal(objecting.items[id].state, 'open', id);
  });
  it('a numeric itemId maps to its item', () => {
    const l = round2(['C2'], [{ itemId: 2, item: 'cover the empty case', doneWhen: 'x' }]);
    assert.deepEqual(l.last.blocking.map((b) => b.itemId), ['C2']);
  });
});

describe('deriveLedger', () => {
  it('skips judgeDead and skipped records', () => {
    const records = [
      rec(1, [{ seat: 'skeptic', askedFor: ['C1', 'C2'], items: [], error: null }]),
      { ...rec(2, [{ seat: 'skeptic', askedFor: ['C1', 'C2'], items: sound(['C1', 'C2']), error: null }]), judge: null, judgeDead: true },
      rec(2, [{ seat: 'skeptic', askedFor: ['C1', 'C2'], items: sound(['C1', 'C2']), error: null }]),
    ];
    const l = deriveLedger(records, closing, findings, 'code');
    assert.equal(l.round, 2);
    assert.equal(l.items.C1.state, 'settled');
  });
  it('exits 2 on a 3.0.2 record and on a record below 3.1.0', () => {
    assert.throws(
      () => deriveLedger([{ plan: 'x', seatResponses: [], judge: { revise: [] } }], closing, findings, 'code'),
      (e) => e.exitCode === 2 && /3\.0\.2/.test(e.message) && !/delete/i.test(e.message)
    );
    assert.throws(
      () => deriveLedger([{ ...rec(1, []), engineVersion: '3.0.9' }], closing, findings, 'code'),
      (e) => e.exitCode === 2
    );
  });
  it('exits 2 when the ruling changed after a round', () => {
    assert.throws(
      () => deriveLedger([{ ...rec(1, []), closingListHash: 'other' }], closing, findings, 'code'),
      (e) => e.exitCode === 2 && /ruling changed/.test(e.message)
    );
  });
});

describe('selectRegression', () => {
  const settledLedger = () => {
    const l = initLedger(closing, findings, 'code');
    l.items.C1.state = 'settled';
    l.items.C2.state = 'open';
    return l;
  };
  it('lists a settled item when another section names its file (Jev disabled)', async () => {
    const d = sectionDelta({ C1: 'a', C2: 'b' }, { C1: 'a', C2: 'b\nalso edit lib/auth.mjs' });
    const r = await selectRegression(settledLedger(), d, null);
    assert.deepEqual(r.list.map((e) => e.id), ['C1']);
    assert.match(r.list[0].reason, /^mentions:/);
  });
  it('matches a Windows-style evidence path by its base name', async () => {
    const l = initLedger(
      [{ n: 1, item: 'x', doneWhen: 'd', sources: ['k-1'] }, { n: 2, item: 'y', doneWhen: 'd', sources: [] }],
      [{ id: 'k-1', seat: 'keeper', evidence: 'lib\\ledger.mjs:12', title: 't' }],
      'code'
    );
    l.items.C1.state = 'settled';
    const d = sectionDelta({ C2: 'a' }, { C2: 'a\nnow edit ledger.mjs' });
    const r = await selectRegression(l, d, null);
    assert.equal(r.list.find((e) => e.id === 'C1')?.reason, 'mentions:ledger.mjs');
  });
  it('never removes a deterministic entry on a router answer of 0', async () => {
    const d = sectionDelta({ C1: 'a' }, { C1: 'a2' });
    const r = await selectRegression(settledLedger(), d, async () => new Map([['C1', 0]]));
    assert.deepEqual(r.list.map((e) => e.id), ['C1']);
    assert.equal(r.list[0].reason, 'own-section');
  });
  it('adds an item on a non-number router answer', async () => {
    const d = sectionDelta({ cross: 'x' }, { cross: 'y' });
    const r = await selectRegression(settledLedger(), d, async () => new Map([['C1', 'abc']]));
    assert.deepEqual(r.list.map((e) => e.id), ['C1']);
  });
  it('lists an item whose router request failed', async () => {
    const d = sectionDelta({ cross: 'x' }, { cross: 'y' });
    const r = await selectRegression(settledLedger(), d, async () => new Map([['C1', null]]));
    assert.equal(r.router, 'fallback');
    assert.deepEqual(r.fallbackIds, ['C1']);
  });
  it('lists every remaining settled item when no router exists', async () => {
    const d = sectionDelta({ cross: 'x' }, { cross: 'y' });
    const r = await selectRegression(settledLedger(), d, null);
    assert.deepEqual(r.list.map((e) => e.id), ['C1']);
  });
  it('drops an item below the threshold', async () => {
    const d = sectionDelta({ cross: 'x' }, { cross: 'y' });
    const r = await selectRegression(settledLedger(), d, async () => new Map([['C1', 0.1]]), { threshold: 0.3 });
    assert.deepEqual(r.list, []);
  });
  it('lists nothing when nothing changed', async () => {
    const r = await selectRegression(settledLedger(), sectionDelta({ C1: 'a' }, { C1: 'a' }), null);
    assert.equal(r.router, 'not-needed');
    assert.deepEqual(r.list, []);
  });
});
