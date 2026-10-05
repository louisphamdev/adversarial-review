// CLI patch-review and verify commands (§18.1, §6.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertRunDir, readState, readCheckpoint, writeIndexed, nextRound, appendEvent } from '../rundir.mjs';
import { runPatchReview, runVerify, countsAsVerify } from '../pipeline.mjs';
import { closingListHashOf } from '../ledger.mjs';
import { collectDiff, resolveBase, validateBase } from '../verify-diff.mjs';
import { runSeatCall } from '../backends/index.mjs';
import { loadConfig } from '../config.mjs';
import { runChild } from '../proc.mjs';
import { acquireLockWithCleanup } from '../cleanup.mjs';
import { readLock, pidAlive } from '../lockfile.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import { makeJevRouter } from '../jev.mjs';
import { ConfigError, RunError } from '../errors.mjs';

// Part C rule C8: never take over a lock whose owner pid is alive, whatever the age of the lock.
export async function refuseLiveOwner(runDir, { isAlive = pidAlive } = {}) {
  const current = await readLock(path.join(runDir, 'lock'));
  if (current?.pid && current.pid !== process.pid && isAlive(current.pid)) {
    throw new RunError(`owner still alive (pid ${current.pid})`, 'owner-alive');
  }
}

// Round records in numeric index order. A gap or an unreadable record stops the command:
// the engine never guesses the state of a lost round.
export async function readRecords(runDir, prefix) {
  const dir = path.join(runDir, 'stages');
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d+)\\.json$`);
  const picked = names
    .map((n) => [n, n.match(re)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
  picked.forEach(([n, m], k) => {
    if (Number(m[1]) !== k + 1) throw new ConfigError(`Record ${n} follows a gap in the ${prefix} records. Start a new run.`);
  });
  const out = [];
  for (const [n] of picked) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')));
    } catch (err) {
      throw new ConfigError(`Cannot read record ${n}: ${err.message}. Start a new run.`);
    }
  }
  return out;
}

function createClosingAgent({ config, env, runDir, repoRoot, round = 1 }) {
  const hostBackend = config.hostBackend || 'claude';
  const judgeBackend = config.stages?.ruling?.backend || hostBackend;

  return async function runAgent({ stage, seat, prompt, schema }) {
    const isJudge = stage.includes('JUDGE') || seat.key === 'judge';
    const backend = isJudge ? judgeBackend : hostBackend;
    const model = isJudge ? config.stages?.ruling?.model : config.stages?.[stage.toLowerCase()]?.model;
    const timeoutMs = config.timeouts?.other || 600000;
    const callId = `${stage.toLowerCase()}-${seat.key}`;

    return await runSeatCall(
      {
        callId,
        prompt,
        schema,
        root: repoRoot,
        runDir,
        cwd: path.join(runDir, 'cwd'),
        model,
        timeoutMs,
        round,
      },
      {
        backend,
        config,
        env,
      }
    );
  };
}

export async function patchReviewCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  if (positionals.length === 0) {
    throw new ConfigError('Run directory is required: patch-review <run-dir> --plan <file>');
  }
  const runDir = assertRunDir(env, positionals[0]);

  if (!flags.plan) {
    throw new ConfigError('Plan file is required: --plan <file>');
  }
  let maxRoundsFlag = null;
  if (flags['max-rounds'] !== undefined) {
    maxRoundsFlag = Number(flags['max-rounds']);
    if (!Number.isInteger(maxRoundsFlag) || maxRoundsFlag < 1) {
      throw new ConfigError(`--max-rounds must be an integer >= 1, got "${flags['max-rounds']}"`);
    }
  }

  // The plan and every record are read under the lock, so two commands never derive one round twice.
  await refuseLiveOwner(runDir);
  const lock = await acquireLockWithCleanup(runDir, { stderr });

  try {
    let planText;
    try {
      planText = await fs.readFile(flags.plan, 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read plan file "${flags.plan}": ${err.message}`);
    }
    if (!planText.trim()) {
      throw new ConfigError(`Plan file "${flags.plan}" is empty`);
    }

    const state = await readState(runDir);
    const rulingCheckpoint = await readCheckpoint(runDir, 'ruling');
    const ruling = state.result?.ruling || rulingCheckpoint;
    if (!ruling) {
      throw new ConfigError('Run directory has no RULING. Cannot perform patch review before ruling.');
    }
    const findCheckpoint = await readCheckpoint(runDir, 'find');
    const findings = state.result?.raw?.findings || findCheckpoint?.findings || [];

    const { config } = loadConfig({ env, flags, stderr });
    const repoRoot = state.request?.repoRoot || cwd;
    const maxRounds = maxRoundsFlag ?? config.patchReview?.maxRounds ?? 3;
    const records = await readRecords(runDir, 'patch-review');
    const router = await makeJevRouter({ config, env, runDir });

    // The call-file round counts record files, so a judge-dead retry never overwrites a call file.
    const round = await nextRound(runDir, 'patch-review');
    const runAgent = createClosingAgent({ config, env, runDir, repoRoot, round });
    const res = await runPatchReview({
      state: { ...state, ruling, findings },
      plan: planText,
      runAgent,
      records,
      config,
      router,
      maxRounds,
    });

    let recordPath = null;
    if (res.record) {
      recordPath = await writeIndexed(runDir, 'patch-review', res.record);
      try {
        await writeFileAtomic(path.join(runDir, 'stages', 'ledger.json'), `${JSON.stringify(res.ledger, null, 2)}\n`);
      } catch (err) {
        stderr.write(`warning: ledger.json not written: ${err.message}\n`);
      }
      await appendEvent(runDir, { event: 'stage_end', stage: 'PATCH_REVIEW', round: res.record.round, decision: res.decision });
    }

    if (flags.json) {
      stdout.write(JSON.stringify({ ...(res.record || {}), decision: res.decision, exitCode: res.exitCode, message: res.message, recordPath }, null, 2) + '\n');
    } else {
      stdout.write(`Decision: ${res.decision}\n${res.message}\n`);
      if (recordPath) stdout.write(`Saved to: ${recordPath}\n`);
    }

    if (res.exitCode === 3) {
      throw new RunError(res.record?.error || 'Judge failed during patch review', 'judge-dead');
    }
    return res.exitCode;
  } finally {
    await lock.release();
  }
}

export async function verifyCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  if (positionals.length === 0) {
    throw new ConfigError('Run directory is required: verify <run-dir> [--base <ref>]');
  }
  const runDir = assertRunDir(env, positionals[0]);
  if (flags.base !== undefined) validateBase(flags.base);

  // Every record and the diff are read under the lock.
  await refuseLiveOwner(runDir);
  const lock = await acquireLockWithCleanup(runDir, { stderr });

  try {
    const state = await readState(runDir);
    const rulingCheckpoint = await readCheckpoint(runDir, 'ruling');
    const ruling = state.result?.ruling || rulingCheckpoint;
    if (!ruling) {
      throw new ConfigError('Run directory has no RULING. Cannot verify before ruling.');
    }

    const repoRoot = state.request?.repoRoot || cwd;
    const records = await readRecords(runDir, 'verify');
    const prior = records.filter(countsAsVerify).at(-1) || null;
    if (prior?.closingListHash && prior.closingListHash !== closingListHashOf(ruling.closingList || [])) {
      throw new ConfigError(`The ruling changed after verify round ${prior.round}. Start a new run with \`adversarial-review run\`.`);
    }
    // The base is pinned in round 1, so a commit of the fix between rounds does not change the diff.
    let baseSha;
    if (prior?.baseSha) {
      baseSha = prior.baseSha;
      if (flags.base) {
        const asked = await resolveBase(repoRoot, flags.base, runChild);
        if (asked !== baseSha) {
          throw new ConfigError(`This run verifies against ${baseSha}. Start a new run to change the base.`);
        }
      }
    } else {
      baseSha = await resolveBase(repoRoot, flags.base || state.request?.material?.commit || 'HEAD', runChild);
    }
    const diffParts = { ...(await collectDiff(repoRoot, baseSha, runChild)), baseSha };

    const { config } = loadConfig({ env, flags, stderr });
    const findCheckpoint = await readCheckpoint(runDir, 'find');
    const findings = state.result?.raw?.findings || state.result?.findings || findCheckpoint?.findings || [];

    // The call-file round counts record files, so a judge-dead retry never overwrites a call file.
    const round = await nextRound(runDir, 'verify');
    const runAgent = createClosingAgent({ config, env, runDir, repoRoot, round });
    const res = await runVerify({
      state: { ...state, ruling, findings },
      diffParts,
      recollect: () => collectDiff(repoRoot, baseSha, runChild),
      runAgent,
      records,
    });

    let recordPath = null;
    if (res.record) {
      recordPath = await writeIndexed(runDir, 'verify', res.record);
      await appendEvent(runDir, { event: 'stage_end', stage: 'VERIFY', round: res.record.round, verdict: res.verdict });
    }

    if (flags.json) {
      stdout.write(JSON.stringify({ ...(res.record || {}), verdict: res.verdict, exitCode: res.exitCode, message: res.message, recordPath }, null, 2) + '\n');
    } else {
      stdout.write(`Verdict: ${res.verdict}\n${res.message}\n`);
      if (recordPath) stdout.write(`Saved to: ${recordPath}\n`);
    }

    if (res.exitCode === 3) {
      throw new RunError(res.record?.error || 'Judge failed during verify', 'judge-dead');
    }
    return res.exitCode;
  } finally {
    await lock.release();
  }
}
