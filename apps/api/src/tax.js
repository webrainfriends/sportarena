// Per-entity tax engine (#593): turns an amount into the tax it contains under the organisation's own rules, so the ledger's tax figures come from one place instead of
// whatever each module happened to compute. The posted gross is always tax-inclusive (it is what the payer paid); the engine reports how much of it is tax.
//   * No rule for the organisation, category and date -> null: nothing changes, the figure stays as the source module gave it (usually 0, "no tax recorded").
//   * A registered=false profile, or a rule with treatment exempt / zero_rated / out_of_scope -> tax 0, but the treatment is recorded, so "zero by design" is visible.
// Rules are effective-dated and never deleted. Informational, not tax advice.
import { pool } from './db.js';

/** Integer division of positive numbers with the organisation's rounding (half_up, or half_even "banker's"). BigInt so large amounts never lose precision. */
export function divRound(num, den, mode = 'half_up') {
  const a = BigInt(num), b = BigInt(den);
  const whole = a / b, rem = a - whole * b;
  const twice = rem * 2n;
  if (twice > b) return Number(whole + 1n);
  if (twice < b) return Number(whole);
  return Number(mode === 'half_even' ? (whole % 2n === 0n ? whole : whole + 1n) : whole + 1n);
}
/** The tax contained in a tax-inclusive amount at a rate in basis points. */
export const taxIn = (gross, rateBp, mode) => (rateBp > 0 && gross > 0 ? divRound(BigInt(gross) * BigInt(rateBp), 10000 + rateBp, mode) : 0);

/** The rule that applies to an organisation's money of this category / source on a date: a source-specific rule beats a category rule beats a catch-all; the newest start wins. */
export async function ruleFor(c, orgId, { category, sourceType, at }) {
  const day = new Date(at ?? Date.now()).toISOString().slice(0, 10);
  return (await (c ?? pool).query(
    `SELECT r.*, p.registered, p.rounding_mode FROM org_tax_rules r LEFT JOIN org_tax_profiles p ON p.organisation_id = r.organisation_id
      WHERE r.organisation_id = $1 AND (r.category = $2 OR r.category = '*') AND (r.source_type IS NULL OR r.source_type = $3) AND r.effective_from <= $4::date AND (r.effective_to IS NULL OR r.effective_to >= $4::date)
      ORDER BY (r.source_type IS NOT NULL) DESC, (r.category <> '*') DESC, r.effective_from DESC, r.created_at DESC LIMIT 1`, [orgId, category ?? 'other', sourceType ?? null, day])).rows[0] ?? null;
}

/** { tax, code, rate_bp, treatment, basis:'engine' } for an amount, or null when the organisation has no rule for it. */
export async function resolveTax(c, { orgId, category, sourceType, at, gross }) {
  if (!orgId || !(gross > 0)) return null;
  const r = await ruleFor(c, orgId, { category, sourceType, at });
  if (!r) return null;
  const off = r.registered === false || r.treatment !== 'standard';
  return { tax: off ? 0 : taxIn(Number(gross), r.rate_bp, r.rounding_mode ?? 'half_up'), code: r.code, rate_bp: off ? 0 : r.rate_bp, treatment: r.registered === false ? 'out_of_scope' : r.treatment, basis: 'engine' };
}
