// Money maths for the front desk. Pure functions: whole minor units, no floats left over, every split adds back to the exact total.

/** Tax contained in a tax-inclusive amount, or added on top of a tax-exclusive one (the same rounding the booking invoices use). */
export const taxOf = (amount, rateBp, inclusive) => (inclusive ? Math.round((amount * rateBp) / (10000 + rateBp)) : Math.round((amount * rateBp) / 10000));

/** Split `total` across `weights` pro rata; the leftover cents go to the biggest weights so the parts always add up exactly. */
export function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - parts.reduce((s, x) => s + x, 0);
  for (const i of weights.map((w, k) => k).sort((a, b) => weights[b] - weights[a] || a - b)) { if (rest <= 0) break; parts[i]++; rest--; }
  return parts;
}

/** The discount in minor units for a cart-level discount over `base` (percent has up to two decimals). */
export function discountCents({ kind, value }, base) {
  if (base <= 0) return 0;
  return kind === 'percent' ? Math.min(base, Math.floor((base * Math.round(value * 100)) / 10000)) : Math.min(base, Math.round(value));
}

/** One priced line: listed gross, a share of the cart discount, then tax on what is left. total = what the customer pays. */
export function priceLine({ unit, qty, discount = 0, rateBp, inclusive, taxable = true }) {
  const gross = unit * qty;
  const net = Math.max(0, gross - discount);
  const tax = taxable ? taxOf(net, rateBp, inclusive) : 0;
  return { gross, discount, tax, total: net + (inclusive || !taxable ? 0 : tax) };
}

/** What `n` more units of a line are worth to give back, given `done` already returned (so the last unit absorbs rounding). */
export const shareOf = (lineTotal, qty, done, n) => Math.round((lineTotal * (done + n)) / qty) - Math.round((lineTotal * done) / qty);
