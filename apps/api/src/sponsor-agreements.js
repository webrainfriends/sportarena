// Shared helpers for sponsorship agreements: persisting lines, generating the schedule, history, and who-is-who on a deal.
import { buildSchedule } from './sponsor-schedule.js';
import { forbidden, notFound } from './errors.js';
import { isAdmin } from './helpers.js';
import { sponsorAccess, assertSponsorCan } from './sponsor-access.js';
import { sponsorContactUser } from './sponsor-identity-access.js';

export const logHistory = (c, sponsorshipId, version, actor, action, reason) =>
  c.query('INSERT INTO sponsorship_history(sponsorship_id, version, actor_id, action, reason) VALUES ($1,$2,$3,$4,$5)', [sponsorshipId, version, actor, action, reason ?? null]);

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
  const plan = buildSchedule(lines, { starts_on: d.starts_on, ends_on: d.ends_on });
  let made = 0;
  for (const o of plan.occurrences) {
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
        AND NOT EXISTS (SELECT 1 FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status IN ('reported','confirmed'))
        AND NOT EXISTS (SELECT 1 FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status <> 'rejected')
        AND NOT EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status <> 'revision_requested')`, [sponsorshipId]);
  return r.rowCount;
}

/**
 * Deal + the people on each side. `role` is 'sponsor' (the brand owner or its organisation staff), 'recipient' (authorised target owner)
 * or 'admin'. Sponsor side = the brand owner, its organisation staff or its entity representatives (see sponsor-access.js). For the sponsor side, `staff` is the live sponsor role and `need(action)` enforces what that role may do.
 */
export async function dealContext(c, sponsorshipId, user, { lock = false } = {}) {
  const d = (await c.query(`SELECT *, starts_on::text AS starts, ends_on::text AS ends FROM sponsorships WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [sponsorshipId])).rows[0];
  if (!d) throw notFound('Sponsorship');
  const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [d.sponsor_id])).rows[0];
  const recipientId = d.target_type === 'event' ? (await c.query('SELECT organizer_id AS u FROM events WHERE id=$1', [d.target_id])).rows[0]?.u
    : d.target_type === 'team' ? (await c.query('SELECT owner_id AS u FROM teams WHERE id=$1', [d.target_id])).rows[0]?.u : d.target_id;
  let access = await sponsorAccess(user, sp, c);
  if (access?.departmentId && access.departmentId !== d.department_id) access = null; // a department-scoped member only sees their department's deals
  // sponsor wins if one person is on both sides; an admin may read everything
  const role = access ? 'sponsor' : user.id === recipientId ? 'recipient' : isAdmin(user) ? 'admin' : null;
  if (!role) throw forbidden('You are not part of this sponsorship');
  // sp.owner_id is who gets notified: an active owner of the sponsor entity, never someone who has left
  return { d, sp: { ...sp, owner_id: await sponsorContactUser(c, sp) }, recipientId, role, staff: access?.role, need: (action, what) => assertSponsorCan(access, action, { departmentId: d.department_id, what }) };
}

/** Obligation + its deal, locking the obligation row so concurrent payments/deliveries serialise. */
export async function obligationContext(c, obligationId, user) {
  const o = (await c.query('SELECT * FROM sponsorship_obligations WHERE id=$1 FOR UPDATE', [obligationId])).rows[0];
  if (!o) throw notFound('Obligation');
  return { o, ...(await dealContext(c, o.sponsorship_id, user)) };
}
