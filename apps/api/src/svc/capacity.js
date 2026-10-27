// Supplier capacity: daily units per profile, reserved under a row lock on the profile so concurrent confirmations can never over-book.
import { conflict } from '../errors.js';

const DAY = 86400000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export function daysBetween(from, to) {
  const out = []; const end = new Date(isoDay(to ?? from)).getTime();
  for (let t = new Date(isoDay(from)).getTime(); t <= end && out.length < 740; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Dates a recurring requirement occurs on (bounded). */
export function occurrences(start, recurrence, end) {
  if (!recurrence) return daysBetween(start, end ?? start);
  const out = []; const until = new Date(recurrence.until).getTime();
  for (let t = new Date(isoDay(start)).getTime(); t <= until && out.length < 740; t += DAY) {
    const d = new Date(t);
    if (recurrence.freq === 'daily' || (recurrence.freq === 'weekly' && (recurrence.by_day?.length ? recurrence.by_day.includes(DOW[d.getUTCDay()]) : d.getUTCDay() === new Date(start).getUTCDay())) || (recurrence.freq === 'monthly' && d.getUTCDate() === new Date(start).getUTCDate())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
/** Reserve `units` on each day for an order (idempotent per order/day). Locks the supplier profile first. */
export async function reserve(c, profile, orderId, days, units) {
  await c.query('SELECT id FROM svc_profiles WHERE id=$1 FOR UPDATE', [profile.id]);
  const p = (await c.query('SELECT daily_capacity FROM svc_profiles WHERE id=$1', [profile.id])).rows[0];
  const bl = new Set((await c.query('SELECT day::text FROM svc_blackouts WHERE profile_id=$1 AND day = ANY($2::date[])', [profile.id, days])).rows.map((r) => r.day));
  const hit = days.find((d) => bl.has(d));
  if (hit) throw conflict(`The supplier is unavailable on ${hit}`);
  if (p.daily_capacity === null) return [];
  const cap = Number(p.daily_capacity);
  const taken = new Map((await c.query(`SELECT day::text, sum(units)::float AS u FROM svc_allocations WHERE profile_id=$1 AND day = ANY($2::date[]) AND order_id <> $3
      AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now())) GROUP BY day`, [profile.id, days, orderId])).rows.map((r) => [r.day, r.u]));
  for (const d of days) if ((taken.get(d) ?? 0) + units > cap + 1e-9) throw conflict(`Not enough capacity on ${d} (${cap - (taken.get(d) ?? 0)} of ${cap} left)`);
  const rows = [];
  for (const d of days) rows.push((await c.query("INSERT INTO svc_allocations(profile_id, order_id, day, units, status) VALUES ($1,$2,$3,$4,'confirmed') ON CONFLICT (order_id, day) DO UPDATE SET units=EXCLUDED.units, status='confirmed', hold_expires_at=NULL RETURNING *", [profile.id, orderId, d, units])).rows[0]);
  return rows;
}
export const HOLD_HOURS = 72;
/**
 * An expiring hold taken when an order is placed: the days are set aside for the supplier to confirm, and lapse after HOLD_HOURS if it does not.
 * Best effort by design — if the days are already full or blacked out the order is still placed (the supplier decides) and no hold is taken.
 * Returns the held rows, or null when nothing could be held.
 */
export async function hold(c, profile, orderId, days, units, hours = HOLD_HOURS) {
  await c.query('SELECT id FROM svc_profiles WHERE id=$1 FOR UPDATE', [profile.id]);
  const p = (await c.query('SELECT daily_capacity FROM svc_profiles WHERE id=$1', [profile.id])).rows[0];
  if (p.daily_capacity === null) return null;                           // an uncapped supplier has nothing to hold
  const blocked = (await c.query('SELECT 1 FROM svc_blackouts WHERE profile_id=$1 AND day = ANY($2::date[])', [profile.id, days])).rowCount;
  if (blocked) return null;
  const taken = new Map((await c.query(`SELECT day::text, sum(units)::float AS u FROM svc_allocations WHERE profile_id=$1 AND day = ANY($2::date[]) AND order_id <> $3
      AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now())) GROUP BY day`, [profile.id, days, orderId])).rows.map((r) => [r.day, r.u]));
  if (days.some((d) => (taken.get(d) ?? 0) + units > Number(p.daily_capacity) + 1e-9)) return null;
  const out = [];
  for (const d of days) out.push((await c.query("INSERT INTO svc_allocations(profile_id, order_id, day, units, status, hold_expires_at) VALUES ($1,$2,$3,$4,'held', now() + ($5 || ' hours')::interval) ON CONFLICT (order_id, day) DO UPDATE SET units=EXCLUDED.units, status='held', hold_expires_at=EXCLUDED.hold_expires_at RETURNING *", [profile.id, orderId, d, units, String(hours)])).rows[0]);
  return out;
}
/** Holds that lapsed: released, and the order's buyer is told once that the supplier has not confirmed in time. */
export const releaseExpiredHolds = (c) => c.query("UPDATE svc_allocations SET status='released' WHERE status='held' AND hold_expires_at <= now() RETURNING order_id");
export const release = (c, orderId, fromDay = null) => c.query("UPDATE svc_allocations SET status='released' WHERE order_id=$1 AND status <> 'released' AND ($2::date IS NULL OR day >= $2)", [orderId, fromDay]);
