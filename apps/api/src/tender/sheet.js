// Pricing-sheet export/import. The sheet is a versioned template tied to the exact RFP version it was issued from. Imports accept CSV
// only (no macros), reject stale templates, locked-column edits and spreadsheet formulas, and return typed priced lines.
import { createHash } from 'node:crypto';
import { toCsv, parseCsv } from '../csv.js';
import { exponent } from '../currency.js';
import { badRequest, unprocessable } from '../errors.js';
import { xlsx } from './xlsx.js';

export const SHEET_SCHEMA = 'sportarena.pricing.v1';
const COLS = ['lot_code', 'lot_title', 'qty', 'unit', 'rate', 'discount_pct', 'tax_pct', 'tax_inclusive', 'notes'];

/** Fingerprint of the structure a sheet was issued from: changes whenever lots, quantities or the RFP version change. */
export const templateHash = (project, lots) => createHash('sha256').update(JSON.stringify([project.id, project.version, lots.map((l) => [l.code, String(l.qty), l.unit])])).digest('hex').slice(0, 16);

const rowsFor = (project, lots, lines = []) => lots.map((l) => {
  const cur = lines.find((x) => x.lot_code === l.code);
  return { lot_code: l.code, lot_title: l.title, qty: String(l.qty), unit: l.unit ?? '', rate: cur ? (cur.rate_minor / 10 ** exponent(project.currency)).toFixed(exponent(project.currency)) : '', discount_pct: cur ? cur.discount_bp / 100 : '', tax_pct: cur ? cur.tax_bp / 100 : '', tax_inclusive: cur?.tax_inclusive ? 'yes' : 'no', notes: cur?.notes ?? '' };
});

export function exportSheet(project, lots, lines, format = 'csv') {
  const meta = [SHEET_SCHEMA, project.ref, String(project.version), templateHash(project, lots), project.currency];
  const rows = rowsFor(project, lots, lines);
  if (format === 'xlsx') return { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', body: xlsx([['#schema', ...meta], COLS, ...rows.map((r) => COLS.map((k) => (k === 'qty' || k === 'rate' || k === 'discount_pct' || k === 'tax_pct') && r[k] !== '' && !Number.isNaN(Number(r[k])) ? Number(r[k]) : r[k]))], 'Pricing') };
  return { type: 'text/csv; charset=utf-8', ext: 'csv', body: `#schema,${meta.join(',')}\n${toCsv(COLS, rows)}` };
}

const FORMULA = /^[=+\-@\t\r|]/;
const dec = (v, what, max) => { const s = String(v ?? '').trim(); if (s === '') return 0; if (!/^\d+(\.\d{1,4})?$/.test(s)) throw unprocessable(`${what} must be a plain number`); const n = Number(s); if (n > max) throw unprocessable(`${what} is above ${max}`); return n; };

export function importSheet(project, lots, text) {
  if (text.length > 500_000) throw badRequest('The pricing sheet is too large');
  const all = parseCsv(text);
  const meta = all[0];
  if (!meta || meta[0] !== '#schema') throw badRequest('This is not a Sportarena pricing sheet. Export a fresh one from the tender.');
  if (meta[1] !== SHEET_SCHEMA) throw badRequest('This pricing sheet uses an unsupported version. Export a fresh one from the tender.');
  if (meta[2] !== project.ref || meta[3] !== String(project.version) || meta[4] !== templateHash(project, lots)) throw unprocessable('This pricing sheet is out of date because the tender changed after it was exported. Export a fresh sheet.');
  const head = all[1]?.map((h) => h.trim());
  if (!head || COLS.some((c, i) => head[i] !== c)) throw badRequest('The pricing sheet columns were changed. Export a fresh sheet.');
  const lines = [];
  for (const r of all.slice(2)) {
    const row = Object.fromEntries(COLS.map((c, i) => [c, (r[i] ?? '').trim()]));
    for (const [k, v] of Object.entries(row)) if (FORMULA.test(v)) throw unprocessable(`Cell "${k}" for lot ${row.lot_code} starts with a formula character. Remove it and import again.`);
    const lot = lots.find((l) => l.code === row.lot_code);
    if (!lot) throw unprocessable(`Unknown lot ${row.lot_code}`);
    for (const k of ['qty', 'unit']) if (String(row[k]) !== String(k === 'qty' ? lot.qty : lot.unit ?? '')) throw unprocessable(`Lot ${row.lot_code}: "${k}" is fixed by the tender and cannot be changed`);
    if (row.rate === '') continue; // unpriced lot: left out, never imported as zero
    const rate = dec(row.rate, `Rate for lot ${row.lot_code}`, 1e12);
    const exp = exponent(project.currency);
    if (!new RegExp(`^\\d+(\\.\\d{1,${exp}})?$`).test(row.rate) ) throw unprocessable(`Rate for lot ${row.lot_code} can have at most ${exp} decimals in ${project.currency}`);
    if (!['yes', 'no', ''].includes(row.tax_inclusive.toLowerCase())) throw unprocessable('tax_inclusive must be yes or no');
    lines.push({ lot_code: lot.code, qty: String(lot.qty), unit: lot.unit ?? '', rate_minor: Math.round(rate * 10 ** exp), discount_bp: Math.round(dec(row.discount_pct, 'Discount', 100) * 100), tax_bp: Math.round(dec(row.tax_pct, 'Tax', 100) * 100), tax_inclusive: row.tax_inclusive.toLowerCase() === 'yes', notes: row.notes.slice(0, 300) });
  }
  return lines;
}
