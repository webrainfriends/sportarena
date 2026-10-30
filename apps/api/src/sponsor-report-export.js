// Report exports (#305): the CSV, XLSX and branded PDF are all built from the SAME report object the dashboard shows, so an export
// reconciles with the screen (and with the source totals) by construction. Amounts are exported in minor units (`*_cents`) with their
// currency, like every other sponsorship export; the XLSX also carries the reporting basis and data-source flags on a second sheet.
import { toCsv } from './csv.js';
import { buildXlsx } from './xlsx.js';
import { renderSponsorshipReport } from './documents/render.js';

export const FORMATS = { csv: { type: 'text/csv; charset=utf-8', ext: 'csv' }, xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' }, pdf: { type: 'application/pdf', ext: 'pdf' } };

const basisRows = (r) => [['Item', 'Value'], ['Report', r.kind], ['View', r.view], ['As of', r.basis.as_of], ['Currency basis', r.basis.currency_basis === 'reporting' ? `converted to ${r.basis.currency}` : 'native (each currency apart)'],
  ['Cash and estimates', 'separate'], ['Generated at (UTC)', r.basis.generated_at], ...r.basis.notes.map((n) => ['Note', n]), ...r.sources.map((s) => [`Source: ${s.label}`, `${s.status.toUpperCase()} — ${s.detail}`])];

/** @returns {Promise<{ filename: string, type: string, body: Buffer | string }>} */
export async function exportReport(report, format, { kit = null, logo = null } = {}) {
  const base = `${report.kind === 'kpi' ? 'analytics' : 'sponsorship'}-${report.kind}-${report.basis.as_of}`;
  const keys = report.columns.map((c) => c.key);
  if (format === 'csv') return { filename: `${base}.csv`, type: FORMATS.csv.type, body: toCsv(keys, report.rows) };
  if (format === 'xlsx') {
    const header = report.columns.map((c) => (c.type === 'money' ? `${c.label} (minor units)` : c.label));
    const num = (c, v) => (c.type === 'money' || c.type === 'int' ? (v === null || v === undefined ? '' : Number(v)) : v ?? '');
    const totalKeys = [...new Set(report.totals.flatMap((t) => Object.keys(t)))];
    return { filename: `${base}.xlsx`, type: FORMATS.xlsx.type, body: buildXlsx([
      { name: 'Report', rows: [header, ...report.rows.map((r) => report.columns.map((c) => num(c, r[c.key])))] },
      { name: 'Totals', rows: [totalKeys, ...report.totals.map((t) => totalKeys.map((k) => t[k] ?? ''))] },
      { name: 'Basis', rows: basisRows(report) },
    ]) };
  }
  const { buffer } = await renderSponsorshipReport({ kit, logo, report });
  return { filename: `${base}.pdf`, type: FORMATS.pdf.type, body: buffer };
}
