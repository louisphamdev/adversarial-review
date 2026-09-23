// CLI patch-review and verify commands (§18.1, §6.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertRunDir, readState, readCheckpoint, writeIndexed } from '../rundir.mjs';
import { acquireLock } from '../lockfile.mjs';
import { runPatchReview, runVerify } from '../pipeline.mjs';
import { runSeatCall } from '../backends/index.mjs';
import { loadConfig } from '../config.mjs';
import { runChild } from '../proc.mjs';
import { normalizeDiff } from '../material.mjs';
import { ConfigError, RunError } from '../errors.mjs';

function createClosingAgent({ config, env, runDir, repoRoot }) {
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

  let planText;
  try {
    planText = await fs.readFile(flags.plan, 'utf8');
    if (!planText.trim()) {
      throw new ConfigError(`Plan file "${flags.plan}" is empty`);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Cannot read plan file "${flags.plan}": ${err.message}`);
  }

  const lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });

  try {
    const state = await readState(runDir);
    const rulingCheckpoint = await readCheckpoint(runDir, 'ruling');
    const ruling = state.result?.ruling || rulingCheckpoint;
    if (!ruling) {
      throw new ConfigError('Run directory has no RULING. Cannot perform patch review before ruling.');
    }

    const { config } = loadConfig({ env, flags, stderr });
    const repoRoot = state.request?.repoRoot || cwd;

    const runAgent = createClosingAgent({ config, env, runDir, repoRoot });
    const res = await runPatchReview({
      state: { ...state, ruling },
      plan: planText,
      runAgent,
    });

    const recordPath = await writeIndexed(runDir, 'patch-review', res.record);

    if (flags.json) {
      stdout.write(JSON.stringify({ decision: res.decision, recordPath, ...res.record }, null, 2) + '\n');
    } else {
      stdout.write(`Decision: ${res.decision}\nSaved to: ${recordPath}\n`);
    }

    if (res.exitCode === 3) {
      throw new RunError(res.record?.error || 'Judge failed during patch review', 'judge-dead');
    }

    return res.decision === 'APPLY' ? 0 : 1;
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

  const lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });

  try {
    const state = await readState(runDir);
    const rulingCheckpoint = await readCheckpoint(runDir, 'ruling');
    const ruling = state.result?.ruling || rulingCheckpoint;
    if (!ruling) {
      throw new ConfigError('Run directory has no RULING. Cannot verify before ruling.');
    }

    const repoRoot = state.request?.repoRoot || cwd;
    const baseRef = flags.base || 'HEAD';

    const diffRes = await runChild({
      cmd: 'git',
      args: ['diff', '--no-color', baseRef],
      cwd: repoRoot,
    });
    if (diffRes.code !== 0) {
      throw new ConfigError(`git diff failed: ${diffRes.stderr || 'exit ' + diffRes.code}`);
    }

    const normDiff = normalizeDiff(diffRes.stdout);
    if (!normDiff.trim()) {
      throw new ConfigError('Empty diff: nothing to verify');
    }

    const { config } = loadConfig({ env, flags, stderr });
    const findCheckpoint = await readCheckpoint(runDir, 'find');
    const findings = state.result?.raw?.findings || state.result?.findings || findCheckpoint?.findings || [];

    const runAgent = createClosingAgent({ config, env, runDir, repoRoot });
    const res = await runVerify({
      state: { ...state, ruling, findings },
      diff: normDiff,
      runAgent,
    });

    const recordPath = await writeIndexed(runDir, 'verify', res.record);

    if (flags.json) {
      stdout.write(JSON.stringify({ verdict: res.verdict, recordPath, ...res.record }, null, 2) + '\n');
    } else {
      stdout.write(`Verdict: ${res.verdict}\nSaved to: ${recordPath}\n`);
    }

    if (res.exitCode === 3) {
      throw new RunError(res.record?.error || 'Judge failed during verify', 'judge-dead');
    }

    return res.verdict === 'PASS' ? 0 : 1;
  } finally {
    await lock.release();
  }
}
