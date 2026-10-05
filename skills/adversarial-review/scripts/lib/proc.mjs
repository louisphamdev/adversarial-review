// Process execution, executable resolution, lifecycle management, and signal tracking.

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Default timeout in seconds when neither config nor job specifies one.
export const DEFAULT_TIMEOUT_SEC = 120;
export const DEFAULT_INACTIVITY_SEC = 120;
export const DEFAULT_HARDCAP_SEC = 1800;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const FORCE_KILL_GRACE_MS = 2000;
export const TIMEOUT_SENTINEL = Symbol('timeout');
export const MAX_SANE_SEC = 2_147_483;

// Characters that cmd.exe treats as metacharacters when re-parsing trailing arguments.
const CMD_METACHAR_RE = /[&|<>^"%()\r\n]/;

// Placeholders that a custom reviewer args array may use.
export const ALLOWED_PLACEHOLDERS = new Set([
  'promptFile',
  'schemaFile',
  'outFile',
  'root',
  'cwd',
  'model',
]);

// Set of all currently active spawned child processes.
export const trackedChildren = new Set();

// Every pid this process spawned, kept while a kill by that pid could still reach something. A
// pid whose child object already closed can still own a live grandchild, which is the leak the
// sweep removes. It is dropped as soon as nothing it could own is alive, because the OS reuses
// pids: a pid kept past that point can name an unrelated process by the time the sweep runs.
export const trackedPids = new Set();

// Every pid this process spawned, with the time window of its spawn() call, kept until the next
// sweep ends. On Windows a lane leader that exited leaves no tree to kill, so the sweep finds its
// survivors by parent pid, and the window tells the lane apart from a later process with its pid.
export const everTracked = new Map();

export const CLEANUP_WAIT_MS = 5000;

// The measured scan takes about 0.5 s; this bound only matters when WMI hangs.
export const WIN_SCAN_TIMEOUT_MS = 3000;
export const DESCENDANT_WAIT_MS = 1000;

// The signal path runs the same cleanup, so this window must outlast all of it:
// CLEANUP_WAIT_MS (5000) + WIN_SCAN_TIMEOUT_MS (3000) + DESCENDANT_WAIT_MS (1000) + 3000 for the
// taskkill calls and the xdg removal retries (3 x 500 ms) = 12000.
export const EXIT_HOOK_GRACE_MS = CLEANUP_WAIT_MS + WIN_SCAN_TIMEOUT_MS + DESCENDANT_WAIT_MS + 3000;

// Set once the exit sweep starts, and never cleared in production: a seat retry loop that is
// still running must not start a lane the sweep has already passed.
let closing = false;

export function beginClosing() {
  closing = true;
}

export function isClosing() {
  return closing;
}

export function resetClosingForTests() {
  closing = false;
}

/**
 * Read an env value by case-insensitive key name.
 *
 * @param {object} env
 * @param {string} name
 * @returns {string|undefined}
 */
export function getEnvCaseInsensitive(env, name) {
  if (!env || typeof env !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(env, name) && env[name] != null) {
    return env[name];
  }
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && env[key] != null) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Resolve a trusted absolute path to a Windows System32 executable.
 *
 * @param {string} exe
 * @returns {string}
 */
export function system32Path(exe) {
  const root =
    getEnvCaseInsensitive(process.env, 'SystemRoot') ||
    getEnvCaseInsensitive(process.env, 'windir') ||
    'C:\\Windows';
  return path.join(root, 'System32', exe);
}

// Every file-existence check of resolveExecutable goes through this, so a caller can inject
// one and keep a test's outcome off the real filesystem.
export const accessExists = async (p, mode) => {
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve a command name or path to an absolute executable path.
 *
 * @param {string} command
 * @param {object} env
 * @param {{ platform?: string, exists?: (p: string, mode: number) => Promise<boolean> }} [seam]
 * @returns {Promise<string|null>}
 */
export async function resolveExecutable(
  command,
  env = process.env,
  { platform = process.platform, exists = accessExists } = {}
) {
  if (typeof command !== 'string' || command.length === 0) return null;

  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;

  if (command.includes('/') || command.includes('\\')) {
    if (!(await exists(command, constants.X_OK)) && !(await exists(command, constants.F_OK))) {
      return null;
    }
    return p.resolve(command);
  }

  const pathValue = getEnvCaseInsensitive(env, 'PATH');
  const pathExtValue = getEnvCaseInsensitive(env, 'PATHEXT');
  const pathEntries = String(pathValue || '').split(p.delimiter).filter(Boolean);
  const extensions = isWin
    ? String(pathExtValue || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  const accessMode = isWin ? constants.F_OK : constants.X_OK;
  for (const dir of pathEntries) {
    for (const ext of extensions) {
      const candidate = p.join(dir, isWin ? `${command}${ext}` : command);
      if (await exists(candidate, accessMode)) return candidate;
    }
  }
  return null;
}

/**
 * Expand `{placeholder}` tokens in an args array.
 * Placeholders must be whole arguments; unknown or partial tokens throw unknown_placeholder.
 *
 * @param {string[]} template
 * @param {object} values
 * @returns {string[]}
 */
export function expandArgs(template, values = {}) {
  if (!Array.isArray(template)) return [];
  return template.map((arg) => {
    const s = String(arg);
    if (!s.includes('{') && !s.includes('}')) {
      return s;
    }
    const match = s.match(/^\{([^{}]+)\}$/);
    if (!match) {
      throw new Error('unknown_placeholder');
    }
    const name = match[1];
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      throw new Error('unknown_placeholder');
    }
    return values[name] != null ? String(values[name]) : '';
  });
}

/**
 * Read a Windows npm .cmd shim and resolve the target JS/MJS/CJS file if it exists.
 * Matches `"%~dp0\<rel>.js"` or `"%dp0%\<rel>.js"`.
 *
 * @param {string} cmdPath
 * @returns {Promise<string|null>}
 */
export async function resolveNpmShim(cmdPath) {
  if (typeof cmdPath !== 'string') return null;
  let content;
  try {
    content = await readFile(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/"?(?:%~dp0|%dp0%)[\\/]?([^"\r\n]+?\.(?:js|mjs|cjs))"?/i);
  if (!match) return null;
  const rel = match[1].replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const target = path.resolve(path.dirname(cmdPath), rel);
  try {
    await access(target, constants.F_OK);
    return target;
  } catch {
    return null;
  }
}

/**
 * Spawn a resolved executable path with shell: false and track process.
 *
 * @param {string} resolvedPath
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function spawnResolved(resolvedPath, args = [], options = {}) {
  const platform = options._platform || process.platform;
  let command = resolvedPath;
  let finalArgs = args;

  if (platform === 'win32') {
    const lower = resolvedPath.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      let shimTarget = null;
      if (lower.endsWith('.cmd')) {
        shimTarget = await resolveNpmShim(resolvedPath);
      }
      if (shimTarget) {
        command = process.execPath;
        finalArgs = [shimTarget, ...args];
      } else {
        for (const arg of args) {
          if (CMD_METACHAR_RE.test(String(arg))) {
            throw new Error('unsafe_batch_argument');
          }
        }
        command = system32Path('cmd.exe');
        finalArgs = ['/c', resolvedPath, ...args];
      }
    }
  }

  // Checked after the last await: a sweep that began during resolveNpmShim has already copied
  // the tracked pids, so a lane started now would outlive it.
  if (closing) {
    const err = new Error('aborted: the exit sweep has begun');
    err.code = 'ABORTED';
    throw err;
  }
  const pre = Date.now();
  const child = spawn(command, finalArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  const post = Date.now();

  trackedChildren.add(child);
  if (child.pid) {
    trackedPids.add(child.pid);
    const lane = { pre, post };
    everTracked.set(child.pid, lane);
    child.once('exit', () => {
      lane.end = Date.now();
    });
  }
  const cleanup = () => {
    trackedChildren.delete(child);
    if (child.pid && !isPidTreeAlive(child.pid)) trackedPids.delete(child.pid);
  };
  child.once('close', cleanup);
  child.once('error', cleanup);

  return child;
}

/**
 * Send a signal to a child process group, falling back to direct pid.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch (err2) {
      if (err2 && err2.code === 'ESRCH') return;
    }
  }
}

/**
 * Force-kill a process tree.
 * POSIX: SIGTERM to process group, followed by SIGKILL after 2000 ms.
 * Windows: taskkill /T /F /PID <pid> from system32Path.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function forceKill(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync(system32Path('taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      signalGroup(child, 'SIGTERM');
      let killTimer = setTimeout(() => {
        try {
          signalGroup(child, 'SIGKILL');
        } catch {
          // ignore
        }
      }, FORCE_KILL_GRACE_MS);

      const clear = () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
      };
      child.once('exit', clear);
      child.once('close', clear);
      child.once('error', clear);
    }
  } catch {
    // ignore
  }
}

/**
 * Whether a pid still names a running process.
 * EPERM means the process exists and belongs to another user, so it is alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Whether a kill by this pid can still reach a running process.
 * POSIX: the process group of the pid, which outlives its leader while a member runs.
 * Windows: the pid itself, because a tree kill by an exited pid reaches nothing (measured
 * 2026-10-05: taskkill answers "process not found" and leaves the descendant running).
 *
 * @param {number} pid
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isPidTreeAlive(pid, platform = process.platform) {
  if (!pid) return false;
  if (platform === 'win32') return isPidAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Kill a process tree by pid, with no child object.
 *
 * @param {number} pid
 * @param {string} [platform]
 */
export function killPidTree(pid, platform = process.platform) {
  if (!pid) return;
  try {
    if (platform === 'win32') {
      spawnSync(system32Path('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // The process is already gone.
  }
}

const WIN_SCAN_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; "$($_.ProcessId),$($_.ParentProcessId),$c" }';

/**
 * Read the Windows process table as pid -> { ppid, created } (epoch ms), or null when it fails.
 * A raw spawnSync on purpose: it runs after the closing flag is set and on the exit path.
 *
 * @param {{ spawnSyncFn?: Function, timeoutMs?: number }} [options]
 * @returns {Map<number, { ppid: number, created: number }>|null}
 */
export function readWinProcessTable({ spawnSyncFn = spawnSync, timeoutMs = WIN_SCAN_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = spawnSyncFn(
      system32Path('WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', WIN_SCAN_SCRIPT],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return null;
  }
  if (!res || res.status !== 0 || typeof res.stdout !== 'string') return null;
  const table = new Map();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+),(\d+),(\d+)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), created: Number(m[3]) });
  }
  return table;
}

/**
 * The live processes that belong to a lane: the lane itself while its pid still names it, and
 * every descendant. A pid holder started outside the lane's spawn window is another process, and
 * a child started before its recorded parent, or after the lane exited, hangs from a reused pid;
 * neither is followed.
 *
 * @param {Map<number, { ppid: number, created: number }>} table
 * @param {Map<number, { pre: number, post: number, end?: number }>} lanes
 * @param {number} [selfPid]
 * @returns {Set<number>}
 */
export function laneProcesses(table, lanes, selfPid = process.pid) {
  const children = new Map();
  for (const [pid, p] of table) {
    if (pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const out = new Set();
  for (const [lane, { pre, post, end = Infinity }] of lanes) {
    const holder = table.get(lane);
    if (holder && (holder.created < pre || holder.created > post)) continue;
    if (holder && lane !== selfPid) out.add(lane);
    const stack = [[lane, holder ? holder.created : pre]];
    while (stack.length) {
      const [pid, created] = stack.pop();
      for (const child of children.get(pid) || []) {
        const c = table.get(child);
        if (child === selfPid || out.has(child) || c.created < created) continue;
        if (pid === lane && c.created > end) continue;
        out.add(child);
        stack.push([child, c.created]);
      }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill the process tree of every tracked pid, then wait for them to disappear.
 * A pid that survives the wait is reported, never hidden: the caller names it to the user.
 *
 * @param {{ waitMs?: number, kill?: (pid: number) => void, isAlive?: (pid: number) => boolean,
 *   platform?: string, spawnSyncFn?: Function, descendantWaitMs?: number }} [options]
 * @returns {Promise<{ killed: number, stillAlive: number[], scanFailed?: boolean }>}
 */
export async function cleanupTracked({
  waitMs = CLEANUP_WAIT_MS,
  kill = killPidTree,
  isAlive = isPidAlive,
  platform = process.platform,
  spawnSyncFn = spawnSync,
  descendantWaitMs = DESCENDANT_WAIT_MS,
} = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  const swept = new Set();
  let killed = 0;
  let alive = [];
  // A seat retry loop can track a new lane while this waits, so each pass sweeps the pids that
  // appeared since the last one, and the loop ends only on a pass that finds nothing new.
  for (;;) {
    const fresh = [...trackedPids].filter((pid) => !swept.has(pid));
    // The attempt never reads the pid's own liveness. A pid that exited can still lead a group
    // that holds a live lane server, and that pid is the only handle on it: skipping it would
    // leave the leak running and still report a clean sweep. Liveness only counts the kill.
    for (const pid of fresh) {
      swept.add(pid);
      if (isAlive(pid)) killed++;
      kill(pid);
    }
    trackedChildren.clear();
    alive = [...swept].filter((pid) => isAlive(pid));
    if (Date.now() >= deadline || (fresh.length === 0 && alive.length === 0)) break;
    await sleep(100);
  }

  let scanFailed = false;
  if (platform === 'win32' && everTracked.size > 0) {
    const table = readWinProcessTable({ spawnSyncFn });
    if (!table) {
      scanFailed = true;
    } else {
      const targets = [...laneProcesses(table, everTracked)].filter((pid) => !swept.has(pid) && isAlive(pid));
      for (const pid of targets) {
        killed++;
        kill(pid);
      }
      const until = Date.now() + Math.max(0, descendantWaitMs);
      let left = targets.filter((pid) => isAlive(pid));
      while (left.length > 0 && Date.now() < until) {
        await sleep(100);
        left = left.filter((pid) => isAlive(pid));
      }
      alive.push(...left);
    }
  }

  for (const pid of swept) {
    if (!alive.includes(pid)) trackedPids.delete(pid);
  }
  for (const pid of [...everTracked.keys()]) {
    if (!alive.includes(pid)) everTracked.delete(pid);
  }
  return scanFailed ? { killed, stillAlive: alive, scanFailed } : { killed, stillAlive: alive };
}

/**
 * Kill all active tracked children synchronously.
 */
export function killAllTrackedSync() {
  for (const child of trackedChildren) {
    if (!child || !child.pid) continue;
    try {
      if (process.platform === 'win32') {
        spawnSync(system32Path('taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
  trackedChildren.clear();
}

let signalHandlersInstalled = false;

/**
 * Install signal and uncaught exception handlers once.
 *
 * @param {Function} [onExit]
 */
export function installSignalHandlers(onExit) {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  let exiting = false;
  const handleExit = async (exitCode, err) => {
    if (exiting) return;
    exiting = true;
    beginClosing();

    try {
      killAllTrackedSync();
    } catch {
      // ignore
    }

    if (typeof onExit === 'function') {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => onExit(err)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, EXIT_HOOK_GRACE_MS);
          }),
        ]);
      } catch {
        // ignore
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    process.exit(exitCode);
  };

  process.once('SIGINT', () => handleExit(130));
  process.once('SIGTERM', () => handleExit(130));
  process.once('SIGHUP', () => handleExit(130));
  process.once('uncaughtException', (err) => handleExit(1, err));
}

const RUN_CHILD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Collect stream keeping the tail capped at maxBytes.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {'stdout'|'stderr'} which
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function collectTailStream(child, which, maxBytes = RUN_CHILD_MAX_BYTES) {
  return new Promise((resolve) => {
    const stream = child[which];
    if (!stream) {
      resolve('');
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let finished = false;

    stream.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      while (chunks.length > 1 && totalBytes - chunks[0].length >= maxBytes) {
        const removed = chunks.shift();
        totalBytes -= removed.length;
      }
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      if (chunks.length === 0) {
        resolve('');
        return;
      }
      const full = Buffer.concat(chunks);
      if (full.length > maxBytes) {
        let start = full.length - maxBytes;
        while (start < full.length && (full[start] & 0xc0) === 0x80) {
          start++;
        }
        resolve(full.subarray(start).toString('utf8'));
      } else {
        resolve(full.toString('utf8'));
      }
    };

    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
    child.once('close', finish);
    child.once('error', finish);
  });
}

/**
 * Run a child process with resolution, stdin piping, tail-capped output draining,
 * and force-kill on timeout.
 *
 * @param {object} options
 * @param {string} options.cmd
 * @param {string[]} [options.args]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {string|Buffer} [options.stdin]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.idleMs] Kill the child after this long with no stdout or stderr chunk.
 * @param {Function} [options.onSpawn]
 * @param {Function} [options.onStdout]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, idled: boolean, spawnError: Error|null, aborted?: boolean }>}
 */
export async function runChild({
  cmd,
  args = [],
  cwd,
  env,
  stdin,
  timeoutMs,
  idleMs,
  onSpawn,
  onStdout,
}) {
  let resolved;
  try {
    resolved = await resolveExecutable(cmd, env);
  } catch (err) {
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      idled: false,
      spawnError: err,
    };
  }

  if (!resolved) {
    const err = new Error(`Executable not found: ${cmd}`);
    err.code = 'ENOENT';
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      idled: false,
      spawnError: err,
    };
  }

  let child;
  try {
    child = await spawnResolved(resolved, args, {
      cwd,
      env,
      stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      idled: false,
      spawnError: err?.code === 'ABORTED' ? null : err,
      ...(err?.code === 'ABORTED' ? { aborted: true } : {}),
    };
  }

  if (typeof onSpawn === 'function') {
    try {
      onSpawn(child);
    } catch {
      // ignore
    }
  }

  if (stdin != null && child.stdin) {
    child.stdin.on('error', () => {
      // ignore EPIPE
    });
    try {
      child.stdin.end(stdin);
    } catch {
      // ignore
    }
  }

  let timeoutTimer = null;
  let timedOut = false;
  let spawnError = null;
  let idled = false;
  let idleTimer = null;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // The deadline restarts on every chunk, so a slow model that still reports stays alive while a
  // silent one dies. A total timeout that already fired owns the kill, so this stands down then.
  const armIdle = () => {
    if (!(idleMs > 0) || timedOut || idled) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      if (timedOut) return;
      idled = true;
      forceKill(child);
    }, idleMs);
  };
  armIdle();

  // Attached synchronously before the collector so that no chunk is lost.
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      armIdle();
      if (typeof onStdout === 'function') {
        try {
          onStdout(chunk);
        } catch {
          // a report hook never breaks a call
        }
      }
    });
  }
  if (child.stderr) child.stderr.on('data', armIdle);

  const stdoutPromise = collectTailStream(child, 'stdout', RUN_CHILD_MAX_BYTES);
  const stderrPromise = collectTailStream(child, 'stderr', RUN_CHILD_MAX_BYTES);

  child.once('error', (err) => {
    spawnError = err;
  });

  const exitPromise = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });

  if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (idled) return;
      timedOut = true;
      clearIdle();
      forceKill(child);
    }, timeoutMs);
  }

  let exitInfo;
  try {
    exitInfo = await exitPromise;
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    clearIdle();
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return {
    code: exitInfo.code ?? child.exitCode,
    signal: exitInfo.signal ?? child.signalCode,
    stdout,
    stderr,
    timedOut,
    idled,
    spawnError,
  };
}

// ---------------------------------------------------------------------------
// Ported v2 stream, timeout, and watchdog helpers
// ---------------------------------------------------------------------------

export function sanePositiveSec(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_SANE_SEC)
    : fallback;
}

export function createMarkerScanner(markers) {
  const list = (markers || []).map(String).filter(Boolean);
  let found = false;
  let carry = '';
  const overlap = list.reduce((m, s) => Math.max(m, s.length), 0);
  return {
    onChunk(chunk) {
      if (found || list.length === 0) return;
      const text = carry + chunk.toString('utf8');
      for (const marker of list) {
        if (text.includes(marker)) {
          found = true;
          carry = '';
          return;
        }
      }
      carry = overlap > 1 ? text.slice(-(overlap - 1)) : '';
    },
    hit() {
      return found;
    },
  };
}

export function collectStream(child, which, maxBytes = MAX_OUTPUT_BYTES, scanner = null) {
  return new Promise((resolve) => {
    const stream = child[which];
    if (!stream) {
      resolve('');
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    stream.on('data', (chunk) => {
      if (scanner) scanner.onChunk(chunk);
      if (truncated) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        truncated = true;
        chunks.push(chunk.slice(0, chunk.length - (totalBytes - maxBytes)));
      } else {
        chunks.push(chunk);
      }
    });

    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function collectOutput(child) {
  return collectStream(child, 'stdout');
}

export function collectStderr(child, scanner = null) {
  return collectStream(child, 'stderr', MAX_OUTPUT_BYTES, scanner);
}

export function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
}

export async function runWithTimeout(child, { timeoutMs, captureStderr = false }) {
  const collectors = captureStderr
    ? [collectOutput(child), collectStderr(child), waitForExit(child)]
    : [collectOutput(child), waitForExit(child)];

  const processPromise = Promise.all(collectors);
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  let raceResult;
  try {
    raceResult = await Promise.race([processPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  if (raceResult === TIMEOUT_SENTINEL) {
    forceKill(child);
    return TIMEOUT_SENTINEL;
  }

  if (captureStderr) {
    const [stdout, stderr, exitCode] = raceResult;
    return { stdout, stderr, exitCode };
  }
  const [stdout, exitCode] = raceResult;
  return { stdout, stderr: '', exitCode };
}

export async function runWithWatchdog(child, { inactivityMs, hardCapMs, captureStderr = false, stderrMarkers = null }) {
  const scanner = stderrMarkers && stderrMarkers.length ? createMarkerScanner(stderrMarkers) : null;
  const collectors = captureStderr
    ? [collectOutput(child), collectStderr(child, scanner), waitForExit(child)]
    : [collectOutput(child), waitForExit(child)];
  if (!captureStderr && scanner && child.stderr) {
    child.stderr.on('data', (chunk) => scanner.onChunk(chunk));
  }
  const processPromise = Promise.all(collectors);

  let inactivityTimer;
  let hardCapTimer;
  let settled = false;
  const timeoutPromise = new Promise((resolve) => {
    const fire = () => { if (!settled) resolve(TIMEOUT_SENTINEL); };
    const resetInactivity = () => {
      if (settled) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(fire, inactivityMs);
      if (inactivityTimer && typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
    };
    if (child.stdout) child.stdout.on('data', resetInactivity);
    if (child.stderr) child.stderr.on('data', resetInactivity);
    resetInactivity();
    hardCapTimer = setTimeout(fire, hardCapMs);
    if (hardCapTimer && typeof hardCapTimer.unref === 'function') hardCapTimer.unref();
  });

  let raceResult;
  try {
    raceResult = await Promise.race([processPromise, timeoutPromise]);
  } finally {
    settled = true;
    clearTimeout(inactivityTimer);
    clearTimeout(hardCapTimer);
  }

  if (raceResult === TIMEOUT_SENTINEL) {
    forceKill(child);
    return TIMEOUT_SENTINEL;
  }

  const stderrMarkerHit = scanner ? scanner.hit() : false;
  if (captureStderr) {
    const [stdout, stderr, exitCode] = raceResult;
    return { stdout, stderr, exitCode, stderrMarkerHit };
  }
  const [stdout, exitCode] = raceResult;
  return { stdout, stderr: '', exitCode, stderrMarkerHit };
}
