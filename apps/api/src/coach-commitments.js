// Occurrences of a coach commitment. Computed from the pattern (nothing is stored per day), minus what the log
// says was skipped or cancelled. A one-off commitment has no weekdays and happens once, on its start date.
import { many, pool } from './db.js';
import { addDays, dateRange, fromLocal } from './booking/time.js';

export function occurrences(c, from, to, log = new Map()) {
  if (c.status === 'cancelled' || c.status === 'paused') return [];
  const start = c.starts_on > from ? c.starts_on : from;
  const end = c.ends_on && c.ends_on < to ? c.ends_on : to;
  if (end < start) return [];
  const days = (c.weekdays?.length ? dateRange(start, end).filter((d) => c.weekdays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) : c.starts_on >= start && c.starts_on <= end ? [c.starts_on] : []);
  return days.map((on_date) => {
    const s = fromLocal(on_date, c.start_min, c.timezone);
    return { commitment_id: c.id, on_date, starts_at: s.toISOString(), ends_at: new Date(+s + c.duration_min * 60_000).toISOString(), logged: log.get(`${c.id}:${on_date}`) ?? null };
  }).filter((o) => !['skipped', 'cancelled'].includes(o.logged?.status));
}

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
/** A Postgres `date` arrives as a local-midnight Date: read it with local getters so the day never shifts. */
export const dbDate = (d) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
/** A commitment row with its dates as plain YYYY-MM-DD strings. */
export const plain = (c) => ({ ...c, starts_on: dbDate(c.starts_on), ends_on: c.ends_on ? dbDate(c.ends_on) : null });
export { addDays };

/** Busy intervals [startMs, endMs] from the coach's commitments between two instants (Dates), so bookings never land on top of them. */
export async function commitmentBusy(coachId, from, to) {
  const classes = (await many("SELECT starts_at, duration_min FROM coach_classes WHERE coach_id=$1 AND status='open' AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2", [coachId, from, to])).map((k) => [+new Date(k.starts_at), +new Date(k.starts_at) + k.duration_min * 60_000]);
  const cs = (await many("SELECT * FROM coach_commitments WHERE coach_id=$1 AND status='active' AND starts_on <= $3::date AND (ends_on IS NULL OR ends_on >= $2::date)", [coachId, addDays(isoDate(from), -1), addDays(isoDate(to), 1)])).map(plain);
  if (!cs.length) return classes;
  const log = await loggedMap(cs.map((c) => c.id));
  const out = [...classes];
  for (const c of cs) for (const o of occurrences(c, addDays(isoDate(from), -1), addDays(isoDate(to), 1), log)) {
    const a = +new Date(o.starts_at), b = +new Date(o.ends_at);
    if (a < +to && b > +from) out.push([a, b]);
  }
  return out;
}

export async function loggedMap(ids) {
  const rows = ids.length ? await many('SELECT commitment_id, on_date, status, note FROM coach_commitment_log WHERE commitment_id = ANY($1::uuid[])', [ids]) : [];
  return new Map(rows.map((r) => [`${r.commitment_id}:${dbDate(r.on_date)}`, r]));
}

/**
 * Run `fn` holding the coach's calendar lock. A class publish takes the same lock (as a transaction lock), so a hire and a class cannot both
 * pass their clash check for the same time. The lock lives on its own connection; the checks inside `fn` use the normal pool and see committed rows.
 */
export async function withCoachCalendar(coachId, fn) {
  const key = `coach_calendar:${coachId}`;
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    try { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); } finally { c.release(); }
  }
}
