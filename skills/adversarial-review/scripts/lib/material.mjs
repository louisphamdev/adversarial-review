// Material resolution, diff extraction, and deterministic tree hashing.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPath } from './paths.mjs';
import { runChild as procRunChild } from './proc.mjs';
import { ConfigError } from './errors.mjs';

// Normalizes CRLF and CR to LF.
export function normalizeDiff(diffText) {
  if (typeof diffText !== 'string') return '';
  return diffText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countLines(text) {
  if (!text || text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') || text.endsWith('\r') ? lines.length - 1 : lines.length;
}

export const LARGE_MATERIAL = { lines: 4000, files: 30 };

// Line counts per top-level directory, largest first. A file at the top level counts under ".".
function bySubsystem(entries) {
  const totals = new Map();
  for (const { relPath, lines } of entries) {
    const parts = relPath.split('/');
    const dir = parts.length > 1 ? parts[0] : '.';
    totals.set(dir, (totals.get(dir) || 0) + lines);
  }
  return [...totals].map(([dir, lines]) => ({ dir, lines })).sort((a, b) => b.lines - a.lines || (a.dir < b.dir ? -1 : 1));
}

// Added and removed lines per file of a git diff. Header lines before the first hunk never count.
function diffLineEntries(diffText) {
  const entries = [];
  let cur = null;
  for (const line of diffText.split('\n')) {
    const head = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (head) {
      cur = { relPath: head[1], lines: 0, inHunk: false };
      entries.push(cur);
    } else if (cur && line.startsWith('@@')) {
      cur.inHunk = true;
    } else if (cur?.inHunk && (line.startsWith('+') || line.startsWith('-'))) {
      cur.lines += 1;
    }
  }
  return entries;
}

// A warning that names the split, or null. A large material never blocks a run.
export function materialSizeWarning(material = {}) {
  const subsystems = material.subsystems || [];
  const lines = subsystems.reduce((n, s) => n + s.lines, 0);
  const files = material.files || 0;
  if (lines <= LARGE_MATERIAL.lines && files <= LARGE_MATERIAL.files) return null;
  const split = subsystems.map((s) => `${s.dir} ${s.lines} lines`).join(', ');
  const what = material.kind === 'diff' ? 'changed lines' : 'lines';
  return `The material is large: ${lines} ${what} in ${files} files (limits: ${LARGE_MATERIAL.lines} lines, ${LARGE_MATERIAL.files} files). Run one table per subsystem: ${split}.`;
}

function hashDiff(diffText, commit) {
  const norm = normalizeDiff(diffText);
  const c = (commit || '').trim();
  return crypto.createHash('sha256').update(norm).update(c).digest('hex');
}

async function walkDir(dir) {
  const entries = [];
  async function recurse(current) {
    const dirents = await fs.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === '.git') continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await recurse(fullPath);
      } else if (dirent.isFile()) {
        const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
        const content = await fs.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const lines = countLines(content.toString('utf8'));
        entries.push({ relPath, fileHash, lines });
      }
    }
  }
  await recurse(dir);
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hasher = crypto.createHash('sha256');
  let totalLines = 0;
  for (const e of entries) {
    hasher.update(`${e.relPath} ${e.fileHash}\n`);
    totalLines += e.lines;
  }
  return {
    files: entries.length,
    lines: totalLines,
    hash: hasher.digest('hex'),
    subsystems: bySubsystem(entries),
  };
}

async function getDiffMaterial(root, base, runChild) {
  const diffRes = await runChild({
    cmd: 'git',
    args: ['diff', '--no-color', base],
    cwd: root,
  });
  if (diffRes.code !== 0) {
    throw new ConfigError(`git diff failed: ${diffRes.stderr || 'exit ' + diffRes.code}`);
  }

  const untrackedRes = await runChild({
    cmd: 'git',
    args: ['ls-files', '--others', '--exclude-standard'],
    cwd: root,
  });
  if (untrackedRes.code !== 0) {
    throw new ConfigError(`git ls-files failed: ${untrackedRes.stderr || 'exit ' + untrackedRes.code}`);
  }

  const untrackedFiles = untrackedRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  const normalizedDiff = normalizeDiff(diffRes.stdout);
  if (!normalizedDiff.trim() && untrackedFiles.length === 0) {
    throw new ConfigError('Working directory is clean (empty diff and no untracked files)');
  }

  let fullText = '';
  if (untrackedFiles.length > 0) {
    fullText += '# Untracked files (new files, read them from disk):\n';
    for (const f of untrackedFiles) {
      fullText += `${f}\n`;
    }
    if (normalizedDiff.trim()) {
      fullText += '\n';
    }
  }
  if (normalizedDiff.trim()) {
    fullText += normalizedDiff;
  }

  const diffFileMatches = normalizedDiff.match(/^diff --git a\/.* b\/(.*)$/gm) || [];
  const changedFiles = new Set(untrackedFiles);
  for (const header of diffFileMatches) {
    const m = header.match(/^diff --git a\/.* b\/(.*)$/);
    if (m && m[1]) {
      changedFiles.add(m[1]);
    }
  }
  const files = Math.max(changedFiles.size, untrackedFiles.length + (diffFileMatches.length > 0 ? 1 : 0));
  const lines = countLines(fullText);

  const commitRes = await runChild({ cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: root });
  const commit = commitRes.code === 0 ? commitRes.stdout.trim() : '';
  const hash = hashDiff(fullText, commit);

  return { text: fullText, files, lines, hash, commit, untrackedFiles };
}

// Resolves review material from a file, directory, or working tree git diff.
export async function resolveMaterial({
  target,
  base = 'HEAD',
  cwd = process.cwd(),
  runChild = procRunChild,
} = {}) {
  if (!target) {
    const topRes = await runChild({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd });
    if (topRes.code !== 0 || !topRes.stdout.trim()) {
      throw new ConfigError('Not a git repository and no target specified');
    }
    const root = canonicalPath(topRes.stdout.trim());
    const diffMat = await getDiffMaterial(root, base, runChild);
    const untracked = await Promise.all(diffMat.untrackedFiles.map(async (relPath) => ({
      relPath,
      lines: await fs.readFile(path.join(root, relPath), 'utf8').then(countLines, () => 0),
    })));
    return {
      kind: 'diff',
      root,
      targetPath: null,
      path: null,
      text: diffMat.text,
      files: diffMat.files,
      lines: diffMat.lines,
      hash: diffMat.hash,
      base,
      subsystems: bySubsystem([...diffLineEntries(normalizeDiff(diffMat.text)), ...untracked]),
    };
  }

  const resolvedTarget = path.resolve(cwd, target);
  let st;
  try {
    st = await fs.stat(resolvedTarget);
  } catch {
    throw new ConfigError(`Target does not exist: ${target}`);
  }

  const checkDir = st.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
  const topRes = await runChild({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd: checkDir });
  let root;
  if (topRes.code === 0 && topRes.stdout.trim()) {
    root = canonicalPath(topRes.stdout.trim());
  } else {
    root = canonicalPath(checkDir);
  }

  const targetPath = canonicalPath(resolvedTarget);
  if (st.isFile()) {
    const fileBytes = await fs.readFile(resolvedTarget);
    const text = fileBytes.toString('utf8');
    const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    return {
      kind: 'file',
      root,
      targetPath,
      path: targetPath,
      text,
      files: 1,
      lines: countLines(text),
      hash,
      subsystems: [{ dir: '.', lines: countLines(text) }],
    };
  }

  if (st.isDirectory()) {
    const dirInfo = await walkDir(resolvedTarget);
    return {
      kind: 'dir',
      root,
      targetPath,
      path: targetPath,
      files: dirInfo.files,
      lines: dirInfo.lines,
      hash: dirInfo.hash,
      subsystems: dirInfo.subsystems,
    };
  }

  throw new ConfigError(`Invalid target: ${target}`);
}

// Recomputes material hash for resume verification.
export async function hashMaterial(material, { runChild = procRunChild } = {}) {
  if (!material || typeof material !== 'object') {
    throw new ConfigError('Invalid material object for hash recomputation');
  }

  if (material.kind === 'file') {
    const filePath = material.targetPath || material.path;
    const bytes = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  if (material.kind === 'dir') {
    const dirPath = material.targetPath || material.path || material.root;
    const dirInfo = await walkDir(dirPath);
    return dirInfo.hash;
  }

  if (material.kind === 'diff') {
    if (material.root) {
      const base = material.base || 'HEAD';
      const diffMat = await getDiffMaterial(material.root, base, runChild);
      return diffMat.hash;
    }
    if (material.text != null) {
      return hashDiff(material.text, material.commit || '');
    }
    throw new ConfigError('Cannot recompute diff hash without root or text');
  }

  throw new ConfigError(`Unknown material kind: ${material.kind}`);
}
