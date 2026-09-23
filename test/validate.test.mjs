import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  PROBE,
  strictify,
} from '../skills/adversarial-review/scripts/lib/schemas.mjs';
import { validate, parseStructured } from '../skills/adversarial-review/scripts/lib/validate.mjs';

describe('schemas and validate module', () => {
  describe('schema structures and order', () => {
    it('RULING closingList item required includes sources', () => {
      assert.ok(RULING.properties.closingList.items.required.includes('sources'));
      assert.ok(RULING.properties.closingList.items.properties.sources);
      assert.equal(RULING.properties.closingList.items.properties.sources.type, 'array');
    });

    it('preserves load-bearing property order', () => {
      const tableProps = Object.keys(TABLE.properties.positions.items.properties);
      assert.ok(tableProps.indexOf('reason') < tableProps.indexOf('position'));

      const rebuttalProps = Object.keys(REBUTTAL.properties);
      assert.ok(rebuttalProps.indexOf('rebuttal') < rebuttalProps.indexOf('standsFirm'));

      const patchSeatProps = Object.keys(PATCH_SEAT.properties.items.items.properties);
      assert.ok(patchSeatProps.indexOf('reason') < patchSeatProps.indexOf('plan'));

      const patchJudgeProps = Object.keys(PATCH_JUDGE.properties);
      assert.ok(patchJudgeProps.indexOf('reasons') < patchJudgeProps.indexOf('decision'));

      const verifySeatProps = Object.keys(VERIFY_SEAT.properties.items.items.properties);
      assert.ok(verifySeatProps.indexOf('evidence') < verifySeatProps.indexOf('status'));

      const verifyJudgeProps = Object.keys(VERIFY_JUDGE.properties);
      assert.ok(verifyJudgeProps.indexOf('reasons') < verifyJudgeProps.indexOf('verdict'));
    });

    it('PROBE has expected shape', () => {
      assert.equal(PROBE.type, 'object');
      assert.equal(PROBE.additionalProperties, false);
      assert.deepEqual(PROBE.required, ['ok']);
      assert.equal(PROBE.properties.ok.type, 'boolean');
    });

    it('validates instances of all schemas', () => {
      // TABLE
      const tableRes = validate(
        {
          positions: [{ id: 's1-1', reason: 'looks wrong', position: 'dispute' }],
          missedBetweenLenses: ['missed boundary'],
          fixRisks: ['might break api'],
        },
        TABLE
      );
      assert.equal(tableRes.ok, true);

      // REBUTTAL
      const rebuttalRes = validate(
        { id: 's1-1', rebuttal: 'it is safe because of lock', standsFirm: true },
        REBUTTAL
      );
      assert.equal(rebuttalRes.ok, true);

      // LASTCALL
      const lastCallRes = validate({ notYetSaid: ['check docs'] }, LASTCALL);
      assert.equal(lastCallRes.ok, true);

      // RULING
      const rulingRes = validate(
        {
          verdict: 'pass-with-items',
          closingList: [
            {
              n: 1,
              item: 'fix bug',
              where: 'src/lib.mjs:10',
              severity: 'important',
              doneWhen: 'tests pass',
              why: 'sound defect',
              sources: ['s1-1'],
            },
          ],
          coverage: 'full coverage',
        },
        RULING
      );
      assert.equal(rulingRes.ok, true);

      // PATCH_SEAT
      const patchSeatRes = validate(
        {
          items: [
            { id: 's1-1', reason: 'good fix', plan: 'sound' },
            { id: 's1-2', reason: 'conflict', plan: 'collides', collidesWith: 's2-1' },
          ],
        },
        PATCH_SEAT
      );
      assert.equal(patchSeatRes.ok, true);

      // PATCH_JUDGE
      const patchJudgeRes = validate(
        {
          reasons: ['all sound'],
          decision: 'APPLY',
          revise: [],
        },
        PATCH_JUDGE
      );
      assert.equal(patchJudgeRes.ok, true);

      // VERIFY_SEAT
      const verifySeatRes = validate(
        {
          items: [{ id: 's1-1', evidence: 'fixed in diff:12', status: 'met' }],
          newInDiff: [],
        },
        VERIFY_SEAT
      );
      assert.equal(verifySeatRes.ok, true);

      // VERIFY_JUDGE
      const verifyJudgeRes = validate(
        {
          reasons: ['verified all items'],
          verdict: 'PASS',
          open: [],
        },
        VERIFY_JUDGE
      );
      assert.equal(verifyJudgeRes.ok, true);

      // PROBE
      const probeRes = validate({ ok: true }, PROBE);
      assert.equal(probeRes.ok, true);
    });
  });

  describe('strictify', () => {
    it('includes file and line in strictify(FINDINGS).properties.findings.items.required', () => {
      const strict = strictify(FINDINGS);
      const itemRequired = strict.properties.findings.items.required;
      assert.ok(itemRequired.includes('file'));
      assert.ok(itemRequired.includes('line'));
    });

    it('does not mutate original schema', () => {
      const origRequired = [...FINDINGS.properties.findings.items.required];
      assert.equal(origRequired.includes('file'), false);
      strictify(FINDINGS);
      assert.equal(FINDINGS.properties.findings.items.required.includes('file'), false);
    });

    it('sets additionalProperties: false and makes unrequired properties nullable anyOf', () => {
      const strict = strictify(FINDINGS);
      assert.equal(strict.additionalProperties, false);
      assert.equal(strict.properties.findings.items.additionalProperties, false);

      const fileSchema = strict.properties.findings.items.properties.file;
      assert.ok(Array.isArray(fileSchema.anyOf));
      assert.ok(fileSchema.anyOf.some((s) => s.type === 'null'));
    });
  });

  describe('validate', () => {
    it('drops extra keys when additionalProperties is false', () => {
      const val = {
        findings: [
          {
            title: 't',
            severity: 'minor',
            detail: 'd',
            evidence: 'e',
            doneWhen: 'w',
            extraInItem: 'drop-me',
          },
        ],
        extraAtTop: 'drop-me-too',
      };
      const res = validate(val, FINDINGS);
      assert.equal(res.ok, true);
      assert.equal('extraAtTop' in res.value, false);
      assert.equal('extraInItem' in res.value.findings[0], false);
      assert.equal(res.value.findings[0].title, 't');
    });

    it('removes null for nullable properties in strictified schema (absent == null)', () => {
      const strict = strictify(FINDINGS);
      const strictNullValue = {
        findings: [
          {
            title: 't',
            severity: 'minor',
            detail: 'd',
            evidence: 'e',
            doneWhen: 'w',
            file: null,
            line: null,
          },
        ],
        notRead: null,
      };
      const res = validate(strictNullValue, strict);
      assert.equal(res.ok, true);
      assert.equal('file' in res.value.findings[0], false);
      assert.equal('line' in res.value.findings[0], false);
      assert.equal('notRead' in res.value, false);
    });

    it('fails when required property is missing with named path', () => {
      const val = {
        findings: [
          {
            severity: 'minor',
            detail: 'd',
            evidence: 'e',
            doneWhen: 'w',
          },
        ],
      };
      const res = validate(val, FINDINGS);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('findings[0].title') && e.includes('required')));
    });

    it('fails on enum violation with named path', () => {
      const val = {
        findings: [
          {
            title: 't',
            severity: 'invalid-severity',
            detail: 'd',
            evidence: 'e',
            doneWhen: 'w',
          },
        ],
      };
      const res = validate(val, FINDINGS);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('findings[0].severity') && e.includes('enum')));
    });
  });

  describe('parseStructured', () => {
    it('takes the LAST ```json fenced block and parses ok with one finding', () => {
      const text =
        'text\n```json\n{"findings":[]}\n```\nmore\n```json\n{"findings":[{"title":"t","severity":"minor","detail":"d","evidence":"e","doneWhen":"w"}]}\n```';
      const res = parseStructured(text, FINDINGS);
      assert.equal(res.ok, true);
      assert.equal(res.value.findings.length, 1);
      assert.equal(res.value.findings[0].title, 't');
    });

    it('parses CRLF variant', () => {
      const text =
        'text\r\n```json\r\n{"findings":[{"title":"t","severity":"minor","detail":"d","evidence":"e","doneWhen":"w"}]}\r\n```';
      const res = parseStructured(text, FINDINGS);
      assert.equal(res.ok, true);
      assert.equal(res.value.findings.length, 1);
    });

    it('parses plain JSON without fence', () => {
      const text = '{"findings":[{"title":"t","severity":"minor","detail":"d","evidence":"e","doneWhen":"w"}]}';
      const res = parseStructured(text, FINDINGS);
      assert.equal(res.ok, true);
      assert.equal(res.value.findings.length, 1);
    });

    it('returns ok:false on "no json"', () => {
      const res = parseStructured('no json', FINDINGS);
      assert.equal(res.ok, false);
      assert.ok(typeof res.error === 'string');
    });

    it('returns ok:false on enum violation and error contains severity', () => {
      const text =
        '```json\n{"findings":[{"title":"t","severity":"invalid","detail":"d","evidence":"e","doneWhen":"w"}]}\n```';
      const res = parseStructured(text, FINDINGS);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes('severity'));
    });

    it('drops extra key foo from value', () => {
      const text =
        '```json\n{"findings":[{"title":"t","severity":"minor","detail":"d","evidence":"e","doneWhen":"w"}],"foo":"bar"}\n```';
      const res = parseStructured(text, FINDINGS);
      assert.equal(res.ok, true);
      assert.equal('foo' in res.value, false);
    });
  });
});
