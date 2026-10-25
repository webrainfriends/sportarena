// Beneficiary portfolio (#292): one read model over the canonical sponsorship tables, grouped by who is supported (athlete, team or event).
// Nothing here is a second ledger: every amount is read from applications, awards, agreement obligations and payments at request time, so the
// portfolio always reconciles with the source agreements. Currencies are never added together, a reported payment is never counted as settled,
// and each caller sees only what their own authority covers (a sponsor's brands, or the recipient's own targets): other sponsors' terms are never read.
import { guardedAthleteSql } from './youth-sponsorship.js';
import { sponsorStaffSql, sponsorBrandSql } from './sponsor-access.js';

export const RISKS = {
  overdue_payment: 'A cash payment is overdue',
  overdue_delivery: 'Goods or an endorsement are overdue',
  unconfirmed_payment: 'A reported payment has waited more than 7 days for confirmation',
  agreement_ending: 'An agreement ends within 30 days',
  review_overdue: 'A scheduled review date has passed',
  payment_blocked: 'A condition that must be met before payment is still open',
  funding_gap: 'Part of the requested funding is not yet awarded or offered',
  youth_beneficiary: 'The beneficiary is under the age of independence: identity and notes are limited',
};
export const SORTS = { name: '', risk: 'cardinality(risks) DESC,', milestone: 'next_due_on ASC NULLS LAST,' };

/** Events, teams and athletes the caller owns — the recipient side of a sponsorship. `a` is the alias carrying target_type/target_id. */
export const recipientSql = (a) => `((${a}.target_type='event' AND ${a}.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
  OR (${a}.target_type='team' AND ${a}.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (${a}.target_type='athlete' AND ${a}.target_id=$1) OR ${guardedAthleteSql(a)})`;

/**
 * The shared CTE chain. $1 user, $2 sponsor, $3 program, $4 target type, $5 search, $6 stage, $7 has_gap, $8 risk, $9 currency, $10 target id.
 * `view` decides whose authority scopes the rows (sponsor | recipient | athlete); `action` is the sponsor permission needed (read for the screen, export for the CSV).
 */
export function chain(view, action = 'read') {
  const sponsor = view === 'sponsor';
  // 'athlete' = one athlete's own workspace ($10): the caller's right to see it (self, guardian, consented coach) is decided before the query runs
  const athlete = view === 'athlete';
  const dealScope = athlete ? "($1::uuid IS NOT NULL AND ss.target_type='athlete' AND ss.target_id=$10)" : sponsor ? sponsorStaffSql(1, action) : recipientSql('ss');
  const appScope = athlete ? "($1::uuid IS NOT NULL AND a.target_type='athlete' AND a.target_id=$10)" : sponsor ? sponsorBrandSql(1, action) : `(a.applicant_id=$1 OR ${recipientSql('a')})`;
  return `
deals AS (
  SELECT ss.id, ss.sponsor_id, ss.target_type, ss.target_id, ss.status, ss.visibility, ss.ends_on, ss.program_id,
         ${sponsor ? `(${sponsorStaffSql(1, 'performance')})` : 'true'} AS may_review
    FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
   WHERE ${dealScope} AND ($2::uuid IS NULL OR ss.sponsor_id=$2) AND ($3::uuid IS NULL OR ss.program_id=$3)
     AND ($4::text IS NULL OR ss.target_type=$4) AND ($10::uuid IS NULL OR ss.target_id=$10)),
apps AS (
  SELECT a.id, a.program_id, a.target_type, a.target_id, a.status, a.requested_cents, a.awarded_cents, a.currency,
         (SELECT w.amount_cents FROM sponsorship_awards w WHERE w.application_id=a.id AND w.status IN ('pending_approval','approved','issued') ORDER BY w.created_at DESC, w.id LIMIT 1) AS offered_cents
    FROM sponsorship_applications a JOIN sponsorship_programs p ON p.id=a.program_id JOIN sponsors sp ON sp.id=p.sponsor_id
   WHERE ${appScope} AND ($2::uuid IS NULL OR p.sponsor_id=$2) AND ($3::uuid IS NULL OR a.program_id=$3)
     AND ($4::text IS NULL OR a.target_type=$4) AND ($10::uuid IS NULL OR a.target_id=$10)),
ob AS (
  SELECT d.id AS sponsorship_id, d.target_type, d.target_id, o.id, o.line_id, o.kind, o.status, o.due_on, o.amount_cents, o.quantity, o.currency,
         coalesce((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed'),0)::bigint AS confirmed,
         coalesce((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported'),0)::bigint AS reported,
         EXISTS (SELECT 1 FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported' AND p.created_at < now() - interval '7 days') AS stale_report
    FROM sponsorship_obligations o JOIN deals d ON d.id=o.sponsorship_id WHERE o.status <> 'cancelled'),
money AS (
  SELECT target_type, target_id, currency, sum(requested)::bigint AS requested, sum(awarded)::bigint AS awarded, sum(offered)::bigint AS offered, sum(gap)::bigint AS gap,
         sum(committed)::bigint AS committed, sum(confirmed)::bigint AS confirmed, sum(reported)::bigint AS reported, sum(overdue)::bigint AS overdue
    FROM (
      SELECT a.target_type, a.target_id, a.currency, a.requested_cents AS requested,
             CASE WHEN a.status='awarded' THEN a.awarded_cents ELSE 0 END AS awarded,
             CASE WHEN a.status='submitted' THEN coalesce(a.offered_cents,0) ELSE 0 END AS offered,
             a.requested_cents - CASE WHEN a.status='awarded' THEN a.awarded_cents ELSE coalesce(a.offered_cents,0) END AS gap,
             0::bigint AS committed, 0::bigint AS confirmed, 0::bigint AS reported, 0::bigint AS overdue
        FROM apps a WHERE a.status IN ('submitted','awarded')
      UNION ALL
      SELECT target_type, target_id, currency, 0, 0, 0, 0, amount_cents, confirmed, reported, CASE WHEN status='scheduled' AND due_on < current_date THEN amount_cents ELSE 0 END
        FROM ob WHERE kind='money') x
   GROUP BY target_type, target_id, currency),
keys AS (SELECT target_type, target_id FROM deals UNION SELECT target_type, target_id FROM apps),
stats AS (
  SELECT k.target_type, k.target_id,
    (SELECT count(*) FROM deals d WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND d.status='active')::int AS active_agreements,
    (SELECT count(*) FROM deals d WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND d.status='proposed')::int AS proposed_agreements,
    (SELECT count(*) FROM deals d WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND d.status IN ('ended','declined','withdrawn'))::int AS closed_agreements,
    (SELECT count(*) FROM apps a WHERE a.target_type=k.target_type AND a.target_id=k.target_id AND a.status='submitted')::int AS open_applications,
    (SELECT count(*) FROM apps a WHERE a.target_type=k.target_type AND a.target_id=k.target_id)::int AS applications,
    EXISTS (SELECT 1 FROM ob WHERE ob.target_type=k.target_type AND ob.target_id=k.target_id AND ob.kind='money' AND ob.status='scheduled' AND ob.due_on < current_date) AS f_overdue_payment,
    EXISTS (SELECT 1 FROM ob WHERE ob.target_type=k.target_type AND ob.target_id=k.target_id AND ob.kind<>'money' AND ob.status='scheduled' AND ob.due_on < current_date) AS f_overdue_delivery,
    EXISTS (SELECT 1 FROM ob WHERE ob.target_type=k.target_type AND ob.target_id=k.target_id AND ob.stale_report) AS f_unconfirmed_payment,
    EXISTS (SELECT 1 FROM deals d WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND d.status='active' AND d.ends_on BETWEEN current_date AND current_date + 30) AS f_agreement_ending,
    EXISTS (SELECT 1 FROM deals d WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND d.status='active' AND d.may_review
              AND (SELECT r.next_review_on FROM sponsorship_reviews r WHERE r.sponsorship_id=d.id AND r.visibility='shared' ORDER BY r.created_at DESC, r.id DESC LIMIT 1) < current_date) AS f_review_overdue,
    EXISTS (SELECT 1 FROM sponsorship_awards w JOIN sponsorship_award_conditions c ON c.award_id=w.id JOIN deals d ON d.id=w.sponsorship_id
             WHERE d.target_type=k.target_type AND d.target_id=k.target_id AND w.status='accepted' AND c.removed_at IS NULL AND c.blocks_payment AND c.met_at IS NULL) AS f_payment_blocked,
    (SELECT min(ob.due_on) FROM ob WHERE ob.target_type=k.target_type AND ob.target_id=k.target_id AND ob.status='scheduled' AND ob.due_on >= current_date)::text AS next_due_on,
    ${sponsor ? "(k.target_type='athlete' AND EXISTS (SELECT 1 FROM users u WHERE u.id=k.target_id AND (u.youth_until IS NOT NULL AND u.youth_until > current_date)))" : 'false'} AS youth
    FROM keys k),
named AS (
  SELECT s.*,
    CASE WHEN s.youth THEN 'Youth athlete'
         ELSE coalesce(CASE s.target_type WHEN 'athlete' THEN (SELECT display_name FROM users WHERE id=s.target_id) WHEN 'team' THEN (SELECT name FROM teams WHERE id=s.target_id) ELSE (SELECT name FROM events WHERE id=s.target_id) END, 'Unavailable') END AS name,
    coalesce((SELECT bool_or(m.gap > 0) FROM money m WHERE m.target_type=s.target_type AND m.target_id=s.target_id), false) AS has_gap,
    CASE WHEN s.active_agreements > 0 THEN 'active' WHEN s.proposed_agreements > 0 OR s.open_applications > 0 THEN 'pending' ELSE 'closed' END AS stage
    FROM stats s),
matched AS (
  SELECT n.*, array_remove(ARRAY[
      CASE WHEN f_overdue_payment THEN 'overdue_payment' END, CASE WHEN f_overdue_delivery THEN 'overdue_delivery' END, CASE WHEN f_unconfirmed_payment THEN 'unconfirmed_payment' END,
      CASE WHEN f_agreement_ending THEN 'agreement_ending' END, CASE WHEN f_review_overdue THEN 'review_overdue' END, CASE WHEN f_payment_blocked THEN 'payment_blocked' END,
      CASE WHEN has_gap THEN 'funding_gap' END, CASE WHEN youth THEN 'youth_beneficiary' END], NULL) AS risks
    FROM named n
   WHERE ($5::text IS NULL OR n.name ILIKE '%' || $5 || '%') AND ($6::text IS NULL OR n.stage=$6) AND (NOT $7::boolean OR n.has_gap)
     AND ($9::text IS NULL OR EXISTS (SELECT 1 FROM money m WHERE m.target_type=n.target_type AND m.target_id=n.target_id AND m.currency=$9))
     AND ($8::text IS NULL OR $8 = ANY(ARRAY[
      CASE WHEN f_overdue_payment THEN 'overdue_payment' END, CASE WHEN f_overdue_delivery THEN 'overdue_delivery' END, CASE WHEN f_unconfirmed_payment THEN 'unconfirmed_payment' END,
      CASE WHEN f_agreement_ending THEN 'agreement_ending' END, CASE WHEN f_review_overdue THEN 'review_overdue' END, CASE WHEN f_payment_blocked THEN 'payment_blocked' END,
      CASE WHEN has_gap THEN 'funding_gap' END, CASE WHEN youth THEN 'youth_beneficiary' END]::text[])))`;
}

/** Outstanding follows the obligations list exactly (committed minus confirmed) so the two screens reconcile. */
export const shapeMoney = (m) => ({
  currency: m.currency, requested_cents: Number(m.requested), awarded_cents: Number(m.awarded), offered_cents: Number(m.offered), gap_cents: Number(m.gap),
  committed_cents: Number(m.committed), confirmed_cents: Number(m.confirmed), reported_unconfirmed_cents: Number(m.reported), overdue_cents: Number(m.overdue),
  outstanding_cents: Number(m.committed) - Number(m.confirmed),
});
