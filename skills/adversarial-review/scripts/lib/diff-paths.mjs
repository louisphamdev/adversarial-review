// File paths named by diff material, and the containment check every such path must pass.
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Decode the C-quoted form git uses for a path with special characters.
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeGitPath(s) {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const n = body[i + 1];
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      const map = { n: 10, t: 9, '"': 34, '\\': 92 };
      bytes.push(map[n] ?? n.charCodeAt(0));
      i += 1;
      continue;
    }
    bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The new-side path of every file section in a git diff.
 * A hunk line that adds `++ x` reads as `+++ x`, so a path counts only from a `+++ ` line that
 * directly follows a `--- ` line, inside a `diff --git` section and before its first `@@`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function materialDiffPaths(text) {
  const out = new Set();
  let inHeader = false;
  let prevMinus = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      prevMinus = false;
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (prevMinus && line.startsWith('+++ ')) {
      const name = line.slice(4);
      if (name !== '/dev/null') out.add(decodeGitPath(name).replace(/^b\//, ''));
      prevMinus = false;
      continue;
    }
    prevMinus = line.startsWith('--- ');
  }
  return [...out];
}

function isInside(root, target, platform) {
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(root), fold(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The real path of `rel` under `root`, or null when `rel` could leave it: an absolute, drive, or
 * UNC form, a `..` part, or a link whose target is outside realpath(root).
 *
 * @param {string} root
 * @param {string} rel
 * @param {{ platform?: string }} [options]
 * @returns {Promise<string|null>}
 */
export async function containedPath(root, rel, { platform = process.platform } = {}) {
  const s = String(rel ?? '');
  if (!s || s.includes('\0')) return null;
  if (path.posix.isAbsolute(s) || path.win32.isAbsolute(s) || /^[A-Za-z]:/.test(s)) return null;
  if (s.split(/[\\/]/).includes('..')) return null;
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(path.join(realRoot, s));
    return isInside(realRoot, real, platform) ? real : null;
  } catch {
    return null;
  }
}
