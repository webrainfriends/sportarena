// Temporary hardware credentials follow the thing that justified them (#510): a booking, a locker assignment, an accreditation. Kept apart from
// the access layer so the booking, locker and accreditation code can call it without importing the whole engine.
import { pool } from './db.js';
import { providerOf } from './access-providers.js';

async function sourceState(c, g) {
  if (g.source_type === 'booking') return (await c.query("SELECT b.ends_at AS valid_to, (b.status='confirmed' AND rs.status='confirmed') AS ok FROM bookings b JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1", [g.source_id])).rows[0];
  if (g.source_type === 'locker_assignment') return (await c.query("SELECT ends_at AS valid_to, status='active' AS ok FROM locker_assignments WHERE id=$1", [g.source_id])).rows[0];
  return (await c.query("SELECT k.valid_to, (a.status='approved' AND a.access='active') AS ok FROM accreditations a JOIN accreditation_categories k ON k.id=a.category_id WHERE a.id=$1", [g.source_id])).rows[0];
}
/** Called inside the transaction that cancels / releases / revokes a source: marks its grants revoke_pending (no network here) and tries the provider right after commit. */
export async function revokeGrantsForSource(c, sourceType, sourceId, reason = 'source_ended') {
  const { rows } = await c.query("UPDATE access_grants SET status='revoke_pending', revoke_reason=$3 WHERE source_type=$1 AND source_id=$2 AND status='active' RETURNING id", [sourceType, sourceId, reason]);
  if (rows.length && c.afterCommit) c.afterCommit(() => settleRevocations(rows.map((r) => r.id)).catch(() => {}));
  return rows.length;
}
export async function settleRevocations(ids = null) {
  const { rows } = await pool.query(
    `SELECT g.*, p.provider, p.endpoint_url, p.secret_enc, p.id AS pid FROM access_grants g JOIN access_points p ON p.id=g.access_point_id WHERE g.status='revoke_pending' AND ($1::uuid[] IS NULL OR g.id = ANY($1)) ORDER BY g.created_at LIMIT 200`, [ids]);
  let done = 0;
  for (const g of rows) {
    const out = await providerOf(g.provider)?.revoke({ id: g.pid, endpoint_url: g.endpoint_url, secret_enc: g.secret_enc }, { reference: g.id, provider_ref: g.provider_ref });
    if (out?.outcome === 'ok') { await pool.query("UPDATE access_grants SET status='revoked', revoked_at=now() WHERE id=$1 AND status='revoke_pending'", [g.id]); done++; }
  }
  return done;
}
/** Worker: grants whose source stopped being valid (or whose time passed) become revoke_pending, then every pending revocation is retried. */
export async function sweepAccessGrants() {
  const { rows } = await pool.query("SELECT * FROM access_grants WHERE status='active' ORDER BY valid_to LIMIT 500");
  let flagged = 0;
  for (const g of rows) {
    const s = await sourceState(pool, g);
    if (!s || !s.ok || new Date(g.valid_to) < new Date()) { await pool.query("UPDATE access_grants SET status='revoke_pending', revoke_reason=$2 WHERE id=$1 AND status='active'", [g.id, !s || !s.ok ? 'source_ended' : 'expired']); flagged++; }
  }
  return flagged + (await settleRevocations());
}
/** A reservation changed: any booking grant whose booking is no longer confirmed starts its revocation. */
export async function revokeStaleBookingGrants(c, reservationId) {
  const { rows } = await c.query(
    `UPDATE access_grants g SET status='revoke_pending', revoke_reason='booking_cancelled' FROM bookings b JOIN reservations rs ON rs.id=b.reservation_id
      WHERE g.source_type='booking' AND g.source_id=b.id AND b.reservation_id=$1 AND g.status='active' AND (b.status<>'confirmed' OR rs.status<>'confirmed') RETURNING g.id`, [reservationId]);
  if (rows.length && c.afterCommit) c.afterCommit(() => settleRevocations(rows.map((r) => r.id)).catch(() => {}));
  return rows.length;
}
