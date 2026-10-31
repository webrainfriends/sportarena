// What stops a coach taking a slot: another class, a requested/confirmed hire, or a commitment (issue #656). Kept free of payment and
// notification imports because the booking code reads it on every availability check and write.
import { many } from './db.js';
import { commitmentBusy } from './coach-commitments.js';

/** [startMs, endMs] for each scheduled class overlapping [from, to) (Dates). `client` reads inside a transaction; `excludeId` skips one class. */
export async function classBusy(coachId, from, to, { client, excludeId } = {}) {
  const sql = "SELECT starts_at, duration_min FROM coach_classes WHERE coach_id=$1 AND status='scheduled' AND ($4::uuid IS NULL OR id<>$4) AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2";
  const rows = client ? (await client.query(sql, [coachId, from, to, excludeId ?? null])).rows : await many(sql, [coachId, from, to, excludeId ?? null]);
  return rows.map((r) => [+new Date(r.starts_at), +new Date(r.starts_at) + r.duration_min * 60_000]);
}

/**
 * Serialise everything that books a coach's time (a hire request, a class publish), so two of them cannot both pass the clash check.
 * A transaction-scoped advisory lock: take it, re-check with the same client, then write, all in one transaction.
 */
export const lockCoachCalendar = (c, coachId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('coach-cal:' || $1::text, 0))", [coachId]);

/** Why a hire cannot start at `start` for `mins` minutes, or null when the coach is free. `db` is the pool, or the client holding the calendar lock. */
export async function hireClash(db, coachId, start, mins) {
  const end = new Date(+start + mins * 60_000);
  if ((await db.query("SELECT 1 FROM coach_hires WHERE coach_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2", [coachId, start, end])).rowCount) return 'Coach is not free then';
  if ((await commitmentBusy(coachId, start, end)).length) return 'The coach has another commitment then';
  if ((await classBusy(coachId, start, end, { client: db })).length) return 'The coach is running a class then';
  return null;
}
