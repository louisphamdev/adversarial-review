// Diff collection and pure diff helpers for verify. Never runs `git add`; never touches the index.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeDiff } from './material.mjs';
import { ConfigError } from './errors.mjs';

const BASE_RE = /^[A-Za-z0-9._/~^@{}-]+$/;

export function validateBase(base) {
  if (typeof base !== 'string' || !BASE_RE.test(base) || base.startsWith('-')) {
    throw new ConfigError(`Invalid --base "${base}": give a commit, branch, or tag name.`);
  }
  return base;
}

export async function resolveBase(root, base, runChild) {
  validateBase(base);
  const r = await runChild({ cmd: 'git', args: ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], cwd: root });
  if (r.code !== 0) throw new ConfigError(`verify needs a git repository and a commit for --base "${base}": ${r.stderr || `exit ${r.code}`}`);
  return r.stdout.trim();
}

const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

async function untrackedEntry(root, rel, fsImpl) {
  const abs = path.join(root, rel);
  try {
    const st = await fsImpl.lstat(abs);
    if (st.isSymbolicLink()) return { path: rel, sha256: `symlink:${await fsImpl.readlink(abs)}` };
    if (st.size > MAX_UNTRACKED_BYTES) return { path: rel, sha256: `too_large:${st.size}` };
    const buf = await fsImpl.readFile(abs);
    return { path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch {
    return { path: rel, sha256: 'unreadable' };
  }
}

export async function collectDiff(root, baseSha, runChild, { fsImpl = fs } = {}) {
  const d = await runChild({ cmd: 'git', args: ['-c', 'core.quotepath=false', 'diff', '--no-color', baseSha, '--'], cwd: root });
  if (d.code !== 0) throw new ConfigError(`verify needs a git repository: git diff failed: ${d.stderr || `exit ${d.code}`}`);
  const u = await runChild({ cmd: 'git', args: ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard'], cwd: root });
  if (u.code !== 0) throw new ConfigError(`verify needs a git repository: git ls-files failed: ${u.stderr || `exit ${u.code}`}`);
  const diff = normalizeDiff(d.stdout);
  const names = u.stdout.split('\0').filter(Boolean).sort();
  const untracked = [];
  for (const rel of names) untracked.push(await untrackedEntry(root, rel, fsImpl));
  if (!diff.trim() && untracked.length === 0) throw new ConfigError('Empty diff: nothing to verify');
  const lines = untracked.map((e) => `${e.path} ${e.sha256}`).join('\n');
  const diffHash = crypto.createHash('sha256').update(`${diff}\n#untracked\n${lines}`).digest('hex');
  return { diff, untracked, diffHash };
}

// A one-file review is verified against the text the table read. A git diff cannot replace this:
// a spec under an ignored temp/ never shows in it, and the seats would verify unrelated code instead.
export async function collectSnapshotDiff({ snapshotPath, targetPath, root, runChild }) {
  const d = await runChild({ cmd: 'git', args: ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--', snapshotPath, targetPath], cwd: root });
  if (d.code !== 0 && d.code !== 1) throw new ConfigError(`verify cannot compare the reviewed snapshot with ${targetPath}: ${d.stderr || `exit ${d.code}`}`);
  const hunks = normalizeDiff(d.stdout).replace(/^[\s\S]*?(?=^@@ )/m, '');
  if (!hunks.trim()) throw new ConfigError('Empty diff: the file is the same as the reviewed snapshot, nothing to verify');
  const rel = path.relative(root, targetPath).split(path.sep).join('/');
  const diff = `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n${hunks}`;
  const diffHash = crypto.createHash('sha256').update(diff).digest('hex');
  return { diff, untracked: [], diffHash };
}

export function unquoteGitPath(p) {
  const s = String(p ?? '');
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const body = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i];
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 })[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function normalizeSeatPath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function headerPath(raw) {
  let s = String(raw ?? '').replace(/\t.*$/, '').trim();
  s = unquoteGitPath(s);
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

export function splitFileBlocks(diff) {
  const out = new Map();
  const parts = String(diff ?? '').split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  for (const block of parts) {
    const keys = new Set();
    for (const line of block.split('\n')) {
      if (line.startsWith('--- ')) {
        const k = headerPath(line.slice(4));
        if (k) keys.add(k);
      } else if (line.startsWith('+++ ')) {
        const k = headerPath(line.slice(4));
        if (k) keys.add(k);
      } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
        keys.add(unquoteGitPath(line.replace(/^rename (from|to) /, '').trim()));
      } else if (line.startsWith('@@')) {
        break;
      }
    }
    if (keys.size === 0) {
      // A binary or mode-only block has no ---/+++ lines: key it by both paths of its first line.
      const m = block.match(/^diff --git ("[^"]+"|\S+) ("[^"]+"|\S+)/);
      if (m) for (const p of [m[1], m[2]]) keys.add(headerPath(p));
    }
    for (const k of keys) out.set(k, block.replace(/\n+$/, ''));
  }
  return out;
}

const pushRange = (arr, n) => {
  const last = arr[arr.length - 1];
  if (last && last[1] === n - 1) last[1] = n;
  else arr.push([n, n]);
};

export function diffRanges(diff) {
  const blocks = splitFileBlocks(diff);
  const byBlock = new Map();
  const out = new Map();
  for (const [key, block] of blocks) {
    if (!byBlock.has(block)) {
      const r = { added: [], removed: [] };
      let oldLine = 0;
      let newLine = 0;
      let inHunk = false;
      for (const line of block.split('\n')) {
        const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) {
          oldLine = Number(h[1]);
          newLine = Number(h[2]);
          inHunk = true;
          continue;
        }
        if (!inHunk) continue;
        if (line.startsWith('+')) pushRange(r.added, newLine++);
        else if (line.startsWith('-')) pushRange(r.removed, oldLine++);
        else if (line.startsWith(' ')) {
          oldLine++;
          newLine++;
        }
      }
      byBlock.set(block, r);
    }
    out.set(key, byBlock.get(block));
  }
  return out;
}

export function interdiff(prev = {}, next = {}) {
  const a = splitFileBlocks(prev.diff);
  const b = splitFileBlocks(next.diff);
  const out = [];
  const seen = new Set();
  for (const [k, block] of b) {
    if (seen.has(block)) continue;
    seen.add(block);
    if (a.get(k) !== block) out.push(block);
  }
  const seenOld = new Set();
  for (const [k, block] of a) {
    if (b.has(k) || seenOld.has(block)) continue;
    seenOld.add(block);
    out.push(`reverted: ${k}\n${block}`);
  }
  const asMap = (list) => new Map((list || []).map((e) => (typeof e === 'string' ? [e, null] : [e.path, e.sha256])));
  const pu = asMap(prev.untracked);
  const nu = asMap(next.untracked);
  for (const [f, h] of nu) {
    if (!pu.has(f)) out.push(`untracked added: ${f}`);
    else if (pu.get(f) !== h) out.push(`untracked changed: ${f}`);
  }
  for (const f of pu.keys()) if (!nu.has(f)) out.push(`untracked removed: ${f}`);
  return out.join('\n');
}

export function isChangedLine({ ranges, untracked = [], entry }) {
  const file = normalizeSeatPath(entry?.file);
  const line = Number(entry?.line);
  const side = entry?.side === 'old' ? 'old' : 'new';
  if (!file || !Number.isInteger(line)) return false;
  if (side === 'new' && untracked.map((e) => normalizeSeatPath(typeof e === 'string' ? e : e.path)).includes(file)) return true;
  const r = ranges.get(file);
  if (!r) return false;
  const list = side === 'old' ? r.removed : r.added;
  return list.some(([from, to]) => line >= from && line <= to);
}
