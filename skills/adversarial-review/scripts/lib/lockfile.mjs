// Owner lock management with atomic hard-links, staleness takeover, and auto-touch.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export class LockBusyError extends Error {
  constructor(message, holderPid) {
    if (typeof message === 'number') {
      super(`Lock is busy (pid ${message})`);
      this.holderPid = message;
    } else {
      super(message || 'Lock is busy');
      this.holderPid = typeof holderPid === 'number' ? holderPid : undefined;
    }
    this.name = 'LockBusyError';
    this.exitCode = 2;
  }
}

export function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

export async function readLock(lockPath) {
  try {
    const text = await fs.readFile(lockPath, 'utf8');
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && typeof data.pid === 'number') {
      return {
        pid: data.pid,
        token: typeof data.token === 'string' ? data.token : null,
        createdAt: data.createdAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function isStale(lockPath, { staleMs = 600000, now = Date.now, isAlive = pidAlive } = {}) {
  let st;
  try {
    st = await fs.stat(lockPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  const currentTime = typeof now === 'function' ? now() : Date.now();
  const age = currentTime - st.mtimeMs;
  if (age > staleMs) {
    return true;
  }
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const data = JSON.parse(content);
    if (data && typeof data === 'object' && typeof data.pid === 'number') {
      return !isAlive(data.pid);
    }
    return false;
  } catch {
    return false;
  }
}

export class Lock {
  constructor(lockPath, token, pid, touchMs = 30000, now = Date.now) {
    this.path = lockPath;
    this.token = token;
    this.pid = pid;
    this.touchMs = touchMs;
    this._now = now;
    this.timer = null;
  }

  async touch() {
    const nowMs = typeof this._now === 'function' ? this._now() : Date.now();
    const d = new Date(nowMs);
    await fs.utimes(this.path, d, d);
  }

  startTimer() {
    if (this.touchMs > 0) {
      this.timer = setInterval(() => {
        this.touch().catch(() => {});
      }, this.touchMs);
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  async release() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const current = await readLock(this.path);
    if (current && current.token === this.token) {
      try {
        await fs.unlink(this.path);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function linkCreate(targetPath, payload, tempPath) {
  await fs.writeFile(tempPath, payload, 'utf8');
  try {
    await fs.link(tempPath, targetPath);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function acquireLock(
  lockPath,
  {
    onBusy = 'fail',
    waitMs = 5000,
    staleMs = 600000,
    takeoverStaleMs = 30000,
    touchMs = 30000,
    now = Date.now,
    isAlive = pidAlive,
  } = {}
) {
  const start = typeof now === 'function' ? now() : Date.now();
  const token = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    createdAt: typeof now === 'function' ? now() : Date.now(),
  });
  const tempPath = `${lockPath}.tmp-${token}`;

  while (true) {
    const created = await linkCreate(lockPath, payload, tempPath);
    if (created) {
      const lock = new Lock(lockPath, token, process.pid, touchMs, now);
      await lock.touch();
      lock.startTimer();
      return lock;
    }

    const initialLock = await readLock(lockPath);
    const stale = await isStale(lockPath, { staleMs, now, isAlive });

    if (stale) {
      const takeoverPath = `${lockPath}.takeover`;
      try {
        const toStat = await fs.stat(takeoverPath);
        const currentTime = typeof now === 'function' ? now() : Date.now();
        if (currentTime - toStat.mtimeMs > takeoverStaleMs) {
          await fs.unlink(takeoverPath).catch(() => {});
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }

      const takeoverToken = crypto.randomBytes(8).toString('hex');
      const takeoverTemp = `${takeoverPath}.tmp-${takeoverToken}`;
      const takeoverPayload = JSON.stringify({
        pid: process.pid,
        token: takeoverToken,
        createdAt: typeof now === 'function' ? now() : Date.now(),
      });

      const gotTakeover = await linkCreate(takeoverPath, takeoverPayload, takeoverTemp);
      if (gotTakeover) {
        try {
          const currentLock = await readLock(lockPath);
          const stillStale = await isStale(lockPath, { staleMs, now, isAlive });
          const sameToken = (currentLock?.token ?? null) === (initialLock?.token ?? null);

          if (stillStale && sameToken) {
            await fs.unlink(lockPath).catch(() => {});
            const newLockCreated = await linkCreate(lockPath, payload, tempPath);
            if (newLockCreated) {
              const lock = new Lock(lockPath, token, process.pid, touchMs, now);
              await lock.touch();
              lock.startTimer();
              return lock;
            }
          }
        } finally {
          await fs.unlink(takeoverPath).catch(() => {});
        }
      }
    }

    if (onBusy === 'fail') {
      const holder = await readLock(lockPath);
      throw new LockBusyError('Lock is busy', holder?.pid ?? initialLock?.pid);
    }

    if (onBusy === 'wait') {
      const currentTime = typeof now === 'function' ? now() : Date.now();
      const elapsed = currentTime - start;
      if (elapsed >= waitMs) {
        const holder = await readLock(lockPath);
        throw new LockBusyError('Lock wait timed out', holder?.pid ?? initialLock?.pid);
      }
      const sleepTime = Math.min(100, Math.max(1, waitMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    } else {
      throw new Error(`Invalid onBusy option: ${onBusy}`);
    }
  }
}
