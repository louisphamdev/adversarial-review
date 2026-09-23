#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8');

if (process.env.FAKE_SEAT_COUNTER_FILE) {
  try {
    fs.appendFileSync(process.env.FAKE_SEAT_COUNTER_FILE, '1\n');
  } catch {}
}
if (process.env.FAKE_SEAT_PID_FILE) {
  try {
    fs.appendFileSync(process.env.FAKE_SEAT_PID_FILE, `${process.pid}\n`);
  } catch {}
}

const stageMatch = input.match(/Stage:\s*([A-Za-z0-9_-]+)/i);
const rawStage = stageMatch ? stageMatch[1].toUpperCase() : 'UNKNOWN';
const stage = rawStage.replace(/[-_]/g, '');

const seatMatch = input.match(/\bseat\s+rt-([a-z0-9_-]+)/i) || input.match(/\brt-([a-z0-9_-]+)\b/i);
const key = seatMatch ? seatMatch[1].toLowerCase() : (stage.includes('JUDGE') || stage === 'RULING' ? 'judge' : 'unknown');

let plan = {};
try {
  plan = JSON.parse(process.env.FAKE_SEAT_PLAN || '{}');
} catch {}

const seatPlan = plan[key] || plan[key.replace(/^rt-/, '')] || {};
const behavior =
  seatPlan[rawStage] ||
  seatPlan[stage] ||
  seatPlan[rawStage.toLowerCase()] ||
  seatPlan[stage.toLowerCase()] ||
  seatPlan.default ||
  'ok';

if (behavior === 'hang') {
  setInterval(() => {}, 10000);
} else if (behavior === 'exit1') {
  process.stderr.write(`Simulated exit 1 for seat rt-${key} at stage ${rawStage}\n`);
  process.exit(1);
} else if (behavior === 'prose') {
  console.log(`I am seat rt-${key} reviewing stage ${rawStage}. I found some issues, but this is plain prose with no json block.`);
  process.exit(0);
} else {
  let canned;

  if (stage === 'FIND') {
    canned = {
      findings: [
        {
          title: 't-' + key,
          file: 'test.js',
          line: '1',
          severity: key === 'breaker' ? 'important' : 'minor',
          detail: 'Detail for ' + key,
          evidence: 'Evidence for ' + key,
          doneWhen: 'fixed',
        },
      ],
      notRead: [],
    };
  } else if (stage === 'TABLE') {
    canned = {
      positions: [
        {
          id: 'breaker-1',
          reason: 'looks reasonable',
          position: 'support',
        },
      ],
      missedBetweenLenses: [],
      fixRisks: [],
    };
  } else if (stage === 'DISPUTE' || stage === 'REBUTTAL') {
    canned = {
      id: 'breaker-1',
      rebuttal: 'I stand by my finding',
      standsFirm: true,
    };
  } else if (stage === 'LASTCALL') {
    canned = {
      notYetSaid: ['Last call item from ' + key],
    };
  } else if (stage === 'RULING') {
    const hasBreaker = input.includes('breaker-1');
    if (hasBreaker) {
      canned = {
        verdict: 'blocked',
        closingList: [
          {
            n: 1,
            item: 'Fix breaker finding',
            where: 'test.js:1',
            severity: 'important',
            doneWhen: 'fixed',
            why: 'breaker is broken',
            sources: ['breaker-1'],
          },
        ],
        advisory: [],
        frozenScope: [],
        coverage: 'Full coverage',
      };
    } else {
      canned = {
        verdict: 'pass',
        closingList: [],
        advisory: [],
        frozenScope: [],
        coverage: 'Full coverage',
      };
    }
  } else if (stage === 'PATCHSEAT') {
    canned = {
      items: [
        {
          id: 'breaker-1',
          reason: 'Sound approach',
          plan: 'sound',
        },
      ],
    };
  } else if (stage === 'PATCHJUDGE') {
    canned = {
      reasons: ['Patch plan addresses closing list'],
      decision: 'APPLY',
      revise: [],
    };
  } else if (stage === 'VERIFYSEAT') {
    canned = {
      items: [
        {
          id: 'breaker-1',
          evidence: 'test.js:1 confirmed fixed',
          status: 'met',
        },
      ],
      newInDiff: [],
    };
  } else if (stage === 'VERIFYJUDGE') {
    canned = {
      reasons: ['All requirements met'],
      verdict: 'PASS',
      open: [],
    };
  } else if (stage === 'PROBE') {
    canned = {
      ok: true,
    };
  } else {
    canned = { ok: true };
  }

  console.log('```json\n' + JSON.stringify(canned, null, 2) + '\n```');
  process.exit(0);
}
