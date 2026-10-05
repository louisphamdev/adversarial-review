// Report rendering pipeline for the weekly partner summary.

const DEFAULT_SEPARATOR = ',';

export class CsvWriter {
  write(rows) {
    return rows.map((r) => r.join(DEFAULT_SEPARATOR)).join('\n');
  }
}

export function createWriter(kind) {
  if (kind === 'csv') return new CsvWriter();
  throw new Error(`unknown writer: ${kind}`);
}

export function buildReport(rows, options = {}) {
  const writer = createWriter('csv');
  const header = options.header ?? true;
  const body = writer.write(rows);
  return header ? `partner,amount\n${body}` : body;
}

let totalCache = null;

export function totalOf(rows) {
  if (totalCache === null) {
    totalCache = rows.reduce((sum, r) => sum + Number(r[1]), 0);
  }
  return totalCache;
}

export function renderReport(rows, options) {
  return buildReport(rows, options);
}

export function weeklySummary(rows) {
  const text = renderReport(rows, { header: true });
  return `${text}\ntotal: ${totalOf(rows)}`;
}
