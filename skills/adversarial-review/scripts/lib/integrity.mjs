// Repository integrity baseline (spec 3.1-A, A10 and section 10 G2-4).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { runChild as defaultRunChild } from './proc.mjs';
import { readJsonSafe, writeFileAtomic } from './fsx.mjs';

// Prepended to every git call the engine makes in the user repository: the repository config
// must not be able to run code through a call that the engine itself started.
export function safeGitArgs(hooksDir) {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksDir}`];
}

async function emptyHooksDir() {
  const dir = path.join(os.tmpdir(), 'ar-empty-hooks');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listIntegrityPaths(repoRoot, { hooksDir, runChild = defaultRunChild } = {}) {
  const hooks = hooksDir || (await emptyHooksDir());
  const res = await runChild({
    cmd: 'git',
    args: [...safeGitArgs(hooks), 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
    cwd: repoRoot,
  });
  if (res.code !== 0) return walk(repoRoot);
  // `-z` keeps git from quoting a non-ASCII name, so the path is the literal name.
  const list = res.stdout.split('\0').filter(Boolean);
  list.push('.git/config');
  try {
    for (const f of await fs.readdir(path.join(repoRoot, '.git', 'hooks'))) list.push(`.git/hooks/${f}`);
  } catch { /* no hooks dir */ }
  return [...new Set(list)].sort();
}

async function walk(root, rel = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (['.git', 'node_modules', '.adversarial-review'].includes(e.name)) continue;
      out.push(...(await walk(root, r)));
    } else out.push(r);
  }
  return out.sort();
}

async function sha256File(file) {
  const h = createHash('sha256');
  await new Promise((resolve, reject) =>
    createReadStream(file).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject)
  );
  return h.digest('hex');
}

export async function hashRepo(repoRoot, opts = {}) {
  const files = {};
  for (const rel of await listIntegrityPaths(repoRoot, opts)) {
    const abs = path.join(repoRoot, rel);
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      // A listed path that is gone is a result, not a fault: the comparison needs the entry.
      if (err.code === 'ENOENT') { files[rel] = 'deleted'; continue; }
      throw err;
    }
    files[rel] = st.isFile() ? await sha256File(abs) : 'not-regular';
  }
  return { files };
}

export function compareBaseline(baseline, current) {
  const a = baseline?.files || {};
  const b = current?.files || {};
  const added = [], removed = [], modified = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) { if (b[k] !== 'deleted') added.push(k); }
    else if (b[k] === 'deleted' && a[k] !== 'deleted') removed.push(k);
    else if (b[k] !== a[k]) modified.push(k);
  }
  for (const k of Object.keys(a)) if (!(k in b) && a[k] !== 'deleted') removed.push(k);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

// The sandbox cleanup must never delete this directory, so it sits beside `sandbox/`, not inside it.
const dirOf = (runDir) => path.join(runDir, 'integrity');

export async function writeIntegrity(runDir, { baseline, state } = {}) {
  await fs.mkdir(dirOf(runDir), { recursive: true });
  if (baseline) await writeFileAtomic(path.join(dirOf(runDir), 'baseline.json'), JSON.stringify(baseline));
  if (state) await writeFileAtomic(path.join(dirOf(runDir), 'state.json'), JSON.stringify(state));
}

export async function readIntegrity(runDir) {
  const read = async (name) => {
    const res = await readJsonSafe(path.join(dirOf(runDir), name));
    // A file that is absent and a file that does not parse are two different states for the
    // caller: the first one starts a baseline, the second one is a lost baseline.
    return res.ok ? { value: res.value } : { error: res.missing ? 'missing' : 'corrupt' };
  };
  const b = await read('baseline.json');
  const s = await read('state.json');
  return { baseline: b.value ?? null, state: s.value ?? null, error: b.error || null };
}
