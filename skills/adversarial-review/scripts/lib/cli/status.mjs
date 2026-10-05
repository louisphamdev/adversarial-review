// CLI status command (§9.2, §18.1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertRunDir, readState } from '../rundir.mjs';
import { runsDir, canonicalPath } from '../paths.mjs';
import { runChild } from '../proc.mjs';
import { ConfigError } from '../errors.mjs';
import { ownerState } from './watch.mjs';

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
  const owner = await ownerState(runDir);
  const ownerLive = owner === 'alive';

  const callsMap = new Map();
  const entryOf = (cid, ev) =>
    callsMap.get(cid) || { callId: cid, seat: ev.seat, stage: ev.stage, model: null, attempt: null, lastAt: null };
  for (const ev of state.events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const cid = ev.callId || `${ev.stage || ''}-${ev.seat || ''}`;
    if (ev.event === 'call_start') {
      const existing = entryOf(cid, ev);
      Object.assign(existing, {
        seat: ev.seat,
        stage: ev.stage,
        model: ev.model ?? null,
        attempt: ev.attempt ?? null,
        lastAt: ev.ts ?? null,
        status: ownerLive ? 'running' : 'orphaned',
      });
      callsMap.set(cid, existing);
    } else if (ev.event === 'seat_output') {
      const existing = callsMap.get(cid);
      if (existing) existing.lastAt = ev.lastOutputAt ?? ev.ts ?? existing.lastAt;
    } else if (ev.event === 'call_end' || ev.event === 'seat_done') {
      const existing = entryOf(cid, ev);
      existing.status = ev.event === 'call_end' && ev.ok === false ? 'dead' : 'done';
      callsMap.set(cid, existing);
    } else if (ev.event === 'seat_dead') {
      const existing = entryOf(cid, ev);
      existing.status = 'dead';
      callsMap.set(cid, existing);
    }
  }

  const nowMs = Date.now();
  const calls = Array.from(callsMap.values()).map(({ lastAt, ...c }) => ({
    ...c,
    idleFor: c.status === 'running' && typeof lastAt === 'number' ? Math.round((nowMs - lastAt) / 1000) : null,
  }));
  const finished = Boolean(state.result);
  const verdict = state.result?.gateVerdict || null;
  const exitCode = state.result?.exitCode ?? null;

  // A per-seat FIND file is part of the FIND stage, not a stage of its own.
  const stageCheckpoints = (state.checkpoints || []).filter((n) => !n.startsWith('find-seat-'));
  let currentStage = 'unknown';
  if (finished) {
    currentStage = 'finished';
  } else if (stageCheckpoints.length > 0) {
    currentStage = stageCheckpoints[stageCheckpoints.length - 1];
  } else if (calls.length > 0) {
    currentStage = calls[calls.length - 1].stage;
  }

  let next = null;
  if (!finished) {
    if (owner === 'hung') {
      next = `the owner pid ${state.lock?.pid} is alive but its lock is old; stop it before you resume`;
    } else if (!ownerLive) {
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
    eventCount: (state.events || []).length,
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
        const detail = [c.model, c.attempt ? `attempt ${c.attempt}` : null, c.idleFor !== null ? `idle ${c.idleFor} s` : null]
          .filter(Boolean)
          .join(', ');
        stdout.write(`  - ${c.callId} [${c.stage}]: ${c.status}${detail ? ` (${detail})` : ''}\n`);
      }
    }
    if (next) {
      stdout.write(`Next: ${next}\n`);
    }
  }

  return 0;
}
