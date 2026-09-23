// CLI status command (§9.2, §18.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertRunDir, readState } from '../rundir.mjs';
import { runsDir, canonicalPath } from '../paths.mjs';
import { runChild } from '../proc.mjs';
import { ConfigError } from '../errors.mjs';

async function findLatestRun(env, cwd) {
  let root = cwd;
  try {
    const gitRes = await runChild({
      cmd: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd,
    });
    if (gitRes.code === 0 && gitRes.stdout.trim()) {
      root = canonicalPath(gitRes.stdout.trim());
    }
  } catch {
    // fallback to cwd
  }

  const base = runsDir(env, root);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(`No runs found under ${base}`);
    }
    throw err;
  }

  const runDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  if (runDirs.length === 0) {
    throw new ConfigError(`No runs found in ${base}`);
  }

  return path.join(base, runDirs[0]);
}

export async function statusCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  let targetDir = null;

  if (flags.latest) {
    targetDir = await findLatestRun(env, cwd);
  } else if (positionals.length > 0) {
    targetDir = positionals[0];
  } else {
    throw new ConfigError('Run directory path or --latest flag is required');
  }

  const runDir = assertRunDir(env, targetDir);

  try {
    const st = await fs.stat(runDir);
    if (!st.isDirectory()) {
      throw new ConfigError(`Path is not a directory: ${runDir}`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(`Run directory does not exist: ${runDir}`);
    }
    throw err;
  }

  const state = await readState(runDir);

  const callsMap = new Map();
  for (const ev of state.events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const cid = ev.callId || `${ev.stage || ''}-${ev.seat || ''}`;
    if (ev.event === 'call_start') {
      callsMap.set(cid, {
        callId: cid,
        seat: ev.seat,
        stage: ev.stage,
        status: state.ownerAlive ? 'running' : 'orphaned',
      });
    } else if (ev.event === 'call_end') {
      const existing = callsMap.get(cid) || { callId: cid, seat: ev.seat, stage: ev.stage };
      existing.status = ev.ok === false ? 'dead' : 'done';
      callsMap.set(cid, existing);
    } else if (ev.event === 'seat_dead') {
      const existing = callsMap.get(cid) || { callId: cid, seat: ev.seat, stage: ev.stage };
      existing.status = 'dead';
      callsMap.set(cid, existing);
    }
  }

  const calls = Array.from(callsMap.values());
  const finished = Boolean(state.result);
  const verdict = state.result?.gateVerdict || null;
  const exitCode = state.result?.exitCode ?? null;

  let currentStage = 'unknown';
  if (finished) {
    currentStage = 'finished';
  } else if (state.checkpoints?.length > 0) {
    currentStage = state.checkpoints[state.checkpoints.length - 1];
  } else if (calls.length > 0) {
    currentStage = calls[calls.length - 1].stage;
  }

  const owner = state.ownerAlive ? 'alive' : 'dead';
  let next = null;
  if (!finished) {
    if (!state.ownerAlive) {
      next = `run --resume "${runDir}"`;
    } else {
      next = 'wait for completion or inspect events.jsonl';
    }
  }

  const payload = {
    runDir,
    stage: currentStage,
    finished,
    verdict,
    exitCode,
    owner,
    calls,
    checkpoints: state.checkpoints,
    next,
  };

  if (flags.json) {
    stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    stdout.write(`Run: ${runDir}\n`);
    stdout.write(`Stage: ${currentStage}\n`);
    stdout.write(`Owner: ${owner}\n`);
    if (verdict) {
      stdout.write(`Verdict: ${verdict} (exit code ${exitCode})\n`);
    }
    if (calls.length > 0) {
      stdout.write('Calls:\n');
      for (const c of calls) {
        stdout.write(`  - ${c.callId} [${c.stage}]: ${c.status}\n`);
      }
    }
    if (next) {
      stdout.write(`Next: ${next}\n`);
    }
  }

  return 0;
}
