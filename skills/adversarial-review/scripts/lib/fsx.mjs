// Atomic file writes, resilient renames, and safe JSON line helpers.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export async function renameWithRetry(from, to, { totalMs = 2000, rename = fs.rename } = {}) {
  const start = Date.now();
  let delay = 25;
  while (true) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        throw err;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= totalMs) {
        throw err;
      }
      const waitTime = Math.min(delay, Math.max(1, totalMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay *= 2;
    }
  }
}

export async function writeFileAtomic(file, data, options = {}) {
  const rand = crypto.randomBytes(4).toString('hex');
  const tmp = `${file}.tmp-${rand}`;
  try {
    await fs.writeFile(tmp, data);
    await renameWithRetry(tmp, file, options);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readJsonSafe(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, missing: true, error: err.message };
    }
    return { ok: false, missing: false, error: err?.message || String(err) };
  }
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, missing: false, error: err?.message || String(err) };
  }
}

export async function appendJsonLine(file, obj) {
  await fs.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

export async function readJsonLines(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  if (!text.endsWith('\n')) {
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) {
      return [];
    }
    text = text.slice(0, lastNl);
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignored: skips unparseable lines.
    }
  }
  return out;
}
