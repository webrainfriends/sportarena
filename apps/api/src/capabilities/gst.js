// India GST billing profile (#694 / #503): one profile per organisation, venue or person (coach). The profile feeds the CGST/SGST/IGST split on
// invoices, credit notes and front-desk receipts (gst.js has the maths). Ownership is enforced here on the server; outsiders get 404.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { canManage } from '../booking/engine.js';
import { orgFor, orgRole } from '../org-access.js';
import { gstinProblem, stateOfGstin } from '../gst.js';
import { encrypt, decrypt } from '../crypto.js';
import { decryptBillingProfile, freezeIssuerSnapshot } from '../india-tax.js';
import { financeStaff } from '../team-money.js';

const TAG = 'GST billing';
const OWNER = z.enum(['organisation', 'venue', 'user']);
const ORG_ROLES = ['owner', 'admin', 'finance'];

async function authorise(user, kind, ownerId, c) {
  if (kind === 'venue') { if (!(await canManage(user, ownerId, c))) throw notFound('Venue'); return; }
  if (kind === 'organisation') { await orgFor(user, ownerId, ORG_ROLES, { write: true, c }); return; }
  if (ownerId !== user.id) throw notFound('Profile');
}
const shape = (r) => r && ({ id: r.id, owner_kind: r.owner_kind, owner_id: r.owner_id, gstin: r.gstin, state_code: r.state_code, legal_name: r.legal_name, default_sac: r.default_sac, tax_inclusive: r.tax_inclusive, rate_bp: r.rate_bp, updated_at: r.updated_at });

cap({
  name: 'get_gst_profile', method: 'GET', path: '/gst-profiles/:owner_kind/:owner_id', tag: TAG,
  summary: 'The GST billing profile (GSTIN, state, SAC, tax-inclusive or exclusive, rate) of an organisation, venue or person you manage. null when none is set. Only the people who manage the owner can read it.',
  input: z.object({ owner_kind: OWNER, owner_id: id }),
  async handler({ user }, i) {
    await authorise(user, i.owner_kind, i.owner_id);
    return { profile: shape(await one('SELECT * FROM gst_profiles WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL', [i.owner_kind, i.owner_id])) };
  },
});

cap({
  name: 'set_gst_profile', method: 'POST', status: 200, path: '/gst-profiles/:owner_kind/:owner_id', tag: TAG,
  summary: 'Create or replace the GST billing profile of an organisation, venue or person you manage. The GSTIN is checked (format and check digit) and the state code is taken from it. From then on, INR invoices, credit notes and front-desk receipts of that owner show the CGST+SGST (same state) or IGST (other state) split. The previous profile is archived, never deleted, and issued documents are not changed. Audit-logged.',
  input: z.object({
    owner_kind: OWNER, owner_id: id, gstin: z.string().trim().toUpperCase().max(15), legal_name: z.string().trim().max(120).optional(),
    default_sac: z.string().regex(/^[0-9]{4,8}$/, 'SAC/HSN is 4 to 8 digits').optional(), tax_inclusive: z.boolean().default(true),
    rate_bp: z.number().int().min(0).max(4000).default(1800).describe('basis points: 1800 = 18%'),
  }),
  async handler({ user }, i) {
    const problem = gstinProblem(i.gstin);
    if (problem === 'format') throw badRequest('That GSTIN is not valid: it has 15 characters (2 state digits, 10 PAN characters, an entity number, Z and a check character)');
    if (problem === 'checksum') throw badRequest('That GSTIN has the right format but its last (check) character does not match. Re-check the number against your GST certificate');
    return tx(async (c) => {
      await authorise(user, i.owner_kind, i.owner_id, c);
      await c.query('UPDATE gst_profiles SET archived_at=now(), updated_at=now() WHERE owner_kind=$1 AND owner_id=$2 AND archived_at IS NULL', [i.owner_kind, i.owner_id]);
      const row = (await c.query(
        `INSERT INTO gst_profiles(owner_kind, owner_id, gstin, state_code, legal_name, default_sac, tax_inclusive, rate_bp, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.owner_kind, i.owner_id, i.gstin, stateOfGstin(i.gstin), i.legal_name ?? null, i.default_sac ?? null, i.tax_inclusive, i.rate_bp, user.id])).rows[0];
      await audit(c, user.id, 'set_gst_profile', 'gst_profiles', row.id);
      return { profile: shape(row) };
    });
  },
});

// --- Org Billing Profile capabilities ---

cap({
  name: 'set_org_billing_profile', method: 'POST', path: '/org-billing-profiles/:org_id', tag: 'GST billing',
  summary: 'Create or update the effective-dated org billing profile (GSTIN, PAN/TAN encrypted, invoice series, withholding matrix). Archives the previous version; issued documents are never changed.',
  input: z.object({
    org_id: id,
    legal_name: z.string().trim().max(200),
    trade_name: z.string().trim().max(200).optional(),
    entity_type: z.enum(['private_limited', 'llp', 'trust', 'partnership', 'sole_proprietor', 'public_limited', 'other']).optional(),
    cin: z.string().trim().max(21).optional(),
    gstin: z.string().trim().toUpperCase().max(15).optional(),
    pan: z.string().trim().toUpperCase().max(10).optional(),
    tan: z.string().trim().toUpperCase().max(10).optional(),
    state_code: z.string().length(2).optional(),
    billing_address: z.string().trim().max(500).optional(),
    invoice_prefix: z.string().trim().max(10).optional(),
    invoice_series: z.string().trim().max(20).optional(),
    auto_rotate_fy: z.boolean().default(true),
    gst_registration_status: z.enum(['regular', 'composition', 'sez', 'unregistered', 'overseas']).default('regular'),
    einvoice_threshold: z.boolean().default(false),
    reverse_charge_applicable: z.boolean().default(false),
    lut_bond_number: z.string().trim().optional(),
    default_sac_code: z.string().regex(/^[0-9]{4,8}$/).optional(),
    tax_inclusive: z.boolean().default(false),
    default_rate_bp: z.number().int().min(0).max(4000).default(1800),
    rounding_policy: z.enum(['half_up', 'half_down', 'half_even', 'floor', 'ceiling']).default('half_up'),
    withholding_matrix: z.array(z.object({
      section_ref: z.string(), label: z.string(), rate_bp: z.number().int(), threshold_cents: z.number().int(), enabled: z.boolean(),
    })).optional(),
    effective_from: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.org_id, ['owner', 'admin', 'finance'], { write: true });
    if (i.gstin && gstinProblem(i.gstin) === 'format') throw badRequest('GSTIN format invalid');
    if (i.gstin && gstinProblem(i.gstin) === 'checksum') throw badRequest('GSTIN check digit mismatch');
    const effective_from = i.effective_from || new Date().toISOString().slice(0, 10);
    const pan_ref_enc         = i.pan             ? encrypt(i.pan,             'org_billing_profiles.pan')             : null;
    const tan_ref_enc         = i.tan             ? encrypt(i.tan,             'org_billing_profiles.tan')             : null;
    const billing_address_enc = i.billing_address ? encrypt(i.billing_address, 'org_billing_profiles.billing_address') : null;
    return tx(async (c) => {
      await c.query(
        `UPDATE org_billing_profiles SET archived_at = NOW()
         WHERE org_id = $1 AND archived_at IS NULL AND effective_from < $2`,
        [i.org_id, effective_from],
      );
      const row = (await c.query(
        `INSERT INTO org_billing_profiles
           (org_id, effective_from, legal_name, trade_name, entity_type, cin, gstin,
            pan_ref_enc, tan_ref_enc, state_code, billing_address_enc,
            invoice_prefix, invoice_series, auto_rotate_fy,
            gst_registration_status, einvoice_threshold, reverse_charge_applicable,
            lut_bond_number, default_sac_code, tax_inclusive, default_rate_bp,
            rounding_policy, withholding_matrix, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id, org_id, effective_from, legal_name, gstin, state_code, invoice_prefix, invoice_series, gst_registration_status`,
        [i.org_id, effective_from, i.legal_name, i.trade_name ?? null, i.entity_type ?? null,
         i.cin ?? null, i.gstin ?? null, pan_ref_enc, tan_ref_enc,
         i.state_code ?? null, billing_address_enc,
         i.invoice_prefix ?? null, i.invoice_series ?? null, i.auto_rotate_fy,
         i.gst_registration_status, i.einvoice_threshold, i.reverse_charge_applicable,
         i.lut_bond_number ?? null, i.default_sac_code ?? null, i.tax_inclusive,
         i.default_rate_bp, i.rounding_policy,
         i.withholding_matrix ? JSON.stringify(i.withholding_matrix) : null,
         user.id],
      )).rows[0];
      await audit(c, user.id, 'set_org_billing_profile', 'org_billing_profiles', row.id);
      return { profile: row };
    });
  },
});

cap({
  name: 'get_org_billing_profile', method: 'GET', path: '/org-billing-profiles/:org_id', tag: 'GST billing',
  summary: 'Get the current effective org billing profile. Finance staff see PAN/TAN/address (audit-logged); others see masked fields.',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    const role = await orgRole(user, i.org_id);
    if (!role) throw notFound('Org billing profile');
    const canDecrypt = ['owner', 'admin', 'finance'].includes(role);
    const row = await one(`SELECT * FROM org_billing_profiles WHERE org_id=$1 AND archived_at IS NULL ORDER BY effective_from DESC LIMIT 1`, [i.org_id]);
    if (!row) return { profile: null };
    if (canDecrypt) {
      const full = await decryptBillingProfile(row);
      await audit(null, user.id, 'decrypt_billing_profile', 'org_billing_profiles', row.id);
      const { pan_ref_enc, tan_ref_enc, billing_address_enc, ...safe } = full;
      return { profile: safe };
    }
    const { pan_ref_enc, tan_ref_enc, billing_address_enc, ...safe } = row;
    return { profile: safe };
  },
});

cap({
  name: 'list_org_billing_profile_history', method: 'GET', path: '/org-billing-profiles/:org_id/history', tag: 'GST billing',
  summary: 'All effective-dated versions of the org billing profile (most recent first). Finance staff only.',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.org_id, ['owner', 'admin', 'finance']);
    return { history: await many(
      `SELECT id, org_id, effective_from, archived_at, legal_name, trade_name, gstin, state_code,
              invoice_prefix, invoice_series, gst_registration_status, created_at, created_by
       FROM org_billing_profiles WHERE org_id = $1 ORDER BY effective_from DESC`,
      [i.org_id],
    ) };
  },
});

cap({
  name: 'gst_period_report', method: 'GET', path: '/gst-report', tag: 'GST billing',
  summary: 'GST period report: CGST/SGST/IGST totals by document type for a GSTIN/org and period (GSTR-1 style).',
  input: z.object({
    org_id: id,
    gstin: z.string().optional(),
    from: z.string().date(),
    to: z.string().date(),
    currency: z.string().length(3).optional(),
  }),
  async handler({ user }, i) {
    await orgFor(user, i.org_id, ['owner', 'admin', 'finance']);
    const rows = await many(
      `SELECT
         document_type,
         COUNT(*)::int                                               AS count,
         SUM(COALESCE((gst_detail->>'cgst_cents')::bigint,0))       AS cgst_cents,
         SUM(COALESCE((gst_detail->>'sgst_cents')::bigint,0))       AS sgst_cents,
         SUM(COALESCE((gst_detail->>'igst_cents')::bigint,0))       AS igst_cents,
         SUM(COALESCE((gst_detail->>'cgst_cents')::bigint,0)
           + COALESCE((gst_detail->>'sgst_cents')::bigint,0)
           + COALESCE((gst_detail->>'igst_cents')::bigint,0))       AS total_tax_cents,
         SUM(total_cents - tax_cents)                                AS taxable_cents,
         SUM(total_cents)                                            AS gross_cents,
         SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END)::int  AS paid_count
       FROM invoices
       WHERE organisation_id = $1
         AND issued_at >= $2 AND issued_at < ($3::date + interval '1 day')
         AND ($4::text IS NULL OR (gst_issuer_snapshot->>'gstin') = $4)
         AND ($5::text IS NULL OR currency = $5)
         AND status != 'void'
       GROUP BY document_type
       ORDER BY document_type`,
      [i.org_id, i.from, i.to, i.gstin ?? null, i.currency ?? null],
    );
    const totals = rows.reduce((acc, r) => ({
      taxable_cents:   (acc.taxable_cents   || 0) + Number(r.taxable_cents),
      cgst_cents:      (acc.cgst_cents      || 0) + Number(r.cgst_cents),
      sgst_cents:      (acc.sgst_cents      || 0) + Number(r.sgst_cents),
      igst_cents:      (acc.igst_cents      || 0) + Number(r.igst_cents),
      total_tax_cents: (acc.total_tax_cents || 0) + Number(r.total_tax_cents),
      gross_cents:     (acc.gross_cents     || 0) + Number(r.gross_cents),
    }), {});
    return { period: { from: i.from, to: i.to }, totals, breakdown: rows };
  },
});
