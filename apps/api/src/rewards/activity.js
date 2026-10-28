// Canonical completed business events -> loyalty points. Each business fact calls `recordActivity` once, from the place it becomes true
// (an invoice marked paid, a coaching session completed, an event ended). Rules match on the event type, the key includes the source,
// so replaying an event never pays twice. Nothing here is reachable from "opened the app" or "created a fixture".
import { config } from '../config.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';
import { award, loadProgramme, earningLive, clawBack } from './ledger.js';
import { qualifyReferrals, voidReferralsFor } from './referrals.js';

const ownerClause = `(p.owner_kind='platform'
  OR (p.owner_kind='venue' AND p.owner_id = $2::uuid) OR (p.owner_kind='organisation' AND p.owner_id = $3::uuid)
  OR (p.owner_kind='coach' AND p.owner_id = $4::uuid) OR (p.owner_kind='event' AND p.owner_id = $5::uuid))`;

/** Does a programme's scope contain this activity? (platform programmes span the network.) */
export const inScope = (p, a) => p.owner_kind === 'platform'
  || (p.owner_kind === 'venue' && a.venueId === p.owner_id) || (p.owner_kind === 'organisation' && a.organisationId === p.owner_id)
  || (p.owner_kind === 'coach' && a.coachId === p.owner_id) || (p.owner_kind === 'event' && a.eventId === p.owner_id);

export async function programmesFor(c, a) {
  const { rows } = await c.query(`SELECT p.id FROM loyalty_programmes p WHERE p.status='active' AND p.current_version IS NOT NULL AND p.currency = coalesce($1, p.currency) AND ${ownerClause} ORDER BY p.created_at, p.id`,
    [a.currency ?? null, a.venueId ?? null, a.organisationId ?? null, a.coachId ?? null, a.eventId ?? null]);
  const out = [];
  for (const r of rows) out.push(await loadProgramme(c, r.id));
  return out;
}

/** Points a rule gives for this activity (0 when the spend is below its minimum or the rule is for another event). */
export function pointsFor(rule, a) {
  if (rule.event !== a.type) return 0;
  if (a.amountMinor !== undefined && !(a.amountMinor > 0)) return 0;          // a bill covered entirely by points or passes earns nothing: no point-farming loops
  if ((a.amountMinor ?? 0) < rule.min_spend_minor) return 0;
  return rule.mode === 'fixed' ? rule.points : Math.floor(((a.amountMinor ?? 0) * rule.percent_bp) / 10000);
}

/**
 * @param {object} a { type, userId, amountMinor?, currency?, sourceType, sourceId, venueId?, organisationId?, coachId?, eventId?, label? }
 * @returns {Promise<{ awarded: Array<{programme_id, points}> }>}
 */
export async function recordActivity(c, a) {
  const awarded = [];
  for (const p of await programmesFor(c, a)) {
    if (!earningLive(p)) continue;
    for (const rule of p.rules.earn) {
      const points = pointsFor(rule, a);
      if (points <= 0) continue;
      const { row } = await award(c, p, { userId: a.userId, points, ruleKey: rule.key, sourceType: a.sourceType, sourceId: a.sourceId, key: `earn:${p.id}:${rule.key}:${a.sourceType}:${a.sourceId}`, reason: rule.label ?? a.label ?? null });
      if (row) {
        awarded.push({ programme_id: p.id, points: row.delta });
        await notify(c, a.userId, { kind: 'loyalty_earned', title: `You earned ${row.delta} ${p.unit} · ${p.name}`, body: `Worth ${p.currency} ${toMajor(row.delta, p.currency)} on a later payment${a.currency ? '' : ''}.`, data: { programme_id: p.id }, dedupe_key: `loyalty:${row.id}` });
      }
    }
  }
  await qualifyReferrals(c, a, { inScope });
  return { awarded };
}

// ---------------------------------------------------------------------------------------------------- source-specific adapters

/** A venue invoice is paid: reward the net cash/wallet/card amount, never the part paid with points or a pass. */
export async function venueInvoicePaid(c, inv) {
  const venue = (await c.query('SELECT organisation_id FROM venues WHERE id=$1', [inv.venue_id])).rows[0];
  const withPoints = Number((await c.query("SELECT coalesce(sum(amount_cents - returned_cents),0) AS n FROM invoice_credits WHERE invoice_id=$1 AND source IN ('points','pass')", [inv.id])).rows[0].n);
  return recordActivity(c, { type: 'venue_booking_paid', userId: inv.user_id, amountMinor: inv.total_cents - withPoints, currency: inv.currency, sourceType: 'venue_invoice', sourceId: inv.id, venueId: inv.venue_id, organisationId: venue?.organisation_id ?? null, label: `Invoice ${inv.number}` });
}

/** An academy charge is paid (the payer earns; for a young player that is the guardian, never the child). */
export async function academyChargePaid(c, ch) {
  const withPoints = Number((await c.query("SELECT coalesce(sum(ic.amount_cents - ic.returned_cents),0) AS n FROM invoice_credits ic JOIN invoices i ON i.id=ic.invoice_id WHERE i.academy_charge_id=$1 AND ic.source='points'", [ch.id])).rows[0].n);
  return recordActivity(c, { type: 'academy_payment_paid', userId: ch.payer_id, amountMinor: Math.max(0, Number(ch.amount_minor) - withPoints), currency: ch.currency, sourceType: 'academy_charge', sourceId: ch.id, organisationId: ch.organisation_id, label: 'Academy payment' });
}

/** A coaching session that is both paid and completed. Safe to call from either side: whichever happens last triggers the reward. */
export async function coachSessionDone(c, hireId) {
  const h = (await c.query("SELECT * FROM coach_hires WHERE id=$1 AND status='completed' AND payment_status='paid'", [hireId])).rows[0];
  if (!h) return { awarded: [] };
  return recordActivity(c, { type: 'coach_session_completed', userId: h.hirer_id, amountMinor: Math.max(0, Number(h.total_cents) - Number(h.loyalty_credit_cents)), currency: config.payments.currency, sourceType: 'coach_hire', sourceId: h.id, coachId: h.coach_id, eventId: h.event_id ?? null, label: 'Coaching session' });
}

/** Events that have finished: every accepted individual, and every active member of an accepted team, took part. Idempotent per person and event. */
export async function eventParticipationSweep(c) {
  const { rows } = await c.query(
    `SELECT DISTINCT e.id AS event_id, e.organisation_id, coalesce(en.user_id, m.user_id) AS user_id
       FROM events e JOIN event_entries en ON en.event_id=e.id AND en.status='accepted'
       LEFT JOIN team_members m ON m.team_id=en.team_id AND m.status='active'
      WHERE e.status='completed' AND e.ended_at > now() - interval '60 days' AND coalesce(en.user_id, m.user_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l WHERE l.source_type='event' AND l.source_id = e.id::text || ':' || coalesce(en.user_id, m.user_id)::text)
      LIMIT 500`);
  let n = 0;
  for (const r of rows) {
    const out = await recordActivity(c, { type: 'event_participation', userId: r.user_id, sourceType: 'event', sourceId: `${r.event_id}:${r.user_id}`, eventId: r.event_id, organisationId: r.organisation_id, label: 'Event participation' });
    n += out.awarded.length;
  }
  return n;
}

/** A paid membership that is still active earns once per whole month. */
export async function membershipTenureSweep(c) {
  const { rows } = await c.query(
    `SELECT up.id, up.user_id, up.venue_id, up.organisation_id, up.price_cents, up.currency, gs.n AS month_no
       FROM user_plans up JOIN LATERAL generate_series(1, LEAST(60, GREATEST(0, (extract(epoch FROM (least(now(), coalesce(up.expires_at, now())) - coalesce(up.starts_at, up.created_at))) / 2592000)::int))) AS gs(n) ON true
      WHERE up.kind='membership' AND up.status='active'
        AND NOT EXISTS (SELECT 1 FROM loyalty_ledger l WHERE l.source_type='membership_month' AND l.source_id = up.id::text || ':' || gs.n::text)
      LIMIT 500`);
  let n = 0;
  for (const r of rows) {
    const out = await recordActivity(c, { type: 'membership_tenure', userId: r.user_id, amountMinor: Number(r.price_cents), currency: r.currency, sourceType: 'membership_month', sourceId: `${r.id}:${r.month_no}`, venueId: r.venue_id, organisationId: r.organisation_id, label: `Membership month ${r.month_no}` });
    n += out.awarded.length;
  }
  return n;
}

/** A refund or cancellation of the thing that earned points: take back the matching share, and void a referral reward that has not been released yet. */
export async function reverseActivity(c, { sourceType, sourceId, refundedMinor, totalMinor, reason }) {
  const taken = await clawBack(c, { sourceType, sourceId, ratioNum: refundedMinor, ratioDen: totalMinor, key: `clawback:${sourceType}:${sourceId}:${refundedMinor}`, reason: reason ?? 'Refunded' });
  if (refundedMinor >= totalMinor) await voidReferralsFor(c, sourceType, sourceId);
  return taken;
}
