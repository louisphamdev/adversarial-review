// Run directory lifecycle, checkpoints, indexed rounds, and state introspection.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENGINE_VERSION, SCHEMA_VERSION } from './version.mjs';
import { runsDir, canonicalPath } from './paths.mjs';
import { writeFileAtomic, readJsonSafe, appendJsonLine, readJsonLines } from './fsx.mjs';
import { readLock, pidAlive, isStale } from './lockfile.mjs';
import { ConfigError, RunError } from './errors.mjs';

// Verifies that a directory is within the user state runs hierarchy.
export function assertRunDir(env, dir) {
  if (!dir || typeof dir !== 'string') {
    throw new ConfigError('Run directory is required');
  }
  const runs = runsDir(env);
  const canonical = canonicalPath(dir);
  const canonicalRuns = canonicalPath(runs);
  const rel = path.relative(canonicalRuns, canonical);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ConfigError(`Directory is not inside runs directory: ${dir}`);
  }
  return canonical;
}

// Creates a run directory with collision backoff and standard subdirectories.
export async function createRun({ env, root, request, mkdir = fs.mkdir }) {
  const baseDir = runsDir(env, root);
  await fs.mkdir(baseDir, { recursive: true });

  const pad = (n) => String(n).padStart(2, '0');
  let attempts = 0;
  let runDir;
  let runId;

  while (attempts < 5) {
    attempts++;
    const now = new Date();
    const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const rand = crypto.randomBytes(4).toString('hex');
    runId = `${ts}-${rand}`;
    runDir = path.join(baseDir, runId);

    try {
      await mkdir(runDir);
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        if (attempts >= 5) {
          throw new RunError('Failed to create run directory: collision after 5 attempts', 'run-dir-collision');
        }
        continue;
      }
      throw err;
    }
  }

  await fs.mkdir(path.join(runDir, 'cwd'));
  await fs.mkdir(path.join(runDir, 'stages'));
  await fs.mkdir(path.join(runDir, 'calls'));

  const reqData = {
    ...request,
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
  await writeFileAtomic(path.join(runDir, 'request.json'), JSON.stringify(reqData, null, 2) + '\n');

  return { runDir, runId };
}

// Writes material snapshot to run directory for diff or file reviews.
export async function writeMaterial(runDir, material) {
  if (!material) return;
  if (material.kind === 'diff') {
    const file = path.join(runDir, 'material.diff');
    await writeFileAtomic(file, material.text || '');
  } else if (material.kind === 'file') {
    const file = path.join(runDir, 'material.txt');
    await writeFileAtomic(file, material.text || '');
  }
}

// Appends an event object to events.jsonl.
export async function appendEvent(runDir, event) {
  const file = path.join(runDir, 'events.jsonl');
  await appendJsonLine(file, event);
}

// Saves a completed stage checkpoint.
export async function writeCheckpoint(runDir, name, data) {
  const file = path.join(runDir, 'stages', `${name}.json`);
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

// Loads a completed stage checkpoint, or null when absent or invalid.
export async function readCheckpoint(runDir, name) {
  const file = path.join(runDir, 'stages', `${name}.json`);
  const res = await readJsonSafe(file);
  return res.ok ? res.value : null;
}

// Atomically writes sequential round records matching prefix-<n>.json.
export async function writeIndexed(runDir, prefix, data) {
  let dir;
  let base;
  if (prefix.includes('/') || prefix.includes('\\')) {
    dir = path.join(runDir, path.dirname(prefix));
    base = path.basename(prefix);
  } else {
    dir = path.join(runDir, 'stages');
    base = prefix;
  }
  await fs.mkdir(dir, { recursive: true });

  let n = 1;
  while (true) {
    const filename = `${base}-${n}.json`;
    const targetPath = path.join(dir, filename);
    let exists = false;
    try {
      await fs.stat(targetPath);
      exists = true;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }
    if (!exists) {
      await writeFileAtomic(targetPath, JSON.stringify(data, null, 2) + '\n');
      return targetPath;
    }
    n++;
  }
}

// Atomically persists final run result.
export async function writeResult(runDir, result) {
  const file = path.join(runDir, 'result.json');
  const payload = {
    ...result,
    engineVersion: result.engineVersion || ENGINE_VERSION,
    schemaVersion: result.schemaVersion || SCHEMA_VERSION,
  };
  await writeFileAtomic(file, JSON.stringify(payload, null, 2) + '\n');
}

// Reads the composite state of a run directory.
export async function readState(runDir) {
  const reqRes = await readJsonSafe(path.join(runDir, 'request.json'));
  const request = reqRes.ok ? reqRes.value : null;

  const stagesDir = path.join(runDir, 'stages');
  const checkpoints = [];
  try {
    const entries = await fs.readdir(stagesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) {
        checkpoints.push(e.name.slice(0, -5));
      }
    }
    checkpoints.sort();
  } catch {
    // stages directory absent
  }

  const resRes = await readJsonSafe(path.join(runDir, 'result.json'));
  const result = resRes.ok ? resRes.value : null;

  const events = await readJsonLines(path.join(runDir, 'events.jsonl'));

  const lockPath = path.join(runDir, 'lock');
  const lock = await readLock(lockPath);

  let ownerAlive = false;
  if (lock && typeof lock.pid === 'number') {
    const alive = pidAlive(lock.pid);
    const stale = await isStale(lockPath);
    ownerAlive = alive && !stale;
  }

  return {
    request,
    checkpoints,
    result,
    events,
    lock,
    ownerAlive,
  };
}
