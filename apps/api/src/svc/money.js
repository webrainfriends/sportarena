// Server decimal arithmetic for quotes, orders and invoices. Everything is integer minor units + ISO currency; quantities carry up to 3 decimals
// and are handled as integer thousandths, so no floating-point error reaches a stored total. Tax rates are basis points. Never aggregate currencies.
import { CURRENCIES, exponent, isSupportedCurrency } from '../currency.js';
import { badRequest } from '../errors.js';

/**
 * Three-decimal currencies (1 dinar = 1000 fils). The platform currency table leaves them out because card providers need special rounding
 * for them, so they are accepted for service procurement only: quotes, orders, tax, invoices, manual payments and reports all work in their
 * own minor unit; online card payment is refused (record a bank/cash payment instead).
 */
export const THREE_DECIMAL = {
  KWD: { name: 'Kuwaiti dinar', symbol: 'KD', exp: 3 }, BHD: { name: 'Bahraini dinar', symbol: 'BD', exp: 3 }, OMR: { name: 'Omani rial', symbol: 'OMR', exp: 3 },
  JOD: { name: 'Jordanian dinar', symbol: 'JD', exp: 3 }, TND: { name: 'Tunisian dinar', symbol: 'DT', exp: 3 },
};
export const isServiceCurrency = (c) => isSupportedCurrency(c) || Object.hasOwn(THREE_DECIMAL, c);
export const serviceExponent = (c) => (Object.hasOwn(THREE_DECIMAL, c) ? THREE_DECIMAL[c].exp : exponent(c));
export const serviceCurrencies = () => [...Object.entries(CURRENCIES), ...Object.entries(THREE_DECIMAL)].map(([code, c]) => ({ code, name: c.name, symbol: c.symbol, exponent: c.exp, online_payments: c.exp !== 3 }));
export const assertCurrency = (c) => { if (!isServiceCurrency(c)) throw badRequest(`Unsupported currency: ${c}`); return c; };
export const qtyMilli = (q) => Math.round(Number(q) * 1000);
/** (quantity × rate − discount) in minor units, rounded half away from zero. rate is per ONE unit in minor units. */
export const lineNet = (qty, rate, discount = 0) => {
  const gross = (BigInt(qtyMilli(qty)) * BigInt(rate));
  const net = divRound(gross, 1000n) - BigInt(discount);
  if (net < 0n) throw badRequest('A discount cannot exceed the line amount');
  return Number(net);
};
export function divRound(n, d) { // half away from zero
  const neg = (n < 0n) !== (d < 0n); const a = n < 0n ? -n : n; const b = d < 0n ? -d : d;
  const q = (a * 2n + b) / (b * 2n);
  return neg ? -q : q;
}
const bp = (amount, rate) => Number(divRound(BigInt(amount) * BigInt(rate), 10000n));

/**
 * Tax for one line. `inclusive`: the listed net already contains tax (tax is carved out, gross = listed). Exclusive: tax is added on top.
 * treatments exempt / zero_rated / reverse_charge carry no tax on the document (reverse charge is evidenced, the buyer accounts for it).
 */
export function lineTax(listed, rateBp, { inclusive = false, treatment = 'standard' } = {}) {
  if (treatment !== 'standard' || rateBp === 0) return { net: listed, tax: 0, gross: listed };
  if (inclusive) { const tax = Number(divRound(BigInt(listed) * BigInt(rateBp), BigInt(10000 + rateBp))); return { net: listed - tax, tax, gross: listed }; }
  const tax = bp(listed, rateBp);
  return { net: listed, tax, gross: listed + tax };
}
/** Total a set of lines [{quantity, rate_minor, discount_minor, tax_bp, tax_treatment}], rounding per line or per document. */
export function totals(lines, { inclusive = false, rounding = 'per_line' } = {}) {
  const out = []; let net = 0, tax = 0, gross = 0;
  if (rounding === 'per_document') {
    const byRate = new Map();
    for (const l of lines) {
      const listed = lineNet(l.quantity, l.rate_minor, l.discount_minor ?? 0);
      const k = `${l.tax_bp ?? 0}|${l.tax_treatment ?? 'standard'}`;
      byRate.set(k, (byRate.get(k) ?? 0) + listed);
      out.push({ ...l, listed });
    }
    for (const [k, listed] of byRate) { const [r, t] = k.split('|'); const x = lineTax(listed, Number(r), { inclusive, treatment: t }); net += x.net; tax += x.tax; gross += x.gross; }
    return { lines: out.map((l) => ({ ...l, net_minor: l.listed, tax_minor: 0, gross_minor: l.listed })), net, tax, gross };
  }
  for (const l of lines) {
    const listed = lineNet(l.quantity, l.rate_minor, l.discount_minor ?? 0);
    const x = lineTax(listed, l.tax_bp ?? 0, { inclusive, treatment: l.tax_treatment ?? 'standard' });
    out.push({ ...l, net_minor: x.net, tax_minor: x.tax, gross_minor: x.gross });
    net += x.net; tax += x.tax; gross += x.gross;
  }
  return { lines: out, net, tax, gross };
}
/** Lines priced and totalled; with per_document rounding the document's tax is rounded once and the difference lands on the last taxed line, so lines always sum to the header. */
export function priced(lines, { inclusive = false, rounding = 'per_line' } = {}) {
  const t = totals(lines, { inclusive, rounding: 'per_line' });
  if (rounding === 'per_document') {
    const d = totals(lines, { inclusive, rounding: 'per_document' });
    const diff = d.tax - t.tax;
    if (diff !== 0) {
      let k = -1; t.lines.forEach((l, n) => { if (l.tax_minor > 0 || (l.tax_bp > 0 && (l.tax_treatment ?? 'standard') === 'standard')) k = n; });
      if (k >= 0) { t.lines[k].tax_minor += diff; if (inclusive) t.lines[k].net_minor -= diff; else t.lines[k].gross_minor += diff; t.tax += diff; if (inclusive) t.net -= diff; else t.gross += diff; }
    }
  }
  return t;
}
export const withholding = (net, rateBp) => bp(net, rateBp);
export const fmt = (minor, currency) => (minor / 10 ** serviceExponent(currency)).toFixed(serviceExponent(currency));
/** Wasted-pass guard: a quantity may have at most 3 decimals. */
export const checkQty = (q) => { if (!(Number(q) > 0) || Math.abs(Number(q) * 1000 - Math.round(Number(q) * 1000)) > 1e-6) throw badRequest('Quantity must be positive with at most 3 decimals'); return q; };
