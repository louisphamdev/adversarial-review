// CLI run command, runner orchestration, resume, detach, and signal handling (§9, §18.1, §19).
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadConfig } from '../config.mjs';
import { resolveMaterial, hashMaterial } from '../material.mjs';
import { resolveSeats } from '../seats.mjs';
import { readQuota } from '../quota.mjs';
import { decideRoute } from '../route.mjs';
import { resolveBackend, runSeatCall } from '../backends/index.mjs';
import { pick, discover, readStore, loadPrior } from '../catalog.mjs';
import { resolveExecutable, installSignalHandlers } from '../proc.mjs';
import {
  assertRunDir,
  createRun,
  writeMaterial,
  appendEvent,
  writeCheckpoint,
  readCheckpoint,
  writeResult,
  readState,
} from '../rundir.mjs';
import { acquireLock, readLock } from '../lockfile.mjs';
import { runTable, normalizeId } from '../pipeline.mjs';
import { siftFindings } from '../sift.mjs';
import { stateDir, isInside } from '../paths.mjs';
import { SCHEMA_VERSION, ENGINE_VERSION } from '../version.mjs';
import { ConfigError, RunError } from '../errors.mjs';

class StopUntilFindError extends Error {
  constructor() {
    super('STOP_UNTIL_FIND');
    this.name = 'StopUntilFindError';
  }
}

function makeSemaphore(max) {
  let running = 0;
  const queue = [];
  return async function acquire() {
    if (running < max) {
      running++;
      return () => {
        running--;
        if (queue.length > 0) {
          const next = queue.shift();
          running++;
          next();
        }
      };
    }
    return new Promise((resolve) => {
      queue.push(() => {
        resolve(() => {
          running--;
          if (queue.length > 0) {
            const next = queue.shift();
            running++;
            next();
          }
        });
      });
    });
  };
}

export async function runCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  // -------------------------------------------------------------------------
  // Branch A: --resume <dir>
  // -------------------------------------------------------------------------
  if (flags.resume) {
    const allowed = new Set(['resume', 'until', 'allow-drift', 'allowDrift', 'json']);
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) {
        throw new ConfigError(`Flag "--${key}" is not allowed with --resume.`);
      }
    }

    const runDir = assertRunDir(env, flags.resume);

    try {
      const st = await fs.stat(runDir);
      if (!st.isDirectory()) {
        throw new ConfigError(`Run directory does not exist: ${runDir}`);
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new ConfigError(`Run directory does not exist: ${runDir}`);
      }
      throw err;
    }

    // First action on resume: acquire lock
    const lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });
    installSignalHandlers(async () => {
      await lock.release();
    });

    try {
      const state = await readState(runDir);

      // Finished run: print stored result and exit
      if (state.result) {
        if (flags.json) {
          stdout.write(JSON.stringify(state.result, null, 2) + '\n');
        } else {
          stdout.write(`Run finished: ${state.result.gateVerdict} (exit code ${state.result.exitCode})\n`);
        }
        return state.result.exitCode;
      }

      const req = state.request;
      if (!req) {
        throw new ConfigError('Corrupted run: missing request.json');
      }

      if (req.schemaVersion !== SCHEMA_VERSION) {
        throw new ConfigError(
          `schemaVersion mismatch: run has ${req.schemaVersion}, engine requires ${SCHEMA_VERSION}`
        );
      }

      // Check material drift
      let driftOk = Boolean(flags.allowDrift || flags['allow-drift'] || req.allowDrift);
      try {
        const currentHash = await hashMaterial(req.material || {
          kind: req.materialKind,
          path: req.materialPath,
          targetPath: req.target,
          root: req.repoRoot,
          base: req.base,
        });
        if (currentHash !== req.materialHash && !driftOk) {
          throw new ConfigError(
            'Review material has drifted since the run was created. Re-run with --allow-drift to proceed.'
          );
        }
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        // Ignore material recomputation if material file is snapshot in runDir
      }

      const { config } = loadConfig({ env, repoRoot: req.repoRoot, flags, stderr });
      return await executePipeline({
        runDir,
        request: req,
        flags,
        config,
        env,
        lock,
        stdout,
        stderr,
      });
    } finally {
      await lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Branch B: normal start or --detach
  // -------------------------------------------------------------------------
  const stageName = flags.stage || 'code';
  let material;
  try {
    material = await resolveMaterial({
      target: flags.target,
      base: flags.base,
      cwd,
    });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to resolve material: ${err.message}`);
  }

  const { config, warnings: configWarnings } = loadConfig({
    env,
    repoRoot: material.root,
    flags,
    stderr,
  });

  const { chosen, noSeat, warnings: seatWarnings } = resolveSeats({
    stage: stageName,
    seatsFlag: flags.seats,
    projectSeats: config.projectSeats,
  });

  for (const w of [...configWarnings, ...seatWarnings]) {
    if (stderr?.write) stderr.write(`Warning: ${w}\n`);
  }

  const hostBackend = config.hostBackend || 'claude';
  const swarmBackend = config.swarm?.backend || 'opencode';

  let hostBackendObj = null;
  try {
    hostBackendObj = await resolveBackend(hostBackend, { config, env });
  } catch {
    hostBackendObj = null;
  }

  let swarmBackendObj = null;
  try {
    swarmBackendObj = await resolveBackend(swarmBackend, { config, env });
  } catch {
    swarmBackendObj = null;
  }

  const effectiveRoute = flags.route || config.route || 'auto';
  let quota = { percent: null };
  let pickedSwarm = null;

  if (effectiveRoute === 'auto' || effectiveRoute === 'swarm') {
    quota = await readQuota({
      config,
      env,
      stateDir: stateDir(env),
    });

    if (swarmBackendObj) {
      try {
        const candidates = await discover(swarmBackend, { config, env });
        const store = await readStore(stateDir(env));
        const prior = await loadPrior({ stateDir: stateDir(env) });
        pickedSwarm = await pick({
          candidates,
          store,
          prior,
          route: effectiveRoute,
          allowFree: config.swarm?.allowFree,
        });
      } catch {
        pickedSwarm = null;
      }
    }
  }

  const swarm = {
    available: Boolean(swarmBackendObj),
    detail: swarmBackendObj ? '' : 'backend not found on PATH',
    model: pickedSwarm?.model || null,
    free: pickedSwarm?.free ?? false,
    tier: pickedSwarm?.tier ?? 'standard',
  };

  const host = { available: Boolean(hostBackendObj) };
  const routeDecision = decideRoute({
    config,
    flags,
    material,
    quota,
    host,
    swarm,
  });

  let requirementsText = '';
  if (config.requirementsFile) {
    try {
      const reqPath = path.resolve(material.root, config.requirementsFile);
      if (!isInside(reqPath, material.root)) {
        stderr.write(
          `warning: requirementsFile "${config.requirementsFile}" ignored: resolves outside repository root\n`
        );
      } else {
        requirementsText = await fs.readFile(reqPath, 'utf8');
      }
    } catch {}
  }
  if (flags['requirements-file'] || flags.requirementsFile) {
    try {
      const reqPath = path.resolve(cwd, flags['requirements-file'] || flags.requirementsFile);
      requirementsText = await fs.readFile(reqPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read requirements file: ${err.message}`);
    }
  }

  const request = {
    target: material.targetPath || null,
    base: material.base || 'HEAD',
    stage: stageName,
    seats: chosen.map((s) => s.key),
    noSeat,
    budget: config.budget,
    requirements: requirementsText,
    allowGaps: Boolean(flags['allow-gaps'] || flags.allowGaps),
    allowDrift: Boolean(flags['allow-drift'] || flags.allowDrift),
    route: routeDecision,
    backend: hostBackend,
    swarmBackend,
    swarmModel: pickedSwarm?.model || null,
    materialHash: material.hash,
    materialKind: material.kind,
    repoRoot: material.root,
    material: {
      kind: material.kind,
      path: material.path,
      targetPath: material.targetPath,
      root: material.root,
      base: material.base,
      commit: material.commit,
      text: material.text,
    },
  };

  const { runDir, runId } = await createRun({
    env,
    root: material.root,
    request,
    mkdir: async (dir) => {
      await fs.mkdir(dir);
      request.runId = path.basename(dir);
      request.materialPath =
        material.kind === 'diff'
          ? path.join(dir, 'material.diff')
          : material.kind === 'file'
            ? path.join(dir, 'material.txt')
            : material.path;
    },
  });
  request.runId = runId;
  request.materialPath =
    material.kind === 'diff'
      ? path.join(runDir, 'material.diff')
      : material.kind === 'file'
        ? path.join(runDir, 'material.txt')
        : material.path;

  await writeMaterial(runDir, material);

  // -------------------------------------------------------------------------
  // Detach mode: spawn detached resume worker and wait <= 10s for lock
  // -------------------------------------------------------------------------
  if (flags.detach) {
    const logPath = path.join(runDir, 'worker.log');
    const fd = fsSync.openSync(logPath, 'a');
    const scriptPath = fileURLToPath(new URL('../../adversarial-review.mjs', import.meta.url));

    const child = spawn(process.execPath, [scriptPath, 'run', '--resume', runDir], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    child.unref();
    fsSync.closeSync(fd);

    const startWait = Date.now();
    let locked = false;
    while (Date.now() - startWait < 10000) {
      const currentLock = await readLock(path.join(runDir, 'lock'));
      if (currentLock && currentLock.pid) {
        locked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!locked) {
      let logTail = '';
      try {
        logTail = await fs.readFile(logPath, 'utf8');
      } catch {}
      stderr.write(`Detached run failed to take lock within 10s:\n${logTail}\n`);
      return 3;
    }

    stdout.write(`${runDir}\n`);
    return 0;
  }

  // Direct run mode
  const lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });
  installSignalHandlers(async () => {
    await lock.release();
  });

  try {
    return await executePipeline({
      runDir,
      request,
      flags,
      config,
      env,
      lock,
      stdout,
      stderr,
    });
  } finally {
    await lock.release();
  }
}

async function executePipeline({ runDir, request, flags, config, env, lock, stdout, stderr }) {
  const maxParallel = typeof config.maxParallel === 'number' ? config.maxParallel : 4;
  const semaphoreAcquire = makeSemaphore(maxParallel);

  const routeDecision = request.route || { stages: {} };
  const stagesRoute = routeDecision.stages || {};

  const hostBackend = request.backend || config.hostBackend || 'claude';
  const swarmBackend = request.swarmBackend || config.swarm?.backend || 'opencode';

  const usedModels = {};

  const runAgent = async ({ stage, seat, prompt, schema, callId: explicitCallId, findingId }) => {
    const release = await semaphoreAcquire();
    const stgKey = stage.toLowerCase();
    const target = resolveStageTarget({
      stage,
      seat,
      stagesRoute,
      hostBackend,
      swarmBackend,
      config,
      swarmModel: request.swarmModel || routeDecision.swarmModel || null,
    });
    const backendName = target.backend;
    const model = target.model;
    const effort = target.effort;
    usedModels[target.routeKey] = model ? `${backendName}:${model}` : backendName;

    let timeoutMs = config.timeouts?.other || 600000;
    if (stgKey === 'find') timeoutMs = config.timeouts?.find || 1200000;
    if (stgKey === 'ruling') timeoutMs = config.timeouts?.ruling || 900000;

    const callId = explicitCallId
      ? explicitCallId
      : (stgKey === 'dispute' && findingId
        ? `dispute-${seat.key}-${normalizeId(findingId)}`
        : `${stgKey}-${seat.key}`);

    await appendEvent(runDir, {
      event: 'call_start',
      stage,
      seat: seat.key,
      callId,
      ts: Date.now(),
    });

    try {
      const res = await runSeatCall(
        {
          callId,
          prompt,
          schema,
          root: request.repoRoot,
          runDir,
          cwd: path.join(runDir, 'cwd'),
          model,
          effort,
          timeoutMs,
        },
        {
          backend: backendName,
          config,
          env,
        }
      );

      await appendEvent(runDir, {
        event: res.ok ? 'call_end' : 'seat_dead',
        stage,
        seat: seat.key,
        callId,
        ok: res.ok,
        error: res.error,
        ts: Date.now(),
      });

      return res;
    } finally {
      release();
    }
  };

  const until = flags.until || request.until || null;

  let loadedSift = await readCheckpoint(runDir, 'sift');

  const siftObj = {
    loaded: loadedSift,
    start: async (findings) => {
      const res = await siftFindings({
        material: {
          kind: request.materialKind,
          text: request.material?.text,
        },
        findings,
        config,
        env,
      });
      await writeCheckpoint(runDir, 'sift', res);
      return res;
    },
  };

  let pipelineResult;
  try {
    pipelineResult = await runTable({
      request,
      seats: request.seats,
      runAgent,
      loadCheckpoint: async (name) => await readCheckpoint(runDir, name),
      checkpoint: async (name, data) => {
        await writeCheckpoint(runDir, name, data);
        if (name === 'find' && until === 'find') {
          throw new StopUntilFindError();
        }
      },
      sift: siftObj,
    });
  } catch (err) {
    if (err instanceof StopUntilFindError) {
      if (flags.json) {
        stdout.write(JSON.stringify({ runDir, stage: 'find', status: 'stopped_until' }, null, 2) + '\n');
      } else {
        stdout.write(`FIND stage complete. Run stopped at --until find.\nTo resume: adversarial-review run --resume "${runDir}"\n`);
      }
      return 0;
    }
    throw err;
  }

  const finalResult = {
    runId: request.runId,
    target: request.target,
    stage: request.stage,
    route: {
      route: routeDecision.route || 'spawn',
      reason: routeDecision.reason || 'default',
      stages: resolveStagesForReport(stagesRoute, hostBackend, swarmBackend),
      models: usedModels,
    },
    gateVerdict: pipelineResult.gateVerdict,
    exitCode: pipelineResult.exitCode,
    blockingCount: pipelineResult.blockingCount || 0,
    allowGaps: Boolean(request.allowGaps),
    allowDrift: Boolean(request.allowDrift),
    gaps: pipelineResult.gaps || { noSeat: [], deadSeats: [], notRead: [] },
    raw: {
      findings: pipelineResult.findings || [],
      disputes: pipelineResult.disputes || [],
      seams: pipelineResult.seams || [],
      fixRisks: pipelineResult.fixRisks || [],
      lastCall: pipelineResult.lastCall || [],
    },
    ruling: pipelineResult.ruling,
    sift: pipelineResult.sift,
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  await writeResult(runDir, finalResult);

  if (flags.json) {
    stdout.write(JSON.stringify(finalResult, null, 2) + '\n');
  } else {
    stdout.write(`Verdict: ${finalResult.gateVerdict}\n`);
    stdout.write(`Exit Code: ${finalResult.exitCode}\n`);
    stdout.write(`Blocking count: ${finalResult.blockingCount}\n`);
    if (finalResult.gaps.deadSeats.length > 0) {
      stdout.write(`Dead seats: ${finalResult.gaps.deadSeats.map((d) => `${d.seat} (${d.stage})`).join(', ')}\n`);
    }
  }

  return finalResult.exitCode;
}

const TIER_MODEL = { strong: 'opus', standard: 'sonnet', light: 'haiku' };
const TIER_EFFORT = { strong: 'high', standard: 'medium', light: 'low' };
const ROUTE_KEYS = {
  PATCH_SEAT: 'patchSeats', PATCH_JUDGE: 'patchJudge', VERIFY_SEAT: 'verifySeats', VERIFY_JUDGE: 'verifyJudge',
};

// Pipeline stage names and route-table keys differ; a raw lower-casing sent patch and verify to the host.
export function routeKeyOf(stage) {
  return ROUTE_KEYS[stage] || stage.toLowerCase();
}

export function resolveStageTarget({ stage, seat, stagesRoute, hostBackend, swarmBackend, config, swarmModel }) {
  const routeKey = routeKeyOf(stage);
  const isJudge = seat.key === 'judge' || stage === 'RULING' || stage.endsWith('_JUDGE');
  let backend = stagesRoute[routeKey] || 'host';
  if (backend === 'host') backend = hostBackend;
  if (backend === 'swarm') backend = swarmBackend;
  const configKey = stage === 'PATCH_JUDGE' || stage === 'VERIFY_JUDGE' ? 'ruling' : routeKey;
  let model = config.stages?.[configKey]?.model || null;
  if (!model && backend === 'claude') model = isJudge ? 'opus' : TIER_MODEL[seat.tier] || 'sonnet';
  if (!model && backend === swarmBackend && swarmModel) model = swarmModel;
  // opencode variant names differ per provider, so it gets an effort only from config.
  let effort = config.stages?.[configKey]?.effort;
  if (!effort && (backend === 'claude' || backend === 'codex')) effort = TIER_EFFORT[isJudge ? 'strong' : seat.tier];
  return effort ? { backend, model, routeKey, effort } : { backend, model, routeKey };
}

function resolveStagesForReport(stagesRoute, hostBackend, swarmBackend) {
  const out = {};
  for (const [k, v] of Object.entries(stagesRoute)) out[k] = v === 'host' ? hostBackend : v === 'swarm' ? swarmBackend : v;
  return out;
}
