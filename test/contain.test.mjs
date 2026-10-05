import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { containFile, findingEvent } from '../skills/adversarial-review/scripts/lib/contain.mjs';

test('containFile refuses absolute, drive, UNC, device, and parent paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-c1-'));
  try {
    for (const bad of ['/etc/passwd', 'C:\\Windows\\x', 'c:/x', '\\\\server\\share\\x', '//server/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'NUL', 'nul.txt', 'COM1.log', 'a/../../b', '..\\x']) {
      const r = await containFile(bad, root);
      assert.equal(r.file, null, bad);
      assert.equal(r.outOfRoot, true, bad);
      assert.equal(r.fileRaw, bad);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('containFile keeps a relative path inside the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-c2-'));
  try {
    assert.deepEqual(await containFile('src/a.mjs', root), {
      file: 'src/a.mjs', fileRaw: 'src/a.mjs', outOfRoot: false, exists: false,
    });
    assert.deepEqual(await containFile('material.txt', root), {
      file: 'material.txt', fileRaw: 'material.txt', outOfRoot: false, exists: false,
    });
    await writeFile(path.join(root, 'material.txt'), 'm');
    assert.deepEqual(await containFile('material.txt', root), {
      file: 'material.txt', fileRaw: 'material.txt', outOfRoot: false, exists: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('containFile with no root runs the text checks only', async () => {
  assert.deepEqual(await containFile('src/a.mjs'), {
    file: 'src/a.mjs', fileRaw: 'src/a.mjs', outOfRoot: false, exists: false,
  });
  const r = await containFile('C:\\Windows\\win.ini');
  assert.equal(r.file, null);
  assert.equal(r.outOfRoot, true);
});

test('containFile: an empty value is refused and is not out of root', async () => {
  assert.deepEqual(await containFile(''), { file: null, fileRaw: '', outOfRoot: false, exists: false });
  assert.deepEqual(await containFile(null), { file: null, fileRaw: '', outOfRoot: false, exists: false });
});

test('findingEvent cuts long text', async () => {
  const e = await findingEvent({ id: 'edge-1', severity: 'minor', title: 'x'.repeat(500), file: 'a.mjs', line: '3' });
  assert.equal(e.title.length, 200);
  assert.equal(e.file, 'a.mjs');
  assert.equal(e.line, '3');
  assert.equal(e.outOfRoot, false);
});

test('findingEvent cuts a long raw path and reports a refusal', async () => {
  const long = `/etc/${'p'.repeat(500)}`;
  const e = await findingEvent({ id: 'edge-2', severity: 'critical', title: 't', file: long });
  assert.equal(e.file, null);
  assert.equal(e.outOfRoot, true);
  assert.equal(e.fileRaw.length, 200);
  assert.equal(e.line, null);
});

test('containFile: round 2 refusals and the symlink check', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-c-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ar-o-'));
  try {
    for (const bad of ['', '   ', '.', 'src/NUL.txt', 'NUL ', 'a.txt:s', 'src\\..\\x', 'x/CONIN$', 'dir./a']) {
      const r = await containFile(bad, root);
      assert.equal(r.file, null, JSON.stringify(bad));
    }
    await writeFile(path.join(outside, 'secret.txt'), 's');
    let linked = true;
    try { await symlink(outside, path.join(root, 'link'), 'junction'); } catch { linked = false; }
    if (linked) {
      const r = await containFile('link/secret.txt', root);
      assert.equal(r.file, null);
      assert.equal(r.outOfRoot, true);
    }
    const ok = await containFile('src/missing.mjs', root);
    assert.equal(ok.file, 'src/missing.mjs');
    assert.equal(ok.exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
