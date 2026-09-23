import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSeats,
  defaultSeatsDir,
  STAGE_SEATS,
  resolveSeats,
  seatBudget,
  renderSeat,
} from '../skills/adversarial-review/scripts/lib/seats.mjs';
import { ConfigError } from '../skills/adversarial-review/scripts/lib/errors.mjs';

test('seats module', async (t) => {
  await t.test('loadSeats loads 13 seats from default directory', () => {
    const seats = loadSeats();
    assert.equal(seats instanceof Map, true);
    assert.equal(seats.size, 13);

    const expectedKeys = [
      'attacker', 'breaker', 'edge', 'historian', 'judge',
      'keeper', 'medic', 'native', 'plumber', 'racer',
      'simplifier', 'skeptic', 'tester',
    ];

    for (const key of expectedKeys) {
      assert.ok(seats.has(key), `Missing seat: ${key}`);
      const seat = seats.get(key);
      assert.equal(seat.key, key);
      assert.ok(typeof seat.title === 'string' && seat.title.length > 0);
      assert.ok(typeof seat.lens === 'string' && seat.lens.length > 0);
      assert.ok(typeof seat.description === 'string' && seat.description.length > 0);
      assert.ok(['strong', 'standard', 'light'].includes(seat.tier));
      assert.ok(typeof seat.budgetFactor === 'number' && seat.budgetFactor > 0);
      assert.ok(typeof seat.body === 'string' && seat.body.length > 0);
    }
  });

  await t.test('loadSeats parses frontmatter and validates key against file name', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'seats-test-'));
    try {
      // Valid seat file
      fs.writeFileSync(
        path.join(tmp, 'dummy.md'),
        `---\nkey: dummy\ntitle: Dummy\nlens: test lens\ndescription: test desc\ntier: standard\nbudgetFactor: 1.25\n---\n\n# Dummy Seat Body\n`,
        'utf8',
      );
      const seats = loadSeats(tmp);
      assert.equal(seats.size, 1);
      const dummy = seats.get('dummy');
      assert.equal(dummy.key, 'dummy');
      assert.equal(dummy.title, 'Dummy');
      assert.equal(dummy.lens, 'test lens');
      assert.equal(dummy.description, 'test desc');
      assert.equal(dummy.tier, 'standard');
      assert.equal(dummy.budgetFactor, 1.25);
      assert.equal(dummy.body, '# Dummy Seat Body');

      // Key mismatch with filename
      fs.writeFileSync(
        path.join(tmp, 'mismatch.md'),
        `---\nkey: different\ntitle: Diff\nlens: l\ndescription: d\ntier: standard\nbudgetFactor: 1\n---\n\nBody\n`,
        'utf8',
      );
      assert.throws(
        () => loadSeats(tmp),
        (err) => err instanceof ConfigError && /does not match file name/i.test(err.message),
      );
      fs.unlinkSync(path.join(tmp, 'mismatch.md'));

      // Missing opening frontmatter
      fs.writeFileSync(path.join(tmp, 'bad1.md'), `key: bad1\n---\nBody\n`, 'utf8');
      assert.throws(
        () => loadSeats(tmp),
        (err) => err instanceof ConfigError && /missing/i.test(err.message),
      );
      fs.unlinkSync(path.join(tmp, 'bad1.md'));

      // Missing closing frontmatter
      fs.writeFileSync(path.join(tmp, 'bad2.md'), `---\nkey: bad2\nBody\n`, 'utf8');
      assert.throws(
        () => loadSeats(tmp),
        (err) => err instanceof ConfigError && /missing/i.test(err.message),
      );
      fs.unlinkSync(path.join(tmp, 'bad2.md'));

      // Invalid line without colon
      fs.writeFileSync(path.join(tmp, 'bad3.md'), `---\nkey: bad3\ninvalid_line_no_colon\n---\nBody\n`, 'utf8');
      assert.throws(
        () => loadSeats(tmp),
        (err) => err instanceof ConfigError && /colon/i.test(err.message),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('seatBudget calculates correctly with minimum 6', () => {
    const seats = loadSeats();
    const racer = seats.get('racer');
    const tester = seats.get('tester');
    const breaker = seats.get('breaker');

    // racer factor is 1.5 -> 20 * 1.5 = 30
    assert.equal(seatBudget(racer, 20), 30);
    // tester factor is 0.75 -> 20 * 0.75 = 15
    assert.equal(seatBudget(tester, 20), 15);
    // breaker factor is 1 -> 20 * 1 = 20
    assert.equal(seatBudget(breaker, 20), 20);

    // Minimum budget of 6
    assert.equal(seatBudget(breaker, 2), 6);
    assert.equal(seatBudget(racer, 2), 6);

    // Default budget is 20
    assert.equal(seatBudget(racer), 30);
  });

  await t.test('STAGE_SEATS defines standard seats for each stage', () => {
    assert.deepEqual(STAGE_SEATS.code, ['breaker', 'edge', 'attacker', 'medic', 'tester', 'skeptic']);
    assert.deepEqual(STAGE_SEATS.spec, ['historian', 'edge', 'attacker', 'keeper', 'simplifier', 'skeptic']);
    assert.deepEqual(STAGE_SEATS.plan, ['historian', 'medic', 'keeper', 'racer', 'simplifier', 'skeptic']);
    assert.deepEqual(STAGE_SEATS.debug, ['racer', 'edge', 'medic', 'keeper', 'breaker', 'skeptic']);
  });

  await t.test('resolveSeats({stage:"code"}) returns 6 keys with skeptic and 6 noSeat without judge', () => {
    const { chosen, noSeat, warnings } = resolveSeats({ stage: 'code' });
    const keys = chosen.map((s) => s.key);
    assert.deepEqual(keys, ['breaker', 'edge', 'attacker', 'medic', 'tester', 'skeptic']);
    assert.equal(noSeat.length, 6);
    assert.ok(!noSeat.includes('judge'));
    assert.equal(warnings.length, 0);
  });

  await t.test('resolveSeats trims and dedupes seatsFlag, adds skeptic, produces warning', () => {
    const { chosen, noSeat, warnings } = resolveSeats({ seatsFlag: ' breaker, ,edge,breaker' });
    const keys = chosen.map((s) => s.key);
    assert.deepEqual(keys, ['breaker', 'edge', 'skeptic']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /duplicate|breaker/i);
    assert.ok(!noSeat.includes('judge'));
    assert.ok(!noSeat.includes('breaker'));
    assert.ok(!noSeat.includes('edge'));
    assert.ok(!noSeat.includes('skeptic'));
  });

  await t.test('resolveSeats throws ConfigError for unknown seat with rt- hint', () => {
    assert.throws(
      () => resolveSeats({ seatsFlag: 'rt-breaker' }),
      (err) => err instanceof ConfigError && err.message.includes('rt-'),
    );
  });

  await t.test('resolveSeats throws ConfigError for judge in seatsFlag', () => {
    assert.throws(
      () => resolveSeats({ seatsFlag: 'judge' }),
      (err) => err instanceof ConfigError && /judge/i.test(err.message),
    );
  });

  await t.test('resolveSeats throws ConfigError for empty seatsFlag after trim', () => {
    assert.throws(
      () => resolveSeats({ seatsFlag: ' , ' }),
      (err) => err instanceof ConfigError,
    );
    assert.throws(
      () => resolveSeats({ seatsFlag: '' }),
      (err) => err instanceof ConfigError,
    );
  });

  await t.test('resolveSeats adds projectSeats to stage seats', () => {
    const { chosen } = resolveSeats({ stage: 'code', projectSeats: ['racer'] });
    const keys = chosen.map((s) => s.key);
    assert.deepEqual(keys, ['breaker', 'edge', 'attacker', 'medic', 'tester', 'skeptic', 'racer']);
  });

  await t.test('renderSeat for claude-agent target', () => {
    const seats = loadSeats();
    const breaker = seats.get('breaker');
    const rendered = renderSeat(breaker, 'claude-agent');

    assert.ok(rendered.startsWith('---\nname: rt-breaker\n'));
    assert.match(rendered, /\bmodel:\s*opus\b/);
    assert.match(rendered, /\btools:\s*Read, Grep, Glob\b/);
    assert.ok(rendered.includes('## Before you work'));
    assert.ok(rendered.includes('table-rules.md'));
    assert.ok(rendered.includes('<state>/memory/rt-breaker.md'));
    assert.ok(rendered.includes('SendMessage'));
  });

  await t.test('renderSeat for cli target', () => {
    const seats = loadSeats();
    const breaker = seats.get('breaker');
    const rendered = renderSeat(breaker, 'cli');

    assert.ok(!rendered.includes('SendMessage'));
    assert.ok(rendered.includes('## Report'));
    assert.ok(rendered.includes('Your final answer is the report. End it with ONE fenced json block that matches the schema below.'));
  });
});
