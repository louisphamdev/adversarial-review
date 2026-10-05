import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  siftFindings,
  buildExcerpt,
  buildSiftState,
  readingOrderOf,
  compareSift,
  findKey,
  materialScopeOf,
} from '../skills/adversarial-review/scripts/lib/sift.mjs';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-repo-'));
  made.push(root);
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
  fs.writeFileSync(path.join(root, 'other.mjs'), 'x');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-run-'));
  made.push(runDir);
  const norm = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
  return { root, runDir, norm, scope: { files: [norm(path.join(root, 'lib', 'a.mjs')), norm(path.join(root, '.env'))], runMaterial: null } };
}
const cfg = { sift: { enabled: true, url: 'https://x/systemone', model: 'm', concurrency: 8, timeoutMs: 2000 } };
const env = { JEV_API_KEY: 'secret-key-value' };
const answer = (over = {}) => ({
  grounded: { choice: 'yes', probabilities: { yes: 0.9, partly: 0.1, no: 0 } },
  happens: { choice: 'happens', probabilities: { happens: 0.8, unclear: 0.1, does_not: 0.1 } },
  impact: { score: 1.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
  ...over,
});

describe('buildExcerpt', () => {
  it('reads cited lines of a material file with margin', async () => {
    const { root, runDir, scope } = repo();
    const r = await buildExcerpt({ file: 'lib/a.mjs', line: '20' }, { scope, repoRoot: root, runDir });
    assert.equal(r.action, 'asked');
    assert.match(r.text, /^14: line 14$/m);
    assert.match(r.text, /^26: line 26$/m);
  });
  it('refuses a secret path without reading it', async () => {
    const { root, runDir, scope } = repo();
    const r = await buildExcerpt({ file: '.env', line: '1' }, { scope, repoRoot: root, runDir });
    assert.deepEqual(r, { text: '', action: 'secret_path' });
  });
  it('refuses a file outside the material', async () => {
    const { root, runDir, scope } = repo();
    const r = await buildExcerpt({ file: 'other.mjs', line: '1' }, { scope, repoRoot: root, runDir });
    assert.deepEqual(r, { text: '', action: 'not_in_material' });
  });
  it('refuses .ENV in any case and a gitignored credentials file', async () => {
    const { root, runDir, scope } = repo();
    assert.equal((await buildExcerpt({ file: '.ENV', line: '1' }, { scope, repoRoot: root, runDir })).action, 'secret_path');
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'credentials.json'), '{"k":"v"}');
    assert.equal((await buildExcerpt({ file: 'config/credentials.json', line: '1' }, { scope, repoRoot: root, runDir })).action, 'secret_path');
  });
  it('refuses a tracked symlink whose target is a secret, without reading the target', async (t) => {
    const { root, runDir, scope, norm } = repo();
    fs.mkdirSync(path.join(root, 'docs'));
    try {
      fs.symlinkSync(path.join(root, '.env'), path.join(root, 'docs', 'notes.md'), 'file');
    } catch {
      t.skip('symlinks need a privilege on this machine');
      return;
    }
    const withLink = { ...scope, files: [...scope.files, norm(path.join(root, 'docs', 'notes.md'))] };
    const r = await buildExcerpt({ file: 'docs/notes.md', line: '1' }, { scope: withLink, repoRoot: root, runDir });
    assert.equal(r.text, '');
    assert.equal(r.action, 'secret_path');
  });
});

describe('buildExcerpt behind a directory link', () => {
  // A junction needs no privilege on Windows, so this case runs on every machine.
  const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  it('refuses a cited path whose realpath leaves the scope, without reading it', async () => {
    const { root, runDir, scope, norm } = repo();
    fs.mkdirSync(path.join(root, 'private'));
    fs.writeFileSync(path.join(root, 'private', 'a.mjs'), 'hidden');
    link(path.join(root, 'private'), path.join(root, 'lnk'));
    const withLink = { ...scope, files: [...scope.files, norm(path.join(root, 'lnk', 'a.mjs'))] };
    const r = await buildExcerpt({ file: 'lnk/a.mjs', line: '1' }, { scope: withLink, repoRoot: root, runDir });
    assert.deepEqual(r, { text: '', action: 'not_in_material' });
  });
  it('refuses a cited path whose realpath is a secret path', async () => {
    const { root, runDir, scope, norm } = repo();
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'notes.md'), 'key');
    link(path.join(root, '.ssh'), path.join(root, 'docs2'));
    const withLink = { ...scope, files: [...scope.files, norm(path.join(root, 'docs2', 'notes.md'))] };
    const r = await buildExcerpt({ file: 'docs2/notes.md', line: '1' }, { scope: withLink, repoRoot: root, runDir });
    assert.deepEqual(r, { text: '', action: 'secret_path' });
  });
});

describe('buildExcerpt boundaries', () => {
  it('refuses a scope file outside the repository root', async () => {
    const { root, runDir, scope, norm } = repo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'x.mjs'), 'x');
    const wide = { ...scope, files: [...scope.files, norm(path.join(outside, 'x.mjs'))] };
    const r = await buildExcerpt({ file: path.join(outside, 'x.mjs'), line: '1' }, { scope: wide, repoRoot: root, runDir });
    assert.deepEqual(r, { text: '', action: 'outside_root' });
  });
  it('refuses a path with a .git segment and reports a missing file', async () => {
    const { root, runDir, scope } = repo();
    assert.equal((await buildExcerpt({ file: '.git/config', line: '1' }, { scope, repoRoot: root, runDir })).action, 'secret_path');
    assert.equal((await buildExcerpt({ file: 'lib/none.mjs', line: '1' }, { scope, repoRoot: root, runDir })).action, 'missing');
  });
});

describe('buildSiftState', () => {
  it('never exceeds 6000 chars', () => {
    const big = 'x'.repeat(20000);
    const { state, cut } = buildSiftState({ stage: 'code', finding: { id: 'a-1', title: big, detail: big, evidence: big, doneWhen: big, severity: 'minor', seat: 'a' }, excerpt: big, challenges: big });
    assert.ok(state.length <= 6000);
    assert.equal(cut, true);
  });
});

describe('siftFindings', () => {
  it('sends one request per finding and logs no key', async () => {
    const { root, runDir, scope } = repo();
    const bodies = [];
    const fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: answer() }) };
    };
    const findings = [
      { id: 'b-1', seat: 'b', file: 'lib/a.mjs', line: '5', title: 't', detail: 'd', evidence: 'lib/a.mjs:5', doneWhen: 'w', severity: 'important' },
      { id: 'b-2', seat: 'b', file: 'lib/a.mjs', line: '9', title: 't', detail: 'd', evidence: 'e', doneWhen: 'w', severity: 'minor' },
    ];
    const r = await siftFindings({ findings, scope, repoRoot: root, runDir, config: cfg, env, fetch });
    assert.equal(r.status, 'used');
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((b) => b.state.length <= 6000));
    assert.equal('survives' in bodies[0].questions, false);
    const log = fs.readFileSync(path.join(runDir, 'jev.log.jsonl'), 'utf8');
    assert.equal(log.includes('secret-key-value'), false);
  });
  it('asks survives only for a disputed finding', async () => {
    const { root, runDir, scope } = repo();
    const bodies = [];
    const fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: answer({ survives: { choice: 'falls', probabilities: { survives: 0.1, falls: 0.9 } } }) }) };
    };
    const findings = [{ id: 'b-1', seat: 'b', file: 'lib/a.mjs', line: '5', title: 't', evidence: 'e', doneWhen: 'w' }];
    const rebuttals = [{ id: 'b-1', challengers: [{ seat: 'e', reason: 'unreachable' }], standsFirm: false, rebuttal: 'agreed' }];
    const r = await siftFindings({ findings, rebuttals, scope, repoRoot: root, runDir, config: cfg, env, fetch });
    assert.ok('survives' in bodies[0].questions);
    assert.match(bodies[0].state, /unreachable/);
    assert.deepEqual(r.readingOrder, ['b-1']);
  });
  it('does not skip directory material, and scopes it to git-listed files', async () => {
    const { root, runDir, norm } = repo();
    const bodies = [];
    const fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: answer() }) };
    };
    const runChild = async () => ({ code: 0, stdout: 'lib/a.mjs\0', stderr: '' });
    const scope = await materialScopeOf({ repoRoot: root, materialKind: 'dir', material: { kind: 'dir', path: root } }, runChild);
    assert.deepEqual(scope.files, [norm(path.join(root, 'lib', 'a.mjs'))]);
    const r = await siftFindings({ findings: [{ id: 'b-1', seat: 'b', file: 'lib/a.mjs', line: '1' }], scope, repoRoot: root, runDir, config: cfg, env, fetch });
    assert.equal(r.status, 'used');
    assert.match(bodies[0].state, /1: line 1/);
  });
  it('gives no excerpt for directory material outside git (fail closed)', async () => {
    const { root, runDir } = repo();
    const runChild = async () => ({ code: 128, stdout: '', stderr: 'not a git repository' });
    const scope = await materialScopeOf({ repoRoot: root, materialKind: 'dir', material: { kind: 'dir', path: root } }, runChild);
    assert.deepEqual(scope.files, []);
    const r = await buildExcerpt({ file: 'lib/a.mjs', line: '1' }, { scope, repoRoot: root, runDir });
    assert.equal(r.action, 'not_in_material');
  });
  it('reports all-failed when every request fails', async () => {
    const { root, runDir, scope } = repo();
    const r = await siftFindings({ findings: [{ id: 'b-1', seat: 'b' }], scope, repoRoot: root, runDir, config: cfg, env, fetch: async () => ({ ok: false, status: 500, text: async () => '' }) });
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'all-failed');
  });
  it('the overall deadline aborts open requests', async () => {
    const { root, runDir, scope } = repo();
    const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
    const t0 = Date.now();
    const r = await siftFindings({ findings: [{ id: 'b-1', seat: 'b' }, { id: 'b-2', seat: 'b' }], scope, repoRoot: root, runDir, config: { sift: { ...cfg.sift, timeoutMs: 50 } }, env, fetch: hang });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.reason, 'all-failed');
  });
  it('skips with no key and when disabled', async () => {
    assert.equal((await siftFindings({ findings: [{ id: 'a' }], config: cfg, env: {} })).reason, 'no-key');
    assert.equal((await siftFindings({ findings: [{ id: 'a' }], config: { sift: { enabled: false } }, env })).reason, 'disabled');
  });
});

describe('readingOrderOf and compareSift', () => {
  const rows = [
    { id: 'a', status: 'used', p: { happens: { does_not: 0.9 }, grounded: { yes: 0.9 } } },
    { id: 'b', status: 'used', p: { happens: { does_not: 0.1 }, grounded: { yes: 0.2 } } },
    { id: 'c', status: 'used', p: { happens: { does_not: 0.1 }, grounded: { yes: 0.8 } } },
    { id: 'd', status: 'failed', p: null },
  ];
  it('puts does_not first, then low grounded, and leaves failed rows out', () => {
    assert.deepEqual(readingOrderOf(rows), ['a', 'b', 'c']);
  });
  it('flags a kept finding that Jev says does not happen', () => {
    const sift = { status: 'used', rows: [{ id: 'a', status: 'used', p: { happens: { does_not: 0.9, happens: 0.1 }, survives: null }, impact: 0.5 }] };
    const d = compareSift(sift, { closingList: [{ sources: ['a'] }], advisory: [] }, [{ id: 'a' }]);
    assert.equal(d.disagreements[0].type, 'judge-kept-falls');
  });
});

describe('materialScopeOf', () => {
  it('lists diff files and untracked files', async () => {
    const scope = await materialScopeOf({
      repoRoot: '/r',
      materialKind: 'diff',
      materialPath: '/run/material.diff',
      material: { kind: 'diff', text: '# Untracked files (new files, read them from disk):\nnew.mjs\n\ndiff --git a/lib/a.mjs b/lib/a.mjs\n' },
    });
    assert.deepEqual(scope.files.sort(), ['/r/lib/a.mjs', '/r/new.mjs']);
    assert.equal(scope.runMaterial, '/run/material.diff');
  });
});

describe('findKey', () => {
  it('still reads JEV_API_KEY first', async () => {
    assert.equal(await findKey({}, { JEV_API_KEY: ' k ' }), 'k');
  });
});

describe('live Jev', { skip: !process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY }, () => {
  it('answers one focused request', async () => {
    const { root, runDir, scope } = repo();
    const r = await siftFindings({ findings: [{ id: 'b-1', seat: 'b', file: 'lib/a.mjs', line: '5', title: 'off by one', evidence: 'lib/a.mjs:5', doneWhen: 'w' }], scope, repoRoot: root, runDir, config: { sift: { enabled: true, timeoutMs: 30000 } }, env: process.env });
    assert.ok(['used', 'skipped'].includes(r.status));
  });
});
