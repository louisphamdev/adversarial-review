import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRun,
  writeMaterial,
  appendEvent,
  writeCheckpoint,
  readCheckpoint,
  writeIndexed,
  writeResult,
  readState,
  assertRunDir,
} from '../skills/adversarial-review/scripts/lib/rundir.mjs';
import { ConfigError, RunError } from '../skills/adversarial-review/scripts/lib/errors.mjs';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../skills/adversarial-review/scripts/lib/version.mjs';
import { runsDir, canonicalPath } from '../skills/adversarial-review/scripts/lib/paths.mjs';
import { makeIsolatedEnv, makeTempRepo } from './helpers/isolated-env.mjs';

describe('rundir module', () => {
  it('createRun twice in the same second -> different dirs', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const run1 = await createRun({ env, root, request: { stage: 'code' } });
      const run2 = await createRun({ env, root, request: { stage: 'code' } });

      assert.notEqual(run1.runId, run2.runId);
      assert.notEqual(run1.runDir, run2.runDir);
      assert.match(run1.runId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
      assert.match(run2.runId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);

      // Verify subdirectories exist
      const stCwd = await stat(path.join(run1.runDir, 'cwd'));
      assert.ok(stCwd.isDirectory());
      const stStages = await stat(path.join(run1.runDir, 'stages'));
      assert.ok(stStages.isDirectory());
      const stCalls = await stat(path.join(run1.runDir, 'calls'));
      assert.ok(stCalls.isDirectory());

      // Verify request.json
      const reqText = await readFile(path.join(run1.runDir, 'request.json'), 'utf8');
      const reqObj = JSON.parse(reqText);
      assert.equal(reqObj.stage, 'code');
      assert.equal(reqObj.engineVersion, ENGINE_VERSION);
      assert.equal(reqObj.schemaVersion, SCHEMA_VERSION);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('forced EEXIST (inject mkdir) five times -> throws RunError with exitCode 3', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      let callCount = 0;
      const failingMkdir = async (p, opts) => {
        callCount++;
        const err = new Error('File exists');
        err.code = 'EEXIST';
        throw err;
      };

      await assert.rejects(
        createRun({ env, root, request: {}, mkdir: failingMkdir }),
        (err) => {
          assert.ok(err instanceof RunError);
          assert.equal(err.exitCode, 3);
          assert.equal(err.reason, 'run-dir-collision');
          return true;
        }
      );
      assert.ok(callCount >= 5);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('writeIndexed twice -> -1, -2', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: {} });

      const file1 = await writeIndexed(runDir, 'patch-review', { round: 1 });
      const file2 = await writeIndexed(runDir, 'patch-review', { round: 2 });

      assert.match(file1, /patch-review-1\.json$/);
      assert.match(file2, /patch-review-2\.json$/);

      const content1 = JSON.parse(await readFile(file1, 'utf8'));
      assert.equal(content1.round, 1);
      const content2 = JSON.parse(await readFile(file2, 'utf8'));
      assert.equal(content2.round, 2);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('readState with a truncated result.json -> result: null', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: { test: true } });

      // Write truncated result.json
      await writeFile(path.join(runDir, 'result.json'), '{"gateVerdict": "PASS", trun');

      const state = await readState(runDir);
      assert.equal(state.result, null);
      assert.equal(state.request.test, true);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('assertRunDir on the repo dir -> throws ConfigError', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      assert.throws(
        () => assertRunDir(env, root),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.exitCode, 2);
          return true;
        }
      );
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('assertRunDir inside <state>/runs -> returns canonical path', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: {} });
      const asserted = assertRunDir(env, runDir);
      assert.equal(asserted, canonicalPath(runDir));
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('readState with a lock of a dead pid -> ownerAlive: false; live pid -> ownerAlive: true', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: {} });

      // Write a lock with a dead pid (e.g. 999999999)
      const deadPayload = JSON.stringify({
        pid: 999999999,
        token: 'deadbeef12345678',
        createdAt: Date.now(),
      });
      await writeFile(path.join(runDir, 'lock'), deadPayload, 'utf8');

      const deadState = await readState(runDir);
      assert.equal(deadState.ownerAlive, false);
      assert.ok(deadState.lock !== null);
      assert.equal(deadState.lock.pid, 999999999);

      // Write a lock with our own live process pid
      const livePayload = JSON.stringify({
        pid: process.pid,
        token: 'livebeef12345678',
        createdAt: Date.now(),
      });
      await writeFile(path.join(runDir, 'lock'), livePayload, 'utf8');

      const liveState = await readState(runDir);
      assert.equal(liveState.ownerAlive, true);
      assert.ok(liveState.lock !== null);
      assert.equal(liveState.lock.pid, process.pid);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('writeMaterial writes material.diff for diff and material.txt for file', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: {} });

      await writeMaterial(runDir, { kind: 'diff', text: 'diff content\n' });
      const diffContent = await readFile(path.join(runDir, 'material.diff'), 'utf8');
      assert.equal(diffContent, 'diff content\n');

      await writeMaterial(runDir, { kind: 'file', text: 'file content\n' });
      const fileContent = await readFile(path.join(runDir, 'material.txt'), 'utf8');
      assert.equal(fileContent, 'file content\n');
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });

  it('appendEvent, writeCheckpoint, readCheckpoint, and writeResult update state', async () => {
    const { env, cleanup: envCleanup } = await makeIsolatedEnv();
    const { root, cleanup: repoCleanup } = await makeTempRepo({ git: true, files: {} });
    try {
      const { runDir } = await createRun({ env, root, request: {} });

      await appendEvent(runDir, { type: 'stage_start', stage: 'find' });
      await appendEvent(runDir, { type: 'stage_end', stage: 'find' });

      await writeCheckpoint(runDir, 'find', { findings: [{ id: 'f1' }] });
      const cp = await readCheckpoint(runDir, 'find');
      assert.deepEqual(cp, { findings: [{ id: 'f1' }] });

      await writeResult(runDir, { exitCode: 0, gateVerdict: 'PASS' });

      const state = await readState(runDir);
      assert.equal(state.events.length, 2);
      assert.equal(state.events[0].type, 'stage_start');
      assert.deepEqual(state.checkpoints, ['find']);
      assert.equal(state.result.exitCode, 0);
      assert.equal(state.result.gateVerdict, 'PASS');
      assert.equal(state.result.engineVersion, ENGINE_VERSION);
      assert.equal(state.result.schemaVersion, SCHEMA_VERSION);
    } finally {
      await repoCleanup();
      await envCleanup();
    }
  });
});
