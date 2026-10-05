// CLI watch command: read-only. It wakes the host on the next important event of a run.
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertRunDir, readEvents } from '../rundir.mjs';
import { readLock, pidAlive } from '../lockfile.mjs';
import { flat } from '../fence.mjs';
import { ConfigError } from '../errors.mjs';

export const WAKE = new Set(['seat_done', 'seat_stalled', 'seat_failover', 'seat_dead', 'stage_end', 'run_end']);
// The owner touches the lock every 30 s, so a lock this old with a live pid is a hung owner.
const HUNG_MS = 600000;

/**
 * State of the run owner from the lock file alone.
 *
 * @param {string} runDir
 * @param {() => number} [now]
 * @returns {Promise<'alive'|'dead'|'hung'|'none'>}
 */
export async function ownerState(runDir, now = Date.now) {
  const lockPath = path.join(runDir, 'lock');
  const lock = await readLock(lockPath);
  if (!lock) return 'none';
  if (!pidAlive(lock.pid)) return 'dead';
  try {
    const st = await fs.stat(lockPath);
    if (now() - st.mtimeMs > HUNG_MS) return 'hung';
  } catch {
    return 'none';
  }
  return 'alive';
}

function parseCount(value, name, { positive = false } = {}) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value))) throw new ConfigError(`--${name} must be a non-negative integer`);
  const n = Number(value);
  if (positive && n <= 0) throw new ConfigError(`--${name} must be greater than 0`);
  return n;
}

function render(index, e) {
  const summary = e.from ? `${e.from} -> ${e.to} (${e.reason})` : (e.action ?? e.gateVerdict ?? e.stopped ?? '');
  const head = `[${index ?? '-'}] ${flat(e.event)} ${flat(e.seat ?? '')} ${flat(e.stage ?? '')} ${flat(summary)}`
    .replace(/ +/g, ' ')
    .trimEnd();
  const lines = [head];
  if (e.event === 'seat_done' && Array.isArray(e.findings)) {
    for (const f of e.findings) {
      lines.push(`  ${flat(f.id)} ${flat(f.severity)} ${flat(f.title)} @ ${flat(f.file ?? f.fileRaw ?? '?')}:${flat(f.line ?? '?')}`);
    }
  }
  return lines.join('\n');
}

// The exit sweep writes `cleanup` after the run ends, so it never makes a run_end non-final.
function finalRunEnd(events) {
  if (!events) return -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i]?.event;
    if (kind === 'cleanup') continue;
    return kind === 'run_end' ? i : -1;
  }
  return -1;
}

async function readResult(runDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, 'result.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `watch <run-dir> [--since n] [--timeout sec] [--json]`. Exit 0 event or run end, 2 usage,
 * 3 owner dead, 4 timeout, 5 owner hung. It takes no lock and writes no file.
 */
export async function watchCommand(
  flags = {},
  positionals = [],
  { env = process.env, stdout = process.stdout, stderr = process.stderr, pollMs = 1000, now = Date.now } = {}
) {
  let since;
  let timeout;
  let runDir;
  try {
    if (positionals.length === 0) throw new ConfigError('Run directory is required: watch <run-dir>');
    since = parseCount(flags.since ?? '0', 'since');
    timeout = parseCount(flags.timeout, 'timeout', { positive: true });
    runDir = assertRunDir(env, positionals[0]);
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`Error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const start = now();
  // The host reads `next` only from the last line or from --json, never from a line with seat text.
  const emit = ({ index, next, event, finished, owner }) => {
    if (flags.json) stdout.write(JSON.stringify({ index, next, event, finished, owner }) + '\n');
    else stdout.write(`${event ? render(index, event) : 'no event'}\nnext: ${next}\n`);
  };
  const findWake = (events) => {
    if (!events) return -1;
    for (let i = since; i < events.length; i++) if (WAKE.has(events[i]?.event)) return i;
    return -1;
  };
  const wake = async (events, i, finished) => {
    const owner = await ownerState(runDir, now);
    emit({ index: i, next: i + 1, event: events[i], finished: finished || events[i].event === 'run_end', owner });
    return 0;
  };

  for (;;) {
    let events = await readEvents(runDir);
    let i = findWake(events);
    if (i >= 0) return wake(events, i, false);

    const owner = await ownerState(runDir, now);
    const result = await readResult(runDir);
    if (result) {
      events = await readEvents(runDir);
      i = findWake(events);
      if (i >= 0) return wake(events, i, true);
      emit({
        index: null,
        next: events ? events.length : since,
        event: { event: 'run_end', gateVerdict: result.gateVerdict ?? null, exitCode: result.exitCode ?? null, synthetic: true },
        finished: true,
        owner,
      });
      return 0;
    }

    if (owner !== 'alive') {
      // The owner may have written its last event and released the lock between two reads.
      events = await readEvents(runDir);
      const end = finalRunEnd(events);
      if (end >= 0) return wake(events, end, true);
      if (flags.json) {
        emit({ index: null, next: since, event: null, finished: false, owner: owner === 'none' ? 'dead' : owner });
      } else if (owner === 'hung') {
        const pid = (await readLock(path.join(runDir, 'lock')))?.pid;
        stdout.write(`owner hung: pid ${pid} is alive but the lock is older than 600 s\nnext: ${since}\n`);
      } else {
        stdout.write(`owner dead\nresume: adversarial-review run --resume "${runDir}" --detach\nnext: ${since}\n`);
      }
      return owner === 'hung' ? 5 : 3;
    }

    if (timeout !== undefined && now() - start >= timeout * 1000) {
      emit({ index: null, next: since, event: null, finished: false, owner });
      return 4;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
