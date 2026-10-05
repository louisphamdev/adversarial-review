import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSiftObj } from '../skills/adversarial-review/scripts/lib/cli/run.mjs';

describe('makeSiftObj checkpoint life cycle', () => {
  const base = { request: { repoRoot: '/r', materialKind: 'file', material: { kind: 'file', targetPath: '/r/a.mjs' } }, runDir: '/run', config: {}, env: {}, runChild: async () => ({ code: 0, stdout: '' }) };
  it('writes no checkpoint for an aborted sift', async () => {
    const writes = [];
    let obj;
    const siftFn = async () => {
      obj.abort();
      return { status: 'skipped', reason: 'all-failed', rows: [], readingOrder: [] };
    };
    obj = makeSiftObj({ ...base, loadedSift: null, siftFn, writeCp: async (...a) => writes.push(a) });
    await obj.start([{ id: 'a' }], { rebuttals: [] });
    assert.equal(writes.length, 0);
  });
  it('discards a 3.0.2-shape checkpoint and a skipped one', () => {
    assert.equal(makeSiftObj({ ...base, loadedSift: { status: 'used', rows: [] } }).loaded, null);
    assert.equal(makeSiftObj({ ...base, loadedSift: { status: 'skipped', engineVersion: '3.1.0' } }).loaded, null);
    const ok = { status: 'used', rows: [], engineVersion: '3.1.0' };
    assert.equal(makeSiftObj({ ...base, loadedSift: ok }).loaded, ok);
  });
  it('writes the checkpoint for a used sift with the engine version', async () => {
    const writes = [];
    const obj = makeSiftObj({ ...base, loadedSift: null, siftFn: async () => ({ status: 'used', rows: [], readingOrder: [] }), writeCp: async (dir, name, data) => writes.push(data) });
    await obj.start([{ id: 'a' }], {});
    assert.equal(writes.length, 1);
    assert.ok(writes[0].engineVersion);
  });
});
