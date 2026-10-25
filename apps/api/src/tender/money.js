// Tender money arithmetic. All amounts are integers in minor units plus a currency; every calculation uses BigInt so there is no
// floating point drift, and rounds half-up exactly once per step as documented in docs/tender-zone.md.
import { exponent } from '../currency.js';
import { unprocessable } from '../errors.js';

const RATE_SCALE = 100000000n; // FX rates carry up to 8 decimals
const QTY_SCALE = 10000n;      // quantities carry up to 4 decimals
const BP = 10000n;             // percentages are basis points (1% = 100)

/** a / b rounded half-up (non-negative operands). */
export const divRound = (a, b) => (a * 2n + b) / (b * 2n);

const parseScaled = (v, scale, digits, what) => {
  const s = String(v).trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`).test(s)) throw unprocessable(`${what} must be a non-negative decimal with at most ${digits} decimal places`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * scale + BigInt(f.padEnd(digits, '0') || '0');
};
export const parseQty = (v) => parseScaled(v, QTY_SCALE, 4, 'Quantity');
export const parseRate = (v) => parseScaled(v, RATE_SCALE, 8, 'Exchange rate');

/**
 * Amounts of one priced line. qty: decimal (<=4 dp); rate_minor: integer minor units per unit; discount_bp and tax_bp: basis points.
 * Rounding happens once per line: after quantity x rate, after the discount, and for the tax split.
 * tax_inclusive: the rate already contains tax; net = gross / (1 + tax).
 */
export function lineAmounts({ qty, rate_minor, discount_bp = 0, tax_bp = 0, tax_inclusive = false }) {
  if (!Number.isInteger(rate_minor) || rate_minor < 0) throw unprocessable('A rate must be a whole number of minor units');
  if (discount_bp < 0 || discount_bp > 10000 || tax_bp < 0 || tax_bp > 10000) throw unprocessable('Discount and tax must be between 0% and 100%');
  const base = divRound(parseQty(qty) * BigInt(rate_minor), QTY_SCALE);
  const discounted = divRound(base * BigInt(10000 - discount_bp), BP);
  let net, tax, gross;
  if (tax_inclusive) { gross = discounted; net = divRound(gross * BP, BigInt(10000 + tax_bp)); tax = gross - net; }
  else { net = discounted; tax = divRound(net * BigInt(tax_bp), BP); gross = net + tax; }
  return { net_minor: Number(net), tax_minor: Number(tax), gross_minor: Number(gross) };
}

/**
 * Convert minor units between currencies with a dated snapshot { date, base, rates: { USD: '83.10' } } where rates[c] is how many base-currency
 * units one major unit of c is worth (rates[base] is 1). The snapshot is for comparison only; contract amounts are never rewritten from it.
 */
export function convertMinor(minor, from, to, fx) {
  if (from === to) return minor;
  const rf = fx?.rates?.[from], rt = fx?.rates?.[to];
  if (rf === undefined || rt === undefined) throw unprocessable(`No exchange rate for ${rf === undefined ? from : to} in the approved snapshot`);
  const num = BigInt(minor) * parseRate(rf) * 10n ** BigInt(exponent(to));
  const den = 10n ** BigInt(exponent(from)) * parseRate(rt);
  return Number(divRound(num, den));
}

/**
 * Evaluated cost of one submission: the priced lines for the lots it bids on, in the project currency. `null` when any line the buyer
 * needs is missing or unpriced; an unknown cost is never treated as zero.
 * lines: [{ lot_code, qty, rate_minor, unit, discount_bp, tax_bp, tax_inclusive, currency }]
 * basis: 'net' | 'gross' (declared tax assumption of the tender).
 */
export function evaluatedCost({ lines, lots, currency, fx, basis = 'net' }) {
  const per = new Map(), qty = {};
  let total = 0; const original = {};
  for (const l of lines ?? []) {
    const a = lineAmounts(l);
    const own = basis === 'gross' ? a.gross_minor : a.net_minor;
    const cur = l.currency ?? currency;
    original[cur] = (original[cur] ?? 0) + own;
    const conv = convertMinor(own, cur, currency, fx);
    per.set(l.lot_code, (per.get(l.lot_code) ?? 0) + conv);
    qty[l.lot_code] = (qty[l.lot_code] ?? 0) + Number(l.qty);
    total += conv;
  }
  const missing = (lots ?? []).filter((c) => !per.has(c) || per.get(c) <= 0);
  return { total_minor: missing.length ? null : total, per_lot: Object.fromEntries(per), qty_per_lot: qty, original, missing_lots: missing, basis, currency };
}
