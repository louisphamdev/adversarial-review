import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemIdsOf,
  normalizeItemIds,
  parsePlan,
  sectionDelta,
  DELTA_CAP,
} from '../skills/adversarial-review/scripts/lib/plan-sections.mjs';

const IDS = ['C1', 'C2', 'C3'];

describe('itemIdsOf', () => {
  it('uses n when every n is a unique positive integer', () => {
    const r = itemIdsOf([{ n: 1 }, { n: 2 }, { n: 5 }]);
    assert.deepEqual(r.ids, ['C1', 'C2', 'C5']);
    assert.equal(r.renumbered, false);
  });
  it('renumbers by position when n repeats or is not an integer', () => {
    assert.deepEqual(itemIdsOf([{ n: 1 }, { n: 1 }]).ids, ['C1', 'C2']);
    const r = itemIdsOf([{ n: 1.5 }, { n: 2 }]);
    assert.deepEqual(r.ids, ['C1', 'C2']);
    assert.equal(r.renumbered, true);
  });
});

describe('normalizeItemIds', () => {
  it('reads every item reference form', () => {
    for (const raw of ['C1', 'c1', '1', 'Item 1', '#1', 'C01']) {
      assert.deepEqual(normalizeItemIds(raw, IDS), ['C1'], raw);
    }
    assert.deepEqual(normalizeItemIds('1+3', IDS), ['C1', 'C3']);
    assert.deepEqual(normalizeItemIds('C1/C3', IDS), ['C1', 'C3']);
  });
  it('maps cross and drops unknown ids', () => {
    assert.deepEqual(normalizeItemIds('cross', IDS), ['cross']);
    assert.deepEqual(normalizeItemIds('Cross-cutting', IDS), ['cross']);
    assert.deepEqual(normalizeItemIds('C9', IDS), []);
    assert.deepEqual(normalizeItemIds('advisory-log', IDS), []);
    assert.deepEqual(normalizeItemIds('pin the 8191-character limit', IDS), []);
  });
  it('binds a number after letters only through a C, Item, or # prefix', () => {
    for (const raw of ['breaker-2', 'edge-1', 'fix after 2 attempts']) {
      assert.deepEqual(normalizeItemIds(raw, IDS), [], raw);
    }
    for (const raw of ['C2', '2', '#2', 'Item 2', 2]) {
      assert.deepEqual(normalizeItemIds(raw, IDS), ['C2'], String(raw));
    }
    assert.deepEqual(normalizeItemIds('C1, C3', IDS), ['C1', 'C3']);
    assert.deepEqual(normalizeItemIds('1, 3', IDS), ['C1', 'C3']);
  });
});

describe('parsePlan', () => {
  const plan = '# Patch plan\nDate: today\n\n## C1\nfix one\n### detail\nmore\n## Cross-cutting\nshared\n##C2\nfix two\n## C03\nfix three\n';
  it('splits preamble, item sections, and cross', () => {
    const r = parsePlan(plan, IDS, { mustHave: IDS });
    assert.equal(r.preamble, '# Patch plan\nDate: today');
    assert.equal(r.sections.C1, 'fix one\n### detail\nmore');
    assert.equal(r.sections.cross, 'shared');
    assert.equal(r.sections.C2, 'fix two');
    assert.equal(r.sections.C3, 'fix three');
  });
  it('normalizes CRLF and BOM', () => {
    const r = parsePlan('\uFEFF## C1\r\na\r\n## C2\r\nb\r\n## C3\r\nc', IDS, { mustHave: IDS });
    assert.equal(r.sections.C1, 'a');
  });
  it('keeps a bare ## line inside the current section', () => {
    const r = parsePlan('## C1\na\n##\nb', IDS, {});
    assert.equal(r.sections.C1, 'a\n##\nb');
  });
  it('exits 2 for an unknown id', () => {
    assert.throws(() => parsePlan('## C9\nx', IDS, {}), (e) => e.exitCode === 2 && /C9/.test(e.message));
  });
  it('exits 2 for a duplicate id', () => {
    assert.throws(() => parsePlan('## C1\na\n## C1\nb', IDS, {}), (e) => e.exitCode === 2 && /two "## C1"/.test(e.message));
  });
  it('exits 2 when a mustHave id has no section', () => {
    assert.throws(
      () => parsePlan('## C1\na\n## C2\nb', IDS, { mustHave: IDS }),
      (e) => e.exitCode === 2 && /C3/.test(e.message) && /## C<n>/.test(e.message)
    );
  });
  it('exits 2 for a plan with no section heading', () => {
    assert.throws(() => parsePlan('just text', IDS, { mustHave: ['C1'] }), (e) => e.exitCode === 2);
  });
  it('ignores headings inside a fenced code block', () => {
    const plan = ['## C1', '```', '## C2', '```', 'after', '## C2', 'b', '## C3', 'c'].join('\n');
    const r = parsePlan(plan, IDS, { mustHave: IDS });
    assert.equal(r.sections.C1, ['```', '## C2', '```', 'after'].join('\n'));
  });
  it('keeps "## Cross-cutting notes" as text and allows an empty section', () => {
    const r = parsePlan(['## C1', '## Cross-cutting notes', 'x', '## C2', '## C3', 'c'].join('\n'), IDS, { mustHave: IDS });
    assert.equal(r.sections.C1, '## Cross-cutting notes\nx');
    assert.equal(r.sections.C2, '');
  });
  it('accepts a missing section that is not in mustHave', () => {
    const r = parsePlan('## C1\na', IDS, { mustHave: ['C1'] });
    assert.deepEqual(Object.keys(r.sections), ['C1']);
  });
});

describe('sectionDelta', () => {
  it('gives no change for equal sections', () => {
    const d = sectionDelta({ C1: 'a\nb' }, { C1: 'a\nb' });
    assert.deepEqual(d.changed, []);
    assert.equal(d.text, '');
  });
  it('lists removed and added lines per changed section', () => {
    const d = sectionDelta({ C1: 'a\nb\nc', C2: 'x' }, { C1: 'a\nB\nc', C2: 'x' });
    assert.deepEqual(d.changed, ['C1']);
    assert.deepEqual(d.changedLines.C1, ['b', 'B']);
    assert.match(d.text, /^--- C1/m);
    assert.match(d.text, /^-b$/m);
    assert.match(d.text, /^\+B$/m);
  });
  it('cuts the text at the cap and keeps changed', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    const d = sectionDelta({ C1: '' }, { C1: big });
    assert.equal(d.cut, true);
    assert.ok(d.text.length <= DELTA_CAP);
    assert.deepEqual(d.changed, ['C1']);
  });
  it('treats a section over 2000 lines as a whole change', () => {
    const a = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l5\n', 'L5\n');
    const d = sectionDelta({ C1: a }, { C1: b });
    assert.equal(d.changedLines.C1.length, 4002);
  });
});
