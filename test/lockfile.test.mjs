import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  LockBusyError,
  readLock,
  isStale,
  pidAlive,
} from '../skills/adversarial-review/scripts/lib/lockfile.mjs';

describe('lockfile module', () => {
  let tempDir;
  let lockPath;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'lockfile-test-'));
    lockPath = path.join(tempDir, 'lock');
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('pidAlive correctly identifies alive vs dead processes', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(999999999), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
    assert.equal(pidAlive(null), false);
    assert.equal(pidAlive(undefined), false);
    assert.equal(pidAlive('123'), false);
    assert.equal(pidAlive(NaN), false);
  });

  it('acquire, then second acquireLock(onBusy: fail) throws LockBusyError with holderPid === process.pid', async () => {
    const lock = await acquireLock(lockPath);
    assert.equal(lock.pid, process.pid);

    await assert.rejects(
      acquireLock(lockPath, { onBusy: 'fail' }),
      (err) => {
        assert.ok(err instanceof LockBusyError);
        assert.equal(err.holderPid, process.pid);
        return true;
      }
    );

    const released = await lock.release();
    assert.equal(released, true);
  });

  it('release() returns true and removes file; Lock with replaced token returns false and file stays', async () => {
    const lock1 = await acquireLock(lockPath);
    const released1 = await lock1.release();
    assert.equal(released1, true);
    assert.equal(await readLock(lockPath), null);

    const lock2 = await acquireLock(lockPath);
    // Replace lock file with a foreign token
    const foreignPayload = JSON.stringify({
      pid: process.pid,
      token: 'foreign-token-1234',
      createdAt: Date.now(),
    });
    await writeFile(lockPath, foreignPayload, 'utf8');

    const released2 = await lock2.release();
    assert.equal(released2, false);

    const lockRead = await readLock(lockPath);
    assert.equal(lockRead?.token, 'foreign-token-1234');
    await rm(lockPath, { force: true });
  });

  it('stale by dead pid -> acquire succeeds, and no .stale* or .takeover file remains', async () => {
    const stalePayload = JSON.stringify({
      pid: 999999999,
      token: 'stale-token-dead',
      createdAt: Date.now(),
    });
    await writeFile(lockPath, stalePayload, 'utf8');

    const lock = await acquireLock(lockPath);
    assert.equal(lock.pid, process.pid);

    const entries = await readdir(tempDir);
    const leftover = entries.filter(
      (f) => f.includes('.stale') || f.includes('.takeover') || f.includes('.tmp-')
    );
    assert.deepEqual(leftover, []);

    await lock.release();
  });

  it('unparseable lock with old mtime is taken over; unparseable with fresh mtime is busy', async () => {
    // Unparseable with fresh mtime -> busy
    await writeFile(lockPath, 'corrupted JSON {{{', 'utf8');

    await assert.rejects(
      acquireLock(lockPath, { onBusy: 'fail' }),
      (err) => err instanceof LockBusyError
    );

    // Unparseable with old mtime (20 min ago) -> taken over
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(lockPath, oldTime, oldTime);

    const lock = await acquireLock(lockPath);
    assert.equal(lock.pid, process.pid);

    const content = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.pid, process.pid);

    await lock.release();
  });

  it('two concurrent acquireLock calls on one stale lock (Promise.allSettled) -> exactly one fulfilled', async () => {
    const stalePayload = JSON.stringify({
      pid: 999999999,
      token: 'stale-token-concurrent',
      createdAt: Date.now(),
    });
    await writeFile(lockPath, stalePayload, 'utf8');

    const results = await Promise.allSettled([
      acquireLock(lockPath, { onBusy: 'fail' }),
      acquireLock(lockPath, { onBusy: 'fail' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof LockBusyError);

    // Clean up
    await fulfilled[0].value.release();
  });

  it("onBusy: 'wait' succeeds when holder releases after 300 ms", async () => {
    const holderLock = await acquireLock(lockPath);

    setTimeout(async () => {
      await holderLock.release();
    }, 300);

    const waiterLock = await acquireLock(lockPath, { onBusy: 'wait', waitMs: 5000 });
    assert.equal(waiterLock.pid, process.pid);

    await waiterLock.release();
  });

  it('the lock file is never empty: after acquire, JSON.parse(readFileSync(lock)) has pid and token', async () => {
    const lock = await acquireLock(lockPath);

    const raw = await readFile(lockPath, 'utf8');
    assert.ok(raw.length > 0);

    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.pid, 'number');
    assert.equal(typeof parsed.token, 'string');
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.token, lock.token);

    await lock.release();
  });

  it('touch() updates the lock mtime', async () => {
    const lock = await acquireLock(lockPath);
    const past = new Date(Date.now() - 45000);
    await utimes(lockPath, past, past);

    const beforeTouch = await stat(lockPath);
    assert.ok(Date.now() - beforeTouch.mtimeMs >= 40000);

    await lock.touch();

    const afterTouch = await stat(lockPath);
    assert.ok(Date.now() - afterTouch.mtimeMs < 5000);

    await lock.release();
  });

  it('readLock and isStale helper behaviors', async () => {
    const nonExistent = path.join(tempDir, 'not-exist');
    assert.equal(await readLock(nonExistent), null);
    assert.equal(await isStale(nonExistent), false);

    const validPayload = { pid: process.pid, token: 'tok-abc', createdAt: Date.now() };
    await writeFile(lockPath, JSON.stringify(validPayload), 'utf8');

    const read = await readLock(lockPath);
    assert.equal(read?.pid, process.pid);
    assert.equal(read?.token, 'tok-abc');

    // Process is alive, so not stale
    assert.equal(await isStale(lockPath), false);

    // Old mtime -> stale
    const oldTime = new Date(Date.now() - 15 * 60 * 1000);
    await utimes(lockPath, oldTime, oldTime);
    assert.equal(await isStale(lockPath), true);
  });

  it("onBusy: 'wait' times out and throws LockBusyError when holder never releases", async () => {
    const holderLock = await acquireLock(lockPath);

    await assert.rejects(
      acquireLock(lockPath, { onBusy: 'wait', waitMs: 250 }),
      (err) => {
        assert.ok(err instanceof LockBusyError);
        assert.equal(err.holderPid, process.pid);
        return true;
      }
    );

    await holderLock.release();
  });

  it('stale .takeover file older than takeoverStaleMs is removed during takeover', async () => {
    // Write stale lock file
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999999, token: 'stale-lock' }),
      'utf8'
    );

    // Write orphaned .takeover file with old timestamp (60s ago)
    const takeoverPath = `${lockPath}.takeover`;
    await writeFile(
      takeoverPath,
      JSON.stringify({ pid: 888888888, token: 'old-takeover' }),
      'utf8'
    );
    const oldTakeoverTime = new Date(Date.now() - 60000);
    await utimes(takeoverPath, oldTakeoverTime, oldTakeoverTime);

    const lock = await acquireLock(lockPath, { takeoverStaleMs: 30000 });
    assert.equal(lock.pid, process.pid);

    const entries = await readdir(tempDir);
    assert.ok(!entries.includes('lock.takeover'));

    await lock.release();
  });

  it('acquireLock respects custom isAlive and now options', async () => {
    let mockTime = 100000;
    const lock = await acquireLock(lockPath, {
      now: () => mockTime,
    });
    assert.equal(lock.pid, process.pid);

    // Another attempt with custom isAlive treating our process as dead
    const lock2 = await acquireLock(lockPath, {
      isAlive: () => false,
      now: () => mockTime + 1000,
    });
    assert.equal(lock2.pid, process.pid);

    await lock2.release();
  });

  it('release() returns false if lock file was unlinked externally', async () => {
    const lock = await acquireLock(lockPath);
    await rm(lockPath, { force: true });

    const released = await lock.release();
    assert.equal(released, false);
  });
});
