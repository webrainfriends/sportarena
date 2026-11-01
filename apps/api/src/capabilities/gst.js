// India GST billing profile (#694 / #503): one profile per organisation, venue or person (coach). The profile feeds the CGST/SGST/IGST split on
// invoices, credit notes and front-desk receipts (gst.js has the maths). Ownership is enforced here on the server; outsiders get 404.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { canManage } from '../booking/engine.js';
import { orgFor } from '../org-access.js';
import { validGstin, stateOfGstin } from '../gst.js';

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
    if (!validGstin(i.gstin)) throw badRequest('That GSTIN is not valid (check the 15 characters)');
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
