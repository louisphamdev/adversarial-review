// Per-session gate state persistence.
//
// State is a small JSON file per session under `stateDir`. It holds the
// session baseline (recorded by the SessionStart hook in a later task), a
// consecutive-block counter, and a review-pass cache keyed by reviewCacheKey.
//
// All reads are tolerant: a missing or corrupt file yields a default `{}` so
// the gate never crashes on a fresh or damaged state directory. Writes are
// atomic (temp file + rename) and use owner-only permissions where supported.

import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./hash.js";

// Owner read/write only. Honored on POSIX; a no-op effect on Windows but safe.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Derive a safe on-disk file name for a session id. The id is hashed so that
 * arbitrary characters (path separators, etc.) in a host-provided session id
 * cannot escape the state directory.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function sessionFileName(sessionId) {
  return `session-${sha256(String(sessionId || "default"))}.json`;
}

/**
 * Read the persisted state for a session.
 *
 * @param {string} stateDir
 * @param {string} sessionId
 * @returns {Promise<object>} the stored state, or `{}` if missing/corrupt.
 */
export async function readSessionState(stateDir, sessionId) {
  const file = join(stateDir, sessionFileName(sessionId));
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    // Corrupt JSON: treat as empty rather than crashing the gate.
    return {};
  }
}

/**
 * Atomically persist a session's state. Writes a temp file then renames it into
 * place so a concurrent reader never observes a half-written file.
 *
 * @param {string} stateDir
 * @param {string} sessionId
 * @param {object} state
 * @returns {Promise<void>}
 */
export async function writeSessionState(stateDir, sessionId, state) {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  const file = join(stateDir, sessionFileName(sessionId));
  // Unique temp name so concurrent writers do not clobber each other's temp. Use a
  // random UUID rather than Date.now(): two writes in the SAME process AND the SAME
  // millisecond would otherwise pick the same temp path and race (one rename hits
  // ENOENT, or an update is lost). randomUUID() is collision-free. (audit ROUND7)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload = { ...state, updatedAt: Date.now() };
  await writeFile(tmp, JSON.stringify(payload), { mode: FILE_MODE });
  await rename(tmp, file);
}

/**
 * Delete session state files whose last update is older than `ttlDays`.
 * Tolerant of unreadable entries and a missing state directory.
 *
 * @param {string} stateDir
 * @param {number} ttlDays
 * @param {number} [now=Date.now()]
 * @returns {Promise<number>} count of files removed.
 */
export async function pruneState(stateDir, ttlDays, now = Date.now()) {
  let entries;
  try {
    entries = await readdir(stateDir);
  } catch {
    return 0;
  }
  const ttlMs = Math.max(0, Number(ttlDays) || 0) * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
    const file = join(stateDir, name);
    try {
      const info = await stat(file);
      if (now - info.mtimeMs > ttlMs) {
        await unlink(file);
        removed += 1;
      }
    } catch {
      // Ignore races / unreadable entries.
    }
  }
  return removed;
}
