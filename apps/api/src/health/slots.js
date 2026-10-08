// Open appointment slots for a provider: weekly windows (in the provider's own time zone) minus time off and appointments
// that are already requested or confirmed. A provider who has set no windows has no bookable grid (legacy free-form booking).
import { many, one } from '../db.js';
import { addDays, dateRange, fromLocal, toLocal } from '../booking/time.js';

export const MIN_NOTICE_MIN = 60;
export const MAX_RANGE_DAYS = 31;

export async function loadSchedule(providerId, c) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows) : many;
  const [profile] = await q('SELECT timezone, slot_min FROM provider_profiles WHERE user_id=$1', [providerId]);
  const windows = await q('SELECT weekday, start_min, end_min FROM provider_availability WHERE provider_id=$1 AND removed_at IS NULL ORDER BY weekday, start_min', [providerId]);
  return { timezone: profile?.timezone ?? 'UTC', slot_min: profile?.slot_min ?? 30, windows };
}

/** Slots between `from` and `to` (Date objects). `duration` must fit inside one window. */
export async function openSlots(providerId, from, to, { duration, schedule, client } = {}) {
  const sched = schedule ?? await loadSchedule(providerId, client);
  if (!sched.windows.length) return [];
  const q = client ? (t, p) => client.query(t, p).then((r) => r.rows) : many;
  const [off, booked] = await Promise.all([
    q('SELECT starts_at, ends_at FROM provider_time_off WHERE provider_id=$1 AND removed_at IS NULL AND starts_at < $3 AND ends_at > $2', [providerId, from, to]),
    q("SELECT starts_at, duration_min FROM appointments WHERE provider_id=$1 AND status IN ('requested','confirmed') AND starts_at < $3 AND starts_at + make_interval(mins => duration_min) > $2", [providerId, from, to]),
  ]);
  const busy = [...off.map((o) => [+new Date(o.starts_at), +new Date(o.ends_at)]), ...booked.map((b) => [+new Date(b.starts_at), +new Date(b.starts_at) + b.duration_min * 60_000])];
  const len = duration ?? sched.slot_min, earliest = Date.now() + MIN_NOTICE_MIN * 60_000, out = [];
  // one day of slack either side because the local date can differ from the UTC date
  for (const date of dateRange(addDays(toLocal(from, sched.timezone).date, -1), addDays(toLocal(to, sched.timezone).date, 1))) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const w of sched.windows.filter((x) => x.weekday === weekday)) {
      for (let m = w.start_min; m + len <= w.end_min; m += sched.slot_min) {
        const start = fromLocal(date, m, sched.timezone), s = +start, e = s + len * 60_000;
        if (s < +from || s >= +to || s < earliest) continue;
        if (busy.some(([a, b]) => s < b && e > a)) continue;
        out.push(start.toISOString());
      }
    }
  }
  return [...new Set(out)].sort();
}

/** Is exactly this start/duration bookable on the provider's grid? */
export async function isBookable(providerId, startsAt, duration, client) {
  const start = new Date(startsAt), sched = await loadSchedule(providerId, client);
  if (!sched.windows.length) return { grid: false, ok: true };
  const slots = await openSlots(providerId, start, new Date(+start + 1000), { duration, schedule: sched, client });
  return { grid: true, ok: slots.includes(start.toISOString()) };
}
