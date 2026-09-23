// Paths and repository keys across Linux, macOS, and Windows.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

// Resolves the user home directory using the injected environment.
export function homeDir(env = process.env) {
  if (env && env.ADVERSARIAL_REVIEW_HOME) {
    return env.ADVERSARIAL_REVIEW_HOME;
  }
  if (env && (env.HOME || env.USERPROFILE)) {
    return env.HOME || env.USERPROFILE;
  }
  return os.homedir();
}

// User state directory: <state> = <home>/.adversarial-review.
export function stateDir(env = process.env) {
  return path.join(homeDir(env), '.adversarial-review');
}

// Normalizes Windows paths: strips extended prefixes, converts slashes, lowercases.
export function normalizeWinPath(p) {
  if (typeof p !== 'string') return '';
  let s = p;
  if (/^(\\\\[?]\\UNC\\|\/\/\?\/UNC\/)/i.test(s)) {
    s = '//' + s.slice(8);
  } else if (/^(\\\\[?]\\|\/\/\?\/)/.test(s)) {
    s = s.slice(4);
  }
  s = s.replace(/\\/g, '/');
  return s.toLowerCase();
}

// Canonical path: native realpath with case normalization per platform.
export function canonicalPath(p, platform = process.platform) {
  let real;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    try {
      const pMod = platform === 'win32' ? path.win32 : path;
      const abs = pMod.resolve(p);
      const parentReal = fs.realpathSync.native(pMod.dirname(abs));
      real = path.join(parentReal, pMod.basename(abs));
    } catch {
      const pMod = platform === 'win32' ? path.win32 : path;
      real = pMod.resolve(p);
    }
  }
  if (platform === 'win32') {
    return normalizeWinPath(real);
  }
  if (platform === 'darwin') {
    return real.toLowerCase();
  }
  return real;
}

// Replaces characters outside [A-Za-z0-9._-] with underscore.
export function safeName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Stable 12-hex hash plus safe directory name for user-state runs grouping.
export function repoKey(root, platform = process.platform) {
  const canonical = canonicalPath(root, platform);
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  const base = (platform === 'win32' ? path.win32.basename(canonical) : path.posix.basename(canonical)) || 'root';
  return `${hash}-${safeName(base)}`;
}

// Runs directory under state, optionally partitioned by repository key.
export function runsDir(env, root) {
  const base = path.join(stateDir(env), 'runs');
  return root ? path.join(base, repoKey(root)) : base;
}

// Checks if child path resolves inside parent directory after canonicalization.
export function isInside(child, parent, platform = process.platform) {
  const cChild = canonicalPath(child, platform);
  const cParent = canonicalPath(parent, platform);
  const rel = platform === 'win32'
    ? path.win32.relative(cParent, cChild)
    : path.posix.relative(cParent, cChild);
  const isAbs = platform === 'win32'
    ? path.win32.isAbsolute(rel)
    : path.posix.isAbsolute(rel);
  return !rel.startsWith('..') && !isAbs;
}
