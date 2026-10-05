import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../skills/adversarial-review/scripts/lib/prompts.mjs';
import { loadSeats } from '../skills/adversarial-review/scripts/lib/seats.mjs';
import { expectSnapshot } from './helpers/snapshot.mjs';

const edge = loadSeats().get('edge');
const base = { materialPath: '/m/material.txt', repoRoot: '/r', budget: 20, tools: ['read', 'glob', 'grep'] };
const reReview = {
  pass: 're-review',
  openItems: [{ id: 'C1', item: 'item text', doneWhen: 'done text', priorDemands: ['demand text'], sectionText: 'section text' }],
  regressionList: [{ id: 'C2', doneWhen: 'reg done', sectionText: 'reg section', reason: 'own-section' }],
  delta: '--- C1\n+changed line',
  round: 2,
};

describe('prompt profiles (review stage x pass x capability)', () => {
  for (const reviewStage of ['spec', 'plan', 'code', 'debug']) {
    for (const pass of ['first', 're-review']) {
      for (const capability of ['strong', 'weak']) {
        const step = pass === 'first' ? 'FIND' : 'PATCH_SEAT';
        it(`${step} ${reviewStage} ${pass} ${capability}`, () => {
          const p = buildPrompt(step, { ...base, reviewStage, seat: { ...edge, capability }, ...(pass === 're-review' ? { reReview } : {}) });
          expectSnapshot(`${step}-${reviewStage}-${pass}-${capability}`, p);
          assert.ok(p.includes(`## Your lens (${reviewStage} review)`));
          assert.equal(p.includes('Q1.'), pass === 'first' && capability === 'weak');
          assert.equal(p.includes('This is a re-review'), pass === 're-review');
          assert.equal(p.includes('Example of the JSON shape'), capability === 'weak');
          if (reviewStage === 'spec') assert.ok(!p.includes('undefined'));
          if (pass === 're-review' && reviewStage === 'spec') assert.ok(!p.includes('Report each term that the document uses and does not define'));
        });
      }
    }
  }

  it('weak first-pass PATCH_SEAT', () => {
    const p = buildPrompt('PATCH_SEAT', { ...base, reviewStage: 'code', seat: { ...edge, capability: 'weak' }, plan: 'plan text', closingList: [{ n: 1, item: 'i', doneWhen: 'd', sources: ['edge-1'] }] });
    expectSnapshot('PATCH_SEAT-code-first-weak', p);
    assert.ok(p.includes('one closing item at a time'));
  });
});
