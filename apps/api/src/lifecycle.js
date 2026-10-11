// Shared lifecycle rules for provider engagements (health appointments and coaching hires).
//   requested -> confirmed | cancelled | expired      confirmed -> completed | cancelled
//   completed, cancelled and expired are final: nothing leaves them (no resurrection).
// `expired` is only ever set by the maintenance sweep, never requested through the API.
import { pool, tx } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { conflict, forbidden } from './errors.js';
import { notify } from './notify.js';
import { refundFor } from './payments/service.js';

export const NEXT = { requested: ['confirmed', 'cancelled', 'expired'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [], expired: [] };
/**
 * Tell the history trigger who is acting and why for the rest of this transaction (it resets at commit/rollback).
 * The reason is encrypted because it may mention health details.
 */
export async function setTransitionContext(c, actorId, reason) {
  await c.query("SELECT set_config('app.actor_id', $1, true), set_config('app.reason_enc', $2, true)", [actorId ?? '', encrypt(reason?.trim() || null, 'status_history.reason') ?? '']);
}

/** Refund key: one refund per engagement, however many times or from however many requests it is attempted. */
export const refundKey = (purpose, id) => `${purpose}-${id}-cancel`;

/** Ordered history of one engagement (oldest first). Caller has already checked the viewer is a party. */
export async function timelineFor(kind, subjectId, viewerId, { limit, offset }) {
  const rows = (await pool.query(
    `SELECT h.id, h.from_status, h.to_status, h.actor_id, u.display_name AS actor_name, h.reason_enc, h.payment_status, h.backfilled, h.at
       FROM engagement_status_history h LEFT JOIN users u ON u.id=h.actor_id
      WHERE h.kind=$1 AND h.subject_id=$2 ORDER BY h.at, h.seq LIMIT $3 OFFSET $4`, [kind, subjectId, limit, offset])).rows;
  if (rows.some((r) => r.reason_enc)) await audit(null, viewerId, 'read_clinical', kind === 'appointment' ? 'appointments' : 'coach_hires', subjectId);
  return rows.map(({ reason_enc, actor_name, ...r }) => ({ ...r, actor_name: r.actor_id ? actor_name : null, by_system: !r.actor_id && !r.backfilled && r.from_status !== null, reason: decrypt(reason_enc, 'status_history.reason') }));
}

export const FINAL = Object.keys(NEXT).filter((s) => NEXT[s].length === 0);

/**
 * Validate a move against the row that is locked in the caller's transaction.
 * `row` needs status, payment_status, starts_at. Throws 403 for the wrong actor and 409 for a move
 * the current state or its prerequisites (payment, start time) do not allow.
 */
export function assertTransition(row, to, { isProvider, isCustomer, isAdmin = false }, { noun, customerWord }) {
  if (!isProvider && !isCustomer && !isAdmin) throw forbidden();
  if (to !== 'cancelled' && !isProvider) throw forbidden('Only the provider can confirm or complete');
  if (!NEXT[row.status]?.includes(to)) {
    throw conflict(FINAL.includes(row.status) ? `This ${noun} is already ${row.status} and cannot be changed` : `A ${row.status} ${noun} cannot become ${to}`);
  }
  if (to === 'confirmed') {
    if (row.payment_status === 'unpaid') throw conflict(`Waiting for the ${customerWord} to pay`);
    if (new Date(row.starts_at) <= new Date()) throw conflict(`This ${noun} was due to start already; cancel it or ask for a new time`);
  }
  if (to === 'completed') {
    if (row.payment_status === 'unpaid') throw conflict(`This ${noun} has not been paid for`);
    if (new Date(row.starts_at) > new Date()) throw conflict(`This ${noun} has not started yet; it can be completed once it has`);
  }
}

const SWEEPS = [
  { key: 'appointments', table: 'appointments', providerCol: 'provider_id', customerCol: 'athlete_id', noun: 'Appointment', kind: 'appointment_update', purpose: 'appointment', dataKey: 'appointment_id' },
  { key: 'hires', table: 'coach_hires', providerCol: 'coach_id', customerCol: 'hirer_id', noun: 'Coaching session', kind: 'coach_hire_expired', purpose: 'coach_hire', dataKey: 'hire_id' },
];

/**
 * Requests whose start time passed without an answer expire. Each row is locked, re-checked and moved with a conditional
 * update; a paid one is refunded first (if the provider refuses, the row stays as it was and is retried next cycle).
 */
export async function expireStaleRequests({ limit = 200 } = {}) {
  const out = { appointments: 0, hires: 0 };
  for (const s of SWEEPS) {
    const ids = (await pool.query(`SELECT id FROM ${s.table} WHERE status='requested' AND starts_at < now() ORDER BY starts_at LIMIT $1`, [limit])).rows.map((r) => r.id);
    for (const id of ids) {
      try {
        const done = await tx(async (c) => {
          const r = (await c.query(`SELECT * FROM ${s.table} WHERE id=$1 AND status='requested' AND starts_at < now() FOR UPDATE SKIP LOCKED`, [id])).rows[0];
          if (!r) return false;
          await setTransitionContext(c, null, 'Not confirmed before the start time');
          let payment = r.payment_status;
          if (payment === 'paid') { await refundFor(s.purpose, r.id, { key: refundKey(s.purpose, r.id) }); payment = 'refunded'; }
          const upd = await c.query(`UPDATE ${s.table} SET status='expired', payment_status=$2 WHERE id=$1 AND status='requested'`, [r.id, payment]);
          if (!upd.rowCount) return false;
          if (s.table === 'appointments') await c.query("UPDATE appointment_followups SET status='due', booked_appointment_id=NULL, updated_at=now() WHERE booked_appointment_id=$1 AND status='booked'", [r.id]);
          else await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='request expired' WHERE session_type='coach_hire' AND session_id=$1 AND released_at IS NULL", [r.id]);
          for (const u of [r[s.customerCol], r[s.providerCol]]) {
            await notify(c, u, { kind: s.kind, title: `${s.noun} request expired`, body: 'It was not confirmed before the start time.', data: { [s.dataKey]: r.id } });
          }
          return true;
        });
        if (done) out[s.key]++;
      } catch (e) { console.error(`[expire ${s.key}]`, id, e.message); }
    }
  }
  return out;
}
