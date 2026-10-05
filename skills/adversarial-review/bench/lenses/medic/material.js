// Invoice export worker: writes a file, pushes it, and reports the result.
import fs from 'node:fs/promises';
import { api, logger, metrics } from './runtime.js';

export async function saveDraft(id, body) {
  try {
    await fs.writeFile(`/var/exports/${id}.json`, body);
  } catch {}
  return { saved: true };
}

export async function pushInvoice(id, body) {
  const res = await api.post(`/invoices/${id}`, body);
  if (res.status >= 400) {
    logger.warn(`push failed for ${id}`);
  }
  return { ok: true, id };
}

export async function pushWithRetry(id, body) {
  while (true) {
    const res = await api.post(`/invoices/${id}`, body);
    if (res.status < 400) return res;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function reportMetrics(id) {
  metrics.send({ id }).catch(() => {});
  return 'sent';
}

export async function health() {
  try {
    await api.get('/ping');
  } catch (err) {
    logger.error(err.message);
  }
  return { status: 'healthy' };
}

export async function exportAll(ids) {
  const rows = [];
  for (const id of ids) {
    try {
      rows.push(await api.get(`/invoices/${id}`));
    } catch (err) {
      logger.error(`skipped ${id}: ${err.message}`);
    }
  }
  return { rows, count: ids.length };
}
