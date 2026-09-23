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

/**
 * Resolve a command name or path to an absolute executable path.
 *
 * @param {string} command
 * @param {object} env
 * @returns {Promise<string|null>}
 */
export async function resolveExecutable(command, env = process.env) {
  if (typeof command !== 'string' || command.length === 0) return null;

  if (command.includes('/') || command.includes('\\')) {
    try {
      await access(command, constants.X_OK);
    } catch {
      try {
        await access(command, constants.F_OK);
      } catch {
        return null;
      }
    }
    return path.resolve(command);
  }

  const pathValue = getEnvCaseInsensitive(env, 'PATH');
  const pathExtValue = getEnvCaseInsensitive(env, 'PATHEXT');
  const pathEntries = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? String(pathExtValue || '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];

  const accessMode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;
  for (const dir of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(
        dir,
        process.platform === 'win32' ? `${command}${ext}` : command
      );
      try {
        await access(candidate, accessMode);
        return candidate;
      } catch {
        continue;
      }
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

  const child = spawn(command, finalArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });

  trackedChildren.add(child);
  const cleanup = () => trackedChildren.delete(child);
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
            timer = setTimeout(resolve, 2000);
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
 * @param {Function} [options.onSpawn]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error|null }>}
 */
export async function runChild({
  cmd,
  args = [],
  cwd,
  env,
  stdin,
  timeoutMs,
  onSpawn,
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
      spawnError: err,
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

  const stdoutPromise = collectTailStream(child, 'stdout', RUN_CHILD_MAX_BYTES);
  const stderrPromise = collectTailStream(child, 'stderr', RUN_CHILD_MAX_BYTES);

  let timeoutTimer = null;
  let timedOut = false;
  let spawnError = null;

  child.once('error', (err) => {
    spawnError = err;
  });

  const exitPromise = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });

  if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
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
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return {
    code: exitInfo.code ?? child.exitCode,
    signal: exitInfo.signal ?? child.signalCode,
    stdout,
    stderr,
    timedOut,
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
