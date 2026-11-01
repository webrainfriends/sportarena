// India GST billing profile (#694 / #503). Pure maths plus GSTIN checks; the profile itself lives in gst_profiles.
// Intra-state supply (supplier state = place of supply) splits the tax into CGST + SGST halves; inter-state supply charges IGST.
// Amounts are paise (integers). A paise left over by halving goes to SGST so the parts always add up to the whole.

const GSTIN = /^([0-9]{2})[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check digit (mod-36 Luhn variant used by the GST network). */
export function gstinCheckDigit(first14) {
  let sum = 0;
  [...first14].forEach((ch, i) => {
    const v = CHARS.indexOf(ch) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  });
  return CHARS[(36 - (sum % 36)) % 36];
}
export const validGstin = (g) => { const s = String(g ?? '').toUpperCase(); return GSTIN.test(s) && gstinCheckDigit(s.slice(0, 14)) === s[14]; };
export const stateOfGstin = (g) => String(g ?? '').slice(0, 2);

/**
 * Split the tax on one supply.
 * @param {{ amount_cents:number, rate_bp:number, inclusive:boolean, supplier_state:string, place_of_supply:string }} p
 * `amount_cents` is the price as quoted: tax-inclusive when `inclusive`, else the taxable value.
 */
export function gstBreakup({ amount_cents, rate_bp, inclusive, supplier_state, place_of_supply }) {
  const amount = Math.round(Number(amount_cents));
  const rate = Number(rate_bp);
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('amount_cents must be a non-negative number');
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError('rate_bp must be a non-negative number');
  const taxable = inclusive ? amount - Math.round((amount * rate) / (10000 + rate)) : amount;
  const tax = inclusive ? amount - taxable : Math.round((amount * rate) / 10000);
  const intra = !!supplier_state && supplier_state === place_of_supply;
  const half = Math.floor(tax / 2);
  return {
    supply: intra ? 'intra_state' : 'inter_state', rate_bp: rate, inclusive: !!inclusive, supplier_state, place_of_supply,
    taxable_cents: taxable, cgst_cents: intra ? half : 0, sgst_cents: intra ? tax - half : 0, igst_cents: intra ? 0 : tax,
    tax_cents: tax, total_cents: taxable + tax,
  };
}

/** Credit note: the same split applied to the credited amount, flagged as a reversal. */
export const gstCreditBreakup = (args) => ({ ...gstBreakup(args), reversal: true });
