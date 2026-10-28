// Trip money (#485). Four states are kept apart and never merged into one "paid" flag:
//   entitlement  = the approved per-diem policy x the days of the trip (computed, nobody has been paid yet)
//   claim        = an expense a traveller submitted: submitted -> approved / rejected (still no money moved)
//   payment      = money recorded as actually paid out: an advance, a per-diem, or a reimbursement of one approved claim
//   balance      = what is still owed or overpaid, derived from the three above
// Payments are recorded in the trip and, for an event organiser, in the canonical event budget ledger (event_budget_payments); there is no second ledger.
import { tripDays } from './trips.js';

const sum = (rows) => rows.reduce((n, r) => n + Number(r.amount_minor), 0);

export async function livePolicy(c, tripId) {
  return (await c.query('SELECT * FROM trip_perdiem_policies WHERE trip_id=$1 AND superseded_at IS NULL', [tripId])).rows[0] ?? null;
}

/** Per-diem entitlement for each confirmed traveller. A policy that is not approved yet shows what it would be but is flagged not payable. */
export function entitlementFor(trip, policy, participant) {
  if (!policy || participant.status !== 'confirmed') return null;
  if (policy.roles.length && !policy.roles.includes(participant.role)) return null;
  return { days: tripDays(trip), daily_minor: Number(policy.daily_minor), amount_minor: tripDays(trip) * Number(policy.daily_minor), currency: policy.currency, approved: !!policy.approved_at };
}

export async function statements(c, trip, onlyParticipantIds = null) {
  const policy = await livePolicy(c, trip.id);
  const parts = (await c.query(`SELECT p.id, p.user_id, p.role, p.status, u.display_name FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status IN ('confirmed','invited') ${onlyParticipantIds ? 'AND p.id = ANY($2::uuid[])' : ''} ORDER BY p.created_at`, onlyParticipantIds ? [trip.id, onlyParticipantIds] : [trip.id])).rows;
  const pays = (await c.query('SELECT * FROM trip_payments WHERE trip_id=$1 AND voided_at IS NULL', [trip.id])).rows;
  const claims = (await c.query("SELECT id, participant_id, category, description, amount_minor, currency, to_char(incurred_on,'YYYY-MM-DD') AS incurred_on, status, decision_note, (receipt_ref_enc IS NOT NULL) AS has_receipt, created_at FROM trip_claims WHERE trip_id=$1 ORDER BY created_at", [trip.id])).rows;
  return {
    policy,
    rows: parts.map((p) => {
      const ent = entitlementFor(trip, policy, p), mine = pays.filter((x) => x.participant_id === p.id), cl = claims.filter((x) => x.participant_id === p.id);
      const pd = sum(mine.filter((x) => x.kind === 'per_diem')), adv = sum(mine.filter((x) => x.kind === 'advance')), reim = sum(mine.filter((x) => x.kind === 'reimbursement'));
      const approved = sum(cl.filter((x) => x.status === 'approved')), submitted = sum(cl.filter((x) => x.status === 'submitted')), rejected = sum(cl.filter((x) => x.status === 'rejected'));
      return {
        participant_id: p.id, user_id: p.user_id, display_name: p.display_name, role: p.role, status: p.status,
        entitlement: ent, per_diem_paid_minor: pd, advances_minor: adv,
        claims: { submitted_minor: submitted, approved_minor: approved, rejected_minor: rejected, reimbursed_minor: reim, items: cl.map((x) => ({ ...x, reimbursed: pays.some((y) => y.claim_id === x.id) })) },
        per_diem_balance_minor: ent ? ent.amount_minor - pd : null, claims_balance_minor: approved - reim,
        net_due_minor: (ent?.amount_minor ?? 0) + approved - pd - reim - adv,
      };
    }),
  };
}

/** Everything cost-related for the trip, per currency, with each state labelled. Supplier orders are read from supplier services, not copied. */
export async function costSummary(c, trip) {
  const st = await statements(c, trip);
  const by = {};
  const slot = (cur) => (by[cur] ??= { currency: cur, supplier_orders_gross_minor: 0, per_diem_entitlement_minor: 0, per_diem_paid_minor: 0, advances_minor: 0, claims_approved_minor: 0, claims_reimbursed_minor: 0, claims_pending_minor: 0 });
  for (const r of st.rows) {
    if (r.entitlement) { const s = slot(r.entitlement.currency); s.per_diem_entitlement_minor += r.entitlement.amount_minor; s.per_diem_paid_minor += r.per_diem_paid_minor; }
    for (const x of r.claims.items) { const s = slot(x.currency); if (x.status === 'approved') s.claims_approved_minor += Number(x.amount_minor); if (x.status === 'submitted') s.claims_pending_minor += Number(x.amount_minor); if (x.reimbursed) s.claims_reimbursed_minor += Number(x.amount_minor); }
  }
  for (const p of (await c.query("SELECT currency, sum(amount_minor)::float8 AS n FROM trip_payments WHERE trip_id=$1 AND voided_at IS NULL AND kind='advance' GROUP BY currency", [trip.id])).rows) slot(p.currency).advances_minor += p.n;
  for (const o of (await c.query("SELECT o.currency, sum(o.gross_minor)::float8 AS n FROM trip_supplier_links l JOIN svc_orders o ON o.id=l.order_id WHERE l.trip_id=$1 AND l.unlinked_at IS NULL AND o.status NOT IN ('cancelled','rejected','terminated') GROUP BY o.currency", [trip.id])).rows) slot(o.currency).supplier_orders_gross_minor += o.n;
  return Object.values(by);
}
