// Cleanup before a command exits (A14 item 3): every process tree the engine started is dead,
// and the isolated lane config is gone, before the command returns on any path.
import path from 'node:path';
import fs from 'node:fs/promises';
import { CLEANUP_WAIT_MS, cleanupTracked, installSignalHandlers } from './proc.mjs';
import { acquireLock } from './lockfile.mjs';
import { removeSandbox } from './sandbox.mjs';
import { appendEvent } from './rundir.mjs';
import { writeFileAtomic } from './fsx.mjs';

// The command names its run directory as soon as it has one. The sweep reads it at the end, so
// a command that throws before it returns still records the sweep in the right place.
const active = { runDir: null };

/**
 * @param {string|null} runDir
 */
export function setActiveRunDir(runDir) {
  active.runDir = runDir || null;
}

// The sweep runs before the result is read, so a result that exists is updated in place. A
// command that writes no result (patch-review, verify, a thrown error) leaves nothing to update.
async function mergeResultCleanup(runDir, cleanup) {
  const file = path.join(runDir, 'result.json');
  let result;
  try {
    result = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  try {
    await writeFileAtomic(file, JSON.stringify({ ...result, cleanup }, null, 2) + '\n');
  } catch {
    // The record is a report, so it never fails the command that produced it.
  }
}

/**
 * Kill every tracked process tree, remove the isolated lane config, and record the sweep.
 * `keep` is true on purpose: the full sandbox tree belongs to the run that built it, and a
 * kept tree is the evidence of a repository change.
 *
 * @param {{ runDir?: string, stderr?: object, waitMs?: number }} [options]
 * @returns {Promise<{ killed: number, stillAlive: number[] }>}
 */
export async function runExitCleanup({ runDir = active.runDir, stderr, waitMs = CLEANUP_WAIT_MS } = {}) {
  const record = await cleanupTracked({ waitMs });

  if (runDir) {
    await removeSandbox(runDir, { keep: true, log: (m) => stderr?.write?.(`note: ${m}\n`) });
    try {
      await appendEvent(runDir, { event: 'cleanup', ...record, ts: Date.now() });
    } catch {
      // A run directory that is already gone must not turn into a second failure.
    }
    await mergeResultCleanup(runDir, record);
  }

  if (record.stillAlive.length > 0) {
    stderr?.write?.(`warning: cleanup could not stop pid ${record.stillAlive.join(', ')}\n`);
  }
  return record;
}

/**
 * Build the one exit handler of a command: sweep, then release the lock the holder carries.
 * It passes no run directory on purpose. The handler fires long after it is installed, and
 * `--detach` clears the active run directory in between so the parent leaves the worker's
 * sandbox alone. A captured path would delete the tree the worker is rebuilding under it.
 *
 * @param {{ stderr?: object, lockHolder?: { lock: { release: () => Promise<void> } | null } }} [options]
 * @returns {() => Promise<void>}
 */
export function makeExitHandler({ stderr, lockHolder = null } = {}) {
  return async () => {
    await runExitCleanup({ stderr });
    const lock = lockHolder?.lock;
    if (lock) await lock.release();
  };
}

/**
 * Install the exit handler of a command. `installSignalHandlers` keeps the first handler it is
 * given, so a command installs once and lets the holder carry the lock it takes later.
 *
 * @param {{ stderr?: object, lockHolder?: { lock: object|null } }} [options]
 */
export function installCleanupHandler(options = {}) {
  installSignalHandlers(makeExitHandler(options));
}

/**
 * Name the run directory for the sweep, install the exit handler, then take the run lock.
 * The handler goes in before the lock so a signal during the wait still sweeps.
 *
 * @param {string} runDir
 * @param {{ stderr?: object }} [options]
 * @returns {Promise<object>}
 */
export async function acquireLockWithCleanup(runDir, { stderr } = {}) {
  setActiveRunDir(runDir);
  const lockHolder = { lock: null };
  installCleanupHandler({ stderr, lockHolder });
  lockHolder.lock = await acquireLock(path.join(runDir, 'lock'), { onBusy: 'fail' });
  return lockHolder.lock;
}

/**
 * Run a command body and sweep afterwards, whatever the body does.
 * The body receives the memoized sweep, so a path that must report the sweep can run it early.
 *
 * @template T
 * @param {{ runDir?: string, stderr?: object, waitMs?: number }} options
 * @param {(cleanup: () => Promise<{ killed: number, stillAlive: number[] }>) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withExitCleanup(options, body) {
  let swept = null;
  const cleanup = async () => {
    if (!swept) swept = await runExitCleanup(options);
    return swept;
  };
  try {
    return await body(cleanup);
  } finally {
    await cleanup();
    setActiveRunDir(null);
  }
}
