// Shared India GST engine: resolves CGST/SGST/IGST from states, freezes detail JSONB at issue time.
// Pure helpers (no I/O) + DB-aware resolvers. Used by invoices, academy-invoices, physio-invoices.
import { gstBreakup } from './gst.js';
import { ruleFor, divRound } from './tax.js';
import { encrypt, decrypt } from './crypto.js';

// Resolve India GST for an invoice line or document.
// Returns the full breakup object from gstBreakup(), augmented with place_of_supply.
export async function resolveIndiaGst(c, {
  orgId, gross, taxInclusive = false,
  sacCode, supplierState, buyerState, rateBp, at,
}) {
  let effectiveRateBp = rateBp;
  if (!effectiveRateBp && orgId) {
    const rule = await ruleFor(c, orgId, { category: 'gst', at: at || new Date() });
    if (rule) effectiveRateBp = rule.rate_bp;
  }
  if (!effectiveRateBp) effectiveRateBp = 1800;

  const result = gstBreakup({
    amount_cents: gross,
    rate_bp: effectiveRateBp,
    inclusive: taxInclusive,
    supplier_state: supplierState,
    place_of_supply: buyerState || supplierState,
  });

  return {
    ...result,
    place_of_supply: buyerState || supplierState,
    hsn_sac_code: sacCode || null,
    rate_bp: effectiveRateBp,
    tax_treatment: 'standard',
    reverse_charge: false,
  };
}

// Build the gst_detail JSONB to freeze on invoice row at issue time.
export function freezeGstDetail(gstResult) {
  return {
    cgst_cents:      gstResult.cgst_cents,
    sgst_cents:      gstResult.sgst_cents,
    igst_cents:      gstResult.igst_cents,
    place_of_supply: gstResult.place_of_supply,
    supply_type:     gstResult.supply,
    hsn_sac_code:    gstResult.hsn_sac_code,
    reverse_charge:  gstResult.reverse_charge,
    tax_treatment:   gstResult.tax_treatment,
    supplier_state:  gstResult.supplier_state,
    rate_bp:         gstResult.rate_bp,
  };
}

// Build tds_detail JSONB to freeze on invoice row.
export function resolveTdsDetail({ sectionRef, rateBp, basisCents }) {
  const withheld = divRound(BigInt(basisCents) * BigInt(rateBp), BigInt(10000));
  return {
    section_ref:    sectionRef,
    rate_bp:        rateBp,
    basis_cents:    basisCents,
    withheld_cents: Number(withheld),
    evidence_ref:   null,
  };
}

// Query org_billing_profiles for the current effective profile at a given date.
// Throws if none exists — org must set one up before issuing India invoices.
export async function currentBillingProfile(c, orgId, at) {
  const asOf = at instanceof Date ? at.toISOString().slice(0, 10) : (at || new Date().toISOString().slice(0, 10));
  const r = (await c.query(
    `SELECT * FROM org_billing_profiles
     WHERE org_id = $1 AND effective_from <= $2 AND archived_at IS NULL
     ORDER BY effective_from DESC LIMIT 1`,
    [orgId, asOf],
  )).rows[0];
  if (!r) throw Object.assign(new Error('No org billing profile found for this organisation'), { code: 'NO_BILLING_PROFILE', status: 422 });
  return r;
}

// Build gst_issuer_snapshot JSONB to freeze on invoice row at issue time.
export function freezeIssuerSnapshot(profile) {
  return {
    gstin:          profile.gstin,
    legal_name:     profile.legal_name,
    trade_name:     profile.trade_name,
    state_code:     profile.state_code,
    invoice_prefix: profile.invoice_prefix,
    invoice_series: profile.invoice_series,
    effective_at:   profile.effective_from,
  };
}

// Decrypt PAN/TAN/address from a billing profile row for authorised callers.
export async function decryptBillingProfile(profile) {
  const out = { ...profile };
  if (profile.pan_ref_enc)         out.pan             = await decrypt(profile.pan_ref_enc,         'org_billing_profiles.pan');
  if (profile.tan_ref_enc)         out.tan             = await decrypt(profile.tan_ref_enc,         'org_billing_profiles.tan');
  if (profile.billing_address_enc) out.billing_address = await decrypt(profile.billing_address_enc, 'org_billing_profiles.billing_address');
  return out;
}
