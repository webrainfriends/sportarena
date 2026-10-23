// Shared helpers for sponsorship agreements: persisting lines, generating the schedule, history, and who-is-who on a deal.
import { buildSchedule } from './sponsor-schedule.js';
import { forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { sponsorAccess, assertSponsorCan } from './sponsor-access.js';
import { sponsorContactUser } from './sponsor-identity-access.js';
import { notify } from './notify.js';
import { ORG_TARGETS, beneficiaryAccess, primaryContact, targetOrgId } from './sponsor-beneficiaries.js';

export const logHistory = (c, sponsorshipId, version, actor, action, reason) =>
  c.query('INSERT INTO sponsorship_history(sponsorship_id, version, actor_id, action, reason) VALUES ($1,$2,$3,$4,$5)', [sponsorshipId, version, actor, action, reason ?? null]);

/** Record who wrote a numbered terms version (and the period it covers), so the negotiation can be compared and audited. */
export const recordVersion = (c, sponsorshipId, version, side, authorId, { reason, restores, starts, ends, tz } = {}) =>
  c.query('INSERT INTO sponsorship_versions(sponsorship_id, version, authored_side, authored_by, reason, restores, starts_on, ends_on, timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [sponsorshipId, version, side, authorId ?? null, reason ?? null, restores ?? null, starts ?? null, ends ?? null, tz ?? null]);

export async function saveLines(c, sponsorshipId, version, lines) {
  let pos = 0;
  for (const l of lines) {
    pos++;
    await c.query(
      `INSERT INTO sponsorship_lines(sponsorship_id, version, position, kind, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on, instalments, custom_dates, promoter, terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [sponsorshipId, version, pos, l.kind, l.label, l.currency ?? null, l.amount_cents ?? null, l.total_cents ?? null, l.estimate_cents ?? null, l.quantity ?? null, l.unit ?? null, l.cadence,
        l.first_due_on ?? null, l.cadence === 'custom' ? l.custom_dates.length : l.cadence === 'once' ? 1 : l.instalments, l.cadence === 'custom' ? l.custom_dates : null, l.promoter ?? null, l.terms ?? {}]);
  }
}

/** The lines of one version, in the shape the schedule builder takes. */
export async function loadLines(c, sponsorshipId, version) {
  const { rows } = await c.query(
    `SELECT id, kind, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on::text, instalments, (SELECT array_agg(x::text ORDER BY x) FROM unnest(custom_dates) x) AS custom_dates, promoter, terms
       FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 ORDER BY position`, [sponsorshipId, version]);
  return rows.map((r) => ({ ...r, custom_dates: r.custom_dates ?? undefined, amount_cents: r.amount_cents ?? undefined, total_cents: r.total_cents ?? undefined, estimate_cents: r.estimate_cents ?? undefined, quantity: r.quantity ?? undefined, unit: r.unit ?? undefined, first_due_on: r.first_due_on ?? undefined, promoter: r.promoter ?? undefined, currency: r.currency ?? undefined }));
}

/**
 * Create the dues of the ACCEPTED version. Idempotent: (sponsorship, version, line, seq) is unique, so a retry or a second worker
 * inserts nothing new. Returns how many dues were newly created.
 */
export async function generateObligations(c, sponsorshipId) {
  const d = (await c.query('SELECT id, accepted_version, starts_on::text, ends_on::text FROM sponsorships WHERE id=$1 FOR UPDATE', [sponsorshipId])).rows[0];
  if (!d?.accepted_version) return 0;
  const lines = await loadLines(c, d.id, d.accepted_version);
  const ids = lines.map((l) => l.id);
  // an amended version only owns the dues from its effective date; earlier dues belong to the versions that were in force then (#296)
  const from = (await c.query('SELECT effective_from::text AS f FROM sponsorship_versions WHERE sponsorship_id=$1 AND version=$2', [d.id, d.accepted_version])).rows[0]?.f ?? null;
  const plan = buildSchedule(lines, { starts_on: d.starts_on, ends_on: d.ends_on });
  let made = 0;
  for (const o of plan.occurrences) {
    if (from && o.due_on < from) continue;
    const r = await c.query(
      `INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (sponsorship_id, version, line_id, seq) DO NOTHING`, [d.id, d.accepted_version, ids[o.line - 1], o.seq, o.kind, o.due_on, o.amount_cents, o.currency, o.quantity]);
    made += r.rowCount;
  }
  return made;
}

/**
 * Ending a deal stops FUTURE dues that nothing has happened to. Anything already due, overdue, part-paid, dispatched or submitted stays
 * open: ending an agreement never erases a debt or delivered value.
 */
export async function cancelFutureObligations(c, sponsorshipId) {
  const r = await c.query(
    `UPDATE sponsorship_obligations o SET status='cancelled', cancelled_at=now()
      WHERE o.sponsorship_id=$1 AND o.status='scheduled' AND o.due_on > current_date
        AND NOT EXISTS (SELECT 1 FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status IN ('reported','confirmed','awaiting_payment'))
        AND NOT EXISTS (SELECT 1 FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status <> 'rejected')
        AND NOT EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status <> 'revision_requested')`, [sponsorshipId]);
  return r.rowCount;
}

/** The authorised recipient of a sponsorship: the event organiser, the team owner or the athlete themselves. */
export async function targetOwner(c, type, id) {
  return type === 'event' ? (await c.query('SELECT organizer_id AS u FROM events WHERE id=$1', [id])).rows[0]?.u
    : type === 'team' ? (await c.query('SELECT owner_id AS u FROM teams WHERE id=$1', [id])).rows[0]?.u : id;
}

/**
 * Deal + the people on each side. `lock` takes FOR NO KEY UPDATE: it still serialises writers of the deal but lets a concurrent payment insert (its foreign key only needs a key-share lock), so a pause and a payment cannot deadlock.
 * `role` is 'sponsor' (the brand owner or its organisation staff), 'recipient' (authorised target owner)
 * or 'admin'. Sponsor side = the brand owner, its organisation staff or its entity representatives (see sponsor-access.js). For the sponsor side, `staff` is the live sponsor role and `need(action)` enforces what that role may do.
 */
export async function dealContext(c, sponsorshipId, user, { lock = false } = {}) {
  const d = (await c.query(`SELECT *, starts_on::text AS starts, ends_on::text AS ends FROM sponsorships WHERE id=$1${lock ? ' FOR NO KEY UPDATE' : ''}`, [sponsorshipId])).rows[0];
  if (!d) throw notFound('Sponsorship');
  const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [d.sponsor_id])).rows[0];
  const beneficiary = ORG_TARGETS.includes(d.target_type) ? await beneficiaryAccess(c, user.id, d) : null;
  const recipientId = ORG_TARGETS.includes(d.target_type) ? await primaryContact(c, await targetOrgId(c, d.target_type, d.target_id)) : await targetOwner(c, d.target_type, d.target_id);
  let access = await sponsorAccess(user, sp, c);
  if (access?.departmentId && access.departmentId !== d.department_id) access = null; // a department-scoped member only sees their department's deals
  // sponsor wins if one person is on both sides; an admin may read everything
  const role = access ? 'sponsor' : (beneficiary ? beneficiary.any : user.id === recipientId) ? 'recipient' : isAdmin(user) ? 'admin' : null;
  if (!role) throw forbidden('You are not part of this sponsorship');
  // sp.owner_id is who gets notified: an active owner of the sponsor entity, never someone who has left
  return { d, sp: { ...sp, owner_id: await sponsorContactUser(c, sp) }, recipientId, role, beneficiary, staff: access?.role, need: (action, what) => assertSponsorCan(access, action, { departmentId: d.department_id, what }) };
}

/** Obligation + its deal, locking the obligation row so concurrent payments/deliveries serialise. */
export async function obligationContext(c, obligationId, user) {
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 FOR UPDATE', [obligationId])).rows[0];
  if (!o) throw notFound('Obligation');
  return { o, ...(await dealContext(c, o.sponsorship_id, user)) };
}

/** Money state of an obligation after any change: fulfilled once confirmed payments (net of refunds) cover it, reopened if a reversal or refund uncovers it. */
export async function settleMoney(c, o) {
  const paid = Number((await c.query("SELECT coalesce(sum(amount_cents - refunded_cents),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status='confirmed'", [o.id])).rows[0].s);
  if (paid + Number(o.conceded_cents ?? 0) >= Number(o.amount_cents)) await c.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=coalesce(fulfilled_at, now()) WHERE id=$1 AND status='scheduled'", [o.id]);
  else await c.query("UPDATE sponsorship_obligations SET status='scheduled', fulfilled_at=NULL WHERE id=$1 AND status='fulfilled'", [o.id]);
}

/**
 * Online checkouts that can no longer complete stop reserving the due: their provider payment failed, or they were abandoned for over two
 * hours. A late provider confirmation of one of these is refunded automatically (the payment is "paid for something that can no longer be
 * fulfilled"), so nothing is ever kept without being credited.
 */
export async function releaseStaleCheckouts(c, obligationId) {
  return (await c.query(
    `UPDATE sponsorship_payments sp SET status='failed', decided_at=now(), decision_note='Checkout was not completed'
      WHERE sp.obligation_id=$1 AND sp.status='awaiting_payment'
        AND (sp.created_at < now() - interval '2 hours' OR EXISTS (SELECT 1 FROM payments p WHERE p.id=sp.payment_id AND p.status IN ('failed','refunded')))`, [obligationId])).rowCount;
}

/**
 * The refund of an online sponsorship payment was recorded on `payments`: mirror it onto the due so confirmed money stays net of refunds.
 * Also covers a checkout that was cancelled or expired but still got paid: that money is refunded, so the row ends 'reversed' and balances the ledger.
 */
export async function syncSponsorshipRefund(c, payment) {
  if (payment.purpose_type !== 'sponsorship_payment') return;
  const sp = (await c.query("UPDATE sponsorship_payments SET refunded_cents=least(amount_cents, $2), status=CASE WHEN $2 >= amount_cents THEN 'reversed' ELSE status END, decided_at=CASE WHEN $2 >= amount_cents THEN now() ELSE decided_at END, decision_note=CASE WHEN $2 >= amount_cents THEN 'Refunded to the sponsor' ELSE decision_note END WHERE id=$1 AND status IN ('confirmed','reversed','awaiting_payment','failed') RETURNING obligation_id", [payment.purpose_id, Number(payment.refunded_cents)])).rows[0];
  if (!sp) return;
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 FOR UPDATE', [sp.obligation_id])).rows[0];
  await settleMoney(c, o);
  await logHistory(c, o.sponsorship_id, o.version, null, 'payment_refunded');
}

/**
 * The provider has verified the money: the online payment becomes confirmed (never from a client report) and the due is re-evaluated.
 * Returns false when the due can no longer take it (cancelled, already covered, deal not active), so the payment is refunded instead.
 */
export async function fulfilSponsorshipPayment(c, id) {
  const x = (await c.query("SELECT * FROM sponsorship_payments WHERE id=$1 AND status='awaiting_payment' FOR UPDATE", [id])).rows[0];
  if (!x) return false;
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 FOR UPDATE', [x.obligation_id])).rows[0];
  const d = (await c.query('SELECT status FROM sponsorships WHERE id=$1', [o.sponsorship_id])).rows[0];
  const covered = Number((await c.query("SELECT coalesce(sum(amount_cents - refunded_cents),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status='confirmed'", [o.id])).rows[0].s);
  if (o.status === 'cancelled' || o.held_by_pause_id || !['active', 'paused', 'ended'].includes(d.status) || covered + Number(x.amount_cents) > Number(o.amount_cents)) return false;
  await c.query("UPDATE sponsorship_payments SET status='confirmed', paid_on=current_date, decided_at=now(), decision_note='Verified by the payment provider' WHERE id=$1", [x.id]);
  await settleMoney(c, o);
  await logHistory(c, o.sponsorship_id, o.version, x.reported_by, 'payment_collected_online');
  const t = (await c.query('SELECT target_type, target_id FROM sponsorships WHERE id=$1', [o.sponsorship_id])).rows[0];
  const to = await targetOwner(c, t.target_type, t.target_id);
  if (to) await notify(c, to, { kind: 'sponsorship_payment', title: 'A sponsorship payment was collected', body: 'A sponsor paid online. It is added to your earnings and paid out after the hold period.', data: { sponsorship_id: o.sponsorship_id } });
  return true;
}

/** What already counts against a due: reported and confirmed money (net of refunds) plus online checkouts still open. */
export async function heldCents(c, obligationId) {
  return Number((await c.query("SELECT coalesce(sum(CASE status WHEN 'confirmed' THEN amount_cents - refunded_cents ELSE amount_cents END),0) AS s FROM sponsorship_payments WHERE obligation_id=$1 AND status IN ('reported','confirmed','awaiting_payment')", [obligationId])).rows[0].s);
}
