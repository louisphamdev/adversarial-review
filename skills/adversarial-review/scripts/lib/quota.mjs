// Quota inspection, OAuth extraction, execution, and locking cache.
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir, homeDir } from './paths.mjs';
import { acquireLock } from './lockfile.mjs';
import { writeFileAtomic, readJsonSafe } from './fsx.mjs';
import { runChild } from './proc.mjs';

/**
 * Parse a percentage value from raw string, number, or JSON text.
 * Returns a number between 0 and 100, or null if invalid, empty, or out of range.
 *
 * @param {unknown} input
 * @returns {number|null}
 */
export function parsePercent(input) {
  if (input === null || input === undefined) return null;

  if (typeof input === 'number') {
    if (Number.isFinite(input) && input >= 0 && input <= 100) {
      return input;
    }
    return null;
  }

  if (typeof input === 'object') {
    if (!Array.isArray(input) && input.percent !== undefined) {
      return parsePercent(input.percent);
    }
    return null;
  }

  if (typeof input !== 'string') return null;

  let s = input.trim();
  if (!s) return null;

  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return parsePercent(obj.percent);
      }
    } catch {
      return null;
    }
  }

  if (s.endsWith('%')) {
    s = s.slice(0, -1).trim();
  }

  const n = Number(s);
  if (s !== '' && Number.isFinite(n) && n >= 0 && n <= 100) {
    return n;
  }
  return null;
}

/**
 * Default credential reader for Claude Code subscriptions.
 * On macOS, reads from Keychain item "Claude Code-credentials".
 * On Linux, Windows, or Keychain fallback, reads ~/.claude/.credentials.json.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @returns {Promise<string|null>}
 */
export async function defaultReadCredentials({
  platform = process.platform,
  home = homeDir(),
} = {}) {
  if (platform === 'darwin') {
    try {
      const res = await runChild({
        cmd: 'security',
        args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        timeoutMs: 5000,
      });
      if (res && res.code === 0 && res.stdout) {
        const text = res.stdout.trim();
        if (text) return text;
      }
    } catch {
      // Fall through to filesystem on Keychain error
    }
  }

  const credPath = path.join(home, '.claude', '.credentials.json');
  try {
    return await fs.readFile(credPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read current provider quota percent.
 * Never throws; all error cases resolve to { percent: null, source, stale: boolean }.
 *
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {object} [options.env]
 * @param {string} [options.stateDir]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.runCommand]
 * @param {Function} [options.readCredentials]
 * @param {Function} [options.now]
 * @param {number} [options.oauthTimeoutMs]
 * @param {number} [options.commandTimeoutMs]
 * @param {number} [options.lockWaitMs]
 * @param {string} [options.platform]
 * @returns {Promise<{ percent: number | null, source: string, stale: boolean }>}
 */
export async function readQuota({
  config = {},
  env = process.env,
  stateDir: customStateDir,
  fetchImpl = fetch,
  runCommand,
  readCredentials,
  now = Date.now,
  oauthTimeoutMs = 10000,
  commandTimeoutMs = 15000,
  lockWaitMs = 5000,
  platform = process.platform,
} = {}) {
  let source = 'none';

  try {
    // 1. ADVERSARIAL_REVIEW_QUOTA_PERCENT wins over every source when set and not empty
    const envQuota = env?.ADVERSARIAL_REVIEW_QUOTA_PERCENT;
    if (envQuota !== undefined && envQuota !== null && String(envQuota).trim() !== '') {
      const percent = parsePercent(String(envQuota));
      return { percent, source: 'env', stale: false };
    }

    // 2. Select source
    source =
      config?.quota?.source ||
      (config?.hostBackend === 'claude' ? 'claude-oauth' : 'none');

    if (source === 'none') {
      return { percent: null, source: 'none', stale: false };
    }

    // 3. Resolve cache and lock paths
    const resolvedStateDir = customStateDir || stateDir(env);
    const cacheDir = path.join(resolvedStateDir, 'cache');
    const cacheFile = path.join(cacheDir, 'quota.json');
    const lockFile = path.join(cacheDir, 'quota.lock');

    const nowMs = typeof now === 'function' ? now() : Date.now();

    // 4. Check existing cache before locking (fresh for 120s)
    const initialCache = await readJsonSafe(cacheFile);
    if (initialCache.ok && initialCache.value && typeof initialCache.value.at === 'number') {
      const age = nowMs - initialCache.value.at;
      if (
        age >= 0 &&
        age < 120000 &&
        initialCache.value.percent !== null &&
        initialCache.value.source === source
      ) {
        return {
          percent: initialCache.value.percent,
          source,
          stale: false,
        };
      }
    }

    // 5. Acquire lock to refresh cache
    let lock = null;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      lock = await acquireLock(lockFile, {
        onBusy: 'wait',
        waitMs: lockWaitMs,
        now,
      });
    } catch {
      // Lock acquisition failed (timeout or busy)
      const fallbackCheck = await readJsonSafe(cacheFile);
      if (fallbackCheck.ok && fallbackCheck.value && typeof fallbackCheck.value.at === 'number') {
        const checkNow = typeof now === 'function' ? now() : Date.now();
        const age = checkNow - fallbackCheck.value.at;
        if (
          age >= 0 &&
          age < 120000 &&
          fallbackCheck.value.percent !== null &&
          fallbackCheck.value.source === source
        ) {
          return { percent: fallbackCheck.value.percent, source, stale: false };
        }
        if (
          age >= 0 &&
          age < 3600000 &&
          fallbackCheck.value.percent !== null &&
          fallbackCheck.value.source === source
        ) {
          return { percent: fallbackCheck.value.percent, source, stale: true };
        }
      }
      return { percent: null, source, stale: false };
    }

    // 6. Double-check cache under lock
    try {
      const doubleCheck = await readJsonSafe(cacheFile);
      if (doubleCheck.ok && doubleCheck.value && typeof doubleCheck.value.at === 'number') {
        const checkNow = typeof now === 'function' ? now() : Date.now();
        const age = checkNow - doubleCheck.value.at;
        if (
          age >= 0 &&
          age < 120000 &&
          doubleCheck.value.percent !== null &&
          doubleCheck.value.source === source
        ) {
          return {
            percent: doubleCheck.value.percent,
            source,
            stale: false,
          };
        }
      }

      // 7. Perform refresh fetch/command
      let fetchedPercent = null;
      let fetchOk = false;

      if (source === 'command') {
        const cmd = config?.quota?.command;
        const argv = Array.isArray(cmd) ? cmd : (typeof cmd === 'string' ? [cmd] : []);
        if (argv.length > 0) {
          try {
            let res;
            if (runCommand) {
              res = await runCommand(argv);
            } else {
              res = await runChild({
                cmd: argv[0],
                args: argv.slice(1),
                timeoutMs: commandTimeoutMs,
                env,
              });
            }
            if (res && res.code === 0 && res.stdout != null) {
              const parsed = parsePercent(res.stdout);
              if (parsed !== null) {
                fetchedPercent = parsed;
                fetchOk = true;
              }
            }
          } catch {
            fetchOk = false;
          }
        }
      } else if (source === 'claude-oauth') {
        try {
          const readCreds = readCredentials || defaultReadCredentials;
          const credText = await readCreds({ platform, home: homeDir(env) });
          if (credText) {
            const creds = JSON.parse(credText);
            const token = creds?.claudeAiOauth?.accessToken || creds?.accessToken;
            if (token && typeof token === 'string') {
              const signal = AbortSignal.timeout(oauthTimeoutMs);
              const res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'anthropic-beta': 'oauth-2025-04-20',
                },
                signal,
              });
              if (res && (res.ok || res.status === 200)) {
                const data = await res.json();
                const parsed = parsePercent(data?.seven_day?.utilization);
                if (parsed !== null) {
                  fetchedPercent = parsed;
                  fetchOk = true;
                }
              }
            }
          }
        } catch {
          fetchOk = false;
        }
      }

      if (fetchOk && fetchedPercent !== null) {
        const writeNow = typeof now === 'function' ? now() : Date.now();
        const cachePayload = {
          at: writeNow,
          percent: fetchedPercent,
          source,
        };
        try {
          await writeFileAtomic(cacheFile, JSON.stringify(cachePayload, null, 2));
        } catch {
          // Failure to write cache does not fail quota read
        }
        return { percent: fetchedPercent, source, stale: false };
      }

      // 8. Fetch failed: fall back to cache younger than 1 hour (3600000ms)
      const fallbackCache = await readJsonSafe(cacheFile);
      if (fallbackCache.ok && fallbackCache.value && typeof fallbackCache.value.at === 'number') {
        const checkNow = typeof now === 'function' ? now() : Date.now();
        const age = checkNow - fallbackCache.value.at;
        if (
          age >= 0 &&
          age < 3600000 &&
          fallbackCache.value.percent !== null &&
          fallbackCache.value.source === source
        ) {
          return {
            percent: fallbackCache.value.percent,
            source,
            stale: true,
          };
        }
      }

      return { percent: null, source, stale: false };
    } finally {
      if (lock) {
        await lock.release().catch(() => {});
      }
    }
  } catch {
    return { percent: null, source, stale: false };
  }
}
