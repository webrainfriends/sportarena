// Official profile compliance checklist (#991 godmode). Structured tracking of mandatory compliance items
// (DBS/police check, safeguarding cert, fitness test, public liability insurance, anti-corruption declaration).
// These are ordinary credential rows with compliance_kind set; this capability is a structured lens on them —
// no second copy of the data. The compliance_summary JSONB on official_profiles is a cached snapshot.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireApproved } from '../access.js';

const TAG = 'Official profile';

export const COMPLIANCE_KINDS = ['dbs_police','safeguarding','fitness_test','insurance','anti_corruption','medical','other_compliance'];
const COMPLIANCE_LABELS = {
  dbs_police: 'DBS / Police Check',
  safeguarding: 'Safeguarding Certificate',
  fitness_test: 'Fitness Test',
  insurance: 'Public Liability Insurance',
  anti_corruption: 'Anti-Corruption Declaration',
  medical: 'Medical Clearance',
  other_compliance: 'Other Compliance',
};

function complianceStatus(cred, now) {
  if (!cred) return 'missing';
  if (cred.status === 'suspended') return 'suspended';
  if (cred.expiry_date) {
    const exp = new Date(cred.expiry_date);
    if (exp < now) return 'expired';
    const days = Math.round((exp - now) / 86400000);
    if (days <= (cred.alert_days_before ?? 30)) return 'expiring_soon';
  }
  return 'ok';
}

export async function buildComplianceSummary(c, profileId) {
  const rows = await (c.query
    ? c.query('SELECT compliance_kind, status, expiry_date, alert_days_before, mandatory, issuing_body, credential_name FROM official_profile_credentials WHERE profile_id=$1 AND compliance_kind IS NOT NULL AND archived_at IS NULL ORDER BY created_at DESC', [profileId]).then((r) => r.rows)
    : many('SELECT compliance_kind, status, expiry_date, alert_days_before, mandatory, issuing_body, credential_name FROM official_profile_credentials WHERE profile_id=$1 AND compliance_kind IS NOT NULL AND archived_at IS NULL ORDER BY created_at DESC', [profileId])
  );
  const now = new Date();
  const byKind = {};
  for (const r of rows) if (!byKind[r.compliance_kind]) byKind[r.compliance_kind] = r;
  return COMPLIANCE_KINDS.map((k) => ({
    kind: k,
    label: COMPLIANCE_LABELS[k],
    status: complianceStatus(byKind[k], now),
    mandatory: byKind[k]?.mandatory ?? false,
    expires_at: byKind[k]?.expiry_date ?? null,
    issuing_body: byKind[k]?.issuing_body ?? null,
    credential_name: byKind[k]?.credential_name ?? null,
    days_until_expiry: byKind[k]?.expiry_date
      ? Math.round((new Date(byKind[k].expiry_date) - now) / 86400000)
      : null,
  }));
}

// ------------------------------------------------------------------ GET compliance checklist
cap({
  name: 'get_official_compliance', method: 'GET', path: '/me/official-profile/compliance', tag: TAG,
  summary: 'Structured compliance checklist for the official: DBS, safeguarding, fitness, insurance, anti-corruption — each with status (ok/expiring_soon/expired/missing) and days until expiry.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id]);
    if (!p) throw notFound('Official profile');
    const items = await buildComplianceSummary(null, p.id);
    const blocking = items.filter((i) => i.mandatory && ['missing','expired','suspended'].includes(i.status));
    const expiring = items.filter((i) => i.status === 'expiring_soon');
    return { items, blocking_count: blocking.length, expiring_count: expiring.length };
  },
});

// ------------------------------------------------------------------ PUT upsert a compliance credential
cap({
  name: 'upsert_compliance_credential', method: 'PUT', path: '/me/official-profile/compliance/:kind', tag: TAG,
  summary: 'Upsert a structured compliance credential (DBS, safeguarding, fitness, insurance, anti_corruption, medical, other_compliance). Soft-archives the previous row for the same kind.',
  input: z.object({
    kind: z.enum(COMPLIANCE_KINDS),
    issuing_body: z.string().trim().min(1).max(100),
    credential_name: z.string().trim().min(1).max(100),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    reference_no: z.string().trim().max(80).optional(),
    mandatory: z.boolean().optional(),
    alert_days_before: z.number().int().min(1).max(365).optional(),
  }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      // soft-archive previous row for same kind
      await c.query("UPDATE official_profile_credentials SET archived_at=now() WHERE profile_id=$1 AND compliance_kind=$2 AND archived_at IS NULL", [p.id, i.kind]);
      const refEnc = i.reference_no ? encrypt(i.reference_no, 'official_profile_credentials.reference_no') : null;
      const status = i.expiry_date && new Date(i.expiry_date) < new Date() ? 'expired' : 'active';
      const cred = (await c.query(
        `INSERT INTO official_profile_credentials
          (profile_id,kind,compliance_kind,issuing_body,credential_name,issue_date,expiry_date,reference_no_enc,status,mandatory,alert_days_before)
         VALUES($1,'clearance',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id,compliance_kind,issuing_body,credential_name,issue_date,expiry_date,status,mandatory,alert_days_before`,
        [p.id, i.kind, i.issuing_body, i.credential_name, i.issue_date||null, i.expiry_date||null, refEnc, status, i.mandatory??false, i.alert_days_before??30]
      )).rows[0];
      // refresh cached summary
      const summary = await buildComplianceSummary(c, p.id);
      await c.query("UPDATE official_profiles SET compliance_summary=$1, row_version=row_version+1, updated_at=now() WHERE id=$2", [JSON.stringify(summary), p.id]);
      return cred;
    });
  },
});

// ------------------------------------------------------------------ GET expiry alerts
cap({
  name: 'get_compliance_alerts', method: 'GET', path: '/me/official-profile/compliance/alerts', tag: TAG,
  summary: 'Returns compliance credentials expiring within their alert_days_before window, plus any missing mandatory items. Used for notification sweeps.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id]);
    if (!p) throw notFound('Official profile');
    const items = await buildComplianceSummary(null, p.id);
    return items.filter((i) => ['expiring_soon','expired','missing'].includes(i.status));
  },
});
