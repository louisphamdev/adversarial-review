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
  lensFor,
} from '../skills/adversarial-review/scripts/lib/seats.mjs';
import { RENDER_ORDER, REVIEW_STAGES, STAGE_BLOCKS, stageBlockText } from '../skills/adversarial-review/scripts/lib/stage-blocks.mjs';
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
    // An agent cannot resolve a placeholder: every path in the rendered agent must be concrete.
    assert.ok(rendered.includes('~/.adversarial-review/memory/rt-breaker.md'));
    assert.ok(rendered.includes('references/table-rules.md'));
    assert.ok(!rendered.includes('<state>'));
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

  const SEAT_HEAD = '---\nkey: KEY\ntitle: T\nlens: one line lens\ndescription: d\ntier: standard\nbudgetFactor: 1\n---\n\n# Seat\n\n## Identity\n\nText.\n\n';
  const write = (dir, key, body) =>
    fs.writeFileSync(path.join(dir, `${key}.md`), SEAT_HEAD.replace('KEY', key) + body, 'utf8');

  await t.test('stage-blocks exports one list and four blocks', () => {
    assert.deepEqual(REVIEW_STAGES, ['spec', 'plan', 'code', 'debug']);
    for (const st of REVIEW_STAGES) {
      assert.ok(typeof STAGE_BLOCKS[st].kind === 'string' && Array.isArray(STAGE_BLOCKS[st].hunt) && typeof STAGE_BLOCKS[st].evidence === 'string');
    }
    assert.ok(stageBlockText('spec').startsWith('The material is a design document.'));
    assert.ok(stageBlockText('spec').includes('Report each term that the document uses and does not define.'));
    assert.equal(Object.hasOwn(STAGE_BLOCKS, 'toString'), false);
  });

  await t.test('parses lens sections out of the body', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'seats-lens-'));
    try {
      write(tmp, 'x', '## Lens: code\n\n- c1\n- c2\n\n## Lens: spec\n\n- s1\n  continued\n\n## Exit criteria\n\nDone.\n');
      const x = loadSeats(tmp).get('x');
      assert.deepEqual(Object.keys(x.lenses).sort(), ['code', 'spec']);
      assert.equal(x.lenses.spec, '- s1\n  continued');
      assert.ok(!x.body.includes('## Lens:'));
      assert.ok(x.body.includes('## Exit criteria'));
      assert.equal(x.legacyLens, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('keeps a legacy "Your lens" section apart from the body', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'seats-legacy-'));
    try {
      write(tmp, 'y', '## Your lens\n\n- old bullet\n\n## Exit criteria\n\nDone.\n');
      const y = loadSeats(tmp).get('y');
      assert.equal(y.legacyLens, '- old bullet');
      assert.ok(!y.body.includes('## Your lens'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('parses a CRLF seat file the same as LF', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'seats-crlf-'));
    try {
      const lf = SEAT_HEAD.replace('KEY', 'z') + '## Lens: spec\n\n- s1\n- s2\n\n## Exit criteria\n\nDone.\n';
      fs.writeFileSync(path.join(tmp, 'z.md'), lf.replace(/\n/g, '\r\n'), 'utf8');
      const z = loadSeats(tmp).get('z');
      assert.equal(z.lenses.spec, '- s1\n- s2');
      assert.ok(!z.body.includes('\r'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const [label, body, re] of [
    ['duplicate lens heading', '## Lens: spec\n\n- a\n\n## Lens: spec\n\n- b\n', /duplicate.*spec/i],
    ['unknown lens name', '## Lens: docs\n\n- a\n', /docs/],
    ['lens with no bullet', '## Lens: plan\n\nJust prose.\n', /no bullet/i],
  ]) {
    await t.test(`rejects a seat file with a ${label}`, () => {
      const tmp = fs.mkdtempSync(path.join(tmpdir(), 'seats-bad-'));
      try {
        write(tmp, 'bad', body);
        assert.throws(() => loadSeats(tmp), (err) => err instanceof ConfigError && re.test(err.message) && /bad\.md/.test(err.message));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  await t.test('lensFor falls back from stage to legacy to frontmatter', () => {
    assert.deepEqual(lensFor({ lenses: { spec: '- s' }, legacyLens: '- l', lens: 'f' }, 'spec'), { text: '- s', source: 'stage' });
    assert.deepEqual(lensFor({ lenses: {}, legacyLens: '- l', lens: 'f' }, 'spec'), { text: '- l', source: 'legacy' });
    assert.deepEqual(lensFor({ lenses: {}, legacyLens: null, lens: 'f' }, 'spec'), { text: '- f', source: 'frontmatter' });
  });

  await t.test('resolveSeats checks the stage first and returns it normalized', () => {
    for (const bad of ['docs', 'toString', '__proto__', '', 7]) {
      assert.throws(() => resolveSeats({ stage: bad }), (err) => err instanceof ConfigError && /spec, plan, code, debug/.test(err.message));
      assert.throws(() => resolveSeats({ stage: bad, seatsFlag: 'breaker' }), ConfigError);
    }
    const r = resolveSeats({ stage: ' Spec ' });
    assert.equal(r.stage, 'spec');
    assert.equal(r.chosen[0].key, 'historian');
  });

  await t.test('renderSeat cli adds the lens for the review stage', () => {
    const seat = { key: 'q', body: '# Q', lenses: { spec: '- s1' }, legacyLens: null, lens: 'f' };
    const out = renderSeat(seat, 'cli', { reviewStage: 'spec' });
    assert.ok(out.includes('## Your lens (spec review)\n\n- s1'));
    assert.ok(out.indexOf('## Your lens') < out.indexOf('## Report'));
    assert.equal(renderSeat(seat, 'cli'), '# Q\n\n## Report\n\nYour final answer is the report. End it with ONE fenced json block that matches the schema below.\n');
  });

  await t.test('renderSeat claude-agent holds the stage rule, the four stage blocks and lenses; judge has none', () => {
    const seat = { key: 'q', description: 'd', tier: 'standard', body: '# Q', lenses: { code: '- c', spec: '- s', plan: '- p', debug: '- d' }, legacyLens: null, lens: 'f' };
    const out = renderSeat(seat, 'claude-agent');
    assert.ok(out.includes('The first line of your task names the review stage, in the form `Review stage: <stage>.`'));
    assert.ok(out.includes('Use only the rules and the lens for that stage. Ignore the other three.'));
    const specAt = out.indexOf('### Spec review');
    assert.ok(specAt > 0 && out.indexOf('Report each term that the document uses and does not define.', specAt) > specAt);
    for (const h of ['### Code review', '### Plan review', '### Debug review']) assert.ok(out.includes(h));
    assert.ok(out.indexOf('## Your lens by review stage') < out.indexOf('## Before you work'));
    const judge = renderSeat({ key: 'judge', description: 'd', tier: 'strong', body: '# J', lenses: {}, legacyLens: null, lens: '' }, 'claude-agent');
    assert.ok(!judge.includes('Your lens by review stage'));
  });

  await t.test('the claude-agent render emits one section per review stage, in RENDER_ORDER', () => {
    assert.equal(RENDER_ORDER.length, REVIEW_STAGES.length);
    assert.deepEqual([...RENDER_ORDER].sort(), [...REVIEW_STAGES].sort());

    const seat = { key: 'q', description: 'd', tier: 'standard', body: '# Q', lenses: {}, legacyLens: null, lens: 'f' };
    const out = renderSeat(seat, 'claude-agent');
    const headings = [...out.matchAll(/^### (.*) review$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, RENDER_ORDER.map((st) => `${st[0].toUpperCase()}${st.slice(1)}`));
  });

  const LENS_SEATS_A = ['attacker', 'breaker', 'edge', 'historian', 'keeper', 'medic'];
  await t.test('batch A seats have four lens sections with at least 3 bullets', () => {
    const seats = loadSeats();
    for (const key of LENS_SEATS_A) {
      const s = seats.get(key);
      for (const st of ['code', 'spec', 'plan', 'debug']) {
        assert.ok(s.lenses[st], `${key} has no ${st} lens`);
        assert.ok((s.lenses[st].match(/^- /gm) || []).length >= 3, `${key} ${st} lens has fewer than 3 bullets`);
      }
      assert.equal(s.legacyLens, null, `${key} still has a "## Your lens" section`);
    }
    const edgeSpec = seats.get('edge').lenses.spec;
    assert.ok(!edgeSpec.includes('undefined') && !edgeSpec.includes('null'));
    assert.ok(edgeSpec.includes('Two sections that define one thing in two different ways.'));
  });

  const FINDER_SEATS = ['attacker', 'breaker', 'edge', 'historian', 'keeper', 'medic', 'native', 'plumber', 'racer', 'simplifier', 'skeptic', 'tester'];
  await t.test('every finder seat has four lens sections and no near-miss heading', () => {
    const seats = loadSeats();
    for (const key of FINDER_SEATS) {
      const s = seats.get(key);
      for (const st of ['code', 'spec', 'plan', 'debug']) {
        assert.ok(s.lenses[st] && (s.lenses[st].match(/^- /gm) || []).length >= 3, `${key} ${st}`);
      }
      const raw = fs.readFileSync(path.join(defaultSeatsDir(), `${key}.md`), 'utf8');
      const withoutReal = raw.replace(/^## Lens: (code|spec|plan|debug)$/gm, '');
      assert.ok(!/^#{2,3} ?[Ll]ens:/m.test(withoutReal), `${key} has a near-miss lens heading`);
    }
    assert.deepEqual(Object.keys(seats.get('judge').lenses), []);
  });

  await t.test('generated rt-edge agent carries the stage rule and the spec block; rt-judge has no lens block', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const edge = fs.readFileSync(path.join(root, 'agents', 'rt-edge.md'), 'utf8');
    assert.ok(edge.includes('The first line of your task names the review stage'));
    const at = edge.indexOf('### Spec review');
    assert.ok(at > 0 && edge.indexOf('Report each term that the document uses and does not define.', at) > at);
    const judge = fs.readFileSync(path.join(root, 'agents', 'rt-judge.md'), 'utf8');
    assert.ok(!judge.includes('Your lens by review stage'));
  });
});
