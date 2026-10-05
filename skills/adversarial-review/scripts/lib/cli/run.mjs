// CLI run command, runner orchestration, resume, detach, and signal handling (§9, §18.1, §19).
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { loadConfig, resolveIdleMs } from '../config.mjs';
import { resolveMaterial, hashMaterial } from '../material.mjs';
import { resolveSeats, loadSeats } from '../seats.mjs';
import { readQuota } from '../quota.mjs';
import { decideRoute, STAGE_NAMES } from '../route.mjs';
import { resolveBackend, runSeatCall } from '../backends/index.mjs';
import {
  LENSES,
  LENS_DIR,
  assignSeats,
  buildPool,
  cleanNamed,
  discover,
  loadPrior,
  probe,
  readStore,
  research,
  storableProbe,
  storeLensTiers,
  updateStore,
} from '../catalog.mjs';
import { makeBenchCallFor } from './models.mjs';
import { killAllTrackedSync } from '../proc.mjs';
import { acquireLockWithCleanup, installCleanupHandler, setActiveRunDir } from '../cleanup.mjs';
import { createLanePool, readMachine, laneCap, laneProvider, laneOutcome } from '../lanes.mjs';
import { compareBaseline, hashRepo, readIntegrity, writeIntegrity } from '../integrity.mjs';
import {
  PROFILE_STEPS,
  createSandbox,
  hasGlobChars,
  removeSandbox,
  writeNamedConfig,
  writeProfileConfig,
} from '../sandbox.mjs';
import { buildContextPack } from '../pack.mjs';
import { laneToolsFor, makeLaneCall } from '../lane.mjs';
import { runCanary } from '../canary.mjs';
import { PROBE } from '../schemas.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import {
  assertRunDir,
  createRun,
  writeMaterial,
  appendEvent,
  repairEvents,
  replayMissingEvents,
  writeCheckpoint,
  readCheckpoint,
  writeSeatCheckpoint,
  readSeatCheckpoint,
  writeResult,
  readState,
} from '../rundir.mjs';
import { findingEvent } from '../contain.mjs';
import { computeDataLeaves, hostJudge, seatEntries } from '../bundle.mjs';
import { acquireLock, readLock } from '../lockfile.mjs';
import { runTable, normalizeId } from '../pipeline.mjs';
import { siftFindings } from '../sift.mjs';
import { stateDir, isInside, homeDir } from '../paths.mjs';
import { SCHEMA_VERSION, ENGINE_VERSION } from '../version.mjs';
import { ConfigError, RunError } from '../errors.mjs';

class StopUntilFindError extends Error {
  constructor() {
    super('STOP_UNTIL_FIND');
    this.name = 'StopUntilFindError';
  }
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
    const allowed = new Set([
      'resume',
      'until',
      'allow-drift',
      'allowDrift',
      'json',
      // Read from the current command line only: it must never be inherited from the request.
      'allow-repo-change',
      'allowRepoChange',
    ]);
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
    const lock = await acquireLockWithCleanup(runDir, { stderr });

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

      // The baseline comes before the drift check: a lost baseline is the one state that makes
      // the whole resume unsafe, and a drift error would hide it.
      const integrity = await readIntegrity(runDir);
      if (req.integrity?.baselineWritten && (integrity.error === 'missing' || integrity.error === 'corrupt')) {
        throw new ConfigError('integrity baseline is missing or unreadable; this run cannot resume safely');
      }

      const sandboxDir = path.join(runDir, 'sandbox');
      const keptSandbox = Boolean(integrity.state?.keepSandbox || integrity.state?.integrityChanged);
      let sandboxExists = false;
      try {
        sandboxExists = (await fs.stat(sandboxDir)).isDirectory();
      } catch {
        sandboxExists = false;
      }
      if (sandboxExists) {
        if (keptSandbox || !integrity.state) {
          throw new ConfigError(
            `a sandbox tree from the earlier attempt is kept at ${sandboxDir}; move or delete it before this run resumes`
          );
        }
        await fs.rm(sandboxDir, { recursive: true, force: true });
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

      // A request from before the part D contract carries no lane tool list and no judge
      // assignment. Filling them here is what lets an older run finish under this engine.
      let requestChanged = false;
      const hostOf = req.backend || config.hostBackend || 'claude';
      if (!Array.isArray(req.lane?.tools) || req.lane.tools.length === 0) {
        req.lane = { tools: laneToolsFor({ finderRoutesToSwarm: req.route?.stages?.find === 'swarm', hostBackend: hostOf }) };
        requestChanged = true;
      }
      if (req.route?.seatModels && !req.route.seatModels.judge) {
        req.route.seatModels.judge = { backend: 'host', capability: 'strong' };
        requestChanged = true;
      }
      // Without a seat assignment there is no swarm model to call, so the resume is spawn-only.
      if (!req.route?.seatModels || Object.keys(req.route.seatModels).filter((k) => k !== 'judge').length === 0) {
        req.route = { ...(req.route || {}), stages: spawnStages(req.route?.stages) };
        requestChanged = true;
      }
      if (requestChanged) {
        await writeFileAtomic(path.join(runDir, 'request.json'), JSON.stringify(req, null, 2) + '\n');
      }

      // The sandbox tree is deleted when a run ends, so a resumed swarm run rebuilds it. The
      // seat models and the canary verdict were decided by the first attempt and are not redone.
      const resumeHooks = path.join(runDir, 'empty-hooks');
      await fs.mkdir(resumeHooks, { recursive: true });
      let resumeSandbox = null;
      let resumePack;
      if (Object.keys(req.route?.seatModels || {}).some((k) => k !== 'judge')) {
        resumeSandbox = await createSandbox({ repoRoot: req.repoRoot, runDir, material: req.material, config });
        if (resumeSandbox.overCap) {
          throw new ConfigError(
            `the sandbox tree is over the cap (${resumeSandbox.overCap.files} files, ${resumeSandbox.overCap.bytes} bytes); this run cannot resume on the swarm`
          );
        }
        const pack = await buildContextPack({
          material: req.material,
          treeDir: resumeSandbox.treeDir,
          repoRoot: req.repoRoot,
          packChars: config.swarm?.packChars ?? 60000,
        });
        resumePack = await fs.readFile(pack.path, 'utf8');
      }

      return await executePipeline({
        runDir,
        request: req,
        flags,
        config,
        env,
        lock,
        stdout,
        stderr,
        baseline: integrity.baseline,
        hooksDir: resumeHooks,
        integrityState: integrity.state || { keepSandbox: false, integrityChanged: false },
        sandbox: resumeSandbox,
        packText: resumePack,
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

  const { chosen, noSeat, warnings: seatWarnings, stage: resolvedStage } = resolveSeats({
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
  if (effectiveRoute === 'auto' || effectiveRoute === 'swarm') {
    quota = await readQuota({ config, env, stateDir: stateDir(env) });
  }

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

  // Step 1 of the section 10 G2-2 order. Discovery and the pool run whatever the route is, and
  // they need no run directory, so a spawn run still records why the swarm was unreachable
  // (G2-10). Nothing here calls a model.
  const discovered = await discoverPool({ config, env, flags, swarmBackend, swarmBackendObj });

  const request = {
    // createRun stamps these too, but the run rewrites request.json after the route is decided,
    // and a rewrite without them makes every later resume fail the schema check.
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    target: material.targetPath || null,
    base: material.base || 'HEAD',
    stage: resolvedStage,
    seats: chosen.map((s) => s.key),
    noSeat,
    budget: config.budget,
    requirements: requirementsText,
    allowGaps: Boolean(flags['allow-gaps'] || flags.allowGaps),
    allowDrift: Boolean(flags['allow-drift'] || flags.allowDrift),
    route: null,
    backend: hostBackend,
    swarmBackend,
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
  setActiveRunDir(runDir);

  // The handler goes in HERE, not at the lock below: the probe and the canary open lanes first,
  // so a Ctrl-C during them is the most likely signal of the whole run. `acquireLockWithCleanup`
  // cannot be used at that lock, because `installSignalHandlers` keeps the first handler it is
  // given and a second install would never receive the lock.
  const lockHolder = { lock: null };
  installCleanupHandler({ stderr, lockHolder });

  // -------------------------------------------------------------------------
  // Step 2 of the G2-2 order: the integrity baseline, which needs runDir. The route and the
  // lane contract follow it.
  // -------------------------------------------------------------------------
  const hooksDir = path.join(runDir, 'empty-hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const keepSandbox = Boolean(flags['keep-sandbox']);
  const baseline = await hashRepo(material.root, { hooksDir });
  await writeIntegrity(runDir, { baseline, state: { keepSandbox, integrityChanged: false } });
  request.integrity = { baselineWritten: true };

  // Steps 3 to 6 of the G2-2 order. A spawn run and an empty pool both skip them, so no spawn
  // run builds a sandbox, writes a profile, or calls a model on the swarm.
  const prep = { ...emptyPrep(), notes: discovered.notes, pool: discovered.pool, discovery: discovered.discovery };
  if (prep.pool.length > 0 && effectiveRoute !== 'spawn') {
    await prepareSwarmTree({
      runDir,
      material,
      config,
      env,
      swarmBackend,
      seats: chosen,
      prior: discovered.prior,
      named: discovered.named,
      out: prep,
    });
  }
  const notes = [...prep.notes];

  const host = { available: Boolean(hostBackendObj) };
  const swarmOf = (overrides = {}) => ({
    available: Object.keys(prep.seatModels).length > 0,
    detail: swarmBackendObj ? 'no seat has a swarm model' : 'backend not found on PATH',
    model: Object.values(prep.seatModels)[0]?.model || null,
    free: prep.pool.some((p) => p.free),
    tier: Object.values(prep.seatModels)[0]?.lensTier || 'unmeasured',
    ...overrides,
  });

  let routeDecision = decideRoute({ config, flags, material, quota, host, swarm: swarmOf() });
  let canary = null;

  // The approval gate (spec G2-4). It sits before the canary because the canary lane is the first
  // call that runs over the material; the probe and the bench read no material.
  const dataLeaves = computeDataLeaves(
    usesSwarm(routeDecision) ? prep.seatModels : {},
    hostJudge(hostBackend),
    config.sift?.enabled !== false
  );
  const training = dataLeaves.filter((r) => r.trains).map((r) => r.provider);
  if (training.length > 0 && config.swarm?.acknowledgeTraining !== true) {
    // Nothing of this run reached a seat, so the run directory goes with the refusal.
    setActiveRunDir(null);
    await fs.rm(runDir, { recursive: true, force: true });
    throw new ConfigError(
      `answer the decisions first: run preflight (a provider can train on the material: ${training.join(', ')})`
    );
  }
  request.approval = { source: 'config', dataLeaves };

  if (usesSwarm(routeDecision) && prep.sandbox) {
    const profiles = [];
    for (const profileKey of ['weak-find', 'strong-find', 'short', 'canary']) {
      const { cwd, xdgHome } = await writeProfileConfig({
        runDir,
        profileKey,
        treeDir: prep.sandbox.treeDir,
        steps: PROFILE_STEPS[profileKey],
      });
      profiles.push({ profileKey, cwd, xdgHome, mode: 'zen' });
    }
    const ranked = [...prep.pool]
      .sort((a, b) => latencyOf(prep.probeResults, a.model) - latencyOf(prep.probeResults, b.model))
      .map((p) => p.model);
    canary = await runCanary({
      runDir,
      repoRoot: material.root,
      treeDir: prep.sandbox.treeDir,
      profiles,
      models: ranked,
      laneCallFor: ({ cwd, mode, xdgHome, prompt }) =>
        makeLaneCall({ config, env, runDir, cwd, mode, xdgHome, stage: 'FIND', prompt, timeoutMs: 180000, callIdPrefix: 'canary', backend: swarmBackend }),
    });
    if (canary.result === 'failed') {
      // The run stops here, before the table, so nothing else cleans up after it. `keep` follows
      // the one flag the spec gives it; the integrity record cannot have changed yet. The note
      // goes straight to stderr, because the throw below skips the note loop.
      await removeSandbox(runDir, { keep: keepSandbox, log: (m) => stderr?.write?.(`note: ${m}\n`) });
      throw new RunError(
        `the lane boundary canary wrote outside its sandbox (profile ${canary.detail.profile}): ${(canary.detail.targetsFound || []).join(', ')}`,
        'canary-failed'
      );
    }
    if (canary.result === 'unverified') {
      const detail = `the canary could not verify the lane boundary (profile ${canary.detail.profile})`;
      if (effectiveRoute === 'swarm') throw new ConfigError(`${detail}; --route swarm cannot proceed`);
      notes.push(`${detail}; the route falls back to spawn`);
      routeDecision = decideRoute({
        config,
        flags,
        material,
        quota,
        host,
        swarm: swarmOf({ available: false, model: null, detail }),
      });
    }
  }

  const stagesRoute = routeDecision.stages || {};
  const swarmInUse = usesSwarm(routeDecision);
  if (!swarmInUse) {
    prep.seatModels = {};
    await removeSandbox(runDir, { keep: keepSandbox, log: (m) => notes.push(m) });
    prep.sandbox = null;
  }

  if (effectiveRoute === 'swarm' && Object.keys(prep.seatModels).length === 0) {
    throw new ConfigError(
      ['--route swarm has no callable swarm model.', ...notes].join('\n')
    );
  }

  for (const note of notes) {
    if (stderr?.write) stderr.write(`note: ${note}\n`);
  }
  if (swarmInUse && stderr?.write) {
    stderr.write(
      'note: the swarm provider can train on every file in the sandbox tree, untracked files of the material included\n'
    );
  }

  request.route = {
    ...routeDecision,
    seatModels: { ...prep.seatModels, judge: { backend: 'host', capability: 'strong' } },
    discovery: { ...prep.discovery, notes },
    research: prep.research,
    lanes: laneCap({ machine: readMachine(), config, callsReady: Math.max(1, chosen.length), provider: 'host' }),
    canary,
    sandbox: prep.sandbox
      ? { treeDir: prep.sandbox.treeDir, fileCount: prep.sandbox.fileCount, bytes: prep.sandbox.bytes, skippedSecrets: prep.sandbox.skippedSecrets }
      : null,
  };
  request.lane = { tools: laneToolsFor({ finderRoutesToSwarm: stagesRoute.find === 'swarm', hostBackend }) };
  await writeFileAtomic(path.join(runDir, 'request.json'), JSON.stringify(request, null, 2) + '\n');

  // -------------------------------------------------------------------------
  // Detach mode: spawn detached resume worker and wait <= 10s for lock
  // -------------------------------------------------------------------------
  if (flags.detach) {
    // The worker owns the run directory from here, and it rebuilds the sandbox under its own
    // lock. The parent must sweep only the processes it started itself, so it clears the run
    // directory. Every exit path below reads it when it fires, the signal handler included.
    setActiveRunDir(null);
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

  // Direct run mode. The exit handler is already installed above; this hands it the lock.
  lockHolder.lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });
  const lock = lockHolder.lock;

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
      baseline,
      hooksDir,
      integrityState: { keepSandbox, integrityChanged: false },
      sandbox: prep.sandbox,
      packText: prep.packText,
    });
  } finally {
    await lock.release();
  }
}

function emptyPrep() {
  return {
    notes: [],
    pool: [],
    sandbox: null,
    packText: undefined,
    seatModels: {},
    probeResults: {},
    research: {},
    discovery: { error: null, hint: null, priorAgeHours: null },
  };
}

const usesSwarm = (decision) => Object.values(decision?.stages || {}).includes('swarm');
const latencyOf = (results, model) => results?.[model]?.latencyMs ?? Number.MAX_SAFE_INTEGER;

const PROBE_PROMPT = 'Reply with one fenced JSON block and nothing else: {"ok":true}';

// How old the models.dev prior is. A null means no prior was read at all, which is not the same
// as a fresh one: with no prior, no discovered model can be proven free.
async function priorAgeHours(dir) {
  try {
    const st = await fs.stat(path.join(dir, 'cache', 'models-dev.json'));
    return Math.round(((Date.now() - st.mtimeMs) / 3600000) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Step 1 of the G2-2 order: discovery and the candidate pool. It reads the executable, the
 * models.dev prior, and the local store; it calls no model and it needs no run directory, so it
 * runs on every route and its notes reach `request.route.discovery.notes` whatever the route is.
 */
async function discoverPool({ config, env, flags, swarmBackend, swarmBackendObj }) {
  const notes = [];
  const disc = swarmBackendObj
    ? await discover(swarmBackend, { config, env })
    : { candidates: [], notes: ['opencode executable not found'] };
  notes.push(...(disc.notes || []));

  const prior = await loadPrior({ stateDir: stateDir(env) });
  const discovery = {
    error: disc.error ?? null,
    hint: disc.hint ?? null,
    priorAgeHours: await priorAgeHours(stateDir(env)),
  };
  const store = await readStore(stateDir(env));
  const named = cleanNamed(
    [...(flags.model ? [].concat(flags.model) : []), ...(config.swarm?.models || [])],
    disc.candidates
  );
  notes.push(...named.notes);
  const built = buildPool({ candidates: disc.candidates, prior, store, named: named.named, probeResults: {} });
  notes.push(...(built.notes || []));
  if (built.pool.length === 0) {
    notes.push('no model is both callable and free, and no model was named, so the swarm pool is empty');
  }
  return { notes, pool: built.pool, prior, named, discovery };
}

/**
 * Steps 3 to 6 of the G2-2 order: the sandbox tree, the context pack, the probe, research, and
 * the seat assignment. It writes into `out`, the accumulator that `discoverPool` filled, so every
 * step that can empty the pool records why and the route decision and the report read one list of
 * notes.
 */
async function prepareSwarmTree({ runDir, material, config, env, swarmBackend, seats, prior, named, out }) {
  const notes = out.notes;
  let pool = out.pool;

  // A permission resource cannot escape a glob character, so the boundary would be wider than
  // the tree it names. There is no safe sandbox on such a path.
  if (hasGlobChars(runDir)) {
    notes.push(`the run path holds a glob character, so the swarm is off: ${runDir}`);
    out.pool = [];
    return out;
  }

  const sandbox = await createSandbox({ repoRoot: material.root, runDir, material, config });
  if (sandbox.overCap) {
    notes.push(`the sandbox tree is over the cap (${sandbox.overCap.files} files, ${sandbox.overCap.bytes} bytes), so the swarm is off`);
    out.pool = [];
    return out;
  }
  out.sandbox = sandbox;
  if (sandbox.skippedSecrets > 0) notes.push(`${sandbox.skippedSecrets} secret-shaped files were left out of the sandbox tree`);

  const pack = await buildContextPack({
    material,
    treeDir: sandbox.treeDir,
    repoRoot: material.root,
    packChars: config.swarm?.packChars ?? 60000,
  });
  out.packText = await fs.readFile(pack.path, 'utf8');

  const { cwd: probeCwd, xdgHome: probeXdgHome } = await writeProfileConfig({
    runDir,
    profileKey: 'probe',
    treeDir: sandbox.treeDir,
    steps: PROFILE_STEPS.probe,
  });
  const probeLane = makeLaneCall({
    config,
    env,
    runDir,
    cwd: probeCwd,
    xdgHome: probeXdgHome,
    stage: 'FIND',
    schema: PROBE,
    prompt: PROBE_PROMPT,
    timeoutMs: 30000,
    callIdPrefix: 'probe',
    backend: swarmBackend,
  });
  const probeResults = await probe({ models: pool.map((p) => p.model), laneCall: probeLane, deadlineMs: 90000 });
  out.probeResults = probeResults;

  const storable = {};
  for (const [model, entry] of Object.entries(probeResults)) {
    if (storableProbe(entry)) storable[`${swarmBackend}:${model}`] = { backend: swarmBackend, ...entry };
  }
  if (Object.keys(storable).length > 0) await updateStore(stateDir(env), storable);

  for (const [model, entry] of Object.entries(probeResults)) {
    if (entry.errorType === 'provider-refused') notes.push(`model ${model} dropped: the provider refused the call`);
  }
  pool = pool.filter((p) => probeResults[p.model]?.errorType !== 'provider-refused');
  out.pool = pool;

  // A named model carries no lens score until something measures it, and an unmeasured seat
  // assignment is the one thing the seat ranking cannot repair.
  const lensSeats = seats.map((s) => s.key).filter((k) => LENSES.includes(k));
  if (lensSeats.length > 0) {
    // A bench lane reads a lens fixture, and it is still a lane: without a permission profile it
    // would inherit the user's own opencode permissions, which is the boundary A6 and A7 close.
    const benchCache = new Map();
    for (const lens of lensSeats) {
      const profile = await writeProfileConfig({
        runDir,
        profileKey: `bench-${lens}`,
        treeDir: path.join(LENS_DIR, lens),
        steps: PROFILE_STEPS.bench,
      });
      benchCache.set(`profile:bench-${lens}`, profile);
    }
    const benchCallFor = makeBenchCallFor({
      config,
      backend: swarmBackend,
      runSeatCall: async (call) => {
        const lens = path.basename(call.root);
        const lane = await laneForCall({
          runDir,
          treeDir: path.join(LENS_DIR, lens),
          stage: 'FIND',
          model: call.model,
          capability: 'weak',
          env,
          namedConfigs: benchCache,
          profileKey: `bench-${lens}`,
        });
        return runSeatCall(
          { ...call, root: lane.cwd, cwd: lane.cwd, lane },
          { backend: call.backend || swarmBackend, config, env }
        );
      },
    });
    for (const model of named.named) {
      if (!pool.some((p) => p.model === model)) continue;
      const entry = (await readStore(stateDir(env)))[`${swarmBackend}:${model}`] || {};
      if (lensSeats.every((lens) => entry.lenses?.[lens])) continue;
      const res = await research(model, {
        seats: lensSeats,
        prior,
        store: await readStore(stateDir(env)),
        deadlineMs: config.swarm?.researchDeadlineMs ?? 600000,
        probeLane,
        benchCallFor,
      });
      out.research[model] = { accepted: res.accepted, reasons: res.reasons, lenses: res.lenses };
      if (res.accepted) {
        await storeLensTiers(stateDir(env), {
          backend: swarmBackend,
          model,
          tiers: res.lenses,
          measured: res.benched,
          extra: storableProbe(res.probe) ? res.probe : {},
        });
      } else {
        notes.push(`named model ${model} rejected: ${res.reasons.join('; ')}`);
        pool = pool.filter((p) => p.model !== model);
        out.pool = pool;
      }
    }
  }

  out.seatModels = assignSeats({ seats, pool, store: await readStore(stateDir(env)) });
  if (Object.keys(out.seatModels).length === 0) notes.push('no seat could be assigned a swarm model');
  return out;
}

async function executePipeline({
  runDir,
  request,
  flags,
  config,
  env,
  lock,
  stdout,
  stderr,
  baseline = null,
  hooksDir,
  integrityState = { keepSandbox: false, integrityChanged: false },
  sandbox = null,
  packText,
}) {
  // The owner holds the lock here. The repair must come before the first append of this owner.
  await repairEvents(runDir);
  await replayMissingEvents(runDir, {
    toEvent: async (data) => ({
      event: 'seat_done',
      stage: 'FIND',
      seat: data.seat,
      callId: data.callId ?? `find-${data.seat}`,
      model: data.model ?? null,
      findingCount: data.findings.length,
      findings: await Promise.all(data.findings.map((f) => findingEvent(f, request.repoRoot))),
    }),
  });

  const lanePool = createLanePool({
    readMachine,
    config,
    seatCount: Math.max(1, request.seats?.length || 1),
  });

  const routeDecision = request.route || { stages: {} };
  const stagesRoute = routeDecision.stages || {};
  const seatModels = routeDecision.seatModels || {};

  const hostBackend = request.backend || config.hostBackend || 'claude';
  const swarmBackend = request.swarmBackend || config.swarm?.backend || 'opencode';
  const treeDir = sandbox?.treeDir || path.join(runDir, 'sandbox', 'tree');
  const allowRepoChange = Boolean(flags['allow-repo-change'] || flags.allowRepoChange);
  const state = { ...integrityState };
  let integrityReport = null;
  let repoChangeWarned = false;
  const namedConfigs = new Map();

  // One comparison against the baseline. `throwOnChange` is false in the cleanup pass, so the
  // run is not failed twice for the same change.
  const checkIntegrity = async ({ throwOnChange }) => {
    if (!baseline) return;
    const diff = compareBaseline(baseline, await hashRepo(request.repoRoot, { hooksDir }));
    const paths = [...diff.added, ...diff.removed, ...diff.modified];
    if (paths.length === 0) return;

    state.integrityChanged = true;
    await writeIntegrity(runDir, { state });
    const recovery = {};
    for (const rel of paths) {
      recovery[rel] = (await copyMatchesBaseline(treeDir, rel, baseline)) ? 'copy matches baseline' : 'no recovery copy';
    }
    integrityReport = { ...diff, recovery };

    if (allowRepoChange) {
      // Every later checkpoint sees the same change, so the warning is printed once per run.
      if (!repoChangeWarned) {
        repoChangeWarned = true;
        stderr?.write?.(`warning: repository changed during the run, cause unknown: ${paths.join(', ')}\n`);
      }
      return;
    }
    if (!throwOnChange) return;
    stderr?.write?.('repository changed during the run, cause unknown\n');
    stderr?.write?.(`  added: ${diff.added.join(', ') || 'none'}\n`);
    stderr?.write?.(`  removed: ${diff.removed.join(', ') || 'none'}\n`);
    stderr?.write?.(`  modified: ${diff.modified.join(', ') || 'none'}\n`);
    if (await dirExists(treeDir)) stderr?.write?.(`  a copy of the baseline tree is at ${treeDir}\n`);
    throw new RunError('repository changed during the run, cause unknown', 'integrity-changed');
  };

  const usedModels = {};
  const startedStages = new Set();
  // Resolved once per stage class, so a config warning is printed once per run.
  const idleByKey = new Map();
  const idleFor = (stage) => {
    const key = String(stage).toUpperCase();
    if (!idleByKey.has(key)) idleByKey.set(key, resolveIdleMs(config, key, { warn: (m) => stderr?.write?.(m) }));
    return idleByKey.get(key);
  };
  // A bad idle value fails the run here, before any seat starts.
  idleFor('FIND');
  idleFor('TABLE');

  const runAgent = async ({ stage, seat, prompt, schema, callId: explicitCallId, findingId }) => {
    const stgKey = stage.toLowerCase();
    const target = resolveStageTarget({
      stage,
      seat,
      stagesRoute,
      hostBackend,
      swarmBackend,
      config,
      seatModels,
    });
    const backendName = target.backend;
    const model = target.model;
    const effort = target.effort;
    if (target.warning) stderr?.write?.(`warning: ${target.warning}\n`);
    usedModels[target.routeKey] = model ? `${backendName}:${model}` : backendName;

    let timeoutMs = config.timeouts?.other || 600000;
    if (stgKey === 'find') timeoutMs = config.timeouts?.find || 1200000;
    if (stgKey === 'ruling') timeoutMs = config.timeouts?.ruling || 900000;

    const callId = explicitCallId
      ? explicitCallId
      : (stgKey === 'dispute' && findingId
        ? `dispute-${seat.key}-${normalizeId(findingId)}`
        : `${stgKey}-${seat.key}`);

    if (!startedStages.has(stage)) {
      startedStages.add(stage);
      await appendEvent(runDir, { event: 'stage_start', stage });
    }

    // The failover list applies only when the call runs the seat's own swarm model; a config
    // model for the stage or a host call has exactly one model.
    const swarmSeat = backendName === swarmBackend && model && model === seatModels[seat.key]?.model;
    const models = swarmSeat ? modelsForSeat(request, seat.key) : [model];
    if (models.length === 0) {
      const dead = { ok: false, value: null, raw: '', error: 'no-approved-model', attempts: 0 };
      await appendEvent(runDir, { event: 'seat_dead', stage, seat: seat.key, callId, ok: false, error: dead.error, attempts: 0 });
      return dead;
    }

    const release = await lanePool.acquire(laneProvider({ backendName, hostBackend, model }));

    // A swarm call never runs in the run cwd: it runs in the permission profile that matches
    // the stage class and the seat capability, over the sandbox tree.
    const laneFor = (m) =>
      laneForCall({ runDir, treeDir, stage, model: m, capability: seatModels[seat.key]?.capability, env, namedConfigs, packText });
    const lane = backendName === swarmBackend && model ? await laneFor(models[0]) : null;

    let lastSeatOutput = 0;
    const emit = (e) => {
      appendEvent(runDir, { ...e, stage, seat: seat.key, callId });
    };

    let res;
    try {
      res = await runSeatCall(
        {
          callId,
          prompt,
          schema,
          root: lane ? lane.cwd : request.repoRoot,
          runDir,
          cwd: lane ? lane.cwd : path.join(runDir, 'cwd'),
          model: models[0],
          models,
          effort,
          timeoutMs,
          idleMs: idleFor(stage),
          ...(lane ? { lane } : {}),
        },
        {
          backend: backendName,
          config,
          env,
          ...(lane ? { laneFor } : {}),
          onAttempt: ({ attempt, model: m }) => emit({ event: 'call_start', model: m ?? null, attempt }),
          onStdout: ({ bytes }) => {
            const now = Date.now();
            if (now - lastSeatOutput < SEAT_OUTPUT_EVERY_MS) return;
            lastSeatOutput = now;
            emit({ event: 'seat_output', bytes, lastOutputAt: now });
          },
          onStalled: ({ model: m, idleMs, action }) => emit({ event: 'seat_stalled', model: m ?? null, idleMs, action }),
          onFailover: ({ from, to, reason }) => emit({ event: 'seat_failover', from, to, reason }),
        }
      );

      await appendEvent(runDir, {
        event: res.ok ? 'call_end' : 'seat_dead',
        stage,
        seat: seat.key,
        callId,
        ok: res.ok,
        error: res.error,
        model: res.model ?? null,
        attempts: res.attempts,
        ts: Date.now(),
      });

      // Three refused tool calls is a model that does not respect the lane, not a bad prompt.
      if (lane && (res.toolRefusals || 0) >= 3) {
        await updateStore(stateDir(env), (cur) => {
          const k = `opencode:${model}`;
          cur[k] = { ...cur[k], misbehaved: (cur[k]?.misbehaved || 0) + 1 };
          return cur;
        });
      }

      return res;
    } finally {
      release(laneOutcome(res));
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
      seats: buildSeatObjects({
        seatKeys: request.seats || [],
        seatModels,
        stagesRoute,
        hostBackend,
        packText,
      }),
      runAgent,
      loadCheckpoint: async (name) => await readCheckpoint(runDir, name),
      checkpoint: async (name, data) => {
        await writeCheckpoint(runDir, name, data);
        await appendEvent(runDir, { event: 'stage_end', stage: name });
        await checkIntegrity({ throwOnChange: true });
        if (name === 'find' && until === 'find') {
          throw new StopUntilFindError();
        }
      },
      seatCheckpoint: (seatKey, data) =>
        writeSeatCheckpoint(runDir, seatKey, { ...data, materialHash: request.materialHash ?? null }),
      loadSeatCheckpoint: (seatKey) => readSeatCheckpoint(runDir, seatKey),
      onSeatDone: (e) => appendEvent(runDir, { event: 'seat_done', stage: 'FIND', findingCount: e.findings.length, ...e }),
      sift: siftObj,
    });
  } catch (err) {
    if (err instanceof StopUntilFindError) {
      await appendEvent(runDir, { event: 'run_end', gateVerdict: null, exitCode: 0, stopped: 'until-find' });
      if (flags.json) {
        stdout.write(JSON.stringify({ runDir, stage: 'find', status: 'stopped_until' }, null, 2) + '\n');
      } else {
        stdout.write(`FIND stage complete. Run stopped at --until find.\nTo resume: adversarial-review run --resume "${runDir}"\n`);
      }
      return 0;
    }
    if (integrityReport) {
      err.integrity = integrityReport;
      await writeResult(runDir, {
        runId: request.runId,
        target: request.target,
        stage: request.stage,
        gateVerdict: 'BLOCK',
        exitCode: err.exitCode || 3,
        blockingCount: 0,
        gaps: { noSeat: [], deadSeats: [], notRead: [] },
        integrity: integrityReport,
      });
      await appendEvent(runDir, { event: 'run_end', gateVerdict: 'BLOCK', exitCode: err.exitCode || 3 });
    }
    throw err;
  } finally {
    // A tracked child that outlives the run can still write in the repository, so it is killed
    // before the last comparison, not after it.
    killAllTrackedSync();
    try {
      await checkIntegrity({ throwOnChange: false });
    } catch {
      // The cleanup pass never fails the run.
    }
    await removeSandbox(runDir, { keep: state.keepSandbox || state.integrityChanged });
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
    ...(integrityReport ? { integrity: integrityReport } : {}),
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  await writeResult(runDir, finalResult);
  await appendEvent(runDir, { event: 'run_end', gateVerdict: finalResult.gateVerdict, exitCode: finalResult.exitCode });

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

// A seat that streams writes many chunks per second; the event log takes one line per 15 s.
const SEAT_OUTPUT_EVERY_MS = 15000;

/**
 * The models one seat call may use: its primary and failover models whose provider the run
 * approved. A run with no approval record keeps host models only, so a swarm seat gets none.
 *
 * @param {object} request
 * @param {string} seatKey
 * @returns {string[]}
 */
export function modelsForSeat(request, seatKey) {
  const entries = seatEntries(request?.route?.seatModels?.[seatKey]);
  const approved = request?.approval?.dataLeaves;
  const allowed = new Set(Array.isArray(approved) ? approved.map((r) => r.provider) : ['host']);
  return entries.filter((e) => allowed.has(e.provider)).map((e) => e.model);
}

const TIER_MODEL = { strong: 'opus', standard: 'sonnet', light: 'haiku' };
const TIER_EFFORT = { strong: 'high', standard: 'medium', light: 'low' };
const JUDGE_STAGES = new Set(['RULING', 'PATCH_JUDGE', 'VERIFY_JUDGE']);
const ROUTE_KEYS = {
  PATCH_SEAT: 'patchSeats', PATCH_JUDGE: 'patchJudge', VERIFY_SEAT: 'verifySeats', VERIFY_JUDGE: 'verifyJudge',
};

// Pipeline stage names and route-table keys differ; a raw lower-casing sent patch and verify to the host.
export function routeKeyOf(stage) {
  return ROUTE_KEYS[stage] || stage.toLowerCase();
}

export function resolveStageTarget({ stage, seat, stagesRoute, hostBackend, swarmBackend, config, seatModels = {} }) {
  const routeKey = routeKeyOf(stage);
  const isJudge = seat.key === 'judge' || JUDGE_STAGES.has(stage);
  // A judge call never leaves the host, whatever the route table or the config says.
  let backend = isJudge ? 'host' : stagesRoute[routeKey] || 'host';
  let warning;
  if (backend === 'host') backend = hostBackend;
  if (backend === 'swarm') {
    // A seat with no swarm model is not a dead seat: it runs on the host and says so.
    if (seatModels[seat.key]?.model) backend = swarmBackend;
    else {
      backend = hostBackend;
      warning = `seat ${seat.key} has no swarm model; it runs on the host`;
    }
  }
  const configKey = stage === 'PATCH_JUDGE' || stage === 'VERIFY_JUDGE' ? 'ruling' : routeKey;
  let model = config.stages?.[configKey]?.model || null;
  if (!model && backend === swarmBackend && !isJudge) model = seatModels[seat.key]?.model || null;
  if (!model && backend === 'claude') model = isJudge ? 'opus' : TIER_MODEL[seat.tier] || 'sonnet';
  // opencode variant names differ per provider, so it gets an effort only from config.
  let effort = config.stages?.[configKey]?.effort;
  if (!effort && (backend === 'claude' || backend === 'codex')) effort = TIER_EFFORT[isJudge ? 'strong' : seat.tier];
  const out = effort ? { backend, model, routeKey, effort } : { backend, model, routeKey };
  return warning ? { ...out, warning } : out;
}

// opus and sonnet answer a strong-capability prompt; haiku takes the weak one.
const CLAUDE_TIER_CAPABILITY = { strong: 'strong', standard: 'strong', light: 'weak' };

// The capability is per run, not per stage: a seat whose FIND ran on the swarm keeps its swarm
// capability on its later swarm stages, so the prompt shape does not change mid-run.
export function buildSeatObjects({ seatKeys = [], seatModels = {}, stagesRoute = {}, hostBackend, packText }) {
  const files = loadSeats();
  return seatKeys.map((key) => {
    const file = files.get(key) || { key, body: '', lens: '', tier: 'standard' };
    const sm = seatModels[key];
    const swarmFind = stagesRoute.find === 'swarm' && Boolean(sm?.model);
    const capability = swarmFind ? sm.capability : CLAUDE_TIER_CAPABILITY[file.tier] || 'strong';
    return swarmFind && packText ? { ...file, capability, contextPack: packText } : { ...file, capability };
  });
}

// A resume with no seat assignment has no swarm model to call, so every stage goes to the host.
function spawnStages(stages = {}) {
  const out = {};
  for (const key of [...STAGE_NAMES, ...Object.keys(stages)]) out[key] = 'host';
  return out;
}

async function dirExists(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// A recovery copy is worth naming only when it is byte-identical to the baseline.
async function copyMatchesBaseline(treeDir, rel, baseline) {
  const want = baseline?.files?.[rel];
  if (!want || want === 'deleted' || want === 'not-regular') return false;
  try {
    const buf = await fs.readFile(path.join(treeDir, rel));
    return createHash('sha256').update(buf).digest('hex') === want;
  } catch {
    return false;
  }
}

// The provider block holds a key. It is read from the user's own opencode config and written
// only under sandbox/xdg, which removeSandbox always deletes.
async function readProviderBlock(provider, env) {
  try {
    const file = path.join(homeDir(env), '.config', 'opencode', 'opencode.json');
    return JSON.parse(await fs.readFile(file, 'utf8'))?.provider?.[provider] || {};
  } catch {
    return {};
  }
}

const profileKeyFor = (stage, capability) =>
  routeKeyOf(stage) === 'find' ? (capability === 'weak' ? 'weak-find' : 'strong-find') : 'short';

/**
 * The lane a swarm call runs in: the permission profile for its stage class and capability,
 * plus an isolated opencode home when the model is not a zen model of the opencode provider.
 */
async function laneForCall({ runDir, treeDir, stage, model, capability, env, namedConfigs, packText, profileKey: forced }) {
  const profileKey = forced || profileKeyFor(stage, capability);
  const steps = PROFILE_STEPS[profileKey];
  const provider = String(model).split('/')[0];
  const mode = provider === 'opencode' ? 'zen' : 'named';

  const profileCacheKey = `profile:${profileKey}`;
  if (!namedConfigs.has(profileCacheKey)) {
    namedConfigs.set(profileCacheKey, await writeProfileConfig({ runDir, profileKey, treeDir, steps }));
  }
  const { cwd, xdgHome: zenXdgHome } = namedConfigs.get(profileCacheKey);

  // A zen lane reads the profile config of this run and nothing else; a named lane reads the
  // home that carries its provider block.
  let xdgHome = zenXdgHome;
  if (mode === 'named') {
    const key = `named:${profileKey}:${provider}`;
    if (!namedConfigs.has(key)) {
      const written = await writeNamedConfig({
        runDir,
        profileKey,
        provider,
        providerBlock: await readProviderBlock(provider, env),
        treeDir,
        steps,
      });
      namedConfigs.set(key, written.xdgHome);
    }
    xdgHome = namedConfigs.get(key);
  }
  return { mode, cwd, xdgHome, stage, packText };
}

function resolveStagesForReport(stagesRoute, hostBackend, swarmBackend) {
  const out = {};
  for (const [k, v] of Object.entries(stagesRoute)) out[k] = v === 'host' ? hostBackend : v === 'swarm' ? swarmBackend : v;
  return out;
}
