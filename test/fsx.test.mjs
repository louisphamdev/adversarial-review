import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeFileAtomic,
  renameWithRetry,
  readJsonSafe,
  appendJsonLine,
  readJsonLines,
} from '../skills/adversarial-review/scripts/lib/fsx.mjs';

describe('fsx module', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'fsx-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('atomic write leaves no *.tmp-* files', async () => {
    const targetFile = path.join(tempDir, 'atomic.json');
    const content = JSON.stringify({ hello: 'world' });

    await writeFileAtomic(targetFile, content);

    const readBack = await readFile(targetFile, 'utf8');
    assert.equal(readBack, content);

    const dirEntries = await readdir(tempDir);
    assert.ok(dirEntries.includes('atomic.json'));
    const tmpFiles = dirEntries.filter((f) => f.includes('.tmp-'));
    assert.equal(tmpFiles.length, 0);
  });

  it('atomic write with Buffer data', async () => {
    const targetFile = path.join(tempDir, 'atomic-bin.dat');
    const buf = Buffer.from([1, 2, 3, 4, 5]);

    await writeFileAtomic(targetFile, buf);

    const readBack = await readFile(targetFile);
    assert.deepEqual(readBack, buf);

    const dirEntries = await readdir(tempDir);
    const tmpFiles = dirEntries.filter((f) => f.includes('.tmp-'));
    assert.equal(tmpFiles.length, 0);
  });

  it('readJsonSafe on missing file returns missing: true', async () => {
    const missingFile = path.join(tempDir, 'does-not-exist.json');
    const res = await readJsonSafe(missingFile);
    assert.equal(res.ok, false);
    assert.equal(res.missing, true);
    assert.equal(typeof res.error, 'string');
  });

  it('readJsonSafe on broken JSON returns ok: false, missing: false', async () => {
    const brokenFile = path.join(tempDir, 'broken.json');
    await writeFile(brokenFile, '{broken', 'utf8');

    const res = await readJsonSafe(brokenFile);
    assert.equal(res.ok, false);
    assert.equal(res.missing, false);
    assert.equal(typeof res.error, 'string');
  });

  it('readJsonSafe on valid JSON returns ok: true with parsed value', async () => {
    const validFile = path.join(tempDir, 'valid.json');
    await writeFile(validFile, JSON.stringify({ status: 'ok', count: 42 }), 'utf8');

    const res = await readJsonSafe(validFile);
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { status: 'ok', count: 42 });
  });

  it('appendJsonLine appends serialized JSON line', async () => {
    const logFile = path.join(tempDir, 'events.jsonl');

    await appendJsonLine(logFile, { event: 'start', step: 1 });
    await appendJsonLine(logFile, { event: 'end', step: 1 });

    const raw = await readFile(logFile, 'utf8');
    assert.equal(raw, '{"event":"start","step":1}\n{"event":"end","step":1}\n');
  });

  it('readJsonLines on incomplete last line returns parsed complete objects', async () => {
    const partialFile = path.join(tempDir, 'partial.jsonl');
    await writeFile(partialFile, '{"a":1}\n{"b":2}\n{"c":', 'utf8');

    const result = await readJsonLines(partialFile);
    assert.equal(result.length, 2);
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it('readJsonLines ignores lines that do not parse and handles empty or missing files', async () => {
    const corruptFile = path.join(tempDir, 'corrupt.jsonl');
    await writeFile(corruptFile, '{"a":1}\ncorrupt json line\n{"b":2}\n', 'utf8');

    const result = await readJsonLines(corruptFile);
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);

    const missingFile = path.join(tempDir, 'missing.jsonl');
    const missingResult = await readJsonLines(missingFile);
    assert.deepEqual(missingResult, []);

    const emptyFile = path.join(tempDir, 'empty.jsonl');
    await writeFile(emptyFile, '', 'utf8');
    const emptyResult = await readJsonLines(emptyFile);
    assert.deepEqual(emptyResult, []);
  });

  it('renameWithRetry with injected rename that fails twice with EPERM then succeeds resolves', async () => {
    let attempts = 0;
    const fakeRename = async (from, to) => {
      attempts++;
      if (attempts <= 2) {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
    };

    await renameWithRetry('from-path', 'to-path', { rename: fakeRename });
    assert.equal(attempts, 3);
  });

  it('renameWithRetry throws immediately on non-retryable error', async () => {
    let attempts = 0;
    const failRename = async () => {
      attempts++;
      const err = new Error('No such file or directory');
      err.code = 'ENOENT';
      throw err;
    };

    await assert.rejects(
      renameWithRetry('from-path', 'to-path', { rename: failRename }),
      (err) => err.code === 'ENOENT'
    );
    assert.equal(attempts, 1);
  });

  it('renameWithRetry throws last error when totalMs is exceeded', async () => {
    let attempts = 0;
    const busyRename = async () => {
      attempts++;
      const err = new Error('Device or resource busy');
      err.code = 'EBUSY';
      throw err;
    };

    await assert.rejects(
      renameWithRetry('from-path', 'to-path', { totalMs: 60, rename: busyRename }),
      (err) => err.code === 'EBUSY'
    );
    assert.ok(attempts >= 2);
  });
});
