// Six-role financial source-of-truth audit service (#1128).
// Detects integration gaps between the canonical fin_transactions ledger and every
// role-domain module (Coach, Referee, Academy, Organisation, Sponsor, Physio).
// All queries are read-only; gaps are written as fin_recon_items + a run summary row.
import { many, tx } from './db.js';

const ROLES = ['coach', 'referee', 'academy', 'organisation', 'sponsor', 'physio'];

/** Returns gap rows for the given org (or all orgs when orgId is null). */
async function detectGaps(orgId) {
  const orgFilter = orgId ? 'AND f.payer_org_id = $1 OR f.payee_org_id = $1' : '';
  const params = orgId ? [orgId] : [];
  const gaps = [];

  // G1 — Coach sessions without a fin_transactions entry
  const coachGaps = await many(`
    SELECT cs.id AS source_id, cs.organisation_id AS org_id, cs.fee_currency AS currency, cs.fee_cents AS amount
    FROM coach_sessions cs
    WHERE cs.fee_cents > 0
      AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_id = cs.id AND f.source_type = 'coach_session')
      ${orgId ? 'AND cs.organisation_id = $1' : ''}
    LIMIT 500`, params);
  for (const r of coachGaps) gaps.push({ kind: 'coach_unlinked', source_module: 'coach', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  // G2 — Referee/official fees without a ledger entry
  const refGaps = await many(`
    SELECT oa.id AS source_id, e.organisation_id AS org_id, oa.fee_currency AS currency, oa.fee_cents AS amount
    FROM official_assignments oa JOIN events e ON e.id = oa.event_id
    WHERE oa.fee_cents > 0
      AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_id = oa.id AND f.source_type IN ('official_fee','referee_fee'))
      ${orgId ? 'AND e.organisation_id = $1' : ''}
    LIMIT 500`, params);
  for (const r of refGaps) gaps.push({ kind: 'referee_unlinked', source_module: 'referee', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  // G3 — Academy enrolments without a ledger entry
  const acadGaps = await many(`
    SELECT ae.id AS source_id, ae.organisation_id AS org_id, ae.currency, ae.fee_cents AS amount
    FROM academy_enrolments ae
    WHERE ae.fee_cents > 0
      AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_id = ae.id AND f.source_type = 'academy_enrolment')
      ${orgId ? 'AND ae.organisation_id = $1' : ''}
    LIMIT 500`, params);
  for (const r of acadGaps) gaps.push({ kind: 'academy_unlinked', source_module: 'academy', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  // G4 — Sponsor deal terms without a ledger entry
  const sponsorGaps = await many(`
    SELECT sdt.id AS source_id, sd.org_id, sdt.currency, sdt.amount_cents AS amount
    FROM sponsorship_deal_terms sdt JOIN sponsorship_deals sd ON sd.id = sdt.deal_id
    WHERE sdt.amount_cents > 0
      AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_id = sdt.id AND f.source_type = 'sponsorship_deal_term')
      ${orgId ? 'AND sd.org_id = $1' : ''}
    LIMIT 500`, params);
  for (const r of sponsorGaps) gaps.push({ kind: 'sponsor_unlinked', source_module: 'sponsor', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  // G5 — Physio packages/appointments without a ledger entry
  const physioGaps = await many(`
    SELECT a.id AS source_id, a.organisation_id AS org_id, a.currency, a.amount_cents AS amount
    FROM physio_appointments a
    WHERE a.amount_cents > 0
      AND NOT EXISTS (SELECT 1 FROM fin_transactions f WHERE f.source_id = a.id AND f.source_type = 'physio_appointment')
      ${orgId ? 'AND a.organisation_id = $1' : ''}
    LIMIT 500`, params);
  for (const r of physioGaps) gaps.push({ kind: 'physio_unlinked', source_module: 'physio', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  // G6 — fin_transactions with no role_link (cross-role orphans)
  const orphanGaps = await many(`
    SELECT f.id AS source_id, coalesce(f.payer_org_id, f.payee_org_id) AS org_id, f.currency, f.gross_minor AS amount
    FROM fin_transactions f
    WHERE f.source_type IN ('coach_session','official_fee','referee_fee','academy_enrolment','academy_package',
                             'academy_subscription','sponsorship_deal_term','physio_appointment','physio_package')
      AND NOT EXISTS (SELECT 1 FROM fin_role_links l WHERE l.transaction_id = f.id)
      ${orgId ? 'AND (f.payer_org_id = $1 OR f.payee_org_id = $1)' : ''}
    LIMIT 500`, params);
  for (const r of orphanGaps) gaps.push({ kind: 'six_role_gap', source_module: 'finance', source_id: r.source_id, org_id: r.org_id, currency: r.currency, amount_cents: r.amount });

  return gaps;
}

/** Upsert gap rows into fin_recon_items; return { inserted, already_open }. */
async function persistGaps(gaps, triggeredBy, source) {
  let inserted = 0, already_open = 0;
  for (const g of gaps) {
    await tx(async (c) => {
      const idem = `six_role:${g.kind}:${g.source_id}`;
      const existing = (await c.query(`SELECT id, status FROM fin_recon_items WHERE idem_key = $1`, [idem])).rows[0];
      if (existing) { already_open++; return; }
      await c.query(
        `INSERT INTO fin_recon_items (idem_key, kind, organisation_id, source_module, source_id, currency, amount_cents, status, opened_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',now(),$8)`,
        [idem, g.kind, g.org_id, g.source_module, g.source_id, g.currency, g.amount_cents ?? 0,
         JSON.stringify({ detected_by: source, triggered_by: triggeredBy ?? null })]
      );
      inserted++;
    });
  }
  return { inserted, already_open };
}

/** Run the full six-role audit for one org (or platform-wide). Returns the run summary. */
export async function runSixRoleAudit({ orgId = null, triggeredBy = null, source = 'worker' } = {}) {
  const gaps = await detectGaps(orgId);
  const { inserted, already_open } = await persistGaps(gaps, triggeredBy, source);
  const byRole = {};
  for (const g of gaps) {
    const role = g.source_module;
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  const summary = { by_role: byRole, total_gaps: gaps.length, inserted, already_open };
  await many(
    `INSERT INTO fin_six_role_audit_runs (organisation_id, gaps_total, gaps_open, gaps_resolved, summary, triggered_by, source)
     VALUES ($1,$2,$3,0,$4,$5,$6)`,
    [orgId, gaps.length, inserted, JSON.stringify(summary), triggeredBy, source]
  );
  return summary;
}

/** Fetch paginated gap items for the API. */
export async function listSixRoleGaps({ orgId, role, status = 'open', limit = 50, offset = 0 }) {
  const kinds = role ? [`${role}_unlinked`, 'six_role_gap'] : ROLES.flatMap((r) => [`${r}_unlinked`]).concat(['six_role_gap']);
  const params = [kinds, limit, offset];
  const orgClause = orgId ? ' AND organisation_id = $4' : '';
  if (orgId) params.push(orgId);
  const rows = await many(
    `SELECT r.*, p.full_name AS assigned_to_name
     FROM fin_recon_items r LEFT JOIN people p ON p.id = r.assigned_to
     WHERE r.kind = ANY($1::text[]) AND r.status = ${ status ? "'open'" : 'r.status' }
       ${orgClause}
     ORDER BY r.opened_at DESC LIMIT $2 OFFSET $3`, params);
  return rows;
}

/** Fetch the latest audit runs for an org. */
export async function listAuditRuns({ orgId, limit = 20 }) {
  const params = orgId ? [orgId, limit] : [null, limit];
  const orgClause = orgId ? 'WHERE organisation_id = $1' : 'WHERE organisation_id IS NULL';
  return many(`SELECT * FROM fin_six_role_audit_runs ${orgClause} ORDER BY ran_at DESC LIMIT $2`, params);
}

/** Resolve a gap item by id. */
export async function resolveGap({ id, resolvedBy, note }) {
  await many(
    `UPDATE fin_recon_items SET status = 'resolved', resolved_at = now(), resolved_by = $2,
       meta = coalesce(meta,'{}') || $3
     WHERE id = $1 AND status = 'open'`,
    [id, resolvedBy, JSON.stringify({ resolution_note: note ?? null })]
  );
}

/** Worker step: run six-role audit across all orgs. */
export async function sixRoleAuditStep() {
  return runSixRoleAudit({ orgId: null, source: 'worker' });
}
