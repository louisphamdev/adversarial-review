// Upload session bookkeeping shared by every request handler.
import fs from 'node:fs/promises';
import { bus, store, lock } from './runtime.js';

const cache = new Map();

export async function writeOnce(file, body) {
  const exists = await fs.access(file).then(() => true, () => false);
  if (exists) return 'skipped';
  await fs.writeFile(file, body);
  return 'written';
}

export async function bumpUploads(userId) {
  const row = await store.read(userId);
  const next = row.uploads + 1;
  await store.write(userId, { ...row, uploads: next });
  return next;
}

export function startProgress(sessionId, onTick) {
  setInterval(() => onTick(sessionId), 1000);
}

export function watchSession(sessionId, handler) {
  bus.on(`session:${sessionId}`, handler);
  return () => handler;
}

export async function loadManifest(key, fetchManifest) {
  if (cache.has(key)) return cache.get(key);
  const value = await fetchManifest(key);
  cache.set(key, value);
  return value;
}

export async function finishSession(sessionId) {
  await lock.acquire(sessionId);
  const row = await store.read(sessionId);
  if (!row) return 'missing';
  await store.write(sessionId, { ...row, done: true });
  await lock.release(sessionId);
  return 'done';
}
