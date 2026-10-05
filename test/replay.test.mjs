// Replays 14 recorded patch-review rounds through the B4 rules. The repository is public, so the
// fixture keeps only structure: item ids, seat verdicts, and the items that each demand names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLedger, applyRound } from '../skills/adversarial-review/scripts/lib/ledger.mjs';
import { itemIdsOf } from '../skills/adversarial-review/scripts/lib/plan-sections.mjs';
import { ENGINE_VERSION } from '../skills/adversarial-review/scripts/lib/version.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay-14-rounds');
const ruling = JSON.parse(fs.readFileSync(path.join(dir, 'ruling.json'), 'utf8'));
const rounds = Array.from({ length: 14 }, (_, i) =>
  JSON.parse(fs.readFileSync(path.join(dir, `patch-review-${i + 1}.json`), 'utf8'))
);

function replay({ maxRounds = Infinity, ruleTwo = true } = {}) {
  const { ids } = itemIdsOf(ruling.closingList);
  let ledger = initLedger(ruling.closingList, [], 'code');
  let used = 0;
  for (const r of rounds) {
    const open = ids.filter((id) => ledger.items[id].state === 'open');
    if (open.length === 0 || used >= maxRounds) break;
    used++;
    const record = {
      round: used,
      reviewedIds: open,
      seatResponses: r.seatResponses.map((s) => ({ seat: s.seat, askedFor: open, items: s.items, error: null })),
      judge: {
        revise: (r.judge.revise || []).flatMap((d) => d.itemIds.map((itemId) => ({ itemId, item: d.item, doneWhen: '' }))),
        priorDemands: [],
      },
      engineVersion: ENGINE_VERSION,
    };
    if (!ruleTwo) {
      // Rule 2 off: every judge demand blocks, as in 3.0.2.
      record.seatResponses = record.seatResponses.concat(
        record.judge.revise.map((d) => ({ seat: 'judge-as-seat', askedFor: [d.itemId], items: [{ id: d.itemId, plan: 'breaks-my-lens', reason: d.item }], error: null }))
      );
    }
    ledger = applyRound(ledger, record);
  }
  return { ledger, used, open: ids.filter((id) => ledger.items[id].state === 'open') };
}

describe('replay of the 14-round run', () => {
  it('maps every recorded demand to at least one item (no unknown-item)', () => {
    for (const [i, r] of rounds.entries()) {
      for (const d of r.judge.revise || []) assert.ok(d.itemIds.length > 0, `round ${i + 1}: ${d.item}`);
    }
  });
  it('settles every item in 6 rounds or fewer with no cap', () => {
    const r = replay();
    assert.deepEqual(r.open, []);
    assert.ok(r.used <= 6, `used ${r.used} rounds`);
    assert.equal(r.used, 6);
  });
  it('stops at the default cap of 3 with C1 open', () => {
    const r = replay({ maxRounds: 3 });
    assert.equal(r.used, 3);
    assert.deepEqual(r.open, ['C1']);
  });
  it('needs more than 6 rounds when rule 2 is off', () => {
    const r = replay({ ruleTwo: false });
    assert.ok(r.used > 6 || r.open.length > 0, `used ${r.used}, open ${r.open}`);
  });
});
